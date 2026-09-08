import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { resolveOwnerIdentity } from "./owner.js";
import { inspectRegistry, type RegistryObservation, type RegistryPaths } from "./diagnostics/registry.js";
import { inspectScan, type ScanObservation } from "./diagnostics/scan.js";
import { buildServiceSnapshot } from "./services.js";
import { resolveProjectDir } from "./scan.js";

export type DoctorStatus = "pass" | "warn" | "error" | "skipped";
export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  summary: string;
  details: string[];
  nextSteps: string[];
}
export interface DoctorReport {
  schemaVersion: 1;
  version: string;
  project: string | null;
  status: "pass" | "warn" | "error";
  complete: boolean;
  owner: { source: "explicit" | "codex" | "none"; available: boolean };
  checks: DoctorCheck[];
}
export type Liveness = "alive" | "gone" | "unknown";
export function observeLiveness(pid: number): Liveness {
  try { process.kill(pid, 0); return "alive"; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
}

const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 500);
const bounded = (values: string[]) => values.length > 20
  ? [...values.slice(0, 19).map(clean), (values.length - 19) + " additional observations omitted."]
  : values.map(clean);
const canonical = (value: string) => {
  try { return realpathSync(value); } catch { return path.resolve(value); }
};
const inProject = (value: string | null, project: string) => {
  if (!value) return false;
  const relative = path.relative(project, canonical(value));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
};

/** The package currently uses one >= minimum. Unknown future range syntax must not silently pass. */
export function meetsNodeMinimum(version: string, range: string): boolean | null {
  const required = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range);
  const actual = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!required || !actual) return null;
  for (let i = 1; i <= 3; i++) {
    const delta = Number(actual[i]) - Number(required[i] ?? 0);
    if (delta) return delta > 0;
  }
  return true;
}

export interface DoctorOptions {
  project?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  cliPath?: string;
  state?: RegistryPaths;
  scan?: () => Promise<ScanObservation>;
  readState?: () => Promise<RegistryObservation>;
  liveness?: (pid: number) => Liveness;
  now?: number;
}

