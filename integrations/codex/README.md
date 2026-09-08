# Codex integration

Copy `skills/portmarshal/SKILL.md` from this adapter into the target project's
`.agents/skills/portmarshal/SKILL.md`, creating the directory if needed and reviewing any existing skill first.
The skill is self-contained. Start a fresh Codex session and explicitly invoke `$portmarshal` to confirm it
is available; also verify the host's active instruction list before relying on automatic selection.
[Official skill locations](https://learn.chatgpt.com/docs/build-skills).

Alternatively, merge this policy into the project's `AGENTS.md`:

```text
For local development services, check portmarshal --version and portmarshal doctor --project . --json.
Start through portmarshal run -d <name> --prefer <port> -- <command>, using {port} when the framework ignores PORT.
Preserve PORTMARSHAL_OWNER when present; otherwise let PortMarshal recognize available Codex session IDs.
Use list --services --project . --json, whois <actual-port> --json, and logs <name> to inspect.
Stop the intended service using portmarshal stop; inspect exit code 3 before any restart or authorized override.
Preview cleanup using portmarshal gc --dry-run. Plain gc releases stale claims; release does not stop a listener.
```

Codex can layer or override project instructions; check which file is active rather than replacing existing
guidance. [Official AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

After activation, follow the skill's readiness/log examples in a disposable project. Run doctor in separate
shell calls: `owner.source` should remain `codex` or `explicit`. If it becomes `none`, diagnose the host's
environment propagation or document project-level fallback. Doctor does not print the session ID or fingerprint.

See [shared workflow and installation options](../README.md).
