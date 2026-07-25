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

function flagsOf(over: Partial<Flags>): Flags {
  return {
    json: false, all: false, force: false, gui: false, install: false,
    killDetached: false, restart: false, positional: [], rest: [], ...over,
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
