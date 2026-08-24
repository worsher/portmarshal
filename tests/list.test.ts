import { test } from "node:test";
import assert from "node:assert/strict";
import { formatServiceList } from "../src/commands/list.js";
import { buildServiceSnapshot } from "../src/services.js";
import type { ProcessInfo } from "../src/types.js";

test("formatServiceList 一行展示服务的多端口、listener、wrapper 与 claim 关系", () => {
  const proc: ProcessInfo = {
    pid: 101,
    ppid: 100,
    pgid: 100,
    ports: [3000, 3001],
    procName: "node",
    command: "node vite",
    cwd: "/p/app",
    inferredProject: null,
    source: "detached",
    origin: "claude-code",
    ancestors: [{ pid: 100, ppid: 1, pgid: 100, procName: "npm", command: "npm run dev" }],
  };
  const service = buildServiceSnapshot([proc], [{
    name: "web", project: "/p/app", port: 3000, claimedAt: "2026-08-24T00:00:00.000Z",
  }]).services[0];
  const out = formatServiceList([service]);
  assert.match(out, /3000,3001/);
  assert.match(out, /101/);
  assert.match(out, /100/);
  assert.match(out, /web@3000:current/);
  assert.match(out, /claude-code/);
});
