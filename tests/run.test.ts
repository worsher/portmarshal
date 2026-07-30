import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import type { Flags } from "../src/flags.js";
import run, { substitutePort } from "../src/commands/run.js";
import type { RegistryEntry } from "../src/types.js";
import { Registry } from "../src/registry.js";
import { pidAlive } from "../src/ready.js";

function flagsOf(over: Partial<Flags>): Flags {
  return {
    json: false, all: false, force: false, gui: false, install: false,
    killDetached: false, restart: false, detach: false, follow: false,
    positional: [], rest: [], ...over,
  };
}

async function withStateDir<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-run-"));
  process.env.PORTMARSHAL_STATE_DIR = stateDir;
  try { return await fn(stateDir); } finally {
    delete process.env.PORTMARSHAL_STATE_DIR;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function loadEntries(stateDir: string): Promise<RegistryEntry[]> {
  return JSON.parse(await fs.readFile(path.join(stateDir, "registry.json"), "utf8"));
}

test("substitutePort 替换每个参数中的所有 {port}", () => {
  assert.deepEqual(
    substitutePort(["vite", "--port", "{port}", "http://127.0.0.1:{port}/{port}"], 3210),
    ["vite", "--port", "3210", "http://127.0.0.1:3210/3210"],
  );
});

test("run: 缺 name 或缺 -- 命令时打印 usage 并退出 1", async () => {
  assert.equal(await run(flagsOf({ positional: [], rest: ["node"] })), 1);
  assert.equal(await run(flagsOf({ positional: ["web"], rest: [] })), 1);
});

test("run: 注入 PORT，子进程退出后自动 release 并保留 lastPort 粘性", async () => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    const code = await run(flagsOf({
      // 固定一个不常用的高位端口：默认 3000 起的低位段常被本机其他 dev server 占用，
      // 一旦被占，claim 后置的旧实例检测会（正确地）在这些无关测试里触发拦截。
      positional: ["web"], project, prefer: 18821,
      // 子进程校验 PORT 已注入且与占位符一致，不一致则以 9 退出
      rest: [process.execPath, "-e", "process.exit(process.env.PORT === process.argv[1] ? 0 : 9)", "{port}"],
    }));
    assert.equal(code, 0);
    const entries = await loadEntries(stateDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "web");
    assert.equal(entries[0].released, true);
    assert.equal(entries[0].lastPort, entries[0].port);
    await fs.rm(project, { recursive: true, force: true });
  });
});

test("run: 透传子进程退出码，且异常退出同样 release", async () => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    const code = await run(flagsOf({
      positional: ["web"], project, prefer: 18822,
      rest: [process.execPath, "-e", "process.exit(7)"],
    }));
    assert.equal(code, 7);
    assert.equal((await loadEntries(stateDir))[0].released, true);
    await fs.rm(project, { recursive: true, force: true });
  });
});

test("run: 命令不存在时报错、release 并退出 1", async () => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    const code = await run(flagsOf({
      positional: ["web"], project, prefer: 18823,
      rest: ["definitely-not-a-real-command-xyz"],
    }));
    assert.equal(code, 1);
    assert.equal((await loadEntries(stateDir))[0].released, true);
    await fs.rm(project, { recursive: true, force: true });
  });
});

function waitListening(port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      const sock = net.connect({ port, host: "127.0.0.1" }, () => { sock.destroy(); resolve(); });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("timeout waiting for port"));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

