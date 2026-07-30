# run --detach 后台托管 + logs + 就绪等待 设计

日期：2026-07-30
状态：已与用户确认

## 目标

补齐 agent 工作流闭环：「起 dev server → 确认就绪 → 继续干别的（跑测试等）」。当前 `run` 只有前台模式，agent 只能自己 `&` 后台化，脱离 PortMarshal 监管变成 detached 进程。

新增三个能力：

1. `run -d`：后台托管模式，日志落盘，registry 记录托管信息
2. 就绪等待：`run -d` 默认等到服务真正可用才返回
3. `logs` 命令：查看/跟随后台服务日志

## 已确认的决策

- **返回时机**：`run -d` 等就绪后返回（退出码 0 = 服务已可用），不采用「立即返回 + 单独 wait 命令」
- **崩溃策略**：不自动重启。崩了记录状态，`list` 显示 dead，用 `logs` 查原因
- **日志保留**：当前 + 上一次（启动时旧日志改名 `.log.old`）
- **架构**：无 supervisor。`run -d` spawn 完就退出，不留任何常驻进程。代价（服务崩溃后无人 release claim、无退出码记录）由现有机制兜底：claim 复用时重验证、`list` 对「有 claim 无监听」标 ⚠ 并加 dead 提示

## 1. `run -d` 流程

```
portmarshal run -d <name> [--wait-timeout N] [--ready-url PATH] [--prefer N] [--range A-B] [--project DIR] [--restart] -- <cmd...>
```

1. claim 端口、已有实例检查、`--restart` 处置：完全复用现有 `run.ts` 逻辑
2. 日志轮转：`~/.portmarshal/logs/<hash8>-<name>.log`（`hash8` = realpath 后项目路径的 sha256 前 8 位 hex；`name` 做文件名安全化）。已存在则先改名为 `.log.old` 覆盖旧的 `.log.old`
3. spawn 子进程：
   - `detached: true`（自成进程组，信号可覆盖整组）
   - `stdio: ["ignore", fd, fd]`（stdout/stderr 同一日志 fd）
   - env 注入 `PORT=<port>` 与 `PORTMARSHAL_SERVICE=<name>` 标记；argv 中 `{port}` 占位符替换与前台一致
   - `child.unref()`，父进程等待就绪后退出
4. registry entry 写入可选字段 `runPid`（子进程 pid，即进程组长）与 `logFile`（绝对路径）。JSON 向后兼容：旧版本读到未知字段忽略即可
5. 就绪等待：
   - 每 100ms 探测一次 `127.0.0.1:<port>` TCP 可连通；默认超时 30 秒，`--wait-timeout <秒>` 调整
   - 指定 `--ready-url <path>` 时（如 `/health`），TCP 通之后继续轮询 `http://127.0.0.1:<port><path>`，2xx/3xx 视为就绪
   - 每轮同时用 `kill(pid, 0)` 检测子进程是否已死，死了立即走失败路径（不等超时）
6. 成功：stderr 打印 `portmarshal: ready <name>@<project> on port <port> (pid <pid>, logs: <path>)`，退出码 0
7. 失败（超时或子进程早死）：打印日志尾部约 20 行到 stderr，对进程组 SIGTERM→宽限→SIGKILL，release claim，退出码 1（`EXIT.ERR`）

前台 `run`（不带 `-d`）行为完全不变，就绪等待不适用于前台模式。

## 2. `logs` 命令

```
portmarshal logs <name|port> [--project DIR] [-f|--follow] [-n N]
```

- 定位：位置参数是纯数字 → 按端口在 registry 中找 entry；否则按 `(name, project)`（project 默认 cwd，realpath 归一化）
- 默认输出 `logFile` 末尾 50 行（`-n` 调整）；`-f` 轮询式 tail 持续跟随（stat 增量读，200ms 间隔），Ctrl-C 退出
- entry 不存在、entry 无 `logFile`、或日志文件已被删除 → 报错，退出码 2（`EXIT.NOT_FOUND`）
- `--json`：输出 `{ name, project, port, logFile, lines: [...] }`（不支持与 `-f` 组合）

## 3. flags 扩展

`parseFlags` 新增：

- `-d` / `--detach` → `detach: boolean`
- `--wait-timeout <秒>`（正整数校验）→ `waitTimeout?: number`
- `--ready-url <path>`（须以 `/` 开头）→ `readyUrl?: string`
- `-f` / `--follow` → `follow: boolean`
- `-n <行数>`（正整数校验）→ `lines?: number`

注意现有 parser 只匹配 `--` 前缀，短旗标（`-d`/`-f`/`-n`）需要显式 case。

## 4. 归属与显示集成

- `scan.ts` env 溯源 allowlist 加入 `PORTMARSHAL_SERVICE`，且优先级最高（高于 agent 标记）：`run -d` 起的服务在 `list`/`whois`/menubar 显示为 `run:<name>` 而不是 `detached (…)`
- `gc`：带 `PORTMARSHAL_SERVICE` 标记的进程不列为清理候选（是被管理的服务，不是孤儿遗留）
- `list`/`watch`：claim 带 `runPid` 但 `kill(pid,0)` 失败（进程已死）时，在现有「claim 无监听 ⚠」路径上追加 `dead` 提示
- `stop`：无需改动。按端口找监听 pid 走现有护栏，release 走现有逻辑，日志文件保留

## 5. registry 变更

`RegistryEntry` 新增可选字段：

```ts
runPid?: number;   // run -d 托管的进程组长 pid
logFile?: string;  // 日志文件绝对路径
```

release 时保留 `logFile`（logs 命令在服务停止后仍可查上一次日志），清除 `runPid`。

## 6. 错误处理要点

- spawn 失败（命令不存在）：立即 release、报错退出 1
- 日志目录创建失败：报错退出 1，不启动服务
- 就绪失败清理时进程组已不存在：忽略 ESRCH，照常 release
- `logs -f` 期间文件被轮转（服务重启）：检测 inode/size 回退，重新从头打开新文件

## 7. 测试

单元测试：

- 日志轮转：`.log` → `.log.old` 覆盖语义
- readiness 探测：对本地临时 TCP server / HTTP server 验证成功、超时、`--ready-url` 非 2xx 继续等
- `logs` 定位（name vs 端口数字）、`-n` 截取、NOT_FOUND 路径
- flags：`-d`、`--wait-timeout`、`--ready-url`、`-f`、`-n` 解析与校验

冒烟测试（复用现有 run.test.ts 风格，真实 spawn）：

- `run -d` 起 node http server → 退出码 0、端口可连、registry 有 runPid/logFile
- `logs <name>` 能看到服务输出；`logs <port>` 同样
- `stop <port>` 后 claim 转 released、进程组消失、日志文件保留
- 「永不监听的命令」（如 `sleep`）用短 `--wait-timeout` 走超时失败：退出码 1、进程被杀、claim 已 release
- 「立即退出的命令」走早死快速失败路径

## 8. 范围外（YAGNI）

- 自动重启 / supervisor
- 按大小轮转日志、logrotate 配置
- 独立 `wait` 命令
- 前台模式的就绪等待
- Windows 支持
