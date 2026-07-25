# `portmarshal run` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `portmarshal run <name> -- <command...>`：一条命令完成拿端口、注入端口、前台监督子进程、退出自动 release。

**Architecture:** 组合现有原语（`Registry.claim/release/markReleasedByPort`、`scanListeners`、`stop` 命令），不改注册表 schema。CLI 层为 `parseFlags` 增加 `--` 截断与 `--restart`；`run` 命令 claim 后检测旧实例（默认 exit 3，`--restart` 走护栏 stop 后重新 claim），然后 `spawn(detached:true)` 让子进程自成进程组，信号转发到整组，子进程退出后 release 并透传退出码。

**Tech Stack:** Node.js ≥ 18.17，TypeScript（ESM / NodeNext），`node:test` + tsx，零运行时依赖。

**Spec:** `docs/specs/2026-07-25-run-command-design.md`

## Global Constraints

- 零 npm 运行时依赖；`engines.node >= 18.17`；仅 macOS/Linux。
- ESM 工程（`"type": "module"`），源码内相对 import 必须带 `.js` 后缀（NodeNext）。
- CLI 用户可见输出为英文（v0.3.0 起 English-first）；代码注释沿用现有中文风格，只注释代码本身说不清的约束。
- 测试用 `node:test` + `assert/strict`，测试文件需显式加进 `package.json` 的 `test` script 文件列表。
- 注册表隔离：测试通过 `PORTMARSHAL_STATE_DIR` 环境变量或 `new Registry(dir)` 指向临时目录，绝不能碰 `~/.portmarshal`。
- 每个任务结束跑 `pnpm test`（Task 5 用 `pnpm smoke`）确认全绿后再 commit。

---

### Task 1: 抽出 `src/flags.ts`，支持 `--` 截断与 `--restart`

**背景（为什么要抽文件）：** `src/cli.ts` 顶层直接执行 `main()`，测试 import 它会误触发命令分发。`Flags`/`parseFlags` 移到无副作用的 `src/flags.ts`；各命令文件对 `Flags` 是 type-only import（编译后擦除），保持 `cli.ts` re-export 类型即可，命令文件一个都不用改。

**Files:**
- Create: `src/flags.ts`
- Modify: `src/cli.ts`（删除 Flags/parseFlags 定义，改为 import + type re-export）
- Create: `tests/flags.test.ts`
- Modify: `package.json`（test script 增加 `tests/flags.test.ts`）

**Interfaces:**
- Produces: `src/flags.ts` 导出 `interface Flags`（新增字段 `restart: boolean; rest: string[]`）与 `parseFlags(args: string[]): Flags`；`src/cli.ts` 保留 `export type { Flags }` 供既有命令文件的 `import type { Flags } from "../cli.js"` 继续工作。

- [ ] **Step 1: 写失败测试**

创建 `tests/flags.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/flags.test.ts`
Expected: FAIL（Cannot find module `src/flags.js`）

- [ ] **Step 3: 实现 `src/flags.ts`**

把 `src/cli.ts` 的 `Flags` 接口与 `parseFlags` 函数整体移入新文件 `src/flags.ts`，并做三处修改（其余逻辑逐行照搬，不要改动现有 case）：

```ts
export interface Flags {
  json: boolean;
  all: boolean;
  force: boolean;
  gui: boolean;
  install: boolean;
  killDetached: boolean;
  restart: boolean;
  project?: string;
  prefer?: number;
  range?: [number, number];
  positional: string[];
  /** `--` 之后的原样参数，交给 run 作为子进程 argv */
  rest: string[];
}

export function parseFlags(args: string[]): Flags {
  const f: Flags = {
    json: false, all: false, force: false, gui: false,
    install: false, killDetached: false, restart: false,
    positional: [], rest: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--": f.rest = args.slice(i + 1); i = args.length; break;
      case "--restart": f.restart = true; break;
      // ……以下与原 cli.ts 中的全部 case 完全一致，逐行照搬（--json/--all/--force/--gui/
      // --install/--kill-detached/--kill-orphans/--project/--prefer/--range/default）
    }
  }
  return f;
}
```

然后修改 `src/cli.ts`：删除其中的 `Flags` 接口与 `parseFlags` 函数，文件头部改为：

```ts
#!/usr/bin/env node
import fs from "node:fs/promises";
import { EXIT } from "./types.js";
import { parseFlags } from "./flags.js";

export type { Flags } from "./flags.js";
```

