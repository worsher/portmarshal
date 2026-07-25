import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "../src/flags.js";

test("parseFlags: -- 之后的参数原样进入 rest，不再解析选项", () => {
  const f = parseFlags(["web", "--prefer", "3000", "--", "pnpm", "vite", "--port", "{port}"]);
  assert.deepEqual(f.positional, ["web"]);
  assert.equal(f.prefer, 3000);
  assert.deepEqual(f.rest, ["pnpm", "vite", "--port", "{port}"]);
});

test("parseFlags: -- 之后的 --force 属于子命令，不影响自身 flags", () => {
  const f = parseFlags(["web", "--", "cmd", "--force"]);
  assert.equal(f.force, false);
  assert.deepEqual(f.rest, ["cmd", "--force"]);
});

test("parseFlags: --restart 开关", () => {
  assert.equal(parseFlags(["--restart"]).restart, true);
  assert.equal(parseFlags([]).restart, false);
});

test("parseFlags: 无 -- 时 rest 为空数组", () => {
  assert.deepEqual(parseFlags(["web"]).rest, []);
});
