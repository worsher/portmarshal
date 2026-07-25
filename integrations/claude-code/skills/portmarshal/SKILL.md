---
name: portmarshal
description: 本机端口服务的查询、协作式 claim 与带护栏停止。当需要启动 dev server、排查端口冲突、寻找某端口属于哪个项目/agent、检查脱离会话的服务时使用。防止多 agent 端口冲突与互相误杀。
---

# portmarshal — 端口侦察与调度

前置：`npm i -g portmarshal`（macOS 或 Linux）。查询与处置命令可用 `--json` 获得结构化输出。

## 启动 dev server

优先用 `run`：预留端口、注入 `PORT`（命令里的 `{port}` 占位符也会被替换）、前台监督、退出自动释放：

```bash
portmarshal run <服务名> --prefer <默认端口> -- npm run dev
portmarshal run <服务名> --prefer 5173 -- pnpm vite --port {port}
```

- 退出码 3：同项目旧实例还在监听。想换掉它就加 `--restart`（走护栏 stop，不会误杀别人的服务）。
- 需要自己管理进程时才用 `PORT=$(portmarshal claim <服务名> --prefer <默认端口>)`。

## 查询与排查

```bash
portmarshal list --project . --json   # 本项目正在监听的服务
portmarshal list --json               # 全机视图（含来源归属与 ⚠ 漂移标记）
portmarshal whois <端口> --json       # 这个端口是谁的：项目目录/命令/来源
```

来源标签含义：`claude-code`/`cursor`/`antigravity`/`terminal` 等为启动工具；`launchd:<label>` 与 `systemd:<unit>` 为受管服务（**不要直接停止**）；`detached` 表示已脱离原会话，需要检查，但不能仅凭该标签断定它是无主进程。

## 停止服务（护栏语义）

```bash
portmarshal stop <端口>
```

- 退出码 0：已停止（detached 或本项目的服务）
- **退出码 3：被拦截——这是其他 agent 的活跃服务。把归属信息展示给用户并请示，不要擅自 `--force`**
- 退出码 2：端口无监听

先用 `portmarshal gc` 查看 detached 候选；确认后才运行 `portmarshal gc --kill-detached`。

## 端口被占的标准处置流程

1. `portmarshal whois <端口>` 看归属
2. 是自己项目的旧进程 → `portmarshal stop <端口>` 直接停
3. 是别人的活跃服务 → 换端口：`PORT=$(portmarshal claim <服务名>)` 自动分配空闲端口
4. 是 detached 候选 → 检查命令和项目目录后再决定是否停止