其余（HELP、COMMANDS、main）不动。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm tsx --test tests/flags.test.ts && pnpm test && pnpm build`
Expected: 全部 PASS，tsc 无错误（证明命令文件的 `import type { Flags } from "../cli.js"` 仍然成立）

- [ ] **Step 5: 更新 package.json test script 并提交**

`package.json` 的 `test` script 改为（在文件列表末尾追加）：

```
"test": "tsx --test tests/scan.test.ts tests/registry.test.ts tests/merge.test.ts tests/stop.test.ts tests/menubar.test.ts tests/render.test.ts tests/flags.test.ts"
```

```bash
git add src/flags.ts src/cli.ts tests/flags.test.ts package.json
git commit -m "refactor: extract side-effect-free flags module; parse -- and --restart"
```

---

### Task 2: 提取共享的 claim 辅助（`projectOwnsPort` / `defaultClaimedBy`）

claim.ts 里的「候选端口是否属于本项目」闭包和 `claimedBy` 探测即将被 run 复用，先提取，DRY。

**Files:**
- Modify: `src/scan.ts`（文件末尾追加 `projectOwnsPort`）
- Modify: `src/registry.ts`（追加 `defaultClaimedBy`）
- Modify: `src/commands/claim.ts`（改用两个新辅助）

**Interfaces:**
- Consumes: `scanListeners(): Promise<ProcessInfo[]>`、`resolveProjectDir(proc): string | null`（scan.ts 已有导出）。
- Produces:
  - `src/scan.ts`: `export function projectOwnsPort(project: string): (port: number) => Promise<boolean>`（内部懒执行且只 scan 一次）。
  - `src/registry.ts`: `export function defaultClaimedBy(): string`。

- [ ] **Step 1: 在 `src/scan.ts` 末尾追加**

```ts
/** 生成 claim 重验证回调：候选端口的监听者是否归属该项目（含父子目录）。scan 只做一次并缓存 */
export function projectOwnsPort(project: string): (port: number) => Promise<boolean> {
  let scanPromise: Promise<ProcessInfo[]> | undefined;
  return async (candidate) => {
    scanPromise ??= scanListeners();
    const proc = (await scanPromise).find((p) => p.ports.includes(candidate));
    const owner = proc ? resolveProjectDir(proc) : null;
    if (!owner) return false;
    return owner === project || owner.startsWith(project + "/") || project.startsWith(owner + "/");
  };
}
```

（若 `ProcessInfo` 未在 scan.ts 中 import，则从 `./types.js` 补一个 type import。）

- [ ] **Step 2: 在 `src/registry.ts` 末尾追加**

```ts
export function defaultClaimedBy(): string {
  return process.env.CLAUDECODE ? "claude-code" : (process.env.TERM_PROGRAM ?? "cli");
}
```

- [ ] **Step 3: 改写 `src/commands/claim.ts` 使用新辅助**

claim.ts 的 `registry.claim({...})` 调用替换为：

```ts
const { port, reused, previousPort } = await registry.claim({
  name, project,
  prefer: flags.prefer,
  range: flags.range,
  claimedBy: defaultClaimedBy(),
  portOwnedByProject: projectOwnsPort(project),
});
```

同步调整 import：`import { Registry, LockTimeoutError, defaultClaimedBy } from "../registry.js";`、`import { projectOwnsPort } from "../scan.js";`，并删掉不再使用的 `scanListeners`/`resolveProjectDir` import 与 `scanPromise` 局部变量。

- [ ] **Step 4: 验证既有测试全绿**

Run: `pnpm test && pnpm build`
Expected: 全部 PASS（行为等价重构，无新测试）

- [ ] **Step 5: 提交**

```bash
git add src/scan.ts src/registry.ts src/commands/claim.ts
git commit -m "refactor: share projectOwnsPort and defaultClaimedBy helpers"
```

---

### Task 3: `run` 核心——claim、注入、前台监督、自动 release

**Files:**
- Create: `src/commands/run.ts`
- Modify: `src/cli.ts`（COMMANDS 注册 + HELP 行）
- Create: `tests/run.test.ts`
- Modify: `package.json`（test script 追加 `tests/run.test.ts`）

**Interfaces:**
- Consumes: `Registry`（`claim/release`）、`defaultClaimedBy`（registry.js）、`projectOwnsPort`（scan.js）、`Flags`（含 Task 1 的 `rest`/`restart`）。
- Produces: `src/commands/run.ts` 导出 `default async function run(flags: Flags): Promise<number>` 与 `export function substitutePort(args: string[], port: number): string[]`（Task 4 在同文件上继续叠加旧实例逻辑）。

- [ ] **Step 1: 写失败测试**

创建 `tests/run.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/run.test.ts`
Expected: FAIL（Cannot find module `src/commands/run.js`）

- [ ] **Step 3: 实现 `src/commands/run.ts`**

```ts
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { Registry, LockTimeoutError, defaultClaimedBy } from "../registry.js";
import { projectOwnsPort } from "../scan.js";

