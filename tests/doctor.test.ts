import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectDoctor, formatDoctor, meetsNodeMinimum, observeLiveness, type DoctorOptions } from "../src/doctor.js";
import { validateDoctorArgs } from "../src/flags.js";
import type { ProcessInfo, RegistryEntry } from "../src/types.js";
import type { ScanObservation } from "../src/diagnostics/scan.js";
import type { RegistryObservation } from "../src/diagnostics/registry.js";

const NOW = Date.parse("2026-09-08T12:00:00Z");
function scan(processes: ProcessInfo[] = [], over: Partial<ScanObservation> = {}): ScanObservation {
  return { processes, ports: processes.flatMap((p) => p.ports), listeners: "success",
    listenerCoverage: true, attributionComplete: true, managedSkipped: false, timedOut: false, issues: [], ...over };
}
function state(entries: RegistryEntry[] = [], over: Partial<RegistryObservation> = {}): RegistryObservation {
  return { status: "valid", entries, permissions: [], lock: "absent", legacy: "absent", ...over };
}
function proc(project: string, pid = 101, port = 3000, over: Partial<ProcessInfo> = {}): ProcessInfo {
  return { pid, ppid: 1, pgid: pid, ports: [port], procName: "node", command: "node --token command-sentinel",
    source: "terminal", cwd: project, inferredProject: null, ...over };
}
function claim(project: string, port = 3000, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return { project, port, name: "name-sentinel", claimedAt: new Date(NOW - 60_000).toISOString(),
    ownerKey: "owner-fingerprint-sentinel", runId: "run-sentinel", ...over };
}
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-doctor-report-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = await fs.realpath(dir);
  const options: DoctorOptions = { project, platform: "darwin", now: NOW,
    env: { PORTMARSHAL_OWNER: "identity-sentinel" }, cliPath: path.resolve("src/cli.ts"),
    scan: async () => scan(), readState: async () => state() };
  return { project, options };
}
const finding = (report: Awaited<ReturnType<typeof collectDoctor>>, id: string) => report.checks.find((c) => c.id === id)!;

test("doctor: first use and another healthy session are not errors", async (t) => {
  const { project, options } = await setup(t);
  for (const registry of [state([], { status: "absent" }), state([claim(project)])]) {
    const report = await collectDoctor({ ...options, scan: async () => scan([proc(project, 101, 3000, { source: "detached" })]),
      readState: async () => registry });
    assert.equal(report.status, registry.entries.length ? "pass" : "warn");
    assert.equal(report.complete, true);
    assert.equal(finding(report, "services.conflict").status, "pass");
    if (registry.entries.length) assert.equal(finding(report, "services.review").status, "pass");
  }
});

test("doctor: missing owner warns without asserting session protection", async (t) => {
  const { options } = await setup(t);
  const report = await collectDoctor({ ...options, env: {} });
  assert.equal(report.status, "warn");
  assert.equal(report.complete, true);
  assert.deepEqual(report.owner, { source: "none", available: false });
  const explicit = await collectDoctor({ ...options, env: { PORTMARSHAL_OWNER: "a", CODEX_THREAD_ID: "b" } });
  assert.deepEqual(explicit.owner, { source: "explicit", available: true });
});

test("doctor: stale claims do not rename healthy listeners and exact boundary is retained", async (t) => {
  const { project, options } = await setup(t);
  for (const age of [30 * 60_000, 30 * 60_000 + 1]) {
    const report = await collectDoctor({ ...options, scan: async () => scan([proc(project)]),
      readState: async () => state([claim(project, 4173, { claimedAt: new Date(NOW - age).toISOString() })]) });
    const review = finding(report, "services.review");
    assert.equal(review.details.some((detail) => detail.includes("stale-claim")), age > 30 * 60_000);
    if (age > 30 * 60_000) assert.ok(review.details.every((detail) => !detail.includes("Ports 3000")));
  }
});

test("doctor: foreign listener on project claim is a conflict, not a stale claim", async (t) => {
  const { project, options } = await setup(t);
  const report = await collectDoctor({ ...options, scan: async () => scan([proc("/foreign")]),
    readState: async () => state([claim(project, 3000, { claimedAt: "2000-01-01T00:00:00Z" })]) });
  assert.equal(report.status, "error");
  assert.equal(finding(report, "services.conflict").status, "error");
  assert.equal(finding(report, "services.review").details.some((s) => s.includes("stale")), false);
});

