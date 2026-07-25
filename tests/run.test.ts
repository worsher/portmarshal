import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Flags } from "../src/flags.js";
import run, { substitutePort } from "../src/commands/run.js";
import type { RegistryEntry } from "../src/types.js";

function flagsOf(over: Partial<Flags>): Flags {
  return {
    json: false, all: false, force: false, gui: false, install: false,
    killDetached: false, restart: false, positional: [], rest: [], ...over,
  };
}

async function withStateDir<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-run-"));
  process.env.PORTMARSHAL_STATE_DIR = stateDir;
  try { return await fn(stateDir); } finally {
    delete process.env.PORTMARSHAL_STATE_DIR;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function loadEntries(stateDir: string): Promise<RegistryEntry[]> {
  return JSON.parse(await fs.readFile(path.join(stateDir, "registry.json"), "utf8"));
}

test("substitutePort 替换每个参数中的所有 {port}", () => {
  assert.deepEqual(
    substitutePort(["vite", "--port", "{port}", "http://127.0.0.1:{port}/{port}"], 3210),
    ["vite", "--port", "3210", "http://127.0.0.1:3210/3210"],
  );
});

test("run: 缺 name 或缺 -- 命令时打印 usage 并退出 1", async () => {
  assert.equal(await run(flagsOf({ positional: [], rest: ["node"] })), 1);
  assert.equal(await run(flagsOf({ positional: ["web"], rest: [] })), 1);
});

test("run: 注入 PORT，子进程退出后自动 release 并保留 lastPort 粘性", async () => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    const code = await run(flagsOf({
      positional: ["web"], project,
      // 子进程校验 PORT 已注入且与占位符一致，不一致则以 9 退出
      rest: [process.execPath, "-e", "process.exit(process.env.PORT === process.argv[1] ? 0 : 9)", "{port}"],
    }));
    assert.equal(code, 0);
    const entries = await loadEntries(stateDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "web");
    assert.equal(entries[0].released, true);
    assert.equal(entries[0].lastPort, entries[0].port);
    await fs.rm(project, { recursive: true, force: true });
  });
});

test("run: 透传子进程退出码，且异常退出同样 release", async () => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    const code = await run(flagsOf({
      positional: ["web"], project,
      rest: [process.execPath, "-e", "process.exit(7)"],
    }));
    assert.equal(code, 7);
    assert.equal((await loadEntries(stateDir))[0].released, true);
    await fs.rm(project, { recursive: true, force: true });
  });
});

test("run: 命令不存在时报错、release 并退出 1", async () => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    const code = await run(flagsOf({
      positional: ["web"], project,
      rest: ["definitely-not-a-real-command-xyz"],
    }));
    assert.equal(code, 1);
    assert.equal((await loadEntries(stateDir))[0].released, true);
    await fs.rm(project, { recursive: true, force: true });
  });
});
