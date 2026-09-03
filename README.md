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
| `portmarshal list [--services] [--json] [--all] [--project .]` | List per-port state, or aggregate process trees, ports, and claims into services |
| `portmarshal whois <port> [--json]` | Inspect one port plus its service listeners, wrappers, PGID, claims, and stop plan |
| `portmarshal claim <name> [--prefer N] [--range A-B]` | Allocate a cooperative sticky port claim; stdout contains only the port number |
| `portmarshal run <name> [--prefer N] [--restart] -- <command...>` | Claim a port, inject it as `PORT` and `{port}`, supervise the command in the foreground, auto-release on exit |
| `portmarshal run -d <name> [--wait-timeout N] [--ready-url PATH] -- <command...>` | Same as above, but detached: captures output to a log file and returns once the service is ready |
| `portmarshal logs <name\|port> [-n N] [-f] [--json]` | Show or follow the log of a service started with `run -d` |
| `portmarshal release <name> [--force]` | Release a claim without stopping its process; another session's claim requires explicit review and `--force` |
| `portmarshal stop <port\|name> [--force\|--gui]` | Stop a service behind the ownership guard |
| `portmarshal gc [--dry-run\|--kill-detached]` | Preview cleanup, reap stale claims, or stop detached service candidates |
| `portmarshal watch [--services]` | Refreshing port or service dashboard; press `q` to quit |
| `portmarshal menubar [--install]` | Service-grouped SwiftBar menu with guarded click-to-stop actions |

Typical agent startup:

```bash
portmarshal run web --prefer 3000 -- npm run dev
# frameworks that only accept a CLI flag:
portmarshal run web --prefer 5173 -- pnpm vite --port {port}
```

