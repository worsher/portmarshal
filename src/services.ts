import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  ProcessInfo,
  RegistryEntry,
  ServiceClaim,
  ServiceConfidence,
  ServiceInfo,
  ServiceSnapshot,
  ServiceStopMode,
} from "./types.js";
import { displaySource, resolveProjectDir } from "./scan.js";
import { pidAlive } from "./ready.js";

function canonical(value: string | null): string | null {
  if (!value) return null;
  try {
    return realpathSync(value);
  } catch {
    return path.normalize(value);
  }
}

function serviceId(parts: Array<string | number | undefined | null>): string {
  const raw = parts.filter((part) => part !== undefined && part !== null).join("\0");
  return `svc_${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
}

function activeEntries(registry: RegistryEntry[]): RegistryEntry[] {
  return registry.filter((entry) => !entry.released);
}

function entriesForProcess(proc: ProcessInfo, registry: RegistryEntry[]): RegistryEntry[] {
  return registry.filter((entry) => proc.ports.includes(entry.port));
}

function managedKey(proc: ProcessInfo, registry: RegistryEntry[]): string | null {
  if (proc.docker) return `docker:${proc.docker.containerId}`;
  if (proc.pm2) return `pm2:${proc.pm2.pmId}`;
  const run = entriesForProcess(proc, registry).find((entry) =>
    entry.runId && entry.runPid !== undefined && proc.pgid === entry.runPid,
  );
  return run ? `run:${run.runId}` : null;
}

interface ProcessGroup {
  key: string;
  managed: boolean;
  project: string | null;
  processes: ProcessInfo[];
}

function initialGroup(proc: ProcessInfo, registry: RegistryEntry[]): ProcessGroup {
  const project = canonical(resolveProjectDir(proc));
  const managed = managedKey(proc, registry);
  const key = managed
    ?? (project && proc.pgid !== undefined ? `pgid:${project}:${proc.pgid}` : `pid:${proc.pid}`);
  return { key, managed: managed !== null, project, processes: [proc] };
}

function sameProjectTree(left: string | null, right: string | null): boolean {
  return Boolean(left && right && (
    left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep)
  ));
}

function relatedProcessGroups(left: ProcessGroup, right: ProcessGroup): boolean {
  if (left.managed || right.managed) return false;
  if (!sameProjectTree(left.project, right.project)) return false;
  const leftPgids = new Set(left.processes.flatMap((proc) => proc.pgid === undefined ? [] : [proc.pgid]));
  const rightPgids = new Set(right.processes.flatMap((proc) => proc.pgid === undefined ? [] : [proc.pgid]));
  if ([...leftPgids].some((pgid) => rightPgids.has(pgid))) return true;
  const ports = new Set(left.processes.flatMap((proc) => proc.ports));
  return right.processes.some((proc) => proc.ports.some((port) => ports.has(port)));
}

function groupProcesses(scan: ProcessInfo[], registry: RegistryEntry[]): ProcessGroup[] {
  const groups = new Map<string, ProcessGroup>();
  for (const proc of scan) {
    const next = initialGroup(proc, registry);
    const existing = groups.get(next.key);
    if (existing) existing.processes.push(proc);
    else groups.set(next.key, next);
  }

  // SO_REUSEPORT/cluster workers may expose one socket through several PGIDs. A shared port plus the same
  // canonical project is stronger evidence than project alone and is safe to aggregate for display.
  const out = [...groups.values()];
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length;) {
      if (!relatedProcessGroups(out[i], out[j])) {
        j++;
        continue;
      }
      out[i].processes.push(...out[j].processes);
      out[i].managed ||= out[j].managed;
      out.splice(j, 1);
    }
  }
  return out;
}

function confidenceFor(project: string | null, claims: ServiceClaim[], verified: boolean): ServiceConfidence {
  if (claims.some((claim) => claim.relation === "conflict")) return "conflict";
  if (verified) return "verified";
  if (project && claims.some((claim) => claim.relation === "current")) return "corroborated";
  if (project) return "inferred";
  return "unknown";
}

function stopModeFor(processes: ProcessInfo[], verifiedRun: boolean, confidence: ServiceConfidence): ServiceStopMode {
  if (confidence === "conflict" || confidence === "unknown") return "blocked";
  if (processes.some((proc) => proc.docker)) return "docker";
  if (processes.some((proc) => proc.pm2)) return "pm2";
  if (verifiedRun) return "managed-run";
  return "listener-only";
}

function serviceFromGroup(group: ProcessGroup, registry: RegistryEntry[]): ServiceInfo {
  const ports = [...new Set(group.processes.flatMap((proc) => proc.ports))].sort((a, b) => a - b);
  const currentEntries = registry.filter((entry) => ports.includes(entry.port));
  const claims: ServiceClaim[] = currentEntries.map((entry) => ({
    relation: group.project && canonical(entry.project) !== group.project ? "conflict" : "current",
    entry,
  }));
  const runEntry = currentEntries.find((entry) =>
    entry.runId && entry.runPid !== undefined && group.processes.some((proc) => proc.pgid === entry.runPid),
  );
  // Docker/PM2 metadata is queried from the owning runtime. A run-d registry/PGID match is only
  // corroborating here; stop.ts re-reads the process marker and verifies runId before group signalling.
  const runtimeVerified = group.processes.some((proc) => proc.docker || proc.pm2);
  const confidence = confidenceFor(group.project, claims, runtimeVerified);
  const everyDetached = group.processes.every((proc) => proc.source === "detached");
  const attachment = runtimeVerified || runEntry ? "managed" : everyDetached ? "detached" : "attached";
  const first = group.processes.find((proc) => proc.source !== "detached") ?? group.processes[0];
  const source = displaySource(first);
  const origins = [...new Set(group.processes.flatMap((proc) => proc.origin ? [proc.origin] : []))];
  const wrapperPids = [...new Set(group.processes.flatMap((proc) => proc.ancestors?.map((item) => item.pid) ?? []))]
    .filter((pid) => !group.processes.some((proc) => proc.pid === pid))
    .sort((a, b) => a - b);
  const warnings: string[] = [];
  if (confidence === "conflict") warnings.push("claim-conflict");
  if (confidence === "unknown") warnings.push("unknown-ownership");
  if (attachment === "detached" && confidence !== "corroborated") warnings.push("detached-unverified");
  const currentClaim = claims.find((claim) => claim.relation === "current");
  const name = currentClaim?.entry.name ?? (group.project ? path.basename(group.project) : first.procName);
  const pgids = [...new Set(group.processes.flatMap((proc) => proc.pgid === undefined ? [] : [proc.pgid]))];

  return {
    id: serviceId([group.key]),
    name,
    activity: "active",
    attachment,
    confidence,
    stopMode: stopModeFor(group.processes, Boolean(runEntry), confidence),
    project: group.project,
    source,
    ...(attachment === "detached" && origins.length === 1 ? { origin: origins[0] } : {}),
    ...(pgids.length === 1 ? { pgid: pgids[0] } : {}),
    ports,
    listenerPids: [...new Set(group.processes.map((proc) => proc.pid))].sort((a, b) => a - b),
    wrapperPids,
    processes: group.processes.sort((a, b) => a.pid - b.pid),
    claims,
    warnings,
  };
}

function reservedService(entry: RegistryEntry): ServiceInfo {
  const project = canonical(entry.project);
  const dead = entry.runPid !== undefined && !pidAlive(entry.runPid);
  return {
    id: serviceId(["reserved", project, entry.name, entry.port]),
    name: entry.name,
    activity: dead ? "dead" : "reserved",
    attachment: "none",
    confidence: entry.ownerKey ? "corroborated" : "inferred",
    stopMode: "blocked",
    project,
    source: "reserved",
    ports: [entry.port],
    listenerPids: [],
    wrapperPids: [],
    processes: [],
    claims: [{ relation: "reserved", entry }],
    warnings: dead ? ["managed-run-dead"] : [],
  };
}

export function buildServiceSnapshot(scan: ProcessInfo[], registry: RegistryEntry[]): ServiceSnapshot {
  const registryEntries = activeEntries(registry);
  const services = groupProcesses(scan, registryEntries).map((group) => serviceFromGroup(group, registryEntries));
  const assigned = new Set(services.flatMap((service) => service.claims.map((claim) => claim.entry)));

  for (const entry of registryEntries) {
    if (assigned.has(entry)) continue;
    const project = canonical(entry.project);
    const peers = services.filter((service) => service.activity === "active" && service.project === project);
    if (peers.length === 1) {
      const peer = peers[0];
      const hasCurrentClaim = peer.claims.some((claim) => claim.relation === "current");
      peer.claims.push({ relation: hasCurrentClaim ? "related" : "drift", entry });
      if (!hasCurrentClaim) {
        peer.name = entry.name;
        peer.warnings.push("port-drift");
      }
    } else {
      services.push(reservedService(entry));
    }
  }

  for (const service of services) {
    const identityClaim = service.claims.find((claim) =>
      claim.relation === "current" || claim.relation === "drift",
    );
    if (identityClaim && service.project) {
      service.id = serviceId(["claim", service.project, identityClaim.entry.name]);
    }
  }

  const servicesByPort = new Map<number, ServiceInfo[]>();
  for (const service of services.filter((candidate) => candidate.activity === "active")) {
    for (const port of service.ports) {
      const owners = servicesByPort.get(port) ?? [];
      owners.push(service);
      servicesByPort.set(port, owners);
    }
  }
  for (const [port, owners] of servicesByPort) {
    if (owners.length < 2) continue;
    for (const owner of owners) {
      owner.confidence = "conflict";
      owner.stopMode = "blocked";
      if (!owner.warnings.includes("shared-port-conflict")) owner.warnings.push("shared-port-conflict");
      if (!owner.warnings.includes(`shared-port:${port}`)) owner.warnings.push(`shared-port:${port}`);
    }
  }

  return {
    schemaVersion: 1,
    services: services.sort((a, b) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0)),
  };
}

export function findServiceByPort(snapshot: ServiceSnapshot, port: number): ServiceInfo | null {
  return findServicesByPort(snapshot, port)[0] ?? null;
}

export function findServicesByPort(snapshot: ServiceSnapshot, port: number): ServiceInfo[] {
  return snapshot.services.filter((service) => service.ports.includes(port));
}