const USAGE = "Usage: portmarshal run <name> [--prefer N] [--range A-B] [--restart] -- <command...>\n";
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export function substitutePort(args: string[], port: number): string[] {
  return args.map((a) => a.split("{port}").join(String(port)));
}

async function claimPort(registry: Registry, name: string, project: string, flags: Flags): Promise<number> {
  const { port } = await registry.claim({
    name, project,
    prefer: flags.prefer,
    range: flags.range,
    claimedBy: defaultClaimedBy(),
    portOwnedByProject: projectOwnsPort(project),
  });
  return port;
}

export default async function run(flags: Flags): Promise<number> {
  const name = flags.positional[0];
  if (!name || flags.rest.length === 0) {
    process.stderr.write(USAGE);
    return EXIT.ERR;
  }
  const project = path.resolve(flags.project ?? process.cwd());
  const registry = new Registry();

  let port: number;
  try {
    port = await claimPort(registry, name, project, flags);
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      process.stderr.write(`portmarshal: ${e.message}\n`);
      return EXIT.LOCK_TIMEOUT;
    }
    throw e;
  }

  const argv = substitutePort(flags.rest, port);
  process.stderr.write(`portmarshal: serving ${name}@${project} on port ${port}\n`);
  const child = spawn(argv[0], argv.slice(1), {
    stdio: "inherit",
    detached: true, // 子进程自成进程组：信号发给整组，覆盖 npm run dev 之下真正监听的孙进程
    env: { ...process.env, PORT: String(port) },
  });

  return new Promise<number>((resolve) => {
    let escalated = false;
    const forward = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, escalated ? "SIGKILL" : "SIGTERM"); } catch { /* 组已不存在 */ }
      escalated = true;
    };
    const finish = (code: number) => {
      for (const sig of FORWARDED) process.removeListener(sig, forward);
      void registry.release(name, project).then(() => resolve(code));
    };
    for (const sig of FORWARDED) process.on(sig, forward);
    child.once("error", (err) => {
      process.stderr.write(`portmarshal: failed to start ${argv[0]}: ${err.message}\n`);
      finish(EXIT.ERR);
    });
    child.once("exit", (code, signal) => {
      finish(signal ? 128 + (os.constants.signals[signal] ?? 15) : (code ?? EXIT.ERR));
    });
  });
}
```

- [ ] **Step 4: 注册命令**

`src/cli.ts` 的 `COMMANDS` 表加一行：

```ts
  run: () => import("./commands/run.js"),
```

HELP 的 Usage 段在 `claim` 行之后加：

```
  portmarshal run <name> [--prefer N] [--range A-B] [--restart] -- <command...>
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm tsx --test tests/run.test.ts && pnpm build`
Expected: 全部 PASS，tsc 无错误

- [ ] **Step 6: 更新 package.json test script 并提交**

`test` script 文件列表末尾追加 `tests/run.test.ts`，然后：

```bash
pnpm test
git add src/commands/run.ts src/cli.ts tests/run.test.ts package.json
git commit -m "feat: add run command with port injection and auto-release"
```

---

### Task 4: 旧实例拦截（exit 3）与 `--restart`

**Files:**
- Modify: `src/commands/run.ts`
- Modify: `tests/run.test.ts`（追加两条测试）

**Interfaces:**
- Consumes: `scanListeners`、`resolveProjectDir`、`displaySource`（scan.js 已有导出）；`stop` 命令默认导出 `(flags: Flags) => Promise<number>`。
- Produces: run 在 claim 与 spawn 之间插入旧实例检测；对外行为见测试。

- [ ] **Step 1: 追加失败测试**

在 `tests/run.test.ts` 末尾追加（顶部补 `import net from "node:net";`、`import { spawn } from "node:child_process";`、`import { Registry } from "../src/registry.js";`）：

```ts
function waitListening(port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      const sock = net.connect({ port, host: "127.0.0.1" }, () => { sock.destroy(); resolve(); });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("timeout waiting for port"));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

