# run --detach + logs + 就绪等待 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 portmarshal 增加 `run -d` 后台托管（日志落盘 + 就绪等待后返回）和 `logs` 命令，形成 agent「起服务 → 确认就绪 → 继续干活」的闭环。

**Architecture:** 无 supervisor。`run -d` 把服务 spawn 成独立进程组、stdout/stderr 重定向到日志文件，registry entry 记录 `runPid`/`logFile`，父进程轮询 TCP/HTTP 就绪后退出。崩溃不重启，靠 `list` 的 dead 提示 + `logs` 排查。归属显示通过现有 env 溯源机制（注入 `PORTMARSHAL_SERVICE` 标记）实现。

**Tech Stack:** Node.js ≥18.17，TypeScript ESM（import 路径带 `.js` 后缀），零运行时依赖，`tsx --test`（node:test + node:assert/strict）。

**Spec:** `docs/superpowers/specs/2026-07-30-run-detach-logs-readiness-design.md`

## Global Constraints

- 零运行时依赖；只用 node: 内置模块
- ESM：源码内相对 import 一律写 `.js` 后缀（如 `from "../registry.js"`）
- CLI 输出为英文；代码注释在「说明非显然约束」时用中文（跟随现有代码风格）
- 状态目录：`process.env.PORTMARSHAL_STATE_DIR ?? ~/.portmarshal`（测试靠 `PORTMARSHAL_STATE_DIR` 隔离）
- 退出码语义沿用 `EXIT`：OK=0, ERR=1, NOT_FOUND=2, BLOCKED=3, LOCK_TIMEOUT=4
- 测试命令：`pnpm test`（跑 package.json 中列出的测试文件；新增测试文件必须加入 `test` script）
- 前台 `run`（不带 `-d`）行为完全不变
- 每个 Task 结束时 `pnpm test` 全绿再 commit

---

### Task 1: flags 扩展

**Files:**
- Modify: `src/flags.ts`
- Test: `tests/flags.test.ts`
- Modify: `tests/run.test.ts`、`tests/stop.test.ts` 等所有内联 `flagsOf` 辅助函数（grep 定位）

**Interfaces:**
- Produces: `Flags` 接口新增字段 `detach: boolean`（默认 false）、`follow: boolean`（默认 false）、`waitTimeout?: number`（秒，正整数）、`readyUrl?: string`（以 `/` 开头）、`lines?: number`（正整数）。后续所有 Task 都从 `Flags` 读这些字段。

- [ ] **Step 1: 写失败测试**

在 `tests/flags.test.ts` 末尾追加：

```ts
test("parseFlags: -d/--detach 与 -f/--follow", () => {
  assert.equal(parseFlags(["-d"]).detach, true);
  assert.equal(parseFlags(["--detach"]).detach, true);
  assert.equal(parseFlags(["-f"]).follow, true);
  assert.equal(parseFlags(["--follow"]).follow, true);
  assert.equal(parseFlags([]).detach, false);
  assert.equal(parseFlags([]).follow, false);
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/flags.test.ts`
Expected: FAIL（`detach` 属性不存在 / 未知选项抛错）

- [ ] **Step 3: 实现**

`src/flags.ts`：`Flags` 接口在 `restart: boolean;` 后加：

```ts
  detach: boolean;
  follow: boolean;
  waitTimeout?: number;
  readyUrl?: string;
  lines?: number;
```

`parseFlags` 初始化对象加 `detach: false, follow: false,`；switch 中 `case "--restart"` 附近加：

```ts
      case "-d": case "--detach": f.detach = true; break;
      case "-f": case "--follow": f.follow = true; break;
      case "--wait-timeout": {
        const s = Number(args[++i]);
        if (!Number.isInteger(s) || s < 1) {
          throw new Error("--wait-timeout must be a positive integer number of seconds");
        }
        f.waitTimeout = s;
        break;
      }
      case "--ready-url": {
        const u = args[++i];
        if (!u || !u.startsWith("/")) {
          throw new Error("--ready-url must be an absolute path starting with /, for example /health");
        }
        f.readyUrl = u;
        break;
      }
      case "-n": {
        const n = Number(args[++i]);
        if (!Number.isInteger(n) || n < 1) throw new Error("-n must be a positive integer line count");
        f.lines = n;
        break;
      }
```

