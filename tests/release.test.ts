import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Flags } from "../src/flags.js";
import release from "../src/commands/release.js";
import { Registry } from "../src/registry.js";
import { ownerFingerprint } from "../src/owner.js";

function flagsOf(over: Partial<Flags>): Flags {
  return {
    json: false, all: false, force: false, gui: false, install: false,
    killDetached: false, restart: false, detach: false, follow: false,
    showSensitiveCommand: false,
    positional: [], rest: [], ...over,
  };
}

test("release: 另一 agent session 默认退出 3，--force 显式释放", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-release-"));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-project-"));
  const previousState = process.env.PORTMARSHAL_STATE_DIR;
  const previousOwner = process.env.PORTMARSHAL_OWNER;
  process.env.PORTMARSHAL_STATE_DIR = stateDir;
  try {
    const registry = new Registry();
    await registry.claim({
      name: "web", project, prefer: 18848, claimedBy: "codex",
      ownerKey: ownerFingerprint("explicit", "agent-a"),
    });
    process.env.PORTMARSHAL_OWNER = "agent-b";

    assert.equal(await release(flagsOf({ positional: ["web"], project })), 3);
    assert.equal((await registry.load())[0].released, undefined);
    assert.equal(await release(flagsOf({ positional: ["web"], project, force: true })), 0);
    assert.equal((await registry.load())[0].released, true);
  } finally {
    if (previousState === undefined) delete process.env.PORTMARSHAL_STATE_DIR;
    else process.env.PORTMARSHAL_STATE_DIR = previousState;
    if (previousOwner === undefined) delete process.env.PORTMARSHAL_OWNER;
    else process.env.PORTMARSHAL_OWNER = previousOwner;
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(project, { recursive: true, force: true });
  }
});
