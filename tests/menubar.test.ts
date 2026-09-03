import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMenubar } from "../src/commands/menubar.js";
import type { ProcessInfo, ServiceInfo } from "../src/types.js";

function entry(port: number, source = "cursor", cwd = "/p/a"): ServiceInfo {
  const proc: ProcessInfo = {
    pid: 1, ports: [port], procName: "node", command: "node dev",
    cwd, inferredProject: null, source,
  };
  return {
    id: `svc_${port}`,
    name: "web",
    activity: "active",
    attachment: source === "detached" ? "detached" : "attached",
    confidence: "inferred",
    stopMode: "listener-only",
    project: cwd,
    source,
    ports: [port],
    listenerPids: [1],
    wrapperPids: [],
    processes: [proc],
    claims: [],
    warnings: source === "detached" ? ["detached-unverified"] : [],
  };
}

test("renderMenubar 标题含服务数与异常数", () => {
  const out = renderMenubar([entry(3000), entry(8901, "detached")], "/bin/portmarshal");
  const title = out.split("\n")[0];
  assert.match(title, /2/);
  assert.match(title, /⚠\s*1/);
});

test("renderMenubar 服务行带子菜单动作，stop 挂 --gui", () => {
  const out = renderMenubar([entry(3000)], "/bin/portmarshal");
  assert.match(out, /-- Stop listener.*bash="\/bin\/portmarshal".*param1=stop.*param2=3000.*param3=--gui.*terminal=false.*refresh=true/);
  assert.match(out, /-- Copy http:\/\/localhost:3000/);
});

test("renderMenubar detached 行标橙色", () => {
  const out = renderMenubar([entry(8901, "detached")], "/bin/portmarshal");
  const line = out.split("\n").find((l) => l.includes("8901") && !l.startsWith("--"))!;
  assert.match(line, /color=orange/);
});

test("renderMenubar 无服务时显示空态", () => {
  const out = renderMenubar([], "/bin/portmarshal");
  assert.match(out, /No listening development services/);
});

test("renderMenubar drift 计入异常数且标橙色", () => {
  const driftEntry = entry(3001);
  driftEntry.warnings.push("port-drift");
  const out = renderMenubar([driftEntry], "/bin/portmarshal");
  const title = out.split("\n")[0];
  assert.match(title, /⚠\s*1/);
  const line = out.split("\n").find((l) => l.includes("3001") && !l.startsWith("--"))!;
  assert.match(line, /color=orange/);
});

test("renderMenubar 路径含双引号时 param 段不残留引号", () => {
  const e = entry(3000, "cursor", '/p/a"b');
  const out = renderMenubar([e], "/bin/portmarshal");
  const finder = out.split("\n").find((l) => l.includes("Finder"))!;
  // 元数据段（| 之后）不应出现未配对的裸引号破坏 param="..."
  const meta = finder.split("|").slice(1).join("|");
  assert.equal(/param1="[^"]*"\s+terminal=false/.test(meta), true);
});

test("renderMenubar detached 行带 env 溯源标签", () => {
  const e = entry(8901, "detached");
  e.origin = "claude-code";
  const out = renderMenubar([e], "/bin/portmarshal");
  assert.match(out, /:8901 · claude-code · detached/);
});

test("renderMenubar cleanup action 仅打开 dry-run 审查，不一键停止 detached 服务", () => {
  const out = renderMenubar([entry(8901, "detached")], "/bin/portmarshal");
  const review = out.split("\n").find((line) => line.includes("Review stale claims"))!;
  assert.match(review, /param1=gc.*param2=--dry-run/);
  assert.match(review, /terminal=true/);
  assert.doesNotMatch(out, /--kill-detached/);
});

test("renderMenubar corroborated detached 服务不计异常，并展示 wrapper 与 related claim", () => {
  const e = entry(3000, "detached", "/p/alab_frontend");
  e.origin = "claude-code";
  e.confidence = "corroborated";
  e.warnings = [];
  e.pgid = 37907;
  e.listenerPids = [37929];
  e.wrapperPids = [37909];
  e.claims = [
    { relation: "current", entry: { name: "alab-frontend-dev", project: "/p/alab_frontend", port: 3000, claimedAt: "2026-08-24T00:00:00Z" } },
    { relation: "related", entry: { name: "alab-frontend", project: "/p/alab_frontend", port: 5173, claimedAt: "2026-08-24T00:00:00Z" } },
  ];
  const out = renderMenubar([e], "/bin/portmarshal", "0.8.0");
  assert.equal(out.split("\n")[0], "⚓1");
  assert.match(out, /Listener PID: 37929/);
  assert.match(out, /Wrapper PID: 37909 · PGID 37907/);
  assert.match(out, /Related claim: alab-frontend · :5173 · related · review/);
  assert.match(out, /PortMarshal 0\.8\.0/);
  assert.match(out, /Executable: \/bin\/portmarshal/);
});

test("renderMenubar 过期 claim 单独标记，正常 live service 不置灰或告警", () => {
  const active = entry(5173, "cursor", "/p/alab_frontend");
  const stale: ServiceInfo = {
    id: "svc_stale_4173",
    name: "alab-preview-review",
    activity: "reserved",
    attachment: "none",
    confidence: "inferred",
    stopMode: "blocked",
    project: "/p/alab_frontend",
    source: "reserved",
    ports: [4173],
    listenerPids: [],
    wrapperPids: [],
    processes: [],
    claims: [{
      relation: "reserved",
      entry: {
        name: "alab-preview-review",
        project: "/p/alab_frontend",
        port: 4173,
        claimedAt: "2026-08-24T00:00:00.000Z",
      },
    }],
    warnings: ["stale-claim"],
  };

  const out = renderMenubar([active, stale], "/bin/portmarshal", "0.8.1");
  assert.equal(out.split("\n")[0], "⚓2 ⚠1 | color=orange");
  assert.match(out, /^alab_frontend · active · :5173 · cursor$/m);
  assert.match(out, /^⚠ alab-preview-review · reserved · :4173 · reserved \| color=orange$/m);
  assert.doesNotMatch(out, /^⚠ alab_frontend · active · :5173/m);
});
