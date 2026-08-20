import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerFingerprint, resolveOwnerIdentity } from "../src/owner.js";
import { defaultClaimedBy } from "../src/registry.js";

test("ownerFingerprint 稳定、区分来源且不泄露原始会话值", () => {
  const raw = "thread-secret-value";
  const a = ownerFingerprint("codex", raw);
  assert.equal(a, ownerFingerprint("codex", raw));
  assert.notEqual(a, ownerFingerprint("explicit", raw));
  assert.match(a, /^v1:[0-9a-f]{24}$/);
  assert.equal(a.includes(raw), false);
});

test("resolveOwnerIdentity: PORTMARSHAL_OWNER 优先且只返回指纹", () => {
  const identity = resolveOwnerIdentity({
    PORTMARSHAL_OWNER: "shared-agent-session",
    CODEX_THREAD_ID: "codex-thread",
  });
  assert.deepEqual(identity, {
    source: "explicit",
    key: ownerFingerprint("explicit", "shared-agent-session"),
  });
  assert.equal(JSON.stringify(identity).includes("shared-agent-session"), false);
});

test("resolveOwnerIdentity: Codex thread 优先于 session，空环境不伪造身份", () => {
  assert.deepEqual(
    resolveOwnerIdentity({ CODEX_THREAD_ID: "thread-1", CODEX_SESSION_ID: "session-1" }),
    { source: "codex", key: ownerFingerprint("codex", "thread-1") },
  );
  assert.deepEqual(
    resolveOwnerIdentity({ CODEX_SESSION_ID: "session-1" }),
    { source: "codex", key: ownerFingerprint("codex", "session-1") },
  );
  assert.equal(resolveOwnerIdentity({}), null);
});

test("defaultClaimedBy 保留 Agent 来源，不把显式 owner 错当成工具名", () => {
  assert.equal(defaultClaimedBy({ PORTMARSHAL_OWNER: "x", CLAUDECODE: "1" }), "claude-code");
  assert.equal(defaultClaimedBy({ PORTMARSHAL_OWNER: "x", CURSOR_AGENT: "1" }), "cursor");
  assert.equal(defaultClaimedBy({ CODEX_THREAD_ID: "x" }), "codex");
  assert.equal(defaultClaimedBy({ PORTMARSHAL_OWNER: "x", TERM_PROGRAM: "WezTerm" }), "WezTerm");
});
