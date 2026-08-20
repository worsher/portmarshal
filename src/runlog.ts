import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_RETAINED_LOG_BYTES = 10 * 1024 * 1024;
export const MAX_TAIL_READ_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = Buffer.from("[portmarshal: earlier log content truncated]\n");

function stateDir(): string {
  return process.env.PORTMARSHAL_STATE_DIR ?? path.join(os.homedir(), ".portmarshal");
}

function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export function logFilePath(project: string, name: string): string {
  const hash8 = crypto.createHash("sha256").update(realpathOrSelf(project)).digest("hex").slice(0, 8);
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  // 非安全字符替换可能把不同名称折叠到同一路径（a/b 与 a_b）；发生清洗或截断时补原名哈希。
  const shortened = (safe || "service").slice(0, 64);
  const needsHash = safe !== name || safe.length > 64 || safe.length === 0;
  const stem = needsHash
    ? `${shortened}-${crypto.createHash("sha256").update(name).digest("hex").slice(0, 8)}`
    : shortened;
  return path.join(stateDir(), "logs", `${hash8}-${stem}.log`);
}

async function retainFileTail(file: string, maxBytes: number): Promise<void> {
  const stat = await fs.stat(file);
  if (stat.size <= maxBytes) return;
  const payloadBytes = Math.max(0, maxBytes - TRUNCATION_MARKER.length);
  const handle = await fs.open(file, "r");
  let tail: Buffer;
  try {
    tail = Buffer.alloc(payloadBytes);
    const { bytesRead } = await handle.read(tail, 0, payloadBytes, stat.size - payloadBytes);
    tail = tail.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  // 避免从 UTF-8 continuation byte 起始；截断后的首行本来就不完整，用 marker 明示。
  let start = 0;
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  const tmp = `${file}.${process.pid}.trim.tmp`;
  try {
    await fs.writeFile(tmp, Buffer.concat([TRUNCATION_MARKER, tail.subarray(start)]), { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export async function rotateLog(file: string, maxBytes = MAX_RETAINED_LOG_BYTES): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  try {
    await fs.rename(file, file + ".old");
    await retainFileTail(file + ".old", maxBytes);
    await fs.chmod(file + ".old", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export async function tailLines(file: string, n: number, maxReadBytes = MAX_TAIL_READ_BYTES): Promise<string[]> {
  const handle = await fs.open(file, "r");
  let position: number;
  const chunks: Buffer[] = [];
  let newlines = 0;
  try {
    position = (await handle.stat()).size;
    let remaining = Math.min(position, maxReadBytes);
    while (position > 0 && remaining > 0 && newlines <= n) {
      const size = Math.min(64 * 1024, position, remaining);
      position -= size;
      remaining -= size;
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      const data = chunk.subarray(0, bytesRead);
      for (const byte of data) if (byte === 0x0a) newlines++;
      chunks.unshift(data);
    }
  } finally {
    await handle.close();
  }
  const combined = Buffer.concat(chunks);
  let start = 0;
  while (start < combined.length && (combined[start] & 0xc0) === 0x80) start++;
  const lines = combined.subarray(start).toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const result = lines.slice(-n);
  if (position > 0 && newlines <= n && result.length > 0) result[0] = `…${result[0]}`;
  return result;
}
