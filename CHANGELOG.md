# Changelog

## 0.6.2 — 2026-08-20

- Make foreground `run --project DIR` execute the child in `DIR`, matching the recorded project identity and detached behavior
- Probe both IPv4 and IPv6 loopback during detached readiness checks, including HTTP health checks
- Read log tails from the end with a bounded 1 MiB window instead of loading the entire file; cap the retained previous-run log at 10 MiB on rotation
- Make sanitized detached-log filenames collision-resistant for service names containing spaces, separators, Unicode, or excessive length
- Test the main workflow on Node.js 22 and 24 across both Ubuntu and macOS; use Node.js 22 for the publish workflow's Linux gate

## 0.6.1 — 2026-08-04

- Redact common token, secret, password, authorization, cookie, URL-credential, and sensitive query-parameter values from scanned commands by default; add the explicit `--show-sensitive-command` debugging escape hatch
- Tighten `~/.portmarshal` and log directories to mode `0700`, and registry, lock metadata, current logs, and rotated logs to `0600`; existing state permissions are repaired on access
- Make live project attribution override stale cooperative claims so a reused port cannot turn another project's listener into an owned stop target
- Guard detached or unattributed listeners by default unless current project attribution or a cooperative claim corroborates ownership
- Bind `run -d` registry records to a random `runId` and process group; readiness now verifies that the responding listener belongs to the spawned run before reporting success
- Verify `runId`/PGID before group termination, with a constrained service-marker compatibility path for v0.6.0 registry entries
- Refresh Claude Code integration instructions, issue templates, and promotion metadata to match the current `run`-first workflow and v0.6.x release line

## 0.6.0 — 2026-07-31

- Add `portmarshal run -d`: detached mode that captures stdout/stderr to `~/.portmarshal/logs/`, waits for TCP (or `--ready-url` HTTP) readiness before returning, and cleans up the claim and process group on failure
- Add `portmarshal logs <name|port>` with `-n`, `-f` (follow), and `--json`
- Attribute services started by `run -d` as `run:<name>` via the `PORTMARSHAL_SERVICE` env marker; they are exempt from `gc` candidates
- `list` marks a managed run whose process has died as `dead`
- Registry entries record `runPid`/`logFile`; log files survive release so the last run stays inspectable
- Harden detached lifecycle cleanup: release claims on log setup failure, clean up on readiness-wait signals, detect log rotation by inode, and verify whole process groups before escalation
- Normalize symlinked project paths when pairing reserved and unregistered entries into drift, fixing macOS `/var` versus `/private/var` mismatches

## 0.5.0 — 2026-07-27

- Trace detached listeners back to their launcher through environment-variable remnants (`CLAUDECODE`, IDE bundle identifiers, `TERM_PROGRAM`, `SSH_CONNECTION`), shown as `detached (claude-code)` in `list`, `whois`, the menubar, and `gc` candidate descriptions
- Agent markers win over IDE markers, which win over terminal markers, so a server started by Claude Code inside Cursor's terminal is attributed to the agent
- Query environments only for detached pids in one batched call (macOS `ps eww`, Linux `/proc/<pid>/environ`), read only an allowlist of marker keys, and never retain the full environment; the origin label is informational and does not change `gc`/`stop` semantics

## 0.4.0 — 2026-07-25

- Add `portmarshal run <name> -- <command...>`: claim a port, inject `PORT` and `{port}` placeholders, supervise the command in the foreground, forward signals to the whole process group, and auto-release the claim on exit
- `run` refuses to start over a live old instance of the same project (exit code 3); `--restart` stops it through the existing ownership guard first
- Fix `claim` allocating ports that are occupied by IPv6-only loopback listeners: `isPortFree` now probes both `127.0.0.1` and `::1`
- Fix project ownership comparisons failing on symlinked paths (such as macOS `/var` → `/private/var`) by realpath-normalizing both sides

## 0.3.4 — 2026-07-20

- Attribute PM2-managed listeners to `pm2:<app-name>` and the configured application cwd using one conditional `pm2 jlist` query
- Keep PM2 environment variables out of scan results while exposing only safe application metadata in `whois` and JSON output
- Stop attributed PM2 targets through `pm2 stop <id>` and refuse to signal managed children when PM2 metadata is unavailable

## 0.3.3 — 2026-07-17

- Attribute published Docker ports to the actual container, Compose service, and host project directory instead of the shared Docker Desktop backend directory
- Split ports sharing a Docker backend PID by container, with Compose, Dev Container, and bind-mount directory fallbacks
- Make guarded `stop` use `docker stop` for attributed containers rather than signaling the shared Docker backend process

## 0.3.2 — 2026-07-17

