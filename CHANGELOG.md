# Changelog

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