/** 轮询直到 pred() 为真或超时；用于容忍 SIGTERM 到进程真正退出之间的异步窗口 */
async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("run: 端口被本项目旧实例监听且无 --restart 时退出 3", async () => {
  await withStateDir(async () => {
    // 测试进程自身监听 claim 到的端口——scan 会把它归属到本进程 cwd（仓库根目录）
    const project = process.cwd();
    const registry = new Registry();
    const { port } = await registry.claim({ name: "old", project, claimedBy: "test" });
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
    try {
      const code = await run(flagsOf({
        positional: ["old"], project,
        rest: [process.execPath, "-e", "process.exit(0)"],
      }));
      assert.equal(code, 3);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

test("run --restart: 护栏停掉本项目旧实例后在同端口重启", async (t) => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    t.after(() => fs.rm(project, { recursive: true, force: true }));
    const registry = new Registry();
    const { port } = await registry.claim({ name: "web", project, claimedBy: "test" });
    // 旧实例：cwd 指向 project 的真实监听子进程，scan 可归属
    const oldInstance = spawn(
      process.execPath,
      ["-e", `require("http").createServer((_q,r)=>r.end("ok")).listen(${port},"127.0.0.1")`],
      { cwd: project, stdio: "ignore" },
    );
    t.after(() => { oldInstance.kill("SIGKILL"); });
    await waitListening(port);

    const code = await run(flagsOf({
      positional: ["web"], project, restart: true,
      rest: [process.execPath, "-e", "process.exit(0)"],
    }));
    assert.equal(code, 0);
    // 旧实例已被护栏 stop 终止
    assert.ok(oldInstance.exitCode !== null || oldInstance.signalCode !== null);
    // 同端口粘回，且新进程退出后 release
    const entry = (await loadEntries(stateDir)).find((e) => e.name === "web");
    assert.ok(entry);
    assert.equal(entry.released, true);
    assert.equal(entry.lastPort, port);
  });
});

test("run -d: 就绪后返回 0，registry 记录 runPid/logFile，服务继续存活", async (t) => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    t.after(() => fs.rm(project, { recursive: true, force: true }));
    const code = await run(flagsOf({
      positional: ["web"], project, prefer: 18830, detach: true,
      rest: [process.execPath, "-e",
        'require("http").createServer((q,r)=>r.end("ok")).listen(process.env.PORT,"127.0.0.1",()=>console.log("server up"))'],
    }));
    assert.equal(code, 0);
    const entry = (await loadEntries(stateDir))[0];
    assert.ok(entry.runPid && entry.runPid > 0);
    assert.ok(entry.logFile);
    assert.equal(entry.released, undefined);
    t.after(() => { try { process.kill(-entry.runPid!, "SIGKILL"); } catch { /* 已退出 */ } });
    // 服务在 run 返回后仍然在监听
    await waitListening(entry.port);
    // 日志已落盘
    const log = await fs.readFile(entry.logFile!, "utf8");
    assert.match(log, /server up/);
  });
});

test("run -d: 命令永不监听 → 超时失败，退出 1，进程被杀，claim 已 release", async () => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    const code = await run(flagsOf({
      positional: ["web"], project, prefer: 18831, detach: true, waitTimeout: 1,
      rest: [process.execPath, "-e", "setInterval(()=>{}, 1000)"],
    }));
    assert.equal(code, 1);
    const entry = (await loadEntries(stateDir))[0];
    assert.equal(entry.released, true);
    assert.equal(entry.runPid, undefined);
    await fs.rm(project, { recursive: true, force: true });
  });
});

test("run -d: 命令立即退出 → 快速失败（不等满超时）", async () => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    const start = Date.now();
    const code = await run(flagsOf({
      positional: ["web"], project, prefer: 18832, detach: true, waitTimeout: 30,
      rest: [process.execPath, "-e", "process.exit(0)"],
    }));
    assert.equal(code, 1);
    assert.ok(Date.now() - start < 10_000);
    assert.equal((await loadEntries(stateDir))[0].released, true);
    await fs.rm(project, { recursive: true, force: true });
  });
});

test("run -d: 日志轮转保留上一次运行", async (t) => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    t.after(() => fs.rm(project, { recursive: true, force: true }));
    const serve = 'require("http").createServer((q,r)=>r.end("ok")).listen(process.env.PORT,"127.0.0.1",()=>console.log("server up"))';
    const args = {
      positional: ["web"], project, prefer: 18833, detach: true,
      rest: [process.execPath, "-e", serve],
    } as const;
    assert.equal(await run(flagsOf({ ...args })), 0);
    let entry = (await loadEntries(stateDir))[0];
    const firstPid = entry.runPid!;
    assert.equal(await run(flagsOf({ ...args, restart: true })), 0);
    entry = (await loadEntries(stateDir)).find((e) => e.name === "web")!;
    t.after(() => { try { process.kill(-entry.runPid!, "SIGKILL"); } catch { /* 已退出 */ } });
    assert.notEqual(entry.runPid, firstPid);
    // restart 的 stop 护栏应已终止旧进程组；SIGTERM 到实际退出有极短异步窗口，轮询容错
    await waitUntil(() => !pidAlive(firstPid), 2000);
    assert.equal(pidAlive(firstPid), false);
    assert.equal(entry.port, 18833); // cwd 钉住 project 后，claim 复用校验应识别出旧实例，端口原地粘回
    // 上一次的日志转到了 .old
    const old = await fs.readFile(entry.logFile! + ".old", "utf8");
    assert.match(old, /server up/);
  });
});
