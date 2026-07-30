import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function stateDir(): string {
  return process.env.PORTMARSHAL_STATE_DIR ?? path.join(os.homedir(), ".portmarshal");
}

function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export function logFilePath(project: string, name: string): string {
  const hash8 = crypto.createHash("sha256").update(realpathOrSelf(project)).digest("hex").slice(0, 8);
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(stateDir(), "logs", `${hash8}-${safe}.log`);
}

export async function rotateLog(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.rename(file, file + ".old");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export async function tailLines(file: string, n: number): Promise<string[]> {
  const lines = (await fs.readFile(file, "utf8")).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}
