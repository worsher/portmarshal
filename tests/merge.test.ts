import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeScanRegistry } from "../src/merge.js";
import type { ProcessInfo, RegistryEntry } from "../src/types.js";

function proc(pid: number, ports: number[], cwd: string): ProcessInfo {
  return { pid, ports, procName: "node", command: "", cwd, inferredProject: null, source: "terminal" };
}
function reg(name: string, project: string, port: number): RegistryEntry {
  return { name, project, port, claimedAt: new Date().toISOString() };
}

test("active：已注册且在监听", () => {
  const out = mergeScanRegistry([proc(1, [3000], "/p/a")], [reg("web", "/p/a", 3000)]);
  assert.equal(out[0].state, "active");
});

test("reserved：已注册未监听", () => {
  const out = mergeScanRegistry([], [reg("web", "/p/a", 3000)]);
  assert.deepEqual(out.map((e) => [e.port, e.state]), [[3000, "reserved"]]);
});

test("unregistered：在监听未注册", () => {
  const out = mergeScanRegistry([proc(1, [8080], "/p/a")], []);
  assert.equal(out[0].state, "unregistered");
});

test("drift：同项目注册 3000 未监听 + 监听 3001 未注册", () => {
  const out = mergeScanRegistry([proc(1, [3001], "/p/a")], [reg("web", "/p/a", 3000)]);
  const drift3000 = out.find((e) => e.port === 3000)!;
  const drift3001 = out.find((e) => e.port === 3001)!;
  assert.equal(drift3000.state, "drift");
  assert.equal(drift3000.driftPeer, 3001);
  assert.equal(drift3001.state, "drift");
  assert.equal(drift3001.driftPeer, 3000);
});

test("drift：注册路径经符号链接、进程 cwd 为真实路径时仍能配对", (t) => {
  const realDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "portmarshal-merge-"));
  const linkDir = `${realDir}-link`;
  fs.symlinkSync(realDir, linkDir);
  t.after(() => {
    fs.unlinkSync(linkDir);
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  const out = mergeScanRegistry([proc(1, [3001], realDir)], [reg("web", linkDir, 3000)]);
  const drift3000 = out.find((e) => e.port === 3000)!;
  const drift3001 = out.find((e) => e.port === 3001)!;
  assert.equal(drift3000.state, "drift");
  assert.equal(drift3000.driftPeer, 3001);
  assert.equal(drift3001.state, "drift");
  assert.equal(drift3001.driftPeer, 3000);
});

test("released 记录不参与合并", () => {
  const released: RegistryEntry = { ...reg("web", "/p/a", 3000), released: true, lastPort: 3000 };
  const out = mergeScanRegistry([], [released]);
  assert.equal(out.length, 0);
});
