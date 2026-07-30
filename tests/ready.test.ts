import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { waitReady, pidAlive } from "../src/ready.js";

function listen(srv: net.Server | http.Server): Promise<number> {
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)));
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
