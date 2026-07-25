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
| `portmarshal list [--json] [--all] [--project .]` | 显示监听服务的项目、来源和状态：正常、预留、未注册或漂移 |
| `portmarshal whois <port> [--json]` | 查询端口的 PID、项目目录、完整命令和 Agent/服务来源 |
| `portmarshal claim <name> [--prefer N] [--range A-B]` | 分配协作式粘性端口 claim；stdout 仅输出端口号 |
| `portmarshal run <name> [--prefer N] [--restart] -- <command...>` | 预留端口并注入 `PORT` 和 `{port}`，前台监督子进程，退出自动释放 |
| `portmarshal release <name>` | 释放 claim，不停止进程 |
| `portmarshal stop <port\|name> [--force\|--gui]` | 通过归属护栏停止服务 |
| `portmarshal gc [--kill-detached]` | 回收过期 claim，查看或停止脱离会话的候选服务 |
| `portmarshal watch` | 终端实时仪表盘，按 `q` 退出 |
| `portmarshal menubar [--install]` | SwiftBar 菜单栏视图，停止动作同样经过护栏 |

典型启动方式：

```bash
portmarshal run web --prefer 3000 -- npm run dev
# 某些框架只接受 CLI 参数的情况：
portmarshal run web --prefer 5173 -- pnpm vite --port {port}
```

`run` 预留粘性端口，注入为 `PORT` 环境变量（同时在命令中替换 `{port}` 占位符），在前台流式输出，转发信号到整个进程组，命令退出时自动释放 claim。若该端口仍被本项目旧实例监听，`run` 会拒绝启动并返回退出码 3；加 `--restart` 可先通过护栏 stop 停掉旧实例。需要自己管理进程生命周期时才用 `claim`。子进程的 stdin 不会被转发，交互式框架快捷键（如 Vite 的终端热键）不会响应——`run` 是为受监督的 dev server 设计的，不是交互式会话。

## 归属与停止护栏

PortMarshal 沿父进程链识别 `claude-code`、`cursor`、`antigravity`、`vscode/electron`、`terminal`、`docker` 和 `pm2`。PM2 托管的监听会通过 `pm2 jlist` 补全，来源显示为 `pm2:<应用名>`，项目使用应用配置的 cwd；完整 PM2 环境变量不会被保留。对于已发布到宿主机的 Docker 端口，它会读取运行中容器的元数据：把 Docker Desktop 的共享监听按容器拆分，来源显示为 `docker:<compose项目>/<服务>`，并从 Compose、Dev Container 或 bind mount 元数据恢复宿主机项目目录；受管运行时元数据不可用时会安全回退，不伪造归属。同时识别 macOS 的 `launchd:<label>` 与 Linux 的 `systemd:<unit>`。被重新挂到 PID 1、但无法识别受管服务的进程会标记为 `detached`——这是需要检查的信号，并不等于已经证明它是无主孤儿。

| 目标 | `stop` 默认行为 |
|---|---|
| 属于调用方项目/claim 的 PM2 应用 | 执行 `pm2 stop <id>`，绝不直接终止会被 PM2 自动拉起的子进程 |
| 属于调用方项目/claim 的 Docker 容器 | 对对应容器执行 `docker stop`，绝不向共享 Docker 后端发送信号 |
| detached 服务，或属于调用方项目/claim 的服务 | SIGTERM；3 秒后仍存活则 SIGKILL |
| 其他活跃服务 | 拦截，显示归属，返回退出码 3 |

检查归属后可以用 `--force` 覆盖护栏；macOS 上的 `--gui` 会弹原生确认框。

PortMarshal 只能归属当前用户有权限读取进程元数据的监听。例如 Linux `ss` 没有返回 PID 的行会被省略，不会伪造归属。

## Agent 接入

把以下约定加入 `AGENTS.md`、`CLAUDE.md` 或编辑器的 Agent rules：

```text
- 用 `portmarshal run <服务名> --prefer <默认端口> -- <命令>` 启动 dev server；自动注入 PORT/{port} 并退出时释放。只在必须自己管理进程时才用 `PORT=$(portmarshal claim ...)`。
- 用 `portmarshal list --project . --json` 和 `portmarshal whois <端口> --json` 排查冲突。
- 用 `portmarshal stop <端口>` 停止服务；退出码 3 表示属于其他活跃服务，应展示归属并在使用 --force 前询问用户。
```

可直接复制的 Claude Code skill 位于 [`integrations/claude-code/skills/portmarshal`](integrations/claude-code/skills/portmarshal)。

## 开发

```bash
pnpm test
pnpm smoke
pnpm build
```

GitHub Actions 会在 macOS 与 Linux 上执行构建、单测和真实监听端口冒烟测试；tag 发布通过 provenance 签名后推送到 npm。

设计文档：[`docs/specs/2026-07-16-portmarshal-design.md`](docs/specs/2026-07-16-portmarshal-design.md) · [更新记录](CHANGELOG.md)

macOS 与 Linux · Node.js ≥ 18.17 · 零运行时依赖 · MIT
