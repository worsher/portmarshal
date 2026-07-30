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

/** 轮询式 tail -f：size 回退（轮转/截断）时从头重读新文件 */
async function follow(file: string, fromPos: number): Promise<never> {
  let pos = fromPos;
  for (;;) {
    const st = await fs.stat(file).catch(() => null);
    if (st) {
      if (st.size < pos) pos = 0;
      if (st.size > pos) {
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(file, { start: pos, end: st.size - 1 });
          stream.on("data", (chunk) => process.stdout.write(chunk));
          stream.on("end", resolve);
          stream.on("error", reject);
        });
        pos = st.size;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
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
    const size = (await fs.stat(entry.logFile).catch(() => null))?.size ?? 0;
    await follow(entry.logFile, size); // 永不返回，Ctrl-C 退出
  }
  return EXIT.OK;
}
