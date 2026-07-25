# `portmarshal run` 设计

日期：2026-07-25 · 状态：已评审通过，待实现

## 目标

补全 claim → 启动 → 退出的生命周期闭环：一条命令完成「拿端口、注入端口、监督子进程、退出自动 release」，从源头消灭 detached dev server 和忘记 release 的注册表垃圾。

已确认的三个关键决策：

1. **仅前台监督**：run 保持前台、透传子进程输出。Agent 需要后台运行时用自己的机制（Claude Code 后台任务、tmux 等）。不做 `--detach`，符合设计 spec 的「不做 daemon」原则。
2. **端口注入 = 环境变量 + 占位符**：始终注入 `PORT`；子命令参数中的 `{port}` 占位符替换为实际端口，覆盖 Vite 类只认命令行参数的框架。
3. **旧实例默认拦截**：同名 claim 的端口仍被本项目旧实例监听时，默认打印归属并 exit 3；`--restart` 显式请求走护栏 stop 后重启。

## CLI 接口

```
portmarshal run <name> [--prefer N] [--range A-B] [--project DIR] [--restart] -- <command...>
```

- `--` 是必需分隔符，之后所有内容原样作为子进程 argv（`spawn` 数组形式，不经 shell）。缺 `--` 或命令为空 → 打印 usage，exit 1。
- 示例：

```bash
portmarshal run web --prefer 3000 -- npm run dev              # Next/CRA 类，读 PORT env
portmarshal run web --prefer 5173 -- pnpm vite --port {port}  # Vite 类，占位符
```

## 执行流程

1. **claim**：复用 `Registry.claim`（同 claim 命令的参数与 `claimedBy` 探测），拿到端口。
2. **旧实例检测**：`scanListeners()` 查该端口是否仍在监听。能走到这一步说明监听者是本项目自己的——claim 的重验证保证端口被外人占用时已换新端口。
   - 无 `--restart`：打印 whois 风格归属信息（PID、命令、来源），提示 `--restart` 或 `portmarshal stop`，exit 3（与 stop 拦截语义一致）。
   - 有 `--restart`：以合成 Flags 调用现有 `stop` 命令函数（不带 `--force` 与 `--json`，护栏保留），成功后重新 claim 一次——stop 会 `markReleasedByPort`，重新 claim 依靠 `lastPort` 粘性拿回同一端口并恢复 active 记录。stop 非 0 则透传其退出码。
3. **注入与启动**：
   - 环境变量：注入 `PORT=<port>`（继承父环境）。
   - 占位符：子命令每个参数中的所有 `{port}` 替换为端口号。
   - `spawn(cmd, args, { stdio: "inherit", detached: true })`——`detached: true` 让子进程自成进程组，后续信号发给整组（`kill(-pid)`），确保 `npm run dev` 底下的孙进程（真正的 dev server）不被落下。
4. **前台监督**：stdio inherit 透传输出，等待子进程退出。

## 信号与退出

- 收到 SIGINT / SIGTERM / SIGHUP：第一次转发 SIGTERM 到整个进程组；再次收到任一信号则 SIGKILL 进程组（与 stop 的 TERM→KILL 降级一致）。
- 子进程退出后：`registry.release(name, project)`（转 `released` 并记 `lastPort`，下次 run 粘回同端口），然后：
  - 正常退出 → 以子进程退出码退出；
  - 信号终止 → 以 `128 + signal` 退出（shell 惯例）。
- supervisor 被 SIGKILL（无法拦截）：claim 留在 active，子进程继续跑。下次 `run` 的旧实例检测与现有 `gc` 都能兜住，不产生新的不一致类型。

## 注册表

不改 schema。run 只组合现有原语（claim / release / markReleasedByPort），零新增字段。

## 错误与退出码

| 场景 | 行为 |
|---|---|
| 缺 name / 缺 `--` / 空命令 | usage，exit 1 |
| 端口被本项目旧实例占用且无 `--restart` | 归属信息，exit 3 |
| `--restart` 时 stop 失败 | 透传 stop 退出码 |
| 注册表锁超时 | exit 4（同 claim） |
| 子进程 spawn 失败（命令不存在等） | 报错并 release，exit 1 |
| 子进程正常/异常退出 | release 后透传退出码 / 128+signal |

## 明确不做（本期）

- `--detach` 后台模式与日志文件管理。
- 启动后的端口漂移监视（子进程无视 PORT 绑到别的端口时，交给现有 list/watch 的 drift ⚠ 标记）。
- 重启策略 / crash 自动拉起（pm2 的领域）。

## 测试

- `tests/run.test.ts`：
  - 单测：参数解析（`--` 分隔、缺参报错）、`{port}` 占位符替换。
  - 集成：用真实 `node -e` HTTP server 子进程验证 PORT 注入、退出后注册表转 released+lastPort、SIGTERM 转发整个进程组。
- `tests/smoke.test.ts` 增加一条 run 冒烟路径（CI 双平台跑真实监听）。

## 文档同步

README（Commands 表 + Agent integration 推荐用法改为 run 优先）、README.zh-CN、`integrations/claude-code/skills/portmarshal`、CHANGELOG。

## 实现落点

- 新增 `src/commands/run.ts`（约 130 行）。
- `src/cli.ts` 的 `COMMANDS` 表注册 `run`，flags 解析补 `--restart`。
- 其余全部复用现有模块，无重构。
