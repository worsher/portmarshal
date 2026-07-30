import net from "node:net";
import http from "node:http";

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * SIGTERM → 宽限 ≤2s 轮询 → SIGKILL，作用于整个进程组（负 pgid）；组已不存在时静默。
 * run.ts 的就绪失败清理、stop.ts 的托管目标停止共用同一份实现，避免行为分叉。
 */
export async function terminateGroup(pgid: number): Promise<void> {
  try { process.kill(-pgid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 20; i++) {
    if (!pidAlive(pgid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(-pgid, "SIGKILL"); } catch { /* 组已不存在 */ }
}

function tcpOnce(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host }, () => { sock.destroy(); resolve(true); });
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
    sock.on("error", () => { sock.destroy(); resolve(false); });
  });
}

function httpOnce(port: number, pathName: string, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: pathName, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

export type ReadyResult = { ok: true } | { ok: false; reason: "timeout" | "died" };

export async function waitReady(opts: {
  port: number;
  pid: number;
  readyUrl?: string;
  timeoutMs: number;
  intervalMs?: number;
}): Promise<ReadyResult> {
  const host = "127.0.0.1";
  const interval = opts.intervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  let tcpOk = false;
  while (Date.now() < deadline) {
    if (!tcpOk) tcpOk = await tcpOnce(opts.port, host);
    // 先判就绪再判存活：双 fork 的服务组长会先退出，但监听已就绪就算成功
    if (tcpOk && (!opts.readyUrl || (await httpOnce(opts.port, opts.readyUrl, host)))) return { ok: true };
    if (!pidAlive(opts.pid)) return { ok: false, reason: "died" };
    await new Promise((r) => setTimeout(r, interval));
  }
  return { ok: false, reason: "timeout" };
}
