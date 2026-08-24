import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { classifyTarget, terminate, scanListeners } from "../src/scan.js";
import type { ProcessInfo, RegistryEntry } from "../src/types.js";
import type { Flags } from "../src/flags.js";
import stop, { listenersOnPort, portsNoLongerListening } from "../src/commands/stop.js";
import { Registry } from "../src/registry.js";
import { pidAlive, processGroupAlive } from "../src/ready.js";
import { ownerFingerprint } from "../src/owner.js";

function proc(over: Partial<ProcessInfo>): ProcessInfo {
  return {
    pid: 100, ports: [3000], procName: "node", command: "",
    cwd: "/p/other", inferredProject: null, source: "cursor", ...over,
  };
}

test("classifyTarget: detached 仍先按实时项目判断；未知归属才进入 guarded detached", () => {
  assert.equal(classifyTarget(proc({ source: "detached", cwd: "/p/me" }), "/p/me", []), "own");
  assert.equal(classifyTarget(proc({ source: "detached", cwd: "/p/other" }), "/p/me", []), "foreign");
  assert.equal(classifyTarget(proc({ source: "detached", cwd: null }), "/p/me", []), "detached");
});

test("classifyTarget: cwd 同项目 → own", () => {
  assert.equal(classifyTarget(proc({ cwd: "/p/me" }), "/p/me", []), "own");
  assert.equal(classifyTarget(proc({ cwd: "/p/me/sub" }), "/p/me", []), "own");
});

test("classifyTarget: 同项目但活跃 claim 属于另一会话 → session", () => {
  const reg: RegistryEntry[] = [{
    name: "web", project: "/p/me", port: 3000,
    claimedAt: new Date().toISOString(), claimedBy: "codex", ownerKey: "v1:owner-a",
  }];
  assert.equal(classifyTarget(proc({ cwd: "/p/me" }), "/p/me", reg, "v1:owner-a"), "own");
  assert.equal(classifyTarget(proc({ cwd: "/p/me" }), "/p/me", reg, "v1:owner-b"), "session");
  assert.equal(classifyTarget(proc({ cwd: "/p/me" }), "/p/me", reg), "session");
  assert.equal(classifyTarget(proc({ cwd: "/p/me/sub" }), "/p/me/sub", reg, "v1:owner-b"), "session");
});

test("classifyTarget: 实时项目归属与旧 claim 冲突时以实时归属为准", () => {
  const reg: RegistryEntry[] = [{ name: "web", project: "/p/me", port: 3000, claimedAt: new Date().toISOString() }];
  assert.equal(classifyTarget(proc({ cwd: "/elsewhere" }), "/p/me", reg), "foreign");
  assert.equal(classifyTarget(proc({ cwd: null }), "/p/me", reg), "own");
});

test("classifyTarget: 他人活跃服务 → foreign", () => {
  assert.equal(classifyTarget(proc({}), "/p/me", []), "foreign");
});

test("classifyTarget: 已知实时项目归属不会被多端口 claim 覆盖", () => {
  const multi = proc({ ports: [3000, 3001] });
  const forward: RegistryEntry[] = [
    { name: "a", project: "/other", port: 3000, claimedAt: new Date().toISOString() },
    { name: "b", project: "/p/me", port: 3001, claimedAt: new Date().toISOString() },
  ];
  assert.equal(classifyTarget(multi, "/p/me", forward), "foreign");
  const reversed: RegistryEntry[] = [forward[1], forward[0]];
  assert.equal(classifyTarget(multi, "/p/me", reversed), "foreign");
});

test("listenersOnPort 保留共享 socket 的全部 listener PID", () => {
  const scan = [
    proc({ pid: 101, ports: [3000] }),
    proc({ pid: 102, ports: [3000, 3001] }),
    proc({ pid: 103, ports: [4000] }),
  ];
  assert.deepEqual(listenersOnPort(scan, 3000).map((item) => item.pid), [101, 102]);
});

test("portsNoLongerListening 只释放复扫后确实消失的端口", () => {
  const after = [proc({ pid: 102, ports: [3001] })];
  assert.deepEqual(portsNoLongerListening([3000, 3001], after), [3000]);
});

test("terminate: SIGTERM 即退 → term", async () => {
  let sent: string[] = [];
  let aliveCalls = 0;
  const result = await terminate(
    42, 500,
    (_pid, sig) => { sent.push(sig); },
    () => { aliveCalls++; return aliveCalls < 2; },
  );
  assert.equal(result, "term");
  assert.deepEqual(sent, ["SIGTERM"]);
});

