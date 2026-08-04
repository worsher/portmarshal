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

test("parseFlags: -d/--detach 与 -f/--follow", () => {
  assert.equal(parseFlags(["-d"]).detach, true);
  assert.equal(parseFlags(["--detach"]).detach, true);
  assert.equal(parseFlags(["-f"]).follow, true);
  assert.equal(parseFlags(["--follow"]).follow, true);
  assert.equal(parseFlags([]).detach, false);
  assert.equal(parseFlags([]).follow, false);
});

test("parseFlags: --show-sensitive-command 需要显式开启", () => {
  assert.equal(parseFlags(["--show-sensitive-command"]).showSensitiveCommand, true);
  assert.equal(parseFlags([]).showSensitiveCommand, false);
});

test("parseFlags: --wait-timeout 正整数校验", () => {
  assert.equal(parseFlags(["--wait-timeout", "45"]).waitTimeout, 45);
  assert.throws(() => parseFlags(["--wait-timeout", "0"]));
  assert.throws(() => parseFlags(["--wait-timeout", "abc"]));
  assert.throws(() => parseFlags(["--wait-timeout", "1.5"]));
});

test("parseFlags: --ready-url 必须以 / 开头", () => {
  assert.equal(parseFlags(["--ready-url", "/health"]).readyUrl, "/health");
  assert.throws(() => parseFlags(["--ready-url", "health"]));
  assert.throws(() => parseFlags(["--ready-url"]));
});

test("parseFlags: -n 正整数校验", () => {
  assert.equal(parseFlags(["-n", "100"]).lines, 100);
  assert.throws(() => parseFlags(["-n", "0"]));
  assert.throws(() => parseFlags(["-n", "xx"]));
});
