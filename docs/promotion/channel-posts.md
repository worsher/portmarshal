# Community post drafts

Every draft discloses the author's relationship to the project and avoids asking
for stars or votes. Recheck each community's live rules before posting.

## V2EX / 分享创造

### 标题

```text
[开源] PortMarshal：避免多个 coding agent 误杀彼此的本地开发服务
```

### 正文

```markdown
我做了一个叫 PortMarshal 的开源 CLI，起因是在同一台机器上并行跑 Claude Code、Cursor 等 coding agent 时，经常遇到三类问题：开发服务静默漂到 3001、会话结束后服务仍占着端口、一个 agent 为了释放端口误停了另一个正在调试的服务。

PortMarshal 会扫描当前可见的 TCP listener，把端口关联到 PID、项目目录和启动来源。已有服务不需要先通过它启动。停止服务时，如果目标属于另一个活跃项目，默认会阻止并显示归属；确认后仍可以显式使用 `--force`。

现在它也能识别常见的托管运行时：Docker Desktop 的共享监听会关联到具体 container、Compose service 和宿主项目，PM2 listener 会显示为 `pm2:<app-name>` 并使用应用配置的 cwd。停止这些目标时分别调用 `docker stop` 或 `pm2 stop`，不会直接 signal 共享 Docker backend 或 PM2 管理的 child process。

快速试用：

    npm install -g portmarshal
    portmarshal list
    portmarshal whois 3000

需要配合 agent 时，优先让 PortMarshal 管理完整生命周期：

    portmarshal run web --prefer 3000 -- npm run dev

目前支持 macOS 和 Linux，MIT，运行时零 npm 依赖，也有 JSON 输出和可选的 SwiftBar 菜单栏视图。

我刻意保留了两个限制：claim 是协作租约，不是操作系统级 socket reservation；`detached` 只表示进程已脱离原会话，不等于它一定是应该清理的孤儿。Linux 看不到 PID 的 listener 也不会猜测归属。

仓库：https://github.com/worsher/portmarshal

比较想听到真实的多 agent 使用场景，尤其是 Linux、tmux、Docker/Compose、PM2 环境以及归属识别错误的案例。
```

## r/ClaudeAI Showcase

### Title

```text
I built an open-source guard against Claude Code sessions killing each other's dev servers
```

### Body

```markdown
I'm the author of PortMarshal, a free MIT-licensed CLI built for Claude Code and other coding agents that run local dev servers in parallel.

The failure mode I wanted to fix was simple: one session sees port 3000 in use, assumes the listener is stale, and kills a service that another session is actively debugging. PortMarshal scans existing TCP listeners and maps a visible port to its PID, project directory, and launching source. A service does not need to be started through PortMarshal first.

    npm install -g portmarshal
    portmarshal list
    portmarshal whois 3000

`portmarshal stop 3000` blocks the stop by default when the listener is attributed to another active project or its ownership cannot be safely verified, and prints the attribution. `--force` remains an explicit escape hatch. Cooperative sessions can use the managed lifecycle:

    portmarshal run web --prefer 3000 -- npm run dev

Managed runtimes use their own control planes: published Docker ports resolve to the container, Compose service, and host project, while PM2 listeners resolve to `pm2:<app-name>` and the configured application cwd. Stops are delegated to `docker stop` or `pm2 stop` instead of signaling a shared backend or supervised child process.

It supports macOS and Linux, has zero runtime npm dependencies, JSON output, and a copyable Claude Code skill in the repository.

The honest limits: a claim is not an OS socket reservation, `detached` is a review signal rather than proof of an orphan, and Linux listeners without visible PID data are omitted rather than guessed.

Repository: https://github.com/worsher/portmarshal

I'd especially value reports from people running multiple Claude Code sessions under tmux, containers, or Linux setups where process ancestry looks different.
```

## r/commandline

### Title

```text
PortMarshal: local port attribution and a kill guard for multi-agent development
```

### Body

```markdown
I'm the maintainer of PortMarshal, an MIT-licensed CLI for inspecting and coordinating local dev-server ports on macOS and Linux.

Unlike a launcher-only approach, it starts by scanning existing listeners. It composes `lsof`/`ss`, process metadata, cwd, parent chains, launchd, systemd, Docker/Compose, and PM2 metadata into a port → PID → project → source view. On top of that it adds sticky cooperative claims, drift detection, and a stop policy that blocks cross-project termination by default.

    npm install -g portmarshal
    portmarshal list
    portmarshal whois 3000

Docker and PM2 targets are controlled through `docker stop` and `pm2 stop`; PortMarshal does not signal the shared Docker Desktop backend or a supervised PM2 child. The runtime has zero npm dependencies and the commands support JSON output and semantic exit codes. The scanner deliberately omits Linux listeners whose PID metadata is not visible, and a `detached` label means only that the process left its original session.

Source and demo: https://github.com/worsher/portmarshal

I'm interested in feedback on the Unix process-model choices, especially attribution after reparenting and whether detached targets should have a stricter default guard.
```

## X / Bluesky

```text
Running multiple coding agents? PortMarshal maps dev-server ports to projects, agents, Docker/Compose containers, and PM2 apps; detects drift; and guards cross-project stops.

macOS/Linux · zero runtime deps · MIT
npm i -g portmarshal
https://github.com/worsher/portmarshal
```

Attach `docs/social-preview.png`. If the platform renders the GitHub link card,
compare it with the attached image and keep only the clearer preview.

## LinkedIn

```text
Parallel coding agents introduced a surprisingly physical coordination problem on my machine: ports.

One session would silently move from 3000 to 3001. Another would leave a dev server behind. A third would free a port by stopping a process that was still being used elsewhere.

I built PortMarshal as a local ownership and safety layer for that workflow. It maps visible TCP listeners to their process, project directory, and launching source; offers sticky cooperative port claims; detects drift; and blocks cross-project stops by default.

Managed services keep their real identity: Docker Desktop ports resolve to the container, Compose service, and host project, while PM2 listeners resolve to the application name and configured cwd. PortMarshal stops them through `docker stop` or `pm2 stop` rather than signaling a shared backend or supervised child.

It is open source under MIT, supports macOS and Linux, has zero runtime npm dependencies, and is installable with:

npm install -g portmarshal

The design intentionally states its limits: a claim is not an OS socket reservation, and a detached process is a review signal rather than proof that it is abandoned.

Repository and demo: https://github.com/worsher/portmarshal

I would be interested in hearing how teams running several local coding agents currently coordinate dev servers and port ownership.
```