test("terminate: 超时后 SIGKILL → kill", async () => {
  const sent: string[] = [];
  const result = await terminate(
    42, 200,
    (_pid, sig) => { sent.push(sig); },
    () => true,
  );
  assert.equal(result, "kill");
  assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
});

test("terminate: SIGTERM 命中 ESRCH 返回 gone", async () => {
  const r = await terminate(42, 200, () => { const e: NodeJS.ErrnoException = new Error("no such process"); e.code = "ESRCH"; throw e; }, () => true);
  assert.equal(r, "gone");
});

test("terminate: EPERM 向上抛出，不谎报成功", async () => {
  await assert.rejects(
    terminate(42, 200, () => { const e: NodeJS.ErrnoException = new Error("op not permitted"); e.code = "EPERM"; throw e; }, () => true),
    /EPERM|op not permitted/,
  );
});

function stopFlagsOf(over: Partial<Flags>): Flags {
  return {
    json: false, all: false, force: false, gui: false, install: false,
    killDetached: false, dryRun: false, services: false, restart: false, detach: false, follow: false,
    showSensitiveCommand: false,
    positional: [], rest: [], ...over,
  };
}

test("stop: 旧 claim 的端口被其他项目占用时阻止误杀", async (t) => {
  await withStateDir(async () => {
    const ownProject = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-own-"));
    const foreignProject = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-foreign-"));
    t.after(() => fs.rm(ownProject, { recursive: true, force: true }));
    t.after(() => fs.rm(foreignProject, { recursive: true, force: true }));

    const registry = new Registry();
    const { port } = await registry.claim({ name: "web", project: ownProject, prefer: 18844, claimedBy: "test" });
    const foreign = spawn(
      process.execPath,
      ["-e", `require("http").createServer((_q,r)=>r.end("ok")).listen(${port},"127.0.0.1")`],
      { cwd: foreignProject, stdio: "ignore" },
    );
    t.after(() => { if (foreign.exitCode === null) foreign.kill("SIGKILL"); });
    await waitListening(port);

    assert.equal(await stop(stopFlagsOf({ positional: ["web"], project: ownProject })), 3);
    assert.equal(pidAlive(foreign.pid!), true);
  });
});

test("stop: 同项目服务被另一 agent session claim 时默认阻止，--force 才停止", async (t) => {
  await withStateDir(async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-session-"));
    t.after(() => fs.rm(project, { recursive: true, force: true }));
    const registry = new Registry();
    const { port } = await registry.claim({
      name: "web", project, prefer: 18847, claimedBy: "codex",
      ownerKey: ownerFingerprint("explicit", "agent-a"),
    });
    const service = spawn(
      process.execPath,
      ["-e", `require("http").createServer((_q,r)=>r.end("ok")).listen(${port},"127.0.0.1")`],
      { cwd: project, stdio: "ignore" },
    );
    t.after(() => { if (service.exitCode === null) service.kill("SIGKILL"); });
    await waitListening(port);

    const previous = process.env.PORTMARSHAL_OWNER;
    process.env.PORTMARSHAL_OWNER = "agent-b";
    try {
      assert.equal(await stop(stopFlagsOf({ positional: [String(port)], project })), 3);
      assert.equal(pidAlive(service.pid!), true);
      assert.equal(await stop(stopFlagsOf({ positional: [String(port)], project, force: true })), 0);
      await waitUntil(() => !pidAlive(service.pid!), 3000);
      assert.equal(pidAlive(service.pid!), false);
    } finally {
      if (previous === undefined) delete process.env.PORTMARSHAL_OWNER;
      else process.env.PORTMARSHAL_OWNER = previous;
    }
  });
});

