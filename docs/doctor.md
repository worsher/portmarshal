# Doctor

Available in the v0.9.0 implementation. Run it from the intended project:

```bash
portmarshal doctor
portmarshal doctor --project . --json
```

Doctor inspects the running package/Node paths and versions, OS scanner availability, project directory,
registry structure/permissions, owner-identity availability and observable project service warnings.
It never writes state, migrates a legacy registry, repairs permissions, releases claims, or stops services.
It does not bind ports or send health requests. A timeout may terminate only its own diagnostic probes.

## Report contract

Text and JSON represent the same checks. JSON is one object with `schemaVersion: 1`, `version`, `project`,
`status`, `complete`, `owner` and `checks`. Each check has a stable `id`, `status`, `summary`, `details`,
and `nextSteps`. Check statuses are `pass`, `warn`, `error`, `skipped`; overall status excludes `skipped`.
Details are bounded local observations. Scripts should use IDs/statuses instead of parsing English prose.

Exit 0 means no error was found, but may include warnings. Exit 1 means an error or invalid command usage.
For a clean automated gate, require both `status === "pass"` and `complete === true`. Existing exit codes
2–4 keep their meanings on other commands. Valid JSON invocations also return a report on expected probe
failures; invalid arguments use the normal CLI stderr usage error.

`complete: false` means some required evidence could not be established. Examples include denied process
visibility, an active registry lock, pending legacy migration, or managed-runtime metadata being skipped.
Doctor does not turn an incomplete scan into a stale-claim, dead-run or foreign-project assertion.
Another session's healthy service is not an error. An active detached service with corroborating ownership
is healthy as well. A stale claim follows the existing strictly-more-than-30-minutes policy.

## Common findings

| Finding | Meaning and next step |
| --- | --- |
| `scanner.listeners` error | Check access to `lsof`/`ps` on macOS or `ss`/`ps` and `/proc` on Linux; rerun in the intended environment |
| `scanner.attribution` warning | Missing process metadata limits conclusions; do not infer that unseen listeners are absent |
| `state.registry` error | State is unreadable, malformed, non-regular, or above the 4 MiB read bound; review it locally; doctor did not repair it |
| `state.concurrent-change` warning | State or lock observation is provisional; retry after the operation finishes, preserving its lock |
| `state.legacy` warning | Legacy migration is pending or could not be checked; doctor does not import legacy claims |
| `owner.identity` warning | No stable session identity is available; follow the [integration guide](../integrations/README.md) or accept project-level fallback |
| `services.review` warning | Inspect the relevant port, claim or managed-run status; `gc --dry-run` previews cleanup |
| `services.conflict` error | Contradictory ownership was observed; inspect `whois <port> --json` before choosing any action |

Doctor scans machine-wide listener evidence before restricting findings to the canonical project and its
descendants. This prevents an out-of-project listener from being mistaken for an unlistened project claim.
It does not invoke Docker or PM2 clients; their visible listeners are noted but container/application
ownership remains unverified. Existing `list` and `whois` retain their runtime enrichment behavior.

Registry reads are capped at 4 MiB, scanner output at 16 MiB per probe, each probe at 3 seconds, and scanner
collection at 10 seconds. No per-PID external commands are added. File/probe errors are sanitized; JSON and
text omit process commands, logs, raw environment values, raw owner IDs/fingerprints and run markers.
Project/executable paths and relevant ports/PIDs remain visible, so the report is not an anonymized upload.

Doctor's observations never authorize a stop. Use existing guarded commands and their fresh ownership
checks for a user-requested action. `--fix`, `--force`, `--show-sensitive-command` and other mutation flags
are not doctor options.
