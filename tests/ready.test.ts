import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { waitReady, pidAlive, processGroupAlive, terminateGroup } from "../src/ready.js";

function listen(srv: net.Server | http.Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((r) => srv.listen(0, host, () => r((srv.address() as net.AddressInfo).port)));
}

test("pidAlive: 自身存活，已收割的子进程 pid 不存活", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(999999), false);
});

test("waitReady: TCP 就绪即 ok", async () => {
  const srv = net.createServer();
  const port = await listen(srv);
  try {
    assert.deepEqual(await waitReady({ port, pid: process.pid, timeoutMs: 3000 }), { ok: true });
  } finally { srv.close(); }
});

test("waitReady: 仅监听 IPv6 loopback 也能就绪", async (t) => {
  const srv = net.createServer();
  let port: number;
  try {
    port = await listen(srv, "::1");
  } catch {
    t.skip("此环境不支持 IPv6 (::1)");
    return;
  }
  try {
    assert.deepEqual(await waitReady({ port, pid: process.pid, timeoutMs: 3000 }), { ok: true });
  } finally { srv.close(); }
});

test("waitReady: IPv6-only HTTP 健康检查也能就绪", async (t) => {
  const srv = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  let port: number;
  try {
    port = await listen(srv, "::1");
  } catch {
    t.skip("此环境不支持 IPv6 (::1)");
    return;
  }
  try {
    assert.deepEqual(
      await waitReady({ port, pid: process.pid, readyUrl: "/health", timeoutMs: 3000 }),
      { ok: true },
    );
  } finally { srv.close(); }
});

test("waitReady: 端口由其他进程提供时返回 foreign", async () => {
  const srv = net.createServer();
  const port = await listen(srv);
  try {
    const res = await waitReady({
      port,
      pid: process.pid,
      timeoutMs: 3000,
      verifyOwner: async () => false,
    });
    assert.deepEqual(res, { ok: false, reason: "foreign" });
  } finally { srv.close(); }
});

test("waitReady: 无人监听 → timeout", async () => {
  // 用一个刚释放的临时端口，几乎不可能被瞬间抢占
  const srv = net.createServer();
  const port = await listen(srv);
  await new Promise<void>((r) => srv.close(() => r()));
  const res = await waitReady({ port, pid: process.pid, timeoutMs: 500, intervalMs: 50 });
  assert.deepEqual(res, { ok: false, reason: "timeout" });
});

test("waitReady: 目标进程死亡 → died（快于超时）", async () => {
  const srv = net.createServer();
  const port = await listen(srv);
  await new Promise<void>((r) => srv.close(() => r()));
  const start = Date.now();
  const res = await waitReady({ port, pid: 999999, timeoutMs: 10_000, intervalMs: 50 });
  assert.deepEqual(res, { ok: false, reason: "died" });
  assert.ok(Date.now() - start < 5000);
});

test("waitReady: --ready-url 等到 HTTP 2xx 才 ok，5xx 继续等", async () => {
  let healthy = false;
  const srv = http.createServer((req, res) => {
    res.statusCode = req.url === "/health" && healthy ? 200 : 500;
    res.end();
  });
  const port = await listen(srv);
  try {
    setTimeout(() => { healthy = true; }, 300);
    const res = await waitReady({ port, pid: process.pid, readyUrl: "/health", timeoutMs: 5000, intervalMs: 50 });
    assert.deepEqual(res, { ok: true });
  } finally { srv.close(); }
});

test("waitReady: AbortSignal 中断正在进行的就绪等待", async () => {
  const srv = net.createServer();
  const port = await listen(srv);
  await new Promise<void>((r) => srv.close(() => r()));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const start = Date.now();
  const res = await waitReady({
    port,
    pid: process.pid,
    timeoutMs: 10_000,
    intervalMs: 1000,
    signal: controller.signal,
  });
  assert.deepEqual(res, { ok: false, reason: "aborted" });
  assert.ok(Date.now() - start < 1000);
});

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("terminateGroup: 组长先退出但子进程忽略 SIGTERM 时仍会 SIGKILL 整个 PGID", async (t) => {
  const stubbornChild = `
    process.on("SIGTERM", () => {});
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `;
  const leaderScript = `
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornChild)}], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.once("data", () => process.stdout.write(String(child.pid) + "\\n"));
    setInterval(() => {}, 1000);
  `;
  const leader = spawn(process.execPath, ["-e", leaderScript], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pgid = leader.pid!;
  t.after(() => {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* 已退出 */ }
  });

  const childPid = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for stubborn child")), 3000);
    leader.stdout!.on("data", (chunk) => {
      output += chunk.toString();
      const line = output.split("\n")[0];
      if (/^\d+$/.test(line)) {
        clearTimeout(timer);
        resolve(Number(line));
      }
    });
    leader.once("error", reject);
  });
  assert.equal(pidAlive(pgid), true);
  assert.equal(pidAlive(childPid), true);
  assert.equal(processGroupAlive(pgid), true);

  await terminateGroup(pgid, 200);
  await waitUntil(() => !processGroupAlive(pgid));
  assert.equal(processGroupAlive(pgid), false);
  assert.equal(pidAlive(childPid), false);
});