注意：default 分支只对 `--` 前缀抛未知选项错，`-d`/`-f`/`-n` 若不加显式 case 会被当成 positional，所以必须逐个列出。

- [ ] **Step 4: 修复既有测试的 flagsOf**

Run: `grep -rn "killDetached: false" tests/`
每处 `flagsOf` 默认对象补上 `detach: false, follow: false,`。

- [ ] **Step 5: 全量测试通过**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/flags.ts tests/
git commit -m "feat: parse -d/--detach, --wait-timeout, --ready-url, -f, -n flags"
```

---

### Task 2: registry 支持 runPid/logFile

**Files:**
- Modify: `src/types.ts`（RegistryEntry）
- Modify: `src/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Produces:
  - `RegistryEntry` 新增可选字段 `runPid?: number; logFile?: string;`
  - `Registry.setRunInfo(name: string, project: string, info: { runPid: number; logFile: string }): Promise<void>` — 给活跃 entry 附加托管信息，无匹配活跃 entry 时静默返回
  - 所有「转 released」路径（`release`、`markReleasedByPort`、`gcStale`）清除 `runPid`、保留 `logFile`

- [ ] **Step 1: 写失败测试**

在 `tests/registry.test.ts` 末尾追加（沿用该文件已有的 state dir 隔离辅助；若无则参照 `tests/run.test.ts` 的 `withStateDir` 写法，用 `new Registry(stateDir)` 直接传目录亦可）：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/registry.test.ts`
Expected: FAIL（setRunInfo 不存在）

- [ ] **Step 3: 实现**

`src/types.ts` 的 `RegistryEntry` 加：

```ts
  /** run -d 托管的进程组长 pid；转 released 时清除 */
  runPid?: number;
  /** run -d 日志文件绝对路径；release 后保留，供 logs 查上一次输出 */
  logFile?: string;
```

`src/registry.ts` 在 `release` 前加方法：

```ts
  async setRunInfo(name: string, project: string, info: { runPid: number; logFile: string }): Promise<void> {
    await this.withLock(async () => {
      const entries = await this.load();
      const idx = entries.findIndex((e) => e.project === project && e.name === name && !e.released);
      if (idx < 0) return;
      entries[idx] = { ...entries[idx], runPid: info.runPid, logFile: info.logFile };
      await this.save(entries);
    });
  }
```

三处「转 released」的对象展开都加 `runPid: undefined`（JSON.stringify 会丢弃 undefined 键）：

- `release`: `entries[idx] = { ...e, released: true, lastPort: e.port, runPid: undefined };`
- `markReleasedByPort`: `entries[i] = { ...e, released: true, lastPort: e.port, runPid: undefined };`
- `gcStale`: `return { ...e, released: true, lastPort: e.port, runPid: undefined };`

- [ ] **Step 4: 全量测试通过**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/registry.ts tests/registry.test.ts
git commit -m "feat: registry tracks runPid/logFile for detached runs"
```

---

### Task 3: runlog 模块（日志路径、轮转、tail）

**Files:**
- Create: `src/runlog.ts`
- Test: `tests/runlog.test.ts`（新文件，需加入 package.json 的 `test` script）

**Interfaces:**
- Produces:
  - `logFilePath(project: string, name: string): string` — `<stateDir>/logs/<hash8>-<safeName>.log`，hash8 = realpath 归一化后项目路径的 sha256 前 8 位 hex
  - `rotateLog(file: string): Promise<void>` — 确保目录存在；`.log` 改名 `.log.old`（覆盖旧 `.old`），不存在则跳过
  - `tailLines(file: string, n: number): Promise<string[]>` — 末尾 n 行（忽略结尾空行）

- [ ] **Step 1: 写失败测试**

创建 `tests/runlog.test.ts`：

```ts
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
    // 不同项目不同文件；危险字符被替换
    assert.notEqual(logFilePath("/tmp/other", "web"), a);
    assert.ok(path.basename(logFilePath("/tmp/proj", "a/b c")).endsWith("-a_b_c.log"));
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

test("tailLines: 末尾 n 行，忽略结尾空行", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-tail-"));
  const file = path.join(dir, "x.log");
  await fs.writeFile(file, "l1\nl2\nl3\n");
  assert.deepEqual(await tailLines(file, 2), ["l2", "l3"]);
  assert.deepEqual(await tailLines(file, 10), ["l1", "l2", "l3"]);
  await fs.rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/runlog.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/runlog.ts`：

