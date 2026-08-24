import path from "node:path";
import type { Flags } from "../cli.js";
import { EXIT, type MergedEntry, type ServiceInfo } from "../types.js";
import { scanListeners, isNoise, resolveProjectDir, displaySource } from "../scan.js";
import { mergeScanRegistry, isDeadRun } from "../merge.js";
import { Registry } from "../registry.js";
import { formatTable, C } from "../render.js";
import { buildServiceSnapshot } from "../services.js";

const STATE_LABEL: Record<string, string> = {
  active: `${C.green}●${C.reset} active`,
  reserved: `${C.dim}◐ reserved${C.reset}`,
  unregistered: "○ unregistered",
  drift: `${C.yellow}⚠ drift${C.reset}`,
};

const SERVICE_ACTIVITY: Record<ServiceInfo["activity"], string> = {
  active: `${C.green}●${C.reset} active`,
  reserved: `${C.dim}◐ reserved${C.reset}`,
  dead: `${C.red}● dead${C.reset}`,
};

export function formatServiceList(services: ServiceInfo[]): string {
  const rows = services.map((service) => [
    service.name,
    SERVICE_ACTIVITY[service.activity],
    service.ports.join(","),
    service.listenerPids.length ? service.listenerPids.join(",") : "-",
    service.wrapperPids.length ? service.wrapperPids.join(",") : "-",
    service.origin ?? service.source,
    service.claims.map((claim) => `${claim.entry.name}@${claim.entry.port}:${claim.relation}`).join(",") || "-",
    service.project ?? "?",
    [...service.warnings, service.confidence].join(","),
  ]);
  return formatTable(
    ["SERVICE", "ACTIVITY", "PORTS", "LISTENER PIDS", "WRAPPERS", "SOURCE", "CLAIMS", "PROJECT", ""],
    rows,
  );
}

export default async function list(flags: Flags): Promise<number> {
  const [scan, registry] = await Promise.all([
    scanListeners(undefined, undefined, !flags.showSensitiveCommand),
    new Registry().load(),
  ]);
  const filtered = flags.all ? scan : scan.filter((p) => !isNoise(p.procName));
  if (flags.services) {
    const snapshot = buildServiceSnapshot(filtered, registry);
    if (flags.project) {
      const dir = path.resolve(flags.project);
      snapshot.services = snapshot.services.filter((service) =>
        service.project === dir || service.project?.startsWith(dir + "/"),
      );
    }
    if (flags.json) {
      process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
      return EXIT.OK;
    }
    process.stdout.write(formatServiceList(snapshot.services) + "\n");
    return EXIT.OK;
  }
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
    e.state === "drift" ? `↔ ${e.driftPeer}` : isDeadRun(e) ? `${C.red}dead${C.reset}` : "",
  ]);
  process.stdout.write(
    formatTable(["PORT", "STATE", "PID", "SOURCE", "CLAIM", "PROJECT", ""], rows) + "\n",
  );
  return EXIT.OK;
}
