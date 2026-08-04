import net from "node:net";
import http from "node:http";

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

/** 进程组长退出后组仍可能存在，因此必须用负 PGID 探测整个组，而不是只探测正 PID。 */
export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM 表示组存在但当前进程无权发信号；只有 ESRCH 才能确认整个组已消失。
    return !isMissingProcess(error);
  }
}

/**
 * SIGTERM → 宽限 ≤2s 轮询 → SIGKILL，作用于整个进程组（负 pgid）；组已不存在时静默。
 * run.ts 的就绪失败清理、stop.ts 的托管目标停止共用同一份实现，避免行为分叉。
 */
export async function terminateGroup(pgid: number, graceMs = 2000): Promise<void> {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch (error) {
    if (isMissingProcess(error)) return;
    throw error;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pgid)) return;
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  if (!processGroupAlive(pgid)) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function tcpOnce(port: number, host: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      sock.destroy();
      resolve(value);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    sock.setTimeout(1000, () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect({ port, host }, () => finish(true));
  });
}

function httpOnce(port: number, pathName: string, host: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const req = http.get({ host, port, path: pathName, timeout: 2000 }, (res) => {
      res.resume();
      finish(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400);
    });
    const onAbort = () => {
      req.destroy();
      finish(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    req.once("error", () => finish(false));
    req.once("timeout", () => {
      req.destroy();
      finish(false);
    });
  });
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) return finish();
    timer = setTimeout(finish, ms);
  });
}

export type ReadyResult = { ok: true } | { ok: false; reason: "timeout" | "died" | "aborted" | "foreign" };

export async function waitReady(opts: {
  port: number;
  pid: number;
  readyUrl?: string;
  timeoutMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
  /** endpoint 响应后验证监听者属于本次 run；防止 allocation-to-bind 竞态误报 ready */
  verifyOwner?: () => Promise<boolean>;
}): Promise<ReadyResult> {
  const host = "127.0.0.1";
  const interval = opts.intervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  let tcpOk = false;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
    if (!tcpOk) tcpOk = await tcpOnce(opts.port, host, opts.signal);
    if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
    // 先判就绪再判存活：双 fork 的服务组长会先退出，但监听已就绪就算成功
    if (tcpOk && (!opts.readyUrl || (await httpOnce(opts.port, opts.readyUrl, host, opts.signal)))) {
      if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
      if (opts.verifyOwner && !(await opts.verifyOwner())) return { ok: false, reason: "foreign" };
      return { ok: true };
    }
    if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
    if (!pidAlive(opts.pid)) return { ok: false, reason: "died" };
    await pause(interval, opts.signal);
  }
  if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
  return { ok: false, reason: "timeout" };
}