```ts
import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function stateDir(): string {
  return process.env.PORTMARSHAL_STATE_DIR ?? path.join(os.homedir(), ".portmarshal");
}

function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export function logFilePath(project: string, name: string): string {
  const hash8 = crypto.createHash("sha256").update(realpathOrSelf(project)).digest("hex").slice(0, 8);
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(stateDir(), "logs", `${hash8}-${safe}.log`);
}

export async function rotateLog(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.rename(file, file + ".old");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export async function tailLines(file: string, n: number): Promise<string[]> {
  const lines = (await fs.readFile(file, "utf8")).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}
```

- [ ] **Step 4: 注册测试文件并跑全量**

package.json `test` script 末尾追加 ` tests/runlog.test.ts`。
Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runlog.ts tests/runlog.test.ts package.json
git commit -m "feat: run log path, rotation, and tail helpers"
```

---

### Task 4: ready 模块（就绪等待）

**Files:**
- Create: `src/ready.ts`
- Test: `tests/ready.test.ts`（新文件，加入 `test` script）

**Interfaces:**
- Produces:
  - `pidAlive(pid: number): boolean`
  - `waitReady(opts: { port: number; pid: number; readyUrl?: string; timeoutMs: number; intervalMs?: number }): Promise<{ ok: true } | { ok: false; reason: "timeout" | "died" }>`
  - 语义：先探就绪再探进程存活（双 fork 场景下组长已死但服务在监听时仍算就绪）；`readyUrl` 时 TCP 通后继续轮询 HTTP，2xx/3xx 视为就绪

- [ ] **Step 1: 写失败测试**

创建 `tests/ready.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { waitReady, pidAlive } from "../src/ready.js";

function listen(srv: net.Server | http.Server): Promise<number> {
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)));
}

test("pidAlive: 自身存活，已收割的子进程 pid 不存活", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(999999), false);
});

test("waitReady: TCP 就绪即 ok", async () => {
  const srv = net.createServer();
  const port = await listen(srv);
  try {
    assert.deepEqual(await waitReady({ port, pid: process.pid, timeoutMs: 3000 }), { ok: true });
  } finally { srv.close(); }
});

test("waitReady: 无人监听 → timeout", async () => {
  // 用一个刚释放的临时端口，几乎不可能被瞬间抢占
  const srv = net.createServer();
  const port = await listen(srv);
  await new Promise<void>((r) => srv.close(() => r()));
  const res = await waitReady({ port, pid: process.pid, timeoutMs: 500, intervalMs: 50 });
  assert.deepEqual(res, { ok: false, reason: "timeout" });
});

test("waitReady: 目标进程死亡 → died（快于超时）", async () => {
  const srv = net.createServer();
  const port = await listen(srv);
  await new Promise<void>((r) => srv.close(() => r()));
  const start = Date.now();
  const res = await waitReady({ port, pid: 999999, timeoutMs: 10_000, intervalMs: 50 });
  assert.deepEqual(res, { ok: false, reason: "died" });
  assert.ok(Date.now() - start < 5000);
});

test("waitReady: --ready-url 等到 HTTP 2xx 才 ok，5xx 继续等", async () => {
  let healthy = false;
  const srv = http.createServer((req, res) => {
    res.statusCode = req.url === "/health" && healthy ? 200 : 500;
    res.end();
  });
  const port = await listen(srv);
  try {
    setTimeout(() => { healthy = true; }, 300);
    const res = await waitReady({ port, pid: process.pid, readyUrl: "/health", timeoutMs: 5000, intervalMs: 50 });
    assert.deepEqual(res, { ok: true });
  } finally { srv.close(); }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/ready.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/ready.ts`：

```ts
import net from "node:net";
import http from "node:http";

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function tcpOnce(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host }, () => { sock.destroy(); resolve(true); });
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
    sock.on("error", () => { sock.destroy(); resolve(false); });
  });
}

