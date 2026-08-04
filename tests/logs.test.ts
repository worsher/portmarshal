import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Flags } from "../src/flags.js";
import type { RegistryEntry } from "../src/types.js";
import logs, { followLog, locateEntry } from "../src/commands/logs.js";

function flagsOf(over: Partial<Flags>): Flags {
  return {
    json: false, all: false, force: false, gui: false, install: false,
    killDetached: false, restart: false, detach: false, follow: false,
    showSensitiveCommand: false,
    positional: [], rest: [], ...over,
  };
}

function entryOf(over: Partial<RegistryEntry>): RegistryEntry {
  return { name: "web", project: "/tmp/p", port: 3000, claimedAt: new Date().toISOString(), ...over };
}

test("locateEntry: 数字按端口找，活跃优先，released 靠 lastPort 兜底", () => {
  const active = entryOf({ port: 3000, logFile: "/a.log" });
  const released = entryOf({ name: "old", port: 3000, released: true, lastPort: 3000, logFile: "/b.log" });
  assert.equal(locateEntry([released, active], "3000", "/x"), active);
  assert.equal(locateEntry([released], "3000", "/x"), released);
  assert.equal(locateEntry([entryOf({ port: 3000 })], "3000", "/x"), undefined); // 无 logFile 不返回
});

test("locateEntry: 名称按 (name, project) 找", () => {
  const e = entryOf({ logFile: "/a.log" });
  assert.equal(locateEntry([e], "web", "/tmp/p"), e);
  assert.equal(locateEntry([e], "web", "/other"), undefined);
  assert.equal(locateEntry([e], "nope", "/tmp/p"), undefined);
});

test("logs: 输出末尾 N 行；目标不存在退出 2", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-logs-"));
  process.env.PORTMARSHAL_STATE_DIR = stateDir;
  const logFile = path.join(stateDir, "svc.log");
  await fs.writeFile(logFile, "l1\nl2\nl3\n");
  await fs.writeFile(
    path.join(stateDir, "registry.json"),
    JSON.stringify([entryOf({ project: "/tmp/p", logFile })]),
  );
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { chunks.push(String(s)); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await logs(flagsOf({ positional: ["web"], project: "/tmp/p", lines: 2 })), 0);
    assert.match(chunks.join(""), /l2\nl3/);
    assert.doesNotMatch(chunks.join(""), /l1/);
    assert.equal(await logs(flagsOf({ positional: ["ghost"], project: "/tmp/p" })), 2);
  } finally {
    process.stdout.write = orig;
    delete process.env.PORTMARSHAL_STATE_DIR;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("logs --json: 输出结构化结果；与 -f 互斥", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-logs2-"));
  process.env.PORTMARSHAL_STATE_DIR = stateDir;
  const logFile = path.join(stateDir, "svc.log");
  await fs.writeFile(logFile, "hello\n");
  await fs.writeFile(
    path.join(stateDir, "registry.json"),
    JSON.stringify([entryOf({ project: "/tmp/p", logFile })]),
  );
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { chunks.push(String(s)); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await logs(flagsOf({ positional: ["web"], project: "/tmp/p", json: true })), 0);
    const out = JSON.parse(chunks.join(""));
    assert.equal(out.name, "web");
    assert.deepEqual(out.lines, ["hello"]);
    assert.equal(await logs(flagsOf({ positional: ["web"], project: "/tmp/p", json: true, follow: true })), 1);
  } finally {
    process.stdout.write = orig;
    delete process.env.PORTMARSHAL_STATE_DIR;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(pred(), true, "condition did not become true before timeout");
}

test("followLog: inode 轮转后即使新文件更大，也从新文件开头继续输出", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-follow-"));
  const file = path.join(dir, "service.log");
  await fs.writeFile(file, "old-start\n");
  const initial = await fs.stat(file);
  const controller = new AbortController();
  let output = "";
  const following = followLog(
    file,
    { position: initial.size, dev: initial.dev, ino: initial.ino },
    {
      intervalMs: 10,
      signal: controller.signal,
      write: (chunk) => { output += chunk.toString("utf8"); },
    },
  );

  try {
    await fs.appendFile(file, "old-next\n");
    await waitUntil(() => output.includes("old-next"));

    await fs.rename(file, file + ".old");
    const newContent = `new-start\n${"x".repeat(64)}\n`;
    await fs.writeFile(file, newContent);
    await waitUntil(() => output.includes("new-start"));
    assert.match(output, /old-next/);
    assert.match(output, /new-start/);
  } finally {
    controller.abort();
    await following;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