`run` claims a sticky port, injects it as the `PORT` environment variable (and replaces `{port}` placeholders in the command), streams output in the foreground, forwards signals to the whole process group, and releases the claim when the command exits. If the port is still served by a previous instance of the same project, `run` refuses with exit code 3; add `--restart` to stop it through the ownership guard first. `claim` remains available for scripts that manage the process themselves. Stdin is not forwarded to the child, so interactive framework shortcuts (e.g. Vite's terminal hotkeys) won't respond — `run` is built for supervised dev servers, not interactive sessions.

### Backgrounding with `run -d`

```bash
# Start a dev server in the background; returns once the port accepts connections
portmarshal run -d web --prefer 3000 -- pnpm dev

# Health-gated readiness and a custom timeout
portmarshal run -d api --ready-url /health --wait-timeout 60 -- pnpm start

# Tail its logs
portmarshal logs web -f
```

`run -d` detaches the child into its own process group, redirects its stdout/stderr into a log file under `~/.portmarshal/logs/`, and returns control to the caller once the service is ready — no need to babysit a foreground process. Readiness defaults to a plain TCP connect on the claimed port over either IPv4 or IPv6 loopback, with a 30-second timeout; pass `--ready-url /health` to require an HTTP 2xx/3xx response from that path instead, and `--wait-timeout N` to change the timeout in seconds. After the endpoint responds, PortMarshal verifies that its listener carries this run's random identity and belongs to the spawned process group, so another process winning the allocation-to-bind race cannot be reported as ready. If the service fails to become ready (crashes, times out, or the listener belongs to another run), `run -d` prints the last 20 lines of its log, terminates only its verified process group, releases the claim, and exits non-zero. Interrupting the readiness wait with SIGINT, SIGTERM, or SIGHUP performs the same process-group and claim cleanup before exiting with the signal-derived code. On success it prints a `ready` line with the pid and log path and exits 0.

Log files live at `~/.portmarshal/logs/<hash8>-<name>.log`, keyed by a hash of the project directory so the same service name in different projects doesn't collide; names that need filesystem sanitization also carry a short hash to prevent collisions. State and log directories are restricted to the current user (`0700`), and registry/log files use `0600`. Each `run -d` rotates the previous log to `<file>.log.old` before starting, retaining at most the final 10 MiB of that previous run, so both the current and prior run stay inspectable; the active log can continue growing until the run exits or restarts. Log files are not deleted when the claim is released. Use `portmarshal logs <name|port>` to print the tail (50 lines by default, `-n` to change it) with a bounded 1 MiB read window, `-f` to follow across file rotation, or `--json` for machine-readable output.

Services started with `run -d` are attributed as `run:<name>` in `list`, `whois`, and `gc`, and are exempt from `gc`'s detached-service candidates — they're already managed. `stop` still applies the normal ownership guard. `run -d` does not auto-restart a crashed process: if the managed process dies on its own, `portmarshal list` marks its entry `dead` until you `run -d` it again or release the claim.

## Attribution and safety

`list --services` builds a service snapshot instead of rendering one row per port. PortMarshal first uses
managed `run -d`, Docker, and PM2 identities, then groups ordinary listeners by canonical project and PGID.
Listeners sharing one socket are grouped only when their project attribution agrees. The result exposes all
listener PIDs, same-PGID wrapper ancestors, ports, claims, attachment state, ownership confidence, and the
safe stop strategy. Use `list --services --json` for the versioned `{ "schemaVersion": 1, "services": [...] }`
shape; the existing per-port `list --json` output remains available.

Attachment and ownership are separate: a detached service with a matching project claim is still active and
corroborated, so it is not counted as a menubar error. A reserved claim in a project with exactly one live
service is shown as related and reviewable; PortMarshal never auto-releases or merges it solely because the
project path matches. Once a claim has been unlistened for more than 30 minutes, it no longer participates in
live-service drift inference: the healthy listener stays unmarked, while the stale claim is shown as its own
warning item and remains available to `gc --dry-run` review.

### SwiftBar troubleshooting

If an otherwise normal service row or submenu appears gray in SwiftBar 2.1.1, refresh or restart SwiftBar and
upgrade to SwiftBar 2.1.2 or newer when available. This is an upstream incremental submenu rendering issue
([SwiftBar #515](https://github.com/swiftbar/SwiftBar/issues/515), fixed by
[SwiftBar #518](https://github.com/swiftbar/SwiftBar/pull/518)); PortMarshal does not emit a disabled attribute
for service rows. An orange `⚠` row is different: it is an intentional PortMarshal review signal, with the
claim or attribution details shown in that row's submenu.

PortMarshal follows the process parent chain to identify `claude-code`, `cursor`, `antigravity`, `vscode/electron`, `terminal`, `docker`, and `pm2`. PM2-managed listeners are enriched from `pm2 jlist`, displayed as `pm2:<app-name>`, and attributed to the application's configured cwd; the full PM2 environment is never retained. For published Docker ports, PortMarshal inspects running-container metadata: shared Docker Desktop listeners are split by container, the source is shown as `docker:<compose-project>/<service>`, and the host project directory is recovered from Compose, Dev Container, or bind-mount metadata. If managed-runtime metadata is unavailable, attribution safely falls back without inventing ownership. PortMarshal also recognizes `launchd:<label>` on macOS and `systemd:<unit>` on Linux. A process reparented to PID 1 without a recognized manager is labeled `detached` — this is a review signal, not proof that the process is abandoned. For detached processes the parent chain is gone, so PortMarshal falls back to environment-variable remnants (macOS `ps eww`, Linux `/proc/<pid>/environ`): markers such as `CLAUDECODE=1` or an IDE bundle identifier reveal who originally launched the process, shown as `detached (claude-code)`. Only a small allowlist of marker keys is read — the full environment, which may contain secrets, is never retained. Command output also redacts common credential-bearing flags, assignments, headers, URL userinfo, and query parameters by default. `--show-sensitive-command` reveals the raw command for local debugging; do not paste that output into issues or agent transcripts.

Cooperative claims also carry an agent-session owner when PortMarshal can resolve one. `PORTMARSHAL_OWNER` is the portable integration contract, and Codex thread/session IDs are recognized automatically. The value should be a stable, non-secret ID shared by every PortMarshal invocation in that session; do not generate a new value per command. PortMarshal stores only a one-way SHA-256 fingerprint, never the raw ID. A different session cannot reuse or release the claim, stop its same-project service, or replace it with `run --restart` without an explicit override. Legacy registries and environments without a stable owner keep the v0.6 project-level behavior; an old ownerless claim is adopted on its first safe reuse.

| Target | Default `stop` behavior |
|---|---|
| PM2 application owned by the caller's project/claim | Run `pm2 stop <id>`; never signal a managed child that PM2 would restart |
| Docker container owned by the caller's project/claim | Run `docker stop` for that container; never signal the shared Docker backend |
| Service verified as owned by the caller's current project/claim | Stop with SIGTERM, then SIGKILL after 3 seconds if needed |
| Same-project service claimed by another agent session | Block, identify the claiming integration, and exit with code 3 |
| Detached/unattributed service without current-project proof | Block, print attribution, and exit with code 3 |
| Another active service or a listener contradicting a stale claim | Block, print attribution, and exit with code 3 |

`--force` overrides the guard after review. On macOS, `--gui` asks through a native confirmation dialog.

PortMarshal can only attribute listeners whose process metadata is visible to the current user. For example, Linux `ss` output without PID information is not invented or guessed; those rows are omitted.

## Agent integration

Add this policy to `AGENTS.md`, `CLAUDE.md`, or your editor's agent rules:

```text
- Start dev servers with `portmarshal run <service> --prefer <default> -- <command>`; it injects PORT/{port} and auto-releases on exit. Use `PORT=$(portmarshal claim ...)` only when you must manage the process yourself.
- Preserve one stable, non-secret `PORTMARSHAL_OWNER` value across commands when the agent host does not expose an automatically recognized session ID; never generate a fresh value per command.
- Diagnose conflicts with `portmarshal list --project . --json` and `portmarshal whois <port> --json`.
- Stop services with `portmarshal stop <port>`; exit code 3 means ownership could not be safely verified or another active service owns it, so show the attribution and ask before using --force.
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

GitHub Actions runs build, unit tests, and a real listener smoke test on macOS and Linux with Node.js 22 and 24. Tagged releases publish to npm with provenance.

Design: [`docs/specs/2026-07-16-portmarshal-design.md`](docs/specs/2026-07-16-portmarshal-design.md) · [v0.7.0 agent-session ownership](docs/specs/2026-08-20-v0.7.0-agent-session-ownership.md) · [v0.8.0 service-level ownership](docs/specs/2026-08-24-v0.8.0-service-ownership.md) · [v0.8.1 attribution fixes](docs/specs/2026-09-03-v0.8.1-attribution-fixes.md) · [Changelog](CHANGELOG.md)

macOS and Linux · Node.js ≥ 18.17 · zero runtime dependencies · MIT