export async function collectDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const identity = resolveOwnerIdentity(options.env ?? process.env);
  const report: DoctorReport = {
    schemaVersion: 1, version: "unknown", project: null, status: "pass", complete: true,
    owner: { source: identity?.source ?? "none", available: identity !== null }, checks: [],
  };
  const add = (id: string, status: DoctorStatus, summary: string, details: string[] = [], nextSteps: string[] = []) => {
    report.checks.push({ id, status, summary: clean(summary), details: bounded(details), nextSteps: bounded(nextSteps) });
    if (status === "error" || (status === "warn" && report.status === "pass")) report.status = status;
  };
  const platform = options.platform ?? process.platform;
  const supported = platform === "darwin" || platform === "linux";
  add("runtime.platform", supported ? "pass" : "error", supported ? "Supported platform: " + platform : "Unsupported platform.");
  let engine = "";
  let installed = false;
  let installation: string[] = [];
  try {
    const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string; engines: { node: string };
    };
    if (typeof pkg.version !== "string" || typeof pkg.engines.node !== "string") throw new Error("metadata");
    report.version = pkg.version;
    engine = pkg.engines.node;
    const cli = await fs.realpath(options.cliPath ?? process.argv[1]);
    installation = ["PortMarshal " + report.version, "CLI: " + cli, "Node: " + process.execPath];
    installed = true;
  } catch { report.complete = false; }
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeOK = meetsNodeMinimum(nodeVersion, engine);
  add("runtime.node", nodeOK === true ? "pass" : "error",
    nodeOK === null ? "Cannot verify the package's Node requirement." :
      "Node " + nodeVersion + (nodeOK ? " satisfies " : " does not satisfy ") + engine + ".");
  add("runtime.installation", installed ? "pass" : "error",
    installed ? "Inspected the running installation; no update lookup performed." : "Could not inspect the running installation.",
    installation);
  if (!supported || nodeOK !== true) report.complete = false;
  try {
    const project = await fs.realpath(options.project ?? process.cwd());
    if (!(await fs.stat(project)).isDirectory()) throw new Error("not directory");
    await fs.access(project, fs.constants.R_OK | fs.constants.X_OK);
    report.project = project;
    add("project.directory", "pass", "Project directory is accessible.", [project]);
  } catch {
    report.complete = false;
    add("project.directory", "error", "Project directory is invalid or inaccessible.", [], ["Select an existing accessible directory with --project."]);
  }

  // Invalid project input is rejected before registry or process observation.
  const canObserve = supported && report.project !== null;
  const observations = canObserve ? await Promise.allSettled([
    (options.scan ?? (() => inspectScan({ platform })))(),
    (options.readState ?? (() => inspectRegistry(options.state)))(),
  ]) : null;
  const scan = observations?.[0].status === "fulfilled" ? observations[0].value as ScanObservation : null;
  const state = observations?.[1].status === "fulfilled" ? observations[1].value as RegistryObservation : null;
  if (!scan) {
    report.complete = false;
    add("scanner.listeners", canObserve ? "error" : "skipped", canObserve ? "Scanner could not complete." : "Scanner prerequisites are unavailable.");
    add("scanner.attribution", "skipped", "No process evidence available.");
    add("scanner.managed-metadata", "skipped", "Managed runtime clients are not invoked.");
  } else {
    const ok = scan.listenerCoverage && (scan.listeners === "success" || scan.listeners === "no-match");
    add("scanner.listeners", ok ? "pass" : "error",
      ok ? "Observed " + scan.ports.length + " listening TCP ports." : "Listener scan: " + scan.listeners + ".",
      [], ok ? [] : ["Check access to lsof/ps on macOS or ss/ps and /proc on Linux; rerun doctor in the intended environment."]);
    add("scanner.attribution", scan.attributionComplete ? "pass" : "warn",
      scan.attributionComplete ? "Observed listener project and ancestry evidence." : "Some ownership evidence is unavailable.",
      scan.issues);
    add("scanner.managed-metadata", "skipped", "Docker and PM2 clients are not invoked.",
      scan.managedSkipped ? ["Managed listeners were observed; container/application ownership is not verified."] : []);
    if (!ok || !scan.attributionComplete || scan.managedSkipped || scan.timedOut) report.complete = false;
  }
  if (!state) {
    report.complete = false;
    add("state.registry", canObserve ? "error" : "skipped", canObserve ? "Registry inspection failed." : "State inspection prerequisites are unavailable.");
    for (const id of ["state.permissions", "state.legacy", "state.concurrent-change"]) add(id, "skipped", "State evidence is unavailable.");
  } else {
    const readable = state.status === "valid" || state.status === "absent";
    add("state.registry", readable ? "pass" : state.status === "changing" ? "warn" : "error",
      "Registry: " + state.status + ".",
      [], readable ? [] : ["Review the state file locally; doctor has left it unchanged."]);
    add("state.permissions", state.permissions.length ? "warn" : state.status === "absent" ? "skipped" : "pass",
      state.permissions.length ? "State permissions need review." : "No permission mismatch observed.", state.permissions);
    add("state.legacy", state.legacy === "absent" ? "pass" : "warn",
      state.legacy === "present" ? "Legacy registry exists; migration is pending." :
        state.legacy === "unknown" ? "Legacy registry presence could not be checked." : "No pending legacy migration observed.");
    const changing = state.status === "changing" || state.lock !== "absent";
    add("state.concurrent-change", changing ? "warn" : "pass",
      changing ? "Registry or lock observation is provisional." : "No concurrent state change observed.",
      [], changing ? ["Retry after the active operation finishes; do not remove its lock."] : []);
    if (!readable || changing || state.legacy !== "absent") report.complete = false;
  }
  add("owner.identity", identity ? "pass" : "warn",
    identity ? "Owner identity source: " + identity.source + "." : "No session identity; new claims use project-level fallback.",
    identity ? ["Identity presence does not prove uniqueness or ownership of every listener."] : [],
    identity ? [] : ["Use the host integration guide to preserve one stable PORTMARSHAL_OWNER when needed."]);

  const servicesReady = scan && state && report.project && scan.listenerCoverage && scan.attributionComplete &&
    !scan.timedOut && state.lock === "absent" && state.legacy === "absent" &&
    (state.status === "valid" || state.status === "absent");
  if (!servicesReady) {
    report.complete = false;
    add("services.review", "skipped", "Service conclusions require complete listener, attribution and state evidence.");
    add("services.conflict", "skipped", "Conflicts cannot be ruled out from incomplete evidence.");
    return report;
  }
  const project = report.project!;
  const livePorts = new Set(scan.ports);
  const managedPorts = new Set(scan.processes.filter((p) => p.source === "docker" || p.source === "pm2").flatMap((p) => p.ports));
  const unknownRuns = new Set<number>();
  const deadPorts = new Set<number>();
  const lives = new Map<number, Liveness>();
  for (const entry of state.entries) {
    if (entry.released || entry.runPid === undefined || livePorts.has(entry.port) || !inProject(entry.project, project)) continue;
    const alive = (options.liveness ?? observeLiveness)(entry.runPid);
    lives.set(entry.runPid, alive);
    if (alive === "unknown") unknownRuns.add(entry.runPid);
    if (alive === "gone") deadPorts.add(entry.port);
  }
  // Never associate a managed backend's cwd with container/application claims.
  const processes = scan.processes.filter((p) => p.source !== "docker" && p.source !== "pm2");
  const entries = state.entries.filter((entry) => !managedPorts.has(entry.port) &&
    !deadPorts.has(entry.port) && !(entry.runPid !== undefined && unknownRuns.has(entry.runPid)));
  // Preserve occupied ports not represented in the selected process set. Suppress absent-claim inference
  // when managed listeners could change a project's grouping; current claims remain analyzable.
  const analyzable = scan.managedSkipped ? entries.filter((entry) => livePorts.has(entry.port)) : entries;
  const snapshot = buildServiceSnapshot(processes, analyzable, options.now ?? Date.now(), {
    pidAlive: (pid) => (lives.get(pid) ?? "alive") !== "gone",
  });
  const relevant = snapshot.services.filter((service) => inProject(service.project, project) ||
    service.claims.some((claim) => inProject(claim.entry.project, project)));
  const conflicts: string[] = [];
  const reviews: string[] = [];
  for (const port of deadPorts) reviews.push("Port " + port + ": managed-run-dead (recorded process is gone and port is unlistened).");
  for (const service of relevant) {
    const target = "Ports " + service.ports.join(", ") + "; listener PIDs " + (service.listenerPids.join(", ") || "none");
    if (service.confidence === "conflict") conflicts.push(target + ": contradictory ownership evidence.");
    const warnings = service.warnings.filter((warning) => warning !== "claim-conflict" &&
      warning !== "shared-port-conflict" && !warning.startsWith("shared-port:"));
    if (warnings.length) reviews.push(target + ": " + warnings.join(", ") + ".");
  }
  if (unknownRuns.size) {
    reviews.push("Some managed-run liveness is unknown; no dead-run conclusion was made.");
    report.complete = false;
  }
  if (scan.managedSkipped) reviews.push("Managed runtime metadata is unavailable; affected claims and absent-claim inference were skipped.");
  add("services.review", reviews.length ? "warn" : "pass",
    reviews.length ? "Service observations need review." : "No review warning in the observed project services.",
    reviews, reviews.length ? ["Use whois <port> --json for attribution details and gc --dry-run for a cleanup preview."] : []);
  add("services.conflict", conflicts.length ? "error" : "pass",
    conflicts.length ? "Contradictory service ownership was observed." :
      scan.managedSkipped ? "No conflict in the analyzable unmanaged services; managed services remain unverified." : "No contradictory service ownership observed.",
    conflicts, conflicts.length ? ["Inspect whois <port> --json; preserve the existing listener until ownership is resolved."] : []);
  return report;
}

export function formatDoctor(report: DoctorReport): string {
  const lines = ["PortMarshal " + report.version + " doctor: " + report.status +
    (report.complete ? "" : " (incomplete)"), "Project: " + clean(report.project ?? "unavailable")];
  for (const check of report.checks) {
    lines.push("[" + check.status + "] " + check.id + ": " + check.summary);
    for (const detail of check.details) lines.push("  " + detail);
    for (const next of check.nextSteps) lines.push("  Next: " + next);
  }
  return lines.join("\n") + "\n";
}
