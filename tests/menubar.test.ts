import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMenubar } from "../src/commands/menubar.js";
import type { MergedEntry, ProcessInfo } from "../src/types.js";

function entry(port: number, state: MergedEntry["state"], source = "cursor", cwd = "/p/a"): MergedEntry {
  const proc: ProcessInfo = {
    pid: 1, ports: [port], procName: "node", command: "node dev",
    cwd, inferredProject: null, source,
  };
  return { port, state, proc };
}

test("renderMenubar 标题含服务数与异常数", () => {
  const out = renderMenubar([entry(3000, "active"), entry(8901, "unregistered", "detached")], "/bin/portmarshal");
  const title = out.split("\n")[0];
  assert.match(title, /2/);
  assert.match(title, /⚠\s*1/);
});

test("renderMenubar 服务行带子菜单动作，stop 挂 --gui", () => {
  const out = renderMenubar([entry(3000, "active")], "/bin/portmarshal");
  assert.match(out, /-- Stop service.*bash="\/bin\/portmarshal".*param1=stop.*param2=3000.*param3=--gui.*terminal=false.*refresh=true/);
  assert.match(out, /-- Copy http:\/\/localhost:3000/);
});

test("renderMenubar detached 行标橙色", () => {
  const out = renderMenubar([entry(8901, "unregistered", "detached")], "/bin/portmarshal");
  const line = out.split("\n").find((l) => l.includes("8901") && !l.startsWith("--"))!;
  assert.match(line, /color=orange/);
});

test("renderMenubar 无服务时显示空态", () => {
  const out = renderMenubar([], "/bin/portmarshal");
  assert.match(out, /No listening development services/);
});

test("renderMenubar drift 计入异常数且标橙色", () => {
  const driftEntry = { port: 3001, state: "drift" as const, proc: { pid: 1, ports: [3001], procName: "node", command: "node dev", cwd: "/p/a", inferredProject: null, source: "cursor" }, driftPeer: 3000 };
  const out = renderMenubar([driftEntry], "/bin/portmarshal");
  const title = out.split("\n")[0];
  assert.match(title, /⚠\s*1/);
  const line = out.split("\n").find((l) => l.includes("3001") && !l.startsWith("--"))!;
  assert.match(line, /color=orange/);
});

test("renderMenubar 路径含双引号时 param 段不残留引号", () => {
  const e = { port: 3000, state: "active" as const, proc: { pid: 1, ports: [3000], procName: "node", command: "x", cwd: '/p/a"b', inferredProject: null, source: "cursor" } };
  const out = renderMenubar([e], "/bin/portmarshal");
  const finder = out.split("\n").find((l) => l.includes("Finder"))!;
  // 元数据段（| 之后）不应出现未配对的裸引号破坏 param="..."
  const meta = finder.split("|").slice(1).join("|");
  assert.equal(/param1="[^"]*"\s+terminal=false/.test(meta), true);
});

test("renderMenubar detached 行带 env 溯源标签", () => {
  const e = entry(8901, "unregistered", "detached");
  e.proc!.origin = "claude-code";
  const out = renderMenubar([e], "/bin/portmarshal");
  assert.match(out, /8901 .* · detached \(claude-code\)/);
});