test("doctor: incomplete scans, invalid state, legacy state and locks suppress negative conclusions", async (t) => {
  const { project, options } = await setup(t);
  const registry = state([claim(project, 3000, { claimedAt: "2000-01-01T00:00:00Z", runPid: 999999 })]);
  for (const overrides of [
    { scan: async () => scan([], { listeners: "denied", listenerCoverage: false }) },
    { scan: async () => scan([], { attributionComplete: false, ports: [3000] }) },
    { readState: async () => state([], { status: "invalid" }) },
    { readState: async () => state([], { status: "absent", legacy: "present" }) },
    { readState: async () => state(registry.entries, { lock: "present" }) },
  ]) {
    const report = await collectDoctor({ ...options, readState: async () => registry, ...overrides });
    assert.equal(report.complete, false);
    assert.equal(finding(report, "services.review").status, "skipped");
    assert.equal(finding(report, "services.conflict").status, "skipped");
    assert.equal(JSON.stringify(report).includes("stale-claim"), false);
    assert.equal(JSON.stringify(report).includes("managed-run-dead"), false);
    assert.notEqual(report.status, "pass");
  }
});

test("doctor: managed runtime cwd never becomes a foreign ownership conclusion", async (t) => {
  const { project, options } = await setup(t);
  const report = await collectDoctor({ ...options,
    scan: async () => scan([proc("/Applications/Docker.app", 101, 3000, { source: "docker" })], { managedSkipped: true }),
    readState: async () => state([claim(project)]) });
  assert.equal(report.status, "warn");
  assert.equal(report.complete, false);
  assert.equal(finding(report, "services.conflict").status, "pass");
  assert.equal(finding(report, "services.review").details.some((s) => s.includes("stale-claim")), false);
});

test("doctor: unknown liveness cannot become a dead run", async (t) => {
  const { project, options } = await setup(t);
  for (const liveness of ["unknown", "gone", "alive"] as const) {
    const report = await collectDoctor({ ...options, liveness: () => liveness,
      readState: async () => state([claim(project, 3000, { runPid: 101, claimedAt: "2000-01-01T00:00:00Z" })]) });
    assert.equal(JSON.stringify(report).includes("managed-run-dead"), liveness === "gone");
    assert.equal(report.complete, liveness !== "unknown");
  }
  assert.equal(observeLiveness(process.pid), "alive");
});

test("doctor: a fresh dead managed run cannot drift onto a healthy same-project listener", async (t) => {
  const { project, options } = await setup(t);
  const report = await collectDoctor({ ...options, liveness: () => "gone",
    scan: async () => scan([proc(project)]),
    readState: async () => state([claim(project, 4173, { runPid: 202 })]) });
  assert.ok(finding(report, "services.review").details.some((s) => s.includes("managed-run-dead")));
  assert.equal(JSON.stringify(report).includes("port-drift"), false);
  assert.equal(finding(report, "services.conflict").status, "pass");
});

test("doctor: JSON and text omit commands, names, environment and registry identifiers", async (t) => {
  const { project, options } = await setup(t);
  const report = await collectDoctor({ ...options, scan: async () => scan([proc("/foreign")]),
    readState: async () => state([claim(project, 3000, { logFile: "/secret-log-sentinel" })]) });
  for (const output of [JSON.stringify(report), formatDoctor(report)]) {
    assert.equal(output.includes("sentinel"), false);
    assert.ok(output.includes("3000"));
  }
  const failed = await collectDoctor({ ...options, scan: async () => { throw new Error("exception-sentinel"); } });
  assert.equal(JSON.stringify(failed).includes("sentinel"), false);
  assert.equal(failed.status, "error");
});

test("doctor: invalid project and unsupported platform skip probes", async (t) => {
  const { project, options } = await setup(t);
  let calls = 0;
  for (const change of [{ project: project + "/missing" }, { platform: "win32" as const }]) {
    const report = await collectDoctor({ ...options, ...change,
      scan: async () => { calls++; return scan(); }, readState: async () => { calls++; return state(); } });
    assert.equal(report.status, "error");
    assert.equal(report.complete, false);
  }
  assert.equal(calls, 0);
});

test("doctor: canonical project and descendants exclude sibling prefix collisions", async (t) => {
  const { project, options } = await setup(t);
  await fs.symlink(project, project + "-link");
  t.after(() => fs.unlink(project + "-link"));
  const report = await collectDoctor({ ...options, project: project + "-link",
    scan: async () => scan([proc("/foreign")]), readState: async () => state([claim(project + "-other")]) });
  assert.equal(report.project, project);
  assert.equal(report.status, "pass");
});

test("doctor: argument validation and package engine comparison", () => {
  validateDoctorArgs(["--project", ".", "--json"]);
  for (const args of [["--project"], ["--project", "--json"], ["--force"], ["--fix"],
    ["--show-sensitive-command"], ["--", "node"], ["3000"], ["--dry-run"]]) {
    assert.throws(() => validateDoctorArgs(args));
  }
  assert.equal(meetsNodeMinimum("18.17.0", ">=18.17"), true);
  assert.equal(meetsNodeMinimum("18.16.9", ">=18.17"), false);
  assert.equal(meetsNodeMinimum("24.1.0", ">=18.17"), true);
  assert.equal(meetsNodeMinimum("24.1.0", "^18"), null);
});
