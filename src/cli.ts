#!/usr/bin/env node
import fs from "node:fs/promises";
import { EXIT } from "./types.js";
import { parseFlags } from "./flags.js";
import type { Flags } from "./flags.js";

export type { Flags } from "./flags.js";

const HELP = `portmarshal — agent-aware local port ownership and guarded orchestration

Usage:
  portmarshal list [--json] [--all] [--project <dir|.>]
  portmarshal whois <port> [--json]
  portmarshal claim <name> [--prefer N] [--range A-B] [--json]
  portmarshal run <name> [-d] [--wait-timeout N] [--ready-url PATH] [--prefer N] [--range A-B] [--project DIR] [--restart] -- <command...>
  portmarshal logs <name|port> [--project DIR] [-f] [-n N] [--json]
  portmarshal release <name>
  portmarshal stop <port|name> [--force|--gui] [--json]
  portmarshal gc [--kill-detached]
  portmarshal watch
  portmarshal menubar [--install]
  portmarshal -v | --version
`;

type CommandFn = (flags: Flags) => Promise<number>;
const COMMANDS: Record<string, () => Promise<{ default: CommandFn }>> = {
  list: () => import("./commands/list.js"),
  whois: () => import("./commands/whois.js"),
  claim: () => import("./commands/claim.js"),
  run: () => import("./commands/run.js"),
  release: () => import("./commands/release.js"),
  stop: () => import("./commands/stop.js"),
  gc: () => import("./commands/gc.js"),
  logs: () => import("./commands/logs.js"),
  watch: () => import("./commands/watch.js"),
  menubar: () => import("./commands/menubar.js"),
};

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    const pkg = JSON.parse(
      await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(pkg.version + "\n");
    return EXIT.OK;
  }
  const loader = COMMANDS[cmd];
  if (!loader) {
    process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
    return EXIT.ERR;
  }
  try {
    const mod = await loader();
    return await mod.default(parseFlags(rest));
  } catch (e) {
    process.stderr.write(`portmarshal: ${(e as Error).message}\n`);
    return EXIT.ERR;
  }
}

main().then((code) => { process.exitCode = code; });
