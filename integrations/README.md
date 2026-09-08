# Agent integrations

PortMarshal 0.9.0 provides self-contained instructions for [Codex](codex/README.md),
[Claude Code](claude-code/README.md), and [Cursor](cursor/README.md). The templates guide local development
work; they do not grant OS isolation or permission to stop unrelated services.

Use assets from the installed npm package so the instructions match that CLI version. From the target
project, find the global package with `npm root -g`; its `portmarshal/integrations` directory contains all
three adapters. A local installation has the same assets under `node_modules/portmarshal/integrations`.
For a source checkout, build first and use its `integrations` directory. Do not replace a released template
with an unversioned download from `main`.

Copy the selected adapter to the project location described in its guide. Review an existing destination
before merging changes; do not overwrite project rules. Confirm the host loads the instructions in a fresh
session. File presence alone is not evidence of activation.

## Shared workflow

1. Run `portmarshal --version` and `portmarshal doctor --project . --json`. Inspect warnings and `complete`.
2. Preserve a stable owner identity; use `run -d` for background work or `run` for foreground supervision.
3. Use `list --services --project . --json`, `whois <actual-port> --json`, and `logs <name>` to inspect.
4. Stop the intended service through `stop`; review exit code 3 instead of escalating automatically.
5. Use `gc --dry-run` for cleanup previews. Plain `gc` mutates stale claims; `release` does not stop a server.

## Owner continuity

`PORTMARSHAL_OWNER` overrides automatic Codex IDs. It must be stable and unique to one session, shared only
for a deliberate handoff. Do not put a constant owner in a checked-in rule, generate a new owner for every
command, or print raw IDs. If your host does not preserve shell exports, pass the same explicit owner in
each command's environment. An absent owner means project-level fallback, not a session-level guarantee.

The Claude/Cursor templates use this explicit contract rather than guessing a host environment variable.
Claude skill session substitution is not proof of a shell export. Instructions cannot guarantee that a
host or model will retain an identity; verify its presence with doctor across tool calls.

See the [doctor guide](../docs/doctor.md) for statuses and diagnostic limits.
