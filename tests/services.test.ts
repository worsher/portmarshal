import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServiceSnapshot } from "../src/services.js";
import type { ProcessInfo, RegistryEntry } from "../src/types.js";

const SNAPSHOT_NOW = Date.parse("2026-08-24T00:20:00.000Z");

function snapshot(scan: ProcessInfo[], registry: RegistryEntry[]) {
  return buildServiceSnapshot(scan, registry, SNAPSHOT_NOW);
}

function proc(pid: number, ports: number[], pgid: number, project = "/p/app", over: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid,
    ppid: 1,
    pgid,
    ports,
    procName: "node",
    command: "node server.js",
    cwd: project,
    inferredProject: null,
    source: "terminal",
    ancestors: [],
    ...over,
  };
}

function reg(name: string, port: number, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return { name, project: "/p/app", port, claimedAt: "2026-08-24T00:00:00.000Z", ...over };
}

test("service snapshot: 同项目同 PGID 的多 PID、多端口与 wrapper 聚合为一个服务", () => {
  const first = proc(101, [3000], 100, "/p/app", {
    ancestors: [{ pid: 100, ppid: 1, pgid: 100, procName: "npm", command: "npm run dev" }],
  });
  const second = proc(102, [3001], 100);
  const result = snapshot([first, second], [reg("web", 3000)]);
  assert.equal(result.services.length, 1);
  assert.deepEqual(result.services[0].ports, [3000, 3001]);
  assert.deepEqual(result.services[0].listenerPids, [101, 102]);
  assert.deepEqual(result.services[0].wrapperPids, [100]);
  assert.equal(result.services[0].confidence, "corroborated");
});

test("service snapshot: 一个 PID 的多个端口只生成一个服务", () => {
  const result = snapshot([proc(101, [3000, 3001], 100)], []);
  assert.equal(result.services.length, 1);
  assert.deepEqual(result.services[0].ports, [3000, 3001]);
});

test("service snapshot: 同一 claim 的 service id 不随监听端口变化", () => {
  const first = snapshot([proc(101, [3000], 100)], [reg("web", 3000)]).services[0];
  const second = snapshot([proc(101, [3001], 100)], [reg("web", 3000)]).services[0];
  assert.equal(first.id, second.id);
  assert.equal(second.claims[0].relation, "drift");
});

test("service snapshot: 同项目不同 PGID 不自动合并", () => {
  const result = snapshot([proc(101, [3000], 100), proc(201, [4000], 200)], []);
  assert.equal(result.services.length, 2);
});

test("service snapshot: 同 PGID 的父子项目路径仍聚合为一个服务", () => {
  const result = snapshot([
    proc(101, [3000], 100, "/p/app"),
    proc(102, [3001], 100, "/p/app/packages/web"),
  ], []);
  assert.equal(result.services.length, 1);
});

test("service snapshot: 同项目共享端口的多个 PID 即使 PGID 不同也聚合", () => {
  const result = snapshot([proc(101, [3000], 100), proc(201, [3000], 200)], []);
  assert.equal(result.services.length, 1);
  assert.deepEqual(result.services[0].listenerPids, [101, 201]);
});

test("service snapshot: 不同项目共享端口时保持两个 service 并标记冲突", () => {
  const result = snapshot([
    proc(101, [3000], 100, "/p/app-a"),
    proc(201, [3000], 200, "/p/app-b"),
  ], []);
  assert.equal(result.services.length, 2);
  for (const service of result.services) {
    assert.equal(service.confidence, "conflict");
    assert.equal(service.stopMode, "blocked");
    assert.ok(service.warnings.includes("shared-port-conflict"));
  }
});

test("service snapshot: runId 与 PGID 匹配时规划 managed-run，停止前仍需 marker 复核", () => {
  const result = snapshot([proc(101, [3000], 100)], [
    reg("web", 3000, { runPid: 100, runId: "run-1" }),
  ]);
  assert.equal(result.services[0].confidence, "corroborated");
  assert.equal(result.services[0].attachment, "managed");
  assert.equal(result.services[0].stopMode, "managed-run");
});

test("service snapshot: 3000 active claim 吸收同项目 5173 为 related，corroborated detached 不报警", () => {
  const result = snapshot([
    proc(37929, [3000], 37907, "/p/app", { source: "detached", origin: "claude-code" }),
  ], [reg("alab-frontend-dev", 3000), reg("alab-frontend", 5173)]);
  const service = result.services[0];
  assert.equal(result.services.length, 1);
  assert.deepEqual(service.claims.map((claim) => [claim.entry.port, claim.relation]), [
    [3000, "current"],
    [5173, "related"],
  ]);
  assert.equal(service.attachment, "detached");
  assert.equal(service.confidence, "corroborated");
  assert.deepEqual(service.warnings, []);
});

test("service snapshot: 同项目存在多个 live service 时 reserved claim 不猜归属", () => {
  const result = snapshot([
    proc(101, [3000], 100),
    proc(201, [4000], 200),
  ], [reg("reserved", 5173)]);
  assert.equal(result.services.length, 3);
  assert.equal(result.services.find((service) => service.activity === "reserved")?.ports[0], 5173);
});

test("service snapshot: 过期未监听 claim 不污染同项目唯一 live service", () => {
  const result = snapshot([
    proc(1145, [5173], 1144, "/p/alab_frontend", { source: "cursor" }),
  ], [
    reg("alab-preview-review", 4173, {
      project: "/p/alab_frontend",
      claimedAt: "2026-08-23T23:00:00.000Z",
    }),
  ]);

  assert.equal(result.services.length, 2);
  const active = result.services.find((service) => service.activity === "active")!;
  assert.equal(active.name, "alab_frontend");
  assert.deepEqual(active.ports, [5173]);
  assert.deepEqual(active.claims, []);
  assert.deepEqual(active.warnings, []);

  const stale = result.services.find((service) => service.activity === "reserved")!;
  assert.equal(stale.name, "alab-preview-review");
  assert.deepEqual(stale.ports, [4173]);
  assert.deepEqual(stale.warnings, ["stale-claim"]);
  assert.equal(stale.claims[0].relation, "reserved");
});

test("service snapshot: run-d claim 的 runPid 已死时服务状态为 dead", () => {
  const result = snapshot([], [reg("dead", 3000, { runPid: 999999, runId: "dead-run" })]);
  assert.equal(result.services[0].activity, "dead");
  assert.deepEqual(result.services[0].warnings, ["managed-run-dead"]);
});

test("service snapshot: live 项目与 claim 项目冲突时阻止 stop", () => {
  const result = snapshot([proc(101, [3000], 100)], [
    reg("foreign", 3000, { project: "/p/other" }),
  ]);
  assert.equal(result.services[0].confidence, "conflict");
  assert.equal(result.services[0].stopMode, "blocked");
  assert.deepEqual(result.services[0].warnings, ["claim-conflict"]);
});

test("service snapshot: 无项目 detached listener 保持 unknown 并报警", () => {
  const result = snapshot([
    proc(101, [3000], 100, "/", { cwd: null, inferredProject: null, source: "detached" }),
  ], []);
  assert.equal(result.services[0].confidence, "unknown");
  assert.deepEqual(result.services[0].warnings, ["unknown-ownership", "detached-unverified"]);
});
