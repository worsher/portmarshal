import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTable, C } from "../src/render.js";
import { isDeadRun } from "../src/commands/list.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// 期望输出均按「CJK/全角占 2 列、ASCII 占 1 列」手工推算，
// 不复用实现中的宽度函数，避免循环验证。

test("formatTable 按终端显示宽度对齐 CJK 表头与 ASCII 数据", () => {
  const out = formatTable(
    ["来源", "端口"],
    [
      ["a", "1"],
      ["orphan", "63979"],
    ],
  );
  // 列宽：max(来源=4, a=1, orphan=6)=6；max(端口=4, 1=1, 63979=5)=5
  assert.equal(
    out,
    ["来源    端口 ", "a       1    ", "orphan  63979"].join("\n"),
  );
});

test("formatTable：CJK 单元格最宽时，ASCII 行按其显示宽度补齐", () => {
  const out = formatTable(
    ["src", "p"],
    [
      ["项目目录", "1"],
      ["ab", "22"],
    ],
  );
  // 列宽：max(src=3, 项目目录=8, ab=2)=8；max(p=1, 1=1, 22=2)=2
  assert.equal(
    out,
    ["src       p ", "项目目录  1 ", "ab        22"].join("\n"),
  );
});

test("formatTable 宽度计算忽略 ANSI 码，假名/全角字符按 2 列", () => {
  const out = formatTable(
    ["プロセス", "状态"],
    [
      [`${C.green}node${C.reset}`, "ＯＫ"],
      ["a", "x"],
    ],
  );
  // 列宽：max(プロセス=8, node=4, a=1)=8；max(状态=4, ＯＫ=4, x=1)=4
  const lines = out.split("\n").map(strip);
  assert.equal(lines[0], "プロセス  状态");
  assert.equal(lines[1], "node      ＯＫ");
  assert.equal(lines[2], "a         x   ");
});

test("isDeadRun: reserved + runPid 已死 → true；其余 false", () => {
  const dead = { port: 3000, state: "reserved", reg: { name: "web", project: "/p", port: 3000, claimedAt: "", runPid: 999999 } };
  const alive = { port: 3000, state: "reserved", reg: { name: "web", project: "/p", port: 3000, claimedAt: "", runPid: process.pid } };
  const plain = { port: 3000, state: "reserved", reg: { name: "web", project: "/p", port: 3000, claimedAt: "" } };
  assert.equal(isDeadRun(dead as never), true);
  assert.equal(isDeadRun(alive as never), false);
  assert.equal(isDeadRun(plain as never), false);
  assert.equal(isDeadRun({ ...dead, state: "active" } as never), false);
});
