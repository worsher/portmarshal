import path from "node:path";
import type { Flags } from "../cli.js";
import { EXIT, type MergedEntry } from "../types.js";
import { scanListeners, isNoise, resolveProjectDir, displaySource } from "../scan.js";
import { mergeScanRegistry } from "../merge.js";
import { Registry } from "../registry.js";
import { formatTable, C } from "../render.js";

const STATE_LABEL: Record<string, string> = {
  active: `${C.green}●${C.reset} active`,
  reserved: `${C.dim}◐ reserved${C.reset}`,
  unregistered: "○ unregistered",
  drift: `${C.yellow}⚠ drift${C.reset}`,
};

export default async function list(flags: Flags): Promise<number> {
  const [scan, registry] = await Promise.all([
    scanListeners(),
    new Registry().load(),
  ]);
  const filtered = flags.all ? scan : scan.filter((p) => !isNoise(p.procName));
  let merged = mergeScanRegistry(filtered, registry);
  if (flags.project) {
    const dir = path.resolve(flags.project);
    merged = merged.filter((e) => {
      const proj = e.proc ? resolveProjectDir(e.proc) : e.reg?.project;
      return proj === dir || proj?.startsWith(dir + "/");
    });
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(merged, null, 2) + "\n");
    return EXIT.OK;
  }
  const rows = merged.map((e: MergedEntry) => [
    String(e.port),
    STATE_LABEL[e.state],
    e.proc ? String(e.proc.pid) : "-",
    e.proc
      ? (e.proc.source === "detached" ? `${C.yellow}${displaySource(e.proc)}${C.reset}` : displaySource(e.proc))
      : "-",
    e.reg?.name ?? "-",
    (e.proc ? resolveProjectDir(e.proc) : e.reg?.project) ?? "?",
    e.state === "drift" ? `↔ ${e.driftPeer}` : "",
  ]);
  process.stdout.write(
    formatTable(["PORT", "STATE", "PID", "SOURCE", "CLAIM", "PROJECT", ""], rows) + "\n",
  );
  return EXIT.OK;
}
