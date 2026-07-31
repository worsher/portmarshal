import { realpathSync, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Flags } from "../cli.js";
import { EXIT, type RegistryEntry } from "../types.js";
import { Registry } from "../registry.js";
import { tailLines } from "../runlog.js";

const USAGE = "Usage: portmarshal logs <name|port> [--project DIR] [-f] [-n N] [--json]\n";

function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export function locateEntry(
  entries: RegistryEntry[], target: string, project: string,
): RegistryEntry | undefined {
  if (/^\d+$/.test(target)) {
    const port = Number(target);
    return (
      entries.find((e) => !e.released && e.port === port && e.logFile) ??
      entries.find((e) => (e.port === port || e.lastPort === port) && e.logFile)
    );
  }
  const proj = realpathOrSelf(project);
  return entries.find(
    (e) => e.name === target && realpathOrSelf(e.project) === proj && e.logFile,
  );
}

export interface FollowCursor {
  position: number;
  dev: number;
  ino: number;
}

export interface FollowOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  write?: (chunk: Buffer) => void;
}

/** 轮询式 tail -f：inode 变化（轮转）或 size 回退（截断）时从头重读新文件 */
export async function followLog(
  file: string,
  cursor: FollowCursor,
  options: FollowOptions = {},
): Promise<void> {
  let pos = cursor.position;
  let dev = cursor.dev;
  let ino = cursor.ino;
  const interval = options.intervalMs ?? 200;
  const write = options.write ?? ((chunk: Buffer) => { process.stdout.write(chunk); });

  while (!options.signal?.aborted) {
    const st = await fs.stat(file).catch(() => null);
    if (st) {
      if (st.dev !== dev || st.ino !== ino || st.size < pos) {
        pos = 0;
        dev = st.dev;
        ino = st.ino;
      }
      if (st.size > pos) {
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(file, { start: pos, end: st.size - 1 });
          stream.on("data", (chunk) => write(Buffer.from(chunk)));
          stream.on("end", resolve);
          stream.on("error", reject);
        });
        pos = st.size;
      }
    }
    if (!options.signal?.aborted) {
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

export default async function logs(flags: Flags): Promise<number> {
  const target = flags.positional[0];
  if (!target) {
    process.stderr.write(USAGE);
    return EXIT.ERR;
  }
  if (flags.json && flags.follow) {
    process.stderr.write("--json cannot be combined with -f/--follow\n");
    return EXIT.ERR;
  }
  const project = path.resolve(flags.project ?? process.cwd());
  const entries = await new Registry().load();
  const entry = locateEntry(entries, target, project);
  if (!entry?.logFile) {
    process.stderr.write(`No run logs found for ${target} (services started with portmarshal run -d keep logs)\n`);
    return EXIT.NOT_FOUND;
  }
  const n = flags.lines ?? 50;
  let lines: string[];
  try {
    lines = await tailLines(entry.logFile, n);
  } catch {
    process.stderr.write(`Log file is gone: ${entry.logFile}\n`);
    return EXIT.NOT_FOUND;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      name: entry.name, project: entry.project, port: entry.port, logFile: entry.logFile, lines,
    }, null, 2) + "\n");
    return EXIT.OK;
  }
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
  if (flags.follow) {
    const st = await fs.stat(entry.logFile).catch(() => null);
    if (!st) {
      process.stderr.write(`Log file is gone: ${entry.logFile}\n`);
      return EXIT.NOT_FOUND;
    }
    await followLog(entry.logFile, {
      position: st.size,
      dev: st.dev,
      ino: st.ino,
    }); // CLI 下持续运行，Ctrl-C 由默认信号行为退出
  }
  return EXIT.OK;
}
