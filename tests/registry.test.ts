import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Registry, isPortFree } from "../src/registry.js";

async function tmpRegistry(): Promise<Registry> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-test-"));
  return new Registry(dir);
}
const alwaysFree = async () => true;

test("claim 分配 prefer 端口并写入注册表", async () => {
  const r = await tmpRegistry();
  const { port, reused } = await r.claim({
    name: "web", project: "/proj/a", prefer: 3000, portFree: alwaysFree,
  });
  assert.equal(port, 3000);
  assert.equal(reused, false);
  const entries = await r.load();
  assert.equal(entries[0].name, "web");
  assert.equal(entries[0].project, "/proj/a");
});

test("claim 幂等：同 (project,name) 重复 claim 返回原端口", async () => {
  const r = await tmpRegistry();
  await r.claim({ name: "web", project: "/proj/a", prefer: 3000, portFree: alwaysFree });
  const second = await r.claim({ name: "web", project: "/proj/a", prefer: 4000, portFree: alwaysFree });
  assert.equal(second.port, 3000);
  assert.equal(second.reused, true);
});

test("claim 幂等：端口正在被本项目监听时继续复用", async () => {
  const r = await tmpRegistry();
  await r.claim({ name: "web", project: "/proj/a", prefer: 3000, portFree: alwaysFree });
  const second = await r.claim({
    name: "web",
    project: "/proj/a",
    portFree: async () => false,
    portOwnedByProject: async () => true,
  });
  assert.equal(second.port, 3000);
  assert.equal(second.reused, true);
});

test("claim 发现旧预留已被其他进程占用时重新分配", async () => {
  const r = await tmpRegistry();
  await r.claim({ name: "web", project: "/proj/a", prefer: 3000, portFree: alwaysFree });
  const second = await r.claim({
    name: "web",
    project: "/proj/a",
    portFree: async (port) => port !== 3000,
    portOwnedByProject: async () => false,
  });
  assert.equal(second.port, 3001);
  assert.equal(second.reused, false);
  assert.equal(second.previousPort, 3000);
});

test("claim 冲突顺延：prefer 被其他项目注册时 +1", async () => {
  const r = await tmpRegistry();
  await r.claim({ name: "web", project: "/proj/a", prefer: 3000, portFree: alwaysFree });
  const b = await r.claim({ name: "web", project: "/proj/b", prefer: 3000, portFree: alwaysFree });
  assert.equal(b.port, 3001);
});

test("claim 跳过实际被占用的端口", async () => {
  const r = await tmpRegistry();
  const busy3000 = async (p: number) => p !== 3000;
  const { port } = await r.claim({ name: "web", project: "/proj/a", prefer: 3000, portFree: busy3000 });
  assert.equal(port, 3001);
});

test("claim 在 prefer 不可用时回落扫描 range 低端口段", async () => {
  const r = await tmpRegistry();
  const { port } = await r.claim({
    name: "web", project: "/proj/a",
    prefer: 3005, range: [3000, 3010],
    portFree: async (p) => p < 3005, // 3005-3010 全被占用
  });
  assert.equal(port, 3000);
});

test("release 后再 claim 粘性复用 lastPort", async () => {
  const r = await tmpRegistry();
  await r.claim({ name: "web", project: "/proj/a", prefer: 3000, portFree: alwaysFree });
  const released = await r.release("web", "/proj/a");
  assert.equal(released?.port, 3000);
  const again = await r.claim({ name: "web", project: "/proj/a", portFree: alwaysFree });
  assert.equal(again.port, 3000); // 未传 prefer，靠 lastPort 粘回
});

test("release 不存在的记录返回 null", async () => {
  const r = await tmpRegistry();
  assert.equal(await r.release("nope", "/proj/a"), null);
});

test("gcStale 回收超过 30 分钟未监听的记录并保留粘性", async () => {
  const r = await tmpRegistry();
  await r.claim({ name: "web", project: "/proj/a", prefer: 3000, portFree: alwaysFree });
  const later = Date.now() + 31 * 60 * 1000;
  const removed = await r.gcStale(new Set(), later);
  assert.equal(removed.length, 1);
  const entries = await r.load();
  assert.equal(entries[0].released, true);
  assert.equal(entries[0].lastPort, 3000);
});

test("gcStale 不回收正在监听的记录", async () => {
  const r = await tmpRegistry();
  await r.claim({ name: "web", project: "/proj/a", prefer: 3000, portFree: alwaysFree });
  const later = Date.now() + 31 * 60 * 1000;
  const removed = await r.gcStale(new Set([3000]), later);
  assert.equal(removed.length, 0);
});