async function withStateDir<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-stop-"));
  process.env.PORTMARSHAL_STATE_DIR = stateDir;
  try { return await fn(stateDir); } finally {
    delete process.env.PORTMARSHAL_STATE_DIR;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

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

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("stop: wrapper 组长本身不监听、孙进程才监听 → stop 对整组发信号，组长与监听孙进程都死，claim 转 released", async (t) => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    t.after(() => fs.rm(project, { recursive: true, force: true }));

    const registry = new Registry();
    const { port } = await registry.claim({ name: "web", project, prefer: 18845, claimedBy: "test" });

    // 组长脚本：自己不监听，只 spawn 一个真正监听端口的孙进程（模拟 nodemon 之类的 wrapper）；
    // 孙进程不传 detached，默认沿用组长刚 setsid() 出来的新进程组，所以对 -leaderPid 发信号能覆盖到它。
    const serveCode = `require("http").createServer((q,r)=>r.end("ok")).listen(${port},"127.0.0.1",()=>console.log("child up"))`;
    const leaderScript = `
      const { spawn } = require("child_process");
      spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(serveCode)}], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `;
    const leader = spawn(process.execPath, ["-e", leaderScript], {
      cwd: project,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PORTMARSHAL_SERVICE: "web" },
    });
    leader.unref();
    const leaderPid = leader.pid!;
    t.after(() => { try { process.kill(-leaderPid, "SIGKILL"); } catch { /* 已退出 */ } });

    await waitListening(port);
    const scanned = (await scanListeners()).find((p) => p.ports.includes(port));
    assert.ok(scanned, "孙进程应已在扫描结果里监听端口");
    const listenerPid = scanned!.pid;
    // 确认场景成立：真正监听的是孙进程而不是组长自己
    assert.notEqual(listenerPid, leaderPid);
    assert.equal(pidAlive(leaderPid), true);
    assert.equal(pidAlive(listenerPid), true);

    await registry.setRunInfo("web", project, { runPid: leaderPid, logFile: path.join(project, "web.log") });

    const code = await stop(stopFlagsOf({ positional: [String(port)], project }));
    assert.equal(code, 0);

    // SIGTERM 到进程真正退出之间有异步窗口，轮询容错
    await waitUntil(() => !pidAlive(leaderPid) && !pidAlive(listenerPid), 3000);
    assert.equal(pidAlive(leaderPid), false, "组长应已被组信号杀死");
    assert.equal(pidAlive(listenerPid), false, "监听孙进程应已被组信号杀死");

    const entries: RegistryEntry[] = JSON.parse(
      await fs.readFile(path.join(stateDir, "registry.json"), "utf8"),
    );
    const entry = entries.find((e) => e.name === "web" && e.project === project);
    assert.ok(entry);
    assert.equal(entry!.released, true);
  });
});

test("stop: 组长已退出但原 PGID 仍有监听与非监听子进程 → 仍清理整个进程组", async (t) => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    t.after(() => fs.rm(project, { recursive: true, force: true }));

    const registry = new Registry();
    const { port } = await registry.claim({ name: "web", project, prefer: 18846, claimedBy: "test" });
    const serveCode = `require("http").createServer((q,r)=>r.end("ok")).listen(${port},"127.0.0.1")`;
    const idleCode = "setInterval(() => {}, 1000)";
    const leaderScript = `
      const { spawn } = require("child_process");
      const listener = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(serveCode)}], { stdio: "ignore" });
      const idle = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(idleCode)}], { stdio: "ignore" });
      listener.unref();
      idle.unref();
      process.stdout.write(JSON.stringify({ listenerPid: listener.pid, idlePid: idle.pid }));
    `;
    const leader = spawn(process.execPath, ["-e", leaderScript], {
      cwd: project,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PORTMARSHAL_SERVICE: "web" },
    });
    const leaderPid = leader.pid!;
    let childPidsJson = "";
    leader.stdout!.setEncoding("utf8");
    leader.stdout!.on("data", (chunk: string) => { childPidsJson += chunk; });
    const leaderExited = new Promise<void>((resolve, reject) => {
      leader.once("exit", () => resolve());
      leader.once("error", reject);
    });
    t.after(() => { try { process.kill(-leaderPid, "SIGKILL"); } catch { /* 已退出 */ } });

    await leaderExited;
    const { listenerPid, idlePid } = JSON.parse(childPidsJson) as {
      listenerPid: number;
      idlePid: number;
    };
    await waitListening(port);
    assert.equal(pidAlive(leaderPid), false, "组长应已在 stop 前退出");
    assert.equal(processGroupAlive(leaderPid), true, "原 PGID 应仍由两个子进程维持");
    assert.equal(pidAlive(listenerPid), true);
    assert.equal(pidAlive(idlePid), true);

    await registry.setRunInfo("web", project, {
      runPid: leaderPid,
      logFile: path.join(project, "web.log"),
    });

    const code = await stop(stopFlagsOf({ positional: [String(port)], project }));
    assert.equal(code, 0);
    await waitUntil(
      () => !processGroupAlive(leaderPid) && !pidAlive(listenerPid) && !pidAlive(idlePid),
      3000,
    );
    assert.equal(processGroupAlive(leaderPid), false, "整个原 PGID 都应被清理");
    assert.equal(pidAlive(listenerPid), false, "监听子进程应退出");
    assert.equal(pidAlive(idlePid), false, "同组非监听子进程也应退出");

    const entries: RegistryEntry[] = JSON.parse(
      await fs.readFile(path.join(stateDir, "registry.json"), "utf8"),
    );
    const entry = entries.find((e) => e.name === "web" && e.project === project);
    assert.ok(entry);
    assert.equal(entry!.released, true);
  });
});
