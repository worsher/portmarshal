import { test } from "node:test";
import assert from "node:assert/strict";
import { formatServiceWatchFrame, formatTable, formatWatchFrame, C } from "../src/render.js";
import { isDeadRun } from "../src/merge.js";
import { buildServiceSnapshot } from "../src/services.js";

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

test("formatWatchFrame: run -d 托管 claim 进程已死 → dead 标记；存活/无 runPid 都不标", () => {
  const deadEntry = { port: 3000, state: "reserved", reg: { name: "web", project: "/p", port: 3000, claimedAt: "", runPid: 999999 } };
  const aliveEntry = { port: 3001, state: "reserved", reg: { name: "api", project: "/p", port: 3001, claimedAt: "", runPid: process.pid } };
  const plainEntry = { port: 3002, state: "active", reg: { name: "db", project: "/p", port: 3002, claimedAt: "" } };
  const out = formatWatchFrame([deadEntry, aliveEntry, plainEntry] as never, new Set([3000, 3001, 3002]));
  const lines = out.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const deadLine = lines.find((l) => l.startsWith("3000"));
  const aliveLine = lines.find((l) => l.startsWith("3001"));
  const plainLine = lines.find((l) => l.startsWith("3002"));
  assert.match(deadLine ?? "", /dead\s*$/);
  assert.doesNotMatch(aliveLine ?? "", /dead/);
  assert.doesNotMatch(plainLine ?? "", /dead/);
});

test("formatServiceWatchFrame 按 service id 追踪并展示多端口", () => {
  const services = buildServiceSnapshot([{
    pid: 10,
    ppid: 9,
    pgid: 9,
    ports: [3000, 3001],
    procName: "node",
    command: "node dev",
    cwd: "/p/app",
    inferredProject: null,
    source: "terminal",
  }], []).services;
  const out = formatServiceWatchFrame(services, new Set());
  assert.match(out, /watch --services/);
  assert.match(out, /3000,3001/);
  assert.match(out, /10/);
});