test("注册表损坏时备份重建", async () => {
  const r = await tmpRegistry();
  await fs.mkdir(r.dir, { recursive: true });
  await fs.writeFile(path.join(r.dir, "registry.json"), "{broken");
  const entries = await r.load();
  assert.deepEqual(entries, []);
  const bak = await fs.readFile(path.join(r.dir, "registry.json.bak"), "utf8");
  assert.equal(bak, "{broken");
});

test("首次读取时从 PortScout 旧注册表复制迁移", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-migration-"));
  const oldDir = path.join(root, ".portscout");
  const newDir = path.join(root, ".portmarshal");
  const oldFile = path.join(oldDir, "registry.json");
  const entry = [{ name: "web", project: "/proj/a", port: 3000, claimedAt: new Date().toISOString() }];
  await fs.mkdir(oldDir, { recursive: true });
  await fs.writeFile(oldFile, JSON.stringify(entry));

  const registry = new Registry(newDir, oldFile);
  assert.deepEqual(await registry.load(), entry);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(newDir, "registry.json"), "utf8")), entry);
  assert.equal(await fs.readFile(oldFile, "utf8"), JSON.stringify(entry));
});

test("markReleasedByPort 把活跃记录转为 released", async () => {
  const r = await tmpRegistry();
  await r.claim({ name: "web", project: "/proj/a", prefer: 3000, portFree: alwaysFree });
  await r.markReleasedByPort(3000);
  const entries = await r.load();
  assert.equal(entries[0].released, true);
  assert.equal(entries[0].lastPort, 3000);
});

test("isPortFree 探测仅绑定 ::1 (IPv6) 的监听者", async (t) => {
  const srv = net.createServer();
  const bound = await new Promise<boolean>((resolve) => {
    srv.once("error", () => {
      resolve(false);
    });
    srv.listen({ port: 0, host: "::1" }, () => resolve(true));
  });
  if (!bound) {
    t.skip("此环境不支持 IPv6 (::1)，跳过该断言");
    return;
  }
  const address = srv.address();
  const port = typeof address === "object" && address !== null ? address.port : -1;
  assert.notEqual(port, -1);

  assert.equal(await isPortFree(port), false);

  await new Promise<void>((resolve) => srv.close(() => resolve()));
  assert.equal(await isPortFree(port), true);
});

test("claim 可夺取已死进程遗留的锁", async () => {
  const r = await tmpRegistry();
  const lockDir = path.join(r.dir, ".lock");
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(path.join(lockDir, "pid"), "999999"); // 几乎必死的 pid
  const { port } = await r.claim({ name: "web", project: "/p", prefer: 3000, portFree: async () => true });
  assert.equal(port, 3000);
});

test("偷锁对无效 pid 文件走 mtime 宽限：内容为空且锁目录足够老时可夺取", async () => {
  const r = await tmpRegistry();
  const lockDir = path.join(r.dir, ".lock");
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(path.join(lockDir, "pid"), ""); // 撕裂写入残留
  const old = new Date(Date.now() - 15_000);
  await fs.utimes(lockDir, old, old); // 锁目录 15 秒前 → 超过 10s 宽限
  const { port } = await r.claim({ name: "web", project: "/p", prefer: 3000, portFree: async () => true });
  assert.equal(port, 3000);
});

test("setRunInfo 附加 runPid/logFile；release 清除 runPid 保留 logFile", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-reg-run-"));
  const reg = new Registry(dir);
  await reg.claim({ name: "web", project: "/tmp/p", claimedBy: "test" });
  await reg.setRunInfo("web", "/tmp/p", { runPid: 12345, logFile: "/tmp/p.log" });
  let e = (await reg.load())[0];
  assert.equal(e.runPid, 12345);
  assert.equal(e.logFile, "/tmp/p.log");

  await reg.release("web", "/tmp/p");
  e = (await reg.load())[0];
  assert.equal(e.released, true);
  assert.equal(e.runPid, undefined);
  assert.equal(e.logFile, "/tmp/p.log");
  await fs.rm(dir, { recursive: true, force: true });
});

test("setRunInfo 对不存在或已 released 的 entry 静默返回", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-reg-run2-"));
  const reg = new Registry(dir);
  await reg.setRunInfo("ghost", "/tmp/p", { runPid: 1, logFile: "/x" });
  assert.equal((await reg.load()).length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("markReleasedByPort 同样清除 runPid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-reg-run3-"));
  const reg = new Registry(dir);
  const { port } = await reg.claim({ name: "web", project: "/tmp/p", claimedBy: "test" });
  await reg.setRunInfo("web", "/tmp/p", { runPid: 12345, logFile: "/tmp/p.log" });
  await reg.markReleasedByPort(port);
  const e = (await reg.load())[0];
  assert.equal(e.runPid, undefined);
  assert.equal(e.logFile, "/tmp/p.log");
  await fs.rm(dir, { recursive: true, force: true });
});
