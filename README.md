# PortMarshal

[![npm](https://img.shields.io/npm/v/portmarshal)](https://www.npmjs.com/package/portmarshal) [![test](https://github.com/worsher/portmarshal/actions/workflows/test.yml/badge.svg)](https://github.com/worsher/portmarshal/actions/workflows/test.yml) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> Know which coding agent owns a local dev server — and stop the wrong one from being killed.

**English** | [简体中文](README.zh-CN.md)

PortMarshal is an agent-aware ownership and safety layer for local development services on macOS and Linux. It maps attributable TCP listeners to their PID, project directory, and launching agent; coordinates sticky port claims; detects port drift; and blocks one agent from stopping another agent's active service by default.

## Try it in 30 seconds

```bash
npm install -g portmarshal
portmarshal list
portmarshal whois 3000
```

The last command inspects the process, project, and agent behind a dev server already listening on port 3000.

![PortMarshal demo](docs/demo.gif)

## Why

Parallel coding agents create three recurring problems:

- **Silent drift** — an agent expects port 3000, but the framework silently starts on 3001.
- **Detached services** — a session exits while its dev server keeps listening.
- **Friendly fire** — one agent frees a port by stopping another agent's service.

PortMarshal scans first and coordinates second. Existing listeners do not need to be launched through PortMarshal to be discovered. Cooperative agents gain stable claims and stronger ownership signals, while uncooperative services still appear when the operating system exposes their process metadata.

## Install

```bash
npm install -g portmarshal
portmarshal --help
```

Requires Node.js 18.17 or newer. The runtime has no npm dependencies.

### Migrating from PortScout

```bash
npm uninstall -g @worsher/portscout @worsher/portmarshal
npm install -g portmarshal
```

On first use, PortMarshal copies an existing `~/.portscout/registry.json` into `~/.portmarshal/registry.json`, preserving sticky claims without deleting the old data.

## Commands

| Command | What it does |
|---|---|
| `portmarshal list [--json] [--all] [--project .]` | List listeners with project, source, and state: active, reserved, unregistered, or drift |
| `portmarshal whois <port> [--json]` | Inspect one port: PID, project directory, full command, agent or service source |
| `portmarshal claim <name> [--prefer N] [--range A-B]` | Allocate a cooperative sticky port claim; stdout contains only the port number |
| `portmarshal run <name> [--prefer N] [--restart] -- <command...>` | Claim a port, inject it as `PORT` and `{port}`, supervise the command in the foreground, auto-release on exit |
| `portmarshal release <name>` | Release a claim without stopping its process |
| `portmarshal stop <port\|name> [--force\|--gui]` | Stop a service behind the ownership guard |
| `portmarshal gc [--kill-detached]` | Reap stale claims and review or stop detached service candidates |
| `portmarshal watch` | Refreshing terminal dashboard; press `q` to quit |
| `portmarshal menubar [--install]` | SwiftBar menu with guarded click-to-stop actions |

Typical agent startup:

```bash
portmarshal run web --prefer 3000 -- npm run dev
# frameworks that only accept a CLI flag:
portmarshal run web --prefer 5173 -- pnpm vite --port {port}
```

`run` claims a sticky port, injects it as the `PORT` environment variable (and replaces `{port}` placeholders in the command), streams output in the foreground, forwards signals to the whole process group, and releases the claim when the command exits. If the port is still served by a previous instance of the same project, `run` refuses with exit code 3; add `--restart` to stop it through the ownership guard first. `claim` remains available for scripts that manage the process themselves. Stdin is not forwarded to the child, so interactive framework shortcuts (e.g. Vite's terminal hotkeys) won't respond — `run` is built for supervised dev servers, not interactive sessions.

## Attribution and safety

PortMarshal follows the process parent chain to identify `claude-code`, `cursor`, `antigravity`, `vscode/electron`, `terminal`, `docker`, and `pm2`. PM2-managed listeners are enriched from `pm2 jlist`, displayed as `pm2:<app-name>`, and attributed to the application's configured cwd; the full PM2 environment is never retained. For published Docker ports, PortMarshal inspects running-container metadata: shared Docker Desktop listeners are split by container, the source is shown as `docker:<compose-project>/<service>`, and the host project directory is recovered from Compose, Dev Container, or bind-mount metadata. If managed-runtime metadata is unavailable, attribution safely falls back without inventing ownership. PortMarshal also recognizes `launchd:<label>` on macOS and `systemd:<unit>` on Linux. A process reparented to PID 1 without a recognized manager is labeled `detached` — this is a review signal, not proof that the process is abandoned. For detached processes the parent chain is gone, so PortMarshal falls back to environment-variable remnants (macOS `ps eww`, Linux `/proc/<pid>/environ`): markers such as `CLAUDECODE=1` or an IDE bundle identifier reveal who originally launched the process, shown as `detached (claude-code)`. Only a small allowlist of marker keys is read — the full environment, which may contain secrets, is never retained — and the label is informational only; it never changes gc/stop semantics.

| Target | Default `stop` behavior |
|---|---|
| PM2 application owned by the caller's project/claim | Run `pm2 stop <id>`; never signal a managed child that PM2 would restart |
| Docker container owned by the caller's project/claim | Run `docker stop` for that container; never signal the shared Docker backend |
| Detached service or a service owned by the caller's project/claim | Stop with SIGTERM, then SIGKILL after 3 seconds if needed |
| Another active service | Block, print attribution, and exit with code 3 |

`--force` overrides the guard after review. On macOS, `--gui` asks through a native confirmation dialog.

PortMarshal can only attribute listeners whose process metadata is visible to the current user. For example, Linux `ss` output without PID information is not invented or guessed; those rows are omitted.

## Agent integration

Add this policy to `AGENTS.md`, `CLAUDE.md`, or your editor's agent rules:

```text
- Start dev servers with `portmarshal run <service> --prefer <default> -- <command>`; it injects PORT/{port} and auto-releases on exit. Use `PORT=$(portmarshal claim ...)` only when you must manage the process yourself.
- Diagnose conflicts with `portmarshal list --project . --json` and `portmarshal whois <port> --json`.
- Stop services with `portmarshal stop <port>`; exit code 3 means another active service owns it, so show the attribution and ask before using --force.
```

A ready-to-copy Claude Code skill lives in [`integrations/claude-code/skills/portmarshal`](integrations/claude-code/skills/portmarshal).

## How it differs

- [`lsof`](https://man7.org/linux/man-pages/man8/lsof.8.html) and `ss` expose sockets and processes; PortMarshal adds project/agent attribution, claims, drift detection, and stop policy.
- [Sonar](https://github.com/RasKrebs/sonar) is a broad localhost and Docker management CLI; PortMarshal focuses on cross-agent ownership and guarded actions.
- [Portless](https://github.com/vercel-labs/portless) launches apps behind stable named local URLs; PortMarshal can inspect services whether or not it launched them. The tools can be used together.

## Development

```bash
pnpm test
pnpm smoke
pnpm build
```

GitHub Actions runs build, unit tests, and a real listener smoke test on macOS and Linux. Tagged releases publish to npm with provenance.

Design: [`docs/specs/2026-07-16-portmarshal-design.md`](docs/specs/2026-07-16-portmarshal-design.md) · [Changelog](CHANGELOG.md)

macOS and Linux · Node.js ≥ 18.17 · zero runtime dependencies · MIT