function httpOnce(port: number, pathName: string, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: pathName, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

export type ReadyResult = { ok: true } | { ok: false; reason: "timeout" | "died" };

export async function waitReady(opts: {
  port: number;
  pid: number;
  readyUrl?: string;
  timeoutMs: number;
  intervalMs?: number;
}): Promise<ReadyResult> {
  const host = "127.0.0.1";
  const interval = opts.intervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  let tcpOk = false;
  while (Date.now() < deadline) {
    if (!tcpOk) tcpOk = await tcpOnce(opts.port, host);
    // 先判就绪再判存活：双 fork 的服务组长会先退出，但监听已就绪就算成功
    if (tcpOk && (!opts.readyUrl || (await httpOnce(opts.port, opts.readyUrl, host)))) return { ok: true };
    if (!pidAlive(opts.pid)) return { ok: false, reason: "died" };
    await new Promise((r) => setTimeout(r, interval));
  }
  return { ok: false, reason: "timeout" };
}
```

- [ ] **Step 4: 注册测试文件并跑全量**

package.json `test` script 追加 ` tests/ready.test.ts`。
Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ready.ts tests/ready.test.ts package.json
git commit -m "feat: TCP/HTTP readiness polling with child liveness check"
```

---

### Task 5: 归属集成（scan / gc）

**Files:**
- Modify: `src/scan.ts`（`originFromEnv`、`displaySource`）
- Modify: `src/commands/gc.ts`
- Test: `tests/scan.test.ts`

**Interfaces:**
- Consumes: 无（纯扩展现有函数）
- Produces:
  - `originFromEnv` 识别 `PORTMARSHAL_SERVICE=<name>` → 返回 `` `run:${name}` ``，优先级最高（放在函数第一行）
  - `displaySource`：detached 且 origin 以 `run:` 开头时直接显示 origin（不包 `detached (…)`）
  - `gc`：origin 以 `run:` 开头的 detached 进程不进入清理候选

- [ ] **Step 1: 写失败测试**

在 `tests/scan.test.ts` 中找到现有 `originFromEnv` / `displaySource` 相关测试块，追加：

```ts
test("originFromEnv: PORTMARSHAL_SERVICE 优先级最高", () => {
  const env = new Map([
    ["PORTMARSHAL_SERVICE", "web"],
    ["CLAUDECODE", "1"],
    ["TERM_PROGRAM", "iTerm.app"],
  ]);
  assert.equal(originFromEnv((k) => env.get(k)), "run:web");
});

test("displaySource: run: 前缀的 detached 直接显示 run:<name>", () => {
  const p = {
    pid: 1, ports: [3000], procName: "node", command: "node server.js",
    cwd: "/tmp/p", inferredProject: null, source: "detached", origin: "run:web",
  };
  assert.equal(displaySource(p as never), "run:web");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/scan.test.ts`
Expected: FAIL（返回 "claude-code" / "detached (run:web)"）

- [ ] **Step 3: 实现**

`src/scan.ts` `originFromEnv` 函数体第一行加：

```ts
  const svc = lookup("PORTMARSHAL_SERVICE");
  if (svc) return `run:${svc}`;
```

并把函数上方注释的优先级说明改为「portmarshal run 标记 > agent 标记 > IDE 标记 > 终端/ssh」。

`displaySource` 在 `detached (${p.origin})` 那行之前加：

```ts
  if (p.source === "detached" && p.origin?.startsWith("run:")) return p.origin;
```

`src/commands/gc.ts` 的候选过滤改为：

```ts
  const detached = scan.filter(
    (p) => p.source === "detached" && !isNoise(p.procName) && !p.origin?.startsWith("run:"),
  );
```

并在该行加中文注释：`// run -d 托管的服务带 PORTMARSHAL_SERVICE 标记，是被管理的，不是清理对象`

- [ ] **Step 4: 全量测试通过**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scan.ts src/commands/gc.ts tests/scan.test.ts
git commit -m "feat: attribute run -d services as run:<name>, exempt from gc"
```

---

### Task 6: run -d 主流程

**Files:**
- Modify: `src/commands/run.ts`
- Test: `tests/run.test.ts`

**Interfaces:**
- Consumes: `Registry.setRunInfo`（Task 2）、`logFilePath`/`rotateLog`/`tailLines`（Task 3）、`waitReady`/`pidAlive`（Task 4）、`flags.detach`/`flags.waitTimeout`/`flags.readyUrl`（Task 1）
- Produces: `portmarshal run -d` 完整行为；claim / 旧实例检查 / `--restart` 与前台共用同一段代码，仅 spawn 之后分叉

- [ ] **Step 1: 写失败测试**

在 `tests/run.test.ts` 末尾追加（`flagsOf`、`withStateDir`、`loadEntries`、`waitListening` 已存在）：

```ts
test("run -d: 就绪后返回 0，registry 记录 runPid/logFile，服务继续存活", async (t) => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    t.after(() => fs.rm(project, { recursive: true, force: true }));
    const code = await run(flagsOf({
      positional: ["web"], project, prefer: 18830, detach: true,
      rest: [process.execPath, "-e",
        'require("http").createServer((q,r)=>r.end("ok")).listen(process.env.PORT,"127.0.0.1",()=>console.log("server up"))'],
    }));
    assert.equal(code, 0);
    const entry = (await loadEntries(stateDir))[0];
    assert.ok(entry.runPid && entry.runPid > 0);
    assert.ok(entry.logFile);
    assert.equal(entry.released, undefined);
    t.after(() => { try { process.kill(-entry.runPid!, "SIGKILL"); } catch { /* 已退出 */ } });
    // 服务在 run 返回后仍然在监听
    await waitListening(entry.port);
    // 日志已落盘
    const log = await fs.readFile(entry.logFile!, "utf8");
    assert.match(log, /server up/);
  });
});