test("run: 端口被本项目旧实例监听且无 --restart 时退出 3", async () => {
  await withStateDir(async () => {
    // 测试进程自身监听 claim 到的端口——scan 会把它归属到本进程 cwd（仓库根目录）
    const project = process.cwd();
    const registry = new Registry();
    const { port } = await registry.claim({ name: "old", project, claimedBy: "test" });
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
    try {
      const code = await run(flagsOf({
        positional: ["old"], project,
        rest: [process.execPath, "-e", "process.exit(0)"],
      }));
      assert.equal(code, 3);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

test("run --restart: 护栏停掉本项目旧实例后在同端口重启", async (t) => {
  await withStateDir(async (stateDir) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-proj-"));
    t.after(() => fs.rm(project, { recursive: true, force: true }));
    const registry = new Registry();
    const { port } = await registry.claim({ name: "web", project, claimedBy: "test" });
    // 旧实例：cwd 指向 project 的真实监听子进程，scan 可归属
    const oldInstance = spawn(
      process.execPath,
      ["-e", `require("http").createServer((_q,r)=>r.end("ok")).listen(${port},"127.0.0.1")`],
      { cwd: project, stdio: "ignore" },
    );
    t.after(() => { oldInstance.kill("SIGKILL"); });
    await waitListening(port);

    const code = await run(flagsOf({
      positional: ["web"], project, restart: true,
      rest: [process.execPath, "-e", "process.exit(0)"],
    }));
    assert.equal(code, 0);
    // 旧实例已被护栏 stop 终止
    assert.ok(oldInstance.exitCode !== null || oldInstance.signalCode !== null);
    // 同端口粘回，且新进程退出后 release
    const entry = (await loadEntries(stateDir)).find((e) => e.name === "web");
    assert.ok(entry);
    assert.equal(entry.released, true);
    assert.equal(entry.lastPort, port);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm tsx --test tests/run.test.ts`
Expected: 两条新测试 FAIL（无拦截时 run 直接 spawn，旧实例测试拿到的退出码不是 3 / 重启测试端口被占子进程起不来）

- [ ] **Step 3: 实现旧实例检测**

`src/commands/run.ts` 调整 import：

```ts
import { projectOwnsPort, scanListeners, resolveProjectDir, displaySource } from "../scan.js";
import stop from "./stop.js";
```

在 `claimPort` 成功之后、`const argv = ...` 之前插入（包在同一个 try/catch 里，LockTimeoutError 处理不变）：

```ts
    // claim 重验证保证：端口仍在监听 ⇒ 监听者归属本项目（外人占用时 claim 已换新端口）
    const running = (await scanListeners()).find((p) => p.ports.includes(port));
    if (running) {
      if (!flags.restart) {
        process.stderr.write(
          `Port ${port} is already served by ${displaySource(running)} · ${resolveProjectDir(running) ?? "?"} · pid ${running.pid}\n` +
          `  Command: ${running.command}\n` +
          `  Keep using the running instance, or re-run with --restart to replace it\n`,
        );
        return EXIT.BLOCKED;
      }
      const stopped = await stop({ ...flags, project, positional: [String(port)], rest: [], force: false, gui: false, json: false });
      if (stopped !== EXIT.OK) return stopped;
      // stop 已把记录转 released；重新 claim 依靠 lastPort 粘回同端口并恢复 active 记录
      port = await claimPort(registry, name, project, flags);
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm tsx --test tests/run.test.ts && pnpm test && pnpm build`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/commands/run.ts tests/run.test.ts
git commit -m "feat: run blocks on a live old instance and supports guarded --restart"
```

---

### Task 5: 冒烟——信号转发整个进程组

真实 CLI 二进制 + `sh -c` 制造孙进程，验证 SIGTERM 转发覆盖整组、退出码 143、注册表 release。

**Files:**
- Modify: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: smoke 文件已有的 `CLI`、`stateDir`、`projDir`、`waitListening`。

- [ ] **Step 1: 追加冒烟测试**

在 `tests/smoke.test.ts` 末尾追加：

```ts
function waitFree(port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      const sock = net.connect({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("timeout waiting for port to free"));
        else setTimeout(tryOnce, 150);
      });
      sock.on("error", () => { sock.destroy(); resolve(); });
    };
    tryOnce();
  });
}

test("run: SIGTERM 转发到进程组（含孙进程）并自动 release", async () => {
  const runPort = 18931;
  // sh -c 制造孙进程：sh 是子进程，真正监听的 node 是孙进程
  const script =
    'require("http").createServer((_q,r)=>r.end("ok")).listen(process.env.PORT,"127.0.0.1");setInterval(()=>{},1000)';
  const runner = spawn(
    "node",
    [CLI, "run", "smoke-run", "--prefer", String(runPort), "--project", projDir,
      "--", "sh", "-c", `"${process.execPath}" -e '${script}'`],
    { cwd: projDir, env: { ...process.env, PORTMARSHAL_STATE_DIR: stateDir }, stdio: "ignore" },
  );
  await waitListening(runPort);

  runner.kill("SIGTERM");
  const code = await new Promise<number>((resolve) => {
    runner.once("exit", (c, s) => resolve(s ? -1 : (c ?? -1)));
  });
  assert.equal(code, 143); // 128 + SIGTERM(15)：supervisor 收到信号→转发进程组→子进程被 TERM

  await waitFree(runPort); // 孙进程也被组信号终止，端口已释放
  const reg = JSON.parse(await fs.readFile(path.join(stateDir, "registry.json"), "utf8")) as
    Array<{ name: string; released?: boolean; lastPort?: number }>;
  const entry = reg.find((e) => e.name === "smoke-run");
  assert.ok(entry);
  assert.equal(entry.released, true);
  assert.equal(entry.lastPort, runPort);
});
```

- [ ] **Step 2: 运行冒烟确认通过**

Run: `pnpm smoke`
Expected: 全部 PASS（含既有冒烟用例；CI 会在 macOS 与 Linux 双平台跑）

- [ ] **Step 3: 提交**

```bash
git add tests/smoke.test.ts
git commit -m "test: smoke-verify run forwards signals to the whole process group"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `integrations/claude-code/skills/portmarshal/SKILL.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README.md**

Commands 表在 `claim` 行之后插入：

```
| `portmarshal run <name> [--prefer N] [--restart] -- <command...>` | Claim a port, inject it as `PORT` and `{port}`, supervise the command in the foreground, auto-release on exit |
```

“Typical agent startup” 代码块替换为：

````
```bash
portmarshal run web --prefer 3000 -- npm run dev
# frameworks that only accept a CLI flag:
portmarshal run web --prefer 5173 -- pnpm vite --port {port}
```

`run` claims a sticky port, injects it as the `PORT` environment variable (and replaces `{port}` placeholders in the command), streams output in the foreground, forwards signals to the whole process group, and releases the claim when the command exits. If the port is still served by a previous instance of the same project, `run` refuses with exit code 3; add `--restart` to stop it through the ownership guard first. `claim` remains available for scripts that manage the process themselves.
````

Agent integration 政策块的第一条改为：

```text
- Start dev servers with `portmarshal run <service> --prefer <default> -- <command>`; it injects PORT/{port} and auto-releases on exit. Use `PORT=$(portmarshal claim ...)` only when you must manage the process yourself.
```

- [ ] **Step 2: README.zh-CN.md**

对照 README.md 的三处改动做中文同步：命令表加 `run` 行（“预留端口并注入 `PORT`/`{port}`，前台监督子进程，退出自动释放”）；典型启动示例换成 `portmarshal run` 两例；agent 集成政策第一条改为 run 优先。

- [ ] **Step 3: SKILL.md**

「启动 dev server 之前」一节替换为：

````
## 启动 dev server

优先用 `run`：预留端口、注入 `PORT`（命令里的 `{port}` 占位符也会被替换）、前台监督、退出自动释放：

```bash
portmarshal run <服务名> --prefer <默认端口> -- npm run dev
portmarshal run <服务名> --prefer 5173 -- pnpm vite --port {port}
```

- 退出码 3：同项目旧实例还在监听。想换掉它就加 `--restart`（走护栏 stop，不会误杀别人的服务）。
- 需要自己管理进程时才用 `PORT=$(portmarshal claim <服务名> --prefer <默认端口>)`。
````

- [ ] **Step 4: CHANGELOG.md**

顶部插入：

```markdown
## Unreleased

- Add `portmarshal run <name> -- <command...>`: claim a port, inject `PORT` and `{port}` placeholders, supervise the command in the foreground, forward signals to the whole process group, and auto-release the claim on exit
- `run` refuses to start over a live old instance of the same project (exit code 3); `--restart` stops it through the existing ownership guard first
```

- [ ] **Step 5: 提交**

```bash
git add README.md README.zh-CN.md integrations/claude-code/skills/portmarshal/SKILL.md CHANGELOG.md
git commit -m "docs: document the run command"
```
