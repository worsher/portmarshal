# Cursor integration

Copy `rules/portmarshal.mdc` from this adapter into the target project's `.cursor/rules/portmarshal.mdc`.
Review and merge an existing rule instead of replacing it. The rule uses `.mdc` frontmatter with
`alwaysApply: true`; a plain `.md` file in that directory is not equivalent.
[Official project-rule documentation](https://cursor.com/docs/rules).

Start a fresh Agent conversation, confirm the rule appears in its active rules, and follow the rule's
background-start, readiness, logs and guarded-stop examples in a disposable project. Automatic activation
must be checked in the host; a copied file or a CLI fixture does not establish that the Agent loaded it.

Cursor's conversation ID is not inferred by this adapter. Preserve an existing `PORTMARSHAL_OWNER` on
every command; otherwise doctor reports `owner.source: none` and project-level fallback. Do not put a
constant identity into this rule or assume shell exports survive between tool calls. An explicitly
configured owner should remain available across two separate doctor invocations.

For teams already using `AGENTS.md`, merge the short shared policy there instead of maintaining duplicate
rules. See [the shared workflow and owner contract](../README.md).