- Migrate npm releases to GitHub OIDC Trusted Publishing with automatic provenance
- Remove the workflow dependency on a long-lived npm write token and limit `id-token: write` to the publish job
- Update release Actions and run the publish job on Node.js 24

## 0.3.1 — 2026-07-17

- Publish the canonical package without an npm scope: install with `npm install -g portmarshal`
- Deprecate the short-lived `@worsher/portmarshal@0.3.0` package in favor of `portmarshal`

## 0.3.0 — 2026-07-17

- **Renamed to PortMarshal**: new npm package `@worsher/portmarshal`, CLI command `portmarshal`, repository URLs, docs, demo, and Claude Code integration; the registry is automatically copied from `~/.portscout` to `~/.portmarshal` on first use
- **Safer Linux attribution**: systemd cgroup labels are checked at every process-chain level, fixing service children that could previously be misclassified
- **Honest detached semantics**: reparented unmanaged processes are labeled `detached` instead of being asserted as true orphans; `gc --kill-detached` requires an explicit review-and-kill action, while `--kill-orphans` remains a compatibility alias
- **Reliable claim reuse**: active claims are revalidated before reuse; if the port belongs to another process, a new port is allocated and the previous port is reported
- English-first CLI, menu-bar output, validation errors, demo, npm metadata, and promotion copy
- Stricter validation for `--prefer`, `--range`, `whois`, and numeric `stop` targets

## 0.2.0 — 2026-07-17

- **Linux 支持**：监听扫描用 `ss -tlnp`（免 lsof 依赖），cwd/受管服务判定直读 `/proc/<pid>/{cwd,cgroup}`（零额外 fork）；systemd 服务标为 `systemd:<unit>`（与 macOS `launchd:<label>` 同语义，不会被误判孤儿）；whois 探测 systemd unit 定义文件
- CI 双平台测试矩阵（ubuntu + macos），发布前强制通过 Linux 门禁
- `--gui` 与 `menubar --install` 在非 macOS 平台明确报错（menubar 协议输出保留，可接 GNOME Argos）

## 0.1.4 — 2026-07-17

- GitHub Actions 发布流水线：push `v*` tag 自动发布到 npm（macOS runner 全量门禁：tag/版本一致性校验 + build + 单测 + 冒烟 + provenance 签名）
- 说明：0.1.3 版本号跳过（tag 被一次版本号不一致的失败发布占用）

## 0.1.2 — 2026-07-17

- **扫描性能优化**：子进程调用从 `3 + 2N` 次（N = 监听进程数）压缩为**固定 5 次**——ps 全表一次取全部命令行、lsof `-p p1,p2,...` 一次批量反查全部 cwd。实测（30+ 监听进程的机器）：walltime 0.18s → 0.089s（2 倍），CPU 0.88s → 0.14s（6 倍）；menubar（5s 轮询）与 watch（2s 刷新）的常驻开销显著下降

## 0.1.1 — 2026-07-17

- **来源判定三层化**：`ppid=1` 不再一律判孤儿——launchd 受管服务（LaunchAgent/登录项，经 `launchctl list` 交叉验证）标为 `launchd:<注册label>`；/Applications 下 GUI 应用的双 fork 后台进程标为 `app`；仅真正被收养的遗留进程才是 `orphan`（起因：OpenClaw gateway 等自启动服务被误判孤儿，`gc --kill-orphans` 有误杀风险）
- **whois 定位服务定义**：launchd 来源的端口显示注册 label 并探测 plist 文件路径（LaunchAgents / LaunchDaemons 常规目录）
- 修复：`.app` 启发式限定 /Applications 前缀，避免误伤 homebrew Python（解释器路径含 Python.app）启动的 dev server

## 0.1.0 — 2026-07-16

首个发布版本：

- 扫描归属引擎：端口 → PID → 项目目录（cwd + 命令行兜底）→ 启动来源（claude-code / cursor / antigravity / vscode/electron / terminal / docker / orphan，父进程链识别）
- 端口预留：`claim`（幂等 + 粘性，唯一键 (项目, 名称)）/ `release`，注册表 mkdir 锁 + 撕裂写入宽限
- 带护栏停止：孤儿与自己的服务直接停，他人活跃服务拦截（agent 退出码 3 / GUI osascript 确认框），SIGTERM→SIGKILL 优雅降级
- 漂移检测：claim 的端口与实际监听端口不符时双向标记 ⚠
- `gc` 孤儿清理、`watch` 终端仪表盘、`menubar` SwiftBar 插件（`--install` 一键安装）
- 全命令 `--json` + 语义化退出码（0/1/2/3/4），零运行时依赖，仅 macOS
