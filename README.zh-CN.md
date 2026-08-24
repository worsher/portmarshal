# PortMarshal

[![npm](https://img.shields.io/npm/v/portmarshal)](https://www.npmjs.com/package/portmarshal) [![test](https://github.com/worsher/portmarshal/actions/workflows/test.yml/badge.svg)](https://github.com/worsher/portmarshal/actions/workflows/test.yml) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> 知道本地开发服务属于哪个 Agent，并阻止错误的服务被停止。

[English](README.md) | **简体中文**

PortMarshal 是面向 macOS 和 Linux 多 Agent 本地开发的服务归属与安全层：把可归属的 TCP 监听映射到 PID、项目目录和启动 Agent，提供粘性端口 claim、端口漂移检测，以及默认阻止一个 Agent 停掉另一个 Agent 活跃服务的护栏。

## 30 秒上手

```bash
npm install -g portmarshal
portmarshal list
portmarshal whois 3000
```

最后一条命令会显示已经监听 3000 端口的开发服务对应的进程、项目和启动 Agent。

![PortMarshal 演示](docs/demo.gif)

## 安装

```bash
npm install -g portmarshal
portmarshal --help
```

需要 Node.js 18.17 或更高版本，运行时没有 npm 依赖。

### 从 PortScout 迁移

```bash
npm uninstall -g @worsher/portscout @worsher/portmarshal
npm install -g portmarshal
```

首次运行时，PortMarshal 会把已有的 `~/.portscout/registry.json` 复制到 `~/.portmarshal/registry.json`，保留粘性 claim，同时不会删除旧数据。

## 命令

| 命令 | 说明 |
|---|---|
| `portmarshal list [--services] [--json] [--all] [--project .]` | 按端口显示状态，或把进程树、端口和 claim 聚合为服务 |
| `portmarshal whois <port> [--json]` | 查询端口以及所属服务的监听 PID、wrapper、PGID、claim 和停止方案 |
| `portmarshal claim <name> [--prefer N] [--range A-B]` | 分配协作式粘性端口 claim；stdout 仅输出端口号 |
| `portmarshal run <name> [--prefer N] [--restart] -- <command...>` | 预留端口并注入 `PORT` 和 `{port}`，前台监督子进程，退出自动释放 |
| `portmarshal run -d <name> [--wait-timeout N] [--ready-url PATH] -- <command...>` | 同上，但转入后台：输出写入日志文件，服务就绪后立即返回 |
| `portmarshal logs <name\|port> [-n N] [-f] [--json]` | 查看或跟随 `run -d` 启动服务的日志 |
| `portmarshal release <name> [--force]` | 释放 claim，不停止进程；释放其他会话的 claim 前必须检查并显式使用 `--force` |
| `portmarshal stop <port\|name> [--force\|--gui]` | 通过归属护栏停止服务 |
| `portmarshal gc [--dry-run\|--kill-detached]` | 预览清理、回收过期 claim，或停止脱离会话的候选服务 |
| `portmarshal watch [--services]` | 按端口或服务显示终端实时仪表盘，按 `q` 退出 |
| `portmarshal menubar [--install]` | 按服务聚合的 SwiftBar 菜单栏视图，停止动作同样经过护栏 |

典型启动方式：

```bash
portmarshal run web --prefer 3000 -- npm run dev
# 某些框架只接受 CLI 参数的情况：
portmarshal run web --prefer 5173 -- pnpm vite --port {port}
```

`run` 预留粘性端口，注入为 `PORT` 环境变量（同时在命令中替换 `{port}` 占位符），在前台流式输出，转发信号到整个进程组，命令退出时自动释放 claim。若该端口仍被本项目旧实例监听，`run` 会拒绝启动并返回退出码 3；加 `--restart` 可先通过护栏 stop 停掉旧实例。需要自己管理进程生命周期时才用 `claim`。子进程的 stdin 不会被转发，交互式框架快捷键（如 Vite 的终端热键）不会响应——`run` 是为受监督的 dev server 设计的，不是交互式会话。

### 用 `run -d` 转入后台

```bash
# 在后台启动 dev server；端口可连接后立即返回
portmarshal run -d web --prefer 3000 -- pnpm dev

# 用健康检查判定就绪，并自定义超时
portmarshal run -d api --ready-url /health --wait-timeout 60 -- pnpm start

# 跟随日志
portmarshal logs web -f
```

`run -d` 会把子进程放进独立的进程组，将其 stdout/stderr 重定向到 `~/.portmarshal/logs/` 下的日志文件，服务就绪后立即把控制权交还调用方——不需要占用一个前台进程去盯着它。默认就绪判定会通过 IPv4 或 IPv6 loopback 连接预留端口，超时 30 秒；传入 `--ready-url /health` 可改为要求该路径返回 HTTP 2xx/3xx 响应，`--wait-timeout N` 可修改超时秒数。端点响应后还会核验监听进程携带本次运行的随机身份、且属于刚启动的进程组，避免其他进程抢先绑定端口时被误报为 ready。如果服务未能就绪（进程崩溃、等待超时或监听者不属于本次运行），`run -d` 会打印日志最后 20 行，只终止已验证的本次进程组，释放 claim，并以非零退出码结束。在等待就绪期间收到 SIGINT、SIGTERM 或 SIGHUP 时，也会先完成进程组与 claim 清理，再按对应信号退出。成功时会打印一行 `ready`（含 pid 与日志路径）并以退出码 0 结束。

日志文件位于 `~/.portmarshal/logs/<hash8>-<name>.log`，`hash8` 由项目目录哈希而来，避免不同项目下同名服务互相冲突；需要进行文件名清洗的服务名还会附加短哈希，避免不同原名折叠到同一文件。状态与日志目录权限为 `0700`，registry 和日志文件为 `0600`，只允许当前用户访问。每次 `run -d` 启动前会把上一次的日志轮转为 `<file>.log.old`，最多保留上一次运行最后 10 MiB；当前日志在本次运行退出或重启前仍可能继续增长。释放 claim 不会删除日志文件。用 `portmarshal logs <name|port>` 查看日志尾部（默认 50 行，`-n` 可调整，单次最多读取文件尾部 1 MiB），`-f` 可跨日志轮转持续跟随，`--json` 输出机器可读格式。

由 `run -d` 启动的服务在 `list`、`whois`、`gc` 中归属显示为 `run:<name>`，并且不会出现在 `gc` 的脱离候选列表里——它们已经被托管了。`stop` 依然走正常的归属护栏。`run -d` 不会自动重启崩溃的进程：如果被托管的进程自行退出，`portmarshal list` 会把对应记录标记为 `dead`，直到再次 `run -d` 或释放该 claim。

## 归属与停止护栏

`list --services` 不再让一个服务的每个端口各占一行，而是生成服务快照。PortMarshal 优先使用
`run -d`、Docker 和 PM2 的受管身份，再按规范化项目目录与 PGID 聚合普通监听。只有项目归属一致时，
共享同一 socket 的监听者才会合并。结果会展示全部监听 PID、同 PGID 的 wrapper 祖先进程、端口、
claim、附着状态、归属可信度和安全停止方案。`list --services --json` 输出带版本的
`{ "schemaVersion": 1, "services": [...] }`；现有按端口的 `list --json` 输出保持不变。

附着状态和归属可信度彼此独立：detached 服务如果有一致的项目与 claim 证据，仍是活跃且已交叉验证的
服务，不会被菜单栏计为错误。同一项目只有一个活跃服务时，未监听的 claim 可以显示为“相关、待复核”；
PortMarshal 不会仅凭项目目录相同就自动合并或释放它。菜单栏的垃圾清理入口只会在终端执行
`gc --dry-run` 供检查，不会一键运行 `gc --kill-detached`。

PortMarshal 沿父进程链识别 `claude-code`、`cursor`、`antigravity`、`vscode/electron`、`terminal`、`docker` 和 `pm2`。PM2 托管的监听会通过 `pm2 jlist` 补全，来源显示为 `pm2:<应用名>`，项目使用应用配置的 cwd；完整 PM2 环境变量不会被保留。对于已发布到宿主机的 Docker 端口，它会读取运行中容器的元数据：把 Docker Desktop 的共享监听按容器拆分，来源显示为 `docker:<compose项目>/<服务>`，并从 Compose、Dev Container 或 bind mount 元数据恢复宿主机项目目录；受管运行时元数据不可用时会安全回退，不伪造归属。同时识别 macOS 的 `launchd:<label>` 与 Linux 的 `systemd:<unit>`。被重新挂到 PID 1、但无法识别受管服务的进程会标记为 `detached`——这是需要检查的信号，并不等于已经证明它是无主孤儿。命令输出默认会脱敏常见凭证 flag、赋值、Header、URL 用户信息和查询参数；仅在本机调试时才应显式使用 `--show-sensitive-command`，不要把原始输出贴进 issue 或 Agent 会话。

协作式 claim 现在还会在可识别时绑定 Agent 会话所有者。`PORTMARSHAL_OWNER` 是跨工具的通用接入约定，Codex 的 thread/session ID 会被自动识别。该值应是同一会话所有 PortMarshal 命令共用的稳定、非敏感 ID，不要每条命令生成一个新值。PortMarshal 只保存单向 SHA-256 指纹，不会保存原始 ID。其他会话默认不能复用或释放该 claim，也不能停止它在同项目中的服务，或通过 `run --restart` 替换它。旧注册表和没有稳定会话标识的环境继续使用 v0.6 的项目级护栏；旧的无 owner claim 会在第一次安全复用时被当前会话接管。

| 目标 | `stop` 默认行为 |
|---|---|
| 属于调用方项目/claim 的 PM2 应用 | 执行 `pm2 stop <id>`，绝不直接终止会被 PM2 自动拉起的子进程 |
| 属于调用方项目/claim 的 Docker 容器 | 对对应容器执行 `docker stop`，绝不向共享 Docker 后端发送信号 |
| 已验证属于调用方当前项目/claim 的服务 | SIGTERM；3 秒后仍存活则 SIGKILL |
| 同项目、但 claim 属于另一个 Agent 会话的服务 | 拦截，显示 claim 来源，返回退出码 3 |
| 没有当前项目证据的 detached/未知归属服务 | 拦截，显示归属，返回退出码 3 |
| 其他活跃服务，或与旧 claim 冲突的监听者 | 拦截，显示归属，返回退出码 3 |

检查归属后可以用 `--force` 覆盖护栏；macOS 上的 `--gui` 会弹原生确认框。

PortMarshal 只能归属当前用户有权限读取进程元数据的监听。例如 Linux `ss` 没有返回 PID 的行会被省略，不会伪造归属。

## Agent 接入

把以下约定加入 `AGENTS.md`、`CLAUDE.md` 或编辑器的 Agent rules：

```text
- 用 `portmarshal run <服务名> --prefer <默认端口> -- <命令>` 启动 dev server；自动注入 PORT/{port} 并退出时释放。只在必须自己管理进程时才用 `PORT=$(portmarshal claim ...)`。
- Agent 宿主没有可自动识别的会话 ID 时，让同一会话的所有命令继承一个稳定、非敏感的 `PORTMARSHAL_OWNER`；不要每条命令重新生成。
- 用 `portmarshal list --services --project . --json` 和 `portmarshal whois <端口> --json` 排查冲突。
- 用 `portmarshal stop <端口>` 停止服务；退出码 3 表示无法安全确认归属或属于其他活跃服务，应展示归属并在使用 --force 前询问用户。
```

可直接复制的 Claude Code skill 位于 [`integrations/claude-code/skills/portmarshal`](integrations/claude-code/skills/portmarshal)。

## 开发

```bash
pnpm test
pnpm smoke
pnpm build
```

GitHub Actions 会使用 Node.js 22 与 24 在 macOS、Linux 上执行构建、单测和真实监听端口冒烟测试；tag 发布通过 provenance 签名后推送到 npm。

设计文档：[`docs/specs/2026-07-16-portmarshal-design.md`](docs/specs/2026-07-16-portmarshal-design.md) · [v0.7.0 Agent 会话所有权](docs/specs/2026-08-20-v0.7.0-agent-session-ownership.md) · [v0.8.0 服务级归属](docs/specs/2026-08-24-v0.8.0-service-ownership.md) · [更新记录](CHANGELOG.md)

macOS 与 Linux · Node.js ≥ 18.17 · 零运行时依赖 · MIT