test("run -d: 命令永不监听 → 超时失败，退出 1，进程被杀，claim 已 release", async () => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    const code = await run(flagsOf({
      positional: ["web"], project, prefer: 18831, detach: true, waitTimeout: 1,
      rest: [process.execPath, "-e", "setInterval(()=>{}, 1000)"],
    }));
    assert.equal(code, 1);
    const entry = (await loadEntries(stateDir))[0];
    assert.equal(entry.released, true);
    assert.equal(entry.runPid, undefined);
    await fs.rm(project, { recursive: true, force: true });
  });
});

test("run -d: 命令立即退出 → 快速失败（不等满超时）", async () => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    const start = Date.now();
    const code = await run(flagsOf({
      positional: ["web"], project, prefer: 18832, detach: true, waitTimeout: 30,
      rest: [process.execPath, "-e", "process.exit(0)"],
    }));
    assert.equal(code, 1);
    assert.ok(Date.now() - start < 10_000);
    assert.equal((await loadEntries(stateDir))[0].released, true);
    await fs.rm(project, { recursive: true, force: true });
  });
});

test("run -d: 日志轮转保留上一次运行", async (t) => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    t.after(() => fs.rm(project, { recursive: true, force: true }));
    const serve = 'require("http").createServer((q,r)=>r.end("ok")).listen(process.env.PORT,"127.0.0.1",()=>console.log("server up"))';
    const args = {
      positional: ["web"], project, prefer: 18833, detach: true,
      rest: [process.execPath, "-e", serve],
    } as const;
    assert.equal(await run(flagsOf({ ...args })), 0);
    let entry = (await loadEntries(stateDir))[0];
    const firstPid = entry.runPid!;
    assert.equal(await run(flagsOf({ ...args, restart: true })), 0);
    entry = (await loadEntries(stateDir)).find((e) => e.name === "web")!;
    t.after(() => { try { process.kill(-entry.runPid!, "SIGKILL"); } catch { /* 已退出 */ } });
    assert.notEqual(entry.runPid, firstPid);
    // 上一次的日志转到了 .old
    const old = await fs.readFile(entry.logFile! + ".old", "utf8");
    assert.match(old, /server up/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/run.test.ts`
Expected: 新增 4 个用例 FAIL（detach 分支不存在，前台模式直接等子进程退出）

- [ ] **Step 3: 实现**

`src/commands/run.ts`：

顶部 import 增加：

```ts
import fs from "node:fs/promises";
import { logFilePath, rotateLog, tailLines } from "../runlog.js";
import { waitReady, pidAlive } from "../ready.js";
```

USAGE 改为：

```ts
const USAGE = "Usage: portmarshal run <name> [-d] [--wait-timeout N] [--ready-url PATH] [--prefer N] [--range A-B] [--project DIR] [--restart] -- <command...>\n";
```

在 `default async function run` 中，claim/旧实例检查之后（`const argv = substitutePort(...)` 处），改为：

```ts
  const argv = substitutePort(flags.rest, port);
  if (flags.detach) return runDetached(name, project, port, argv, registry, flags);
```

其后原前台逻辑保持不动。文件末尾新增：

```ts
/** SIGTERM → 宽限 2s → SIGKILL，作用于整个进程组；组已消失时静默 */
async function terminateGroup(pgid: number): Promise<void> {
  try { process.kill(-pgid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 20; i++) {
    if (!pidAlive(pgid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(-pgid, "SIGKILL"); } catch { /* 组已不存在 */ }
}

async function runDetached(
  name: string, project: string, port: number, argv: string[],
  registry: Registry, flags: Flags,
): Promise<number> {
  const logFile = logFilePath(project, name);
  await rotateLog(logFile);
  const fd = await fs.open(logFile, "a");

  const child = spawn(argv[0], argv.slice(1), {
    stdio: ["ignore", fd.fd, fd.fd],
    detached: true, // 自成进程组：失败清理时信号覆盖整组
    env: { ...process.env, PORT: String(port), PORTMARSHAL_SERVICE: name },
  });
  const spawnErr = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (e) => resolve(e));
  });
  await fd.close(); // 子进程持有 fd 副本，父进程侧即可关闭
  if (spawnErr || child.pid === undefined) {
    process.stderr.write(`portmarshal: failed to start ${argv[0]}: ${spawnErr?.message ?? "no pid"}\n`);
    await registry.release(name, project).catch(() => {});
    return EXIT.ERR;
  }
  child.unref();
  await registry.setRunInfo(name, project, { runPid: child.pid, logFile });

  const ready = await waitReady({
    port, pid: child.pid, readyUrl: flags.readyUrl,
    timeoutMs: (flags.waitTimeout ?? 30) * 1000,
  });
  if (!ready.ok) {
    const why = ready.reason === "died" ? "process exited before becoming ready" : "readiness wait timed out";
    const tail = await tailLines(logFile, 20).catch(() => []);
    process.stderr.write(
      `portmarshal: ${name}@${project} failed to become ready on port ${port}: ${why}\n` +
      (tail.length ? `--- last ${tail.length} log lines (${logFile}) ---\n${tail.join("\n")}\n` : ""),
    );
    await terminateGroup(child.pid);
    await registry.release(name, project).catch(() => {});
    return EXIT.ERR;
  }
  process.stderr.write(
    `portmarshal: ready ${name}@${project} on port ${port} (pid ${child.pid}, logs: ${logFile})\n`,
  );
  return EXIT.OK;
}
```

注意：`Flags` 从 `../cli.js` 已 import；`EXIT`、`Registry`、`spawn` 已有 import。

- [ ] **Step 4: 全量测试通过**

Run: `pnpm test`
Expected: PASS（含新增 4 用例）

- [ ] **Step 5: Commit**

```bash
git add src/commands/run.ts tests/run.test.ts
git commit -m "feat: run -d detached mode with log capture and readiness gate"
```

---

### Task 7: logs 命令

**Files:**
- Create: `src/commands/logs.ts`
- Modify: `src/cli.ts`（注册命令 + HELP）
- Test: `tests/logs.test.ts`（新文件，加入 `test` script）

**Interfaces:**
- Consumes: `tailLines`（Task 3）、`RegistryEntry.logFile`（Task 2）
- Produces:
  - `locateEntry(entries: RegistryEntry[], target: string, project: string): RegistryEntry | undefined`（导出，供测试）——纯数字 target 按端口找（活跃优先，其次 released 的 `port`/`lastPort` 匹配），否则按 `(name, realpath 归一化的 project)`；只返回带 `logFile` 的 entry
  - CLI：`portmarshal logs <name|port> [--project DIR] [-f] [-n N] [--json]`；默认 tail 50 行；`-f` 轮询跟随（200ms，size 回退则从头重读）；找不到 → stderr 提示 + 退出码 2；`--json` 输出 `{ name, project, port, logFile, lines }`（与 `-f` 互斥，同时给出时报错退出 1）

- [ ] **Step 1: 写失败测试**

创建 `tests/logs.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Flags } from "../src/flags.js";
import type { RegistryEntry } from "../src/types.js";
import logs, { locateEntry } from "../src/commands/logs.js";

function flagsOf(over: Partial<Flags>): Flags {
  return {
    json: false, all: false, force: false, gui: false, install: false,
    killDetached: false, restart: false, detach: false, follow: false,
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/logs.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `src/commands/logs.ts`：

```ts
import { realpathSync, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Flags } from "../cli.js";
import { EXIT, type RegistryEntry } from "../types.js";
import { Registry } from "../registry.js";
import { tailLines } from "../runlog.js";

const USAGE = "Usage: portmarshal logs <name|port> [--project DIR] [-f] [-n N] [--json]\n";

function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export function locateEntry(
  entries: RegistryEntry[], target: string, project: string,
): RegistryEntry | undefined {
  if (/^\d+$/.test(target)) {
    const port = Number(target);
    return (
      entries.find((e) => !e.released && e.port === port && e.logFile) ??
      entries.find((e) => (e.port === port || e.lastPort === port) && e.logFile)
    );
  }
  const proj = realpathOrSelf(project);
  return entries.find(
    (e) => e.name === target && realpathOrSelf(e.project) === proj && e.logFile,
  );
}

/** 轮询式 tail -f：size 回退（轮转/截断）时从头重读新文件 */
async function follow(file: string, fromPos: number): Promise<never> {
  let pos = fromPos;
  for (;;) {
    const st = await fs.stat(file).catch(() => null);
    if (st) {
      if (st.size < pos) pos = 0;
      if (st.size > pos) {
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(file, { start: pos, end: st.size - 1 });
          stream.on("data", (chunk) => process.stdout.write(chunk));
          stream.on("end", resolve);
          stream.on("error", reject);
        });
        pos = st.size;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export default async function logs(flags: Flags): Promise<number> {
  const target = flags.positional[0];
  if (!target) {
    process.stderr.write(USAGE);
    return EXIT.ERR;
  }
  if (flags.json && flags.follow) {
    process.stderr.write("--json cannot be combined with -f/--follow\n");
    return EXIT.ERR;
  }
  const project = path.resolve(flags.project ?? process.cwd());
  const entries = await new Registry().load();
  const entry = locateEntry(entries, target, project);
  if (!entry?.logFile) {
    process.stderr.write(`No run logs found for ${target} (services started with portmarshal run -d keep logs)\n`);
    return EXIT.NOT_FOUND;
  }
  const n = flags.lines ?? 50;
  let lines: string[];
  try {
    lines = await tailLines(entry.logFile, n);
  } catch {
    process.stderr.write(`Log file is gone: ${entry.logFile}\n`);
    return EXIT.NOT_FOUND;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      name: entry.name, project: entry.project, port: entry.port, logFile: entry.logFile, lines,
    }, null, 2) + "\n");
    return EXIT.OK;
  }
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
  if (flags.follow) {
    const size = (await fs.stat(entry.logFile).catch(() => null))?.size ?? 0;
    await follow(entry.logFile, size); // 永不返回，Ctrl-C 退出
  }
  return EXIT.OK;
}
```

`src/cli.ts`：`COMMANDS` 中 `gc` 之后加 `logs: () => import("./commands/logs.js"),`；HELP 的 `run` 行替换为、并在其后加 `logs` 行：

```
  portmarshal run <name> [-d] [--wait-timeout N] [--ready-url PATH] [--prefer N] [--range A-B] [--project DIR] [--restart] -- <command...>
  portmarshal logs <name|port> [--project DIR] [-f] [-n N] [--json]
```

- [ ] **Step 4: 注册测试文件并跑全量**

package.json `test` script 追加 ` tests/logs.test.ts`。
Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/logs.ts src/cli.ts tests/logs.test.ts package.json
git commit -m "feat: logs command with tail, follow, and JSON output"
```

---

### Task 8: list 的 dead 提示

**Files:**
- Modify: `src/commands/list.ts`
- Test: `tests/render.test.ts`（若该文件只测 render 纯函数，则将判定逻辑抽为可测导出）

**Interfaces:**
- Consumes: `pidAlive`（Task 4）、`RegistryEntry.runPid`（Task 2）
- Produces: `isDeadRun(e: MergedEntry, alive?: (pid: number) => boolean): boolean`（从 `src/commands/list.ts` 导出）——state 为 `reserved` 且 `reg.runPid` 存在且进程不存活时为 true；表格末列显示红色 `dead`

- [ ] **Step 1: 写失败测试**

在 `tests/render.test.ts` 末尾追加：

```ts
import { isDeadRun } from "../src/commands/list.js";

test("isDeadRun: reserved + runPid 已死 → true；其余 false", () => {
  const dead = { port: 3000, state: "reserved", reg: { name: "web", project: "/p", port: 3000, claimedAt: "", runPid: 999999 } };
  const alive = { port: 3000, state: "reserved", reg: { name: "web", project: "/p", port: 3000, claimedAt: "", runPid: process.pid } };
  const plain = { port: 3000, state: "reserved", reg: { name: "web", project: "/p", port: 3000, claimedAt: "" } };
  assert.equal(isDeadRun(dead as never), true);
  assert.equal(isDeadRun(alive as never), false);
  assert.equal(isDeadRun(plain as never), false);
  assert.equal(isDeadRun({ ...dead, state: "active" } as never), false);
});
```

（若 `tests/render.test.ts` 顶部没有 `test`/`assert` 之外的 import 冲突，直接加；import 放文件顶部。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/render.test.ts`
Expected: FAIL（isDeadRun 不存在）

- [ ] **Step 3: 实现**

`src/commands/list.ts`：

```ts
import { pidAlive } from "../ready.js";

/** run -d 托管的 claim：进程已死但记录还在（无监听）→ 提示 dead */
export function isDeadRun(e: MergedEntry, alive: (pid: number) => boolean = pidAlive): boolean {
  return e.state === "reserved" && e.reg?.runPid !== undefined && !alive(e.reg.runPid);
}
```

表格行的末列（原 `e.state === "drift" ? …` 处）改为：

```ts
    e.state === "drift" ? `↔ ${e.driftPeer}` : isDeadRun(e) ? `${C.red}dead${C.reset}` : "",
```

- [ ] **Step 4: 全量测试通过**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/list.ts tests/render.test.ts
git commit -m "feat: list marks dead detached runs"
```

---

### Task 9: 文档与收尾验证

**Files:**
- Modify: `README.md`、`README.zh-CN.md`（Usage/命令表增加 `run -d`、`logs`；简述就绪等待与日志位置）
- Modify: `CHANGELOG.md`（新增 0.6.0 段）
- Test: 全量 + 冒烟

**Interfaces:** 无代码接口；文档描述必须与实现一致（旗标名、默认值 30s/50 行、日志路径 `~/.portmarshal/logs/`、退出码语义）。

- [ ] **Step 1: 更新两份 README**

在现有 `run` 命令说明处补充 `-d` 模式（含示例）：

```bash
# Start a dev server in the background; returns once the port accepts connections
portmarshal run -d web --prefer 3000 -- pnpm dev

# Health-gated readiness and custom timeout
portmarshal run -d api --ready-url /health --wait-timeout 60 -- pnpm start

# Tail its logs
portmarshal logs web -f
```

说明要点：默认 TCP 就绪、30 秒超时；失败时打印日志尾部并自动清理；日志在 `~/.portmarshal/logs/`，保留当前 + 上一次（`.old`）；`stop` 照常走护栏；崩溃不自动重启，`list` 显示 `dead`。README.zh-CN.md 写对应中文。

- [ ] **Step 2: 更新 CHANGELOG**

```markdown
## 0.6.0 — <当天日期>

- Add `portmarshal run -d`: detached mode that captures stdout/stderr to `~/.portmarshal/logs/`, waits for TCP (or `--ready-url` HTTP) readiness before returning, and cleans up the claim and process group on failure
- Add `portmarshal logs <name|port>` with `-n`, `-f` (follow), and `--json`
- Attribute services started by `run -d` as `run:<name>` via the `PORTMARSHAL_SERVICE` env marker; they are exempt from `gc` candidates
- `list` marks a managed run whose process has died as `dead`
- Registry entries record `runPid`/`logFile`; log files survive release so the last run stays inspectable
```

- [ ] **Step 3: 全量验证**

```bash
pnpm build && pnpm test && pnpm smoke
```

Expected: 全部 PASS（smoke 会重新 build 一次，无妨）

- [ ] **Step 4: 手工冒烟（真实 CLI 路径）**

```bash
PORTMARSHAL_STATE_DIR=$(mktemp -d) sh -c '
  node dist/cli.js run -d demo --prefer 18899 --project /tmp -- node -e "require(\"http\").createServer((q,r)=>r.end(\"ok\")).listen(process.env.PORT,\"127.0.0.1\")" &&
  curl -s http://127.0.0.1:18899/ &&
  node dist/cli.js logs demo --project /tmp &&
  node dist/cli.js stop 18899 --force
'
```

Expected: 打印 ready 行 → `ok` → 日志内容 → stop 成功。

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh-CN.md CHANGELOG.md
git commit -m "docs: document run -d, logs, and readiness wait"
```
