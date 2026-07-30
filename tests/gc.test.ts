import { test } from "node:test";
import assert from "node:assert/strict";
import { gcCandidates } from "../src/commands/gc.js";
import type { ProcessInfo, RegistryEntry } from "../src/types.js";

function proc(over: Partial<ProcessInfo>): ProcessInfo {
  return {
    pid: 100, ports: [3000], procName: "node", command: "node server.js",
    cwd: null, inferredProject: null, source: "detached", ...over,
  };
}

function reg(over: Partial<RegistryEntry>): RegistryEntry {
  return {
    name: "web", project: "/p", port: 3000, claimedAt: new Date().toISOString(), ...over,
  };
}

test("gcCandidates: run:* 进程有活跃 entry 背书（runPid 命中）→ 豁免，不入候选", () => {
  const p = proc({ pid: 200, origin: "run:web" });
  const entries = [reg({ runPid: 200 })];
  assert.deepEqual(gcCandidates([p], entries), []);
});

test("gcCandidates: run:* 进程有活跃 entry 背书（端口命中）→ 豁免，不入候选", () => {
  const p = proc({ pid: 200, ports: [4000], origin: "run:web" });
  const entries = [reg({ runPid: 999, port: 4000 })];
  assert.deepEqual(gcCandidates([p], entries), []);
});

test("gcCandidates: run:* 进程无任何活跃 entry 背书 → 照常入候选（伪装成受管服务的无主进程）", () => {
  // 场景复现：stop 只 kill 了监听 pid，组长（runPid）被落下；registry 里已经没有背书这个 pid/端口的活跃记录，
  // 但组长进程还带着 PORTMARSHAL_SERVICE 环境残留，origin 仍会被 scan 标成 run:web。
  const p = proc({ pid: 200, origin: "run:web" });
  assert.deepEqual(gcCandidates([p], []), [p]);
});

test("gcCandidates: run:* 进程的背书 entry 已 released → 不算背书，照常入候选", () => {
  const p = proc({ pid: 200, origin: "run:web" });
  const entries = [reg({ runPid: 200, released: true })];
  assert.deepEqual(gcCandidates([p], entries), [p]);
});

test("gcCandidates: run:* 进程的背书 entry 的 runPid/端口都对不上 → 不算背书，照常入候选", () => {
  const p = proc({ pid: 200, ports: [3000], origin: "run:web" });
  const entries = [reg({ runPid: 999, port: 4000 })];
  assert.deepEqual(gcCandidates([p], entries), [p]);
});

test("gcCandidates: 非 run:* 的 detached 进程无需背书，一律入候选", () => {
  const p = proc({ pid: 200, origin: "claude-code" });
  assert.deepEqual(gcCandidates([p], []), [p]);
  const noOrigin = proc({ pid: 201 });
  assert.deepEqual(gcCandidates([noOrigin], []), [noOrigin]);
});

test("gcCandidates: 噪声进程或非 detached 来源不入候选，即便无背书", () => {
  const noisy = proc({ pid: 202, procName: "language_server_macos_arm" });
  const notDetached = proc({ pid: 203, source: "cursor" });
  assert.deepEqual(gcCandidates([noisy, notDetached], []), []);
});
