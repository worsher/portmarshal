import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logFilePath, rotateLog, tailLines } from "../src/runlog.js";

test("logFilePath: 落在 stateDir/logs 下，同项目同名稳定，名称安全化", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-runlog-"));
  process.env.PORTMARSHAL_STATE_DIR = stateDir;
  try {
    const a = logFilePath("/tmp/proj", "web");
    const b = logFilePath("/tmp/proj", "web");
    assert.equal(a, b);
    assert.ok(a.startsWith(path.join(stateDir, "logs") + path.sep));
    assert.ok(a.endsWith("-web.log"));
    // 不同项目不同文件；危险字符被替换后补原名哈希，避免与合法名称碰撞
    assert.notEqual(logFilePath("/tmp/other", "web"), a);
    const unsafe = logFilePath("/tmp/proj", "a/b c");
    assert.match(path.basename(unsafe), /-a_b_c-[0-9a-f]{8}\.log$/);
    assert.notEqual(logFilePath("/tmp/proj", "a/b"), logFilePath("/tmp/proj", "a_b"));
  } finally {
    delete process.env.PORTMARSHAL_STATE_DIR;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("rotateLog: .log → .log.old 覆盖旧的；文件不存在时静默", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-rot-"));
  const file = path.join(dir, "x.log");
  await rotateLog(file); // 不存在，不抛错
  await fs.writeFile(file, "run1\n");
  await rotateLog(file);
  assert.equal(await fs.readFile(file + ".old", "utf8"), "run1\n");
  await fs.writeFile(file, "run2\n");
  await rotateLog(file);
  assert.equal(await fs.readFile(file + ".old", "utf8"), "run2\n");
  await fs.rm(dir, { recursive: true, force: true });
});

test("rotateLog: 轮转日志只保留大小上限内的尾部", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-rot-limit-"));
  const file = path.join(dir, "x.log");
  await fs.writeFile(file, `${"earlier\n".repeat(20)}fourth\n`);
  await rotateLog(file, 64);
  const old = await fs.readFile(file + ".old", "utf8");
  assert.ok(Buffer.byteLength(old) <= 64);
  assert.match(old, /earlier log content truncated/);
  assert.match(old, /fourth/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("tailLines: 末尾 n 行，忽略结尾空行", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-tail-"));
  const file = path.join(dir, "x.log");
  await fs.writeFile(file, "l1\nl2\nl3\n");
  assert.deepEqual(await tailLines(file, 2), ["l2", "l3"]);
  assert.deepEqual(await tailLines(file, 10), ["l1", "l2", "l3"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("tailLines: 从文件尾部分块读取，并对超长单行给出截断标记", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-tail-limit-"));
  const file = path.join(dir, "x.log");
  await fs.writeFile(file, `${"x".repeat(256)}\nlast\n`);
  assert.deepEqual(await tailLines(file, 1, 32), ["last"]);
  await fs.writeFile(file, "y".repeat(256));
  const [line] = await tailLines(file, 1, 32);
  assert.equal(line, `…${"y".repeat(32)}`);
  await fs.rm(dir, { recursive: true, force: true });
});
