import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { Registry, LockTimeoutError, defaultClaimedBy } from "../registry.js";
import { projectOwnsPort } from "../scan.js";

const USAGE = "Usage: portmarshal run <name> [--prefer N] [--range A-B] [--restart] -- <command...>\n";
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export function substitutePort(args: string[], port: number): string[] {
  return args.map((a) => a.split("{port}").join(String(port)));
}

async function claimPort(registry: Registry, name: string, project: string, flags: Flags): Promise<number> {
  const { port } = await registry.claim({
    name, project,
    prefer: flags.prefer,
    range: flags.range,
    claimedBy: defaultClaimedBy(),
    portOwnedByProject: projectOwnsPort(project),
  });
  return port;
}

export default async function run(flags: Flags): Promise<number> {
  const name = flags.positional[0];
  if (!name || flags.rest.length === 0) {
    process.stderr.write(USAGE);
    return EXIT.ERR;
  }
  const project = path.resolve(flags.project ?? process.cwd());
  const registry = new Registry();

  let port: number;
  try {
    port = await claimPort(registry, name, project, flags);
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      process.stderr.write(`portmarshal: ${e.message}\n`);
      return EXIT.LOCK_TIMEOUT;
    }
    throw e;
  }

  const argv = substitutePort(flags.rest, port);
  process.stderr.write(`portmarshal: serving ${name}@${project} on port ${port}\n`);
  const child = spawn(argv[0], argv.slice(1), {
    stdio: "inherit",
    detached: true, // 子进程自成进程组：信号发给整组，覆盖 npm run dev 之下真正监听的孙进程
    env: { ...process.env, PORT: String(port) },
  });

  return new Promise<number>((resolve) => {
    let escalated = false;
    const forward = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, escalated ? "SIGKILL" : "SIGTERM"); } catch { /* 组已不存在 */ }
      escalated = true;
    };
    const finish = (code: number) => {
      for (const sig of FORWARDED) process.removeListener(sig, forward);
      void registry.release(name, project).then(() => resolve(code));
    };
    for (const sig of FORWARDED) process.on(sig, forward);
    child.once("error", (err) => {
      process.stderr.write(`portmarshal: failed to start ${argv[0]}: ${err.message}\n`);
      finish(EXIT.ERR);
    });
    child.once("exit", (code, signal) => {
      finish(signal ? 128 + (os.constants.signals[signal] ?? 15) : (code ?? EXIT.ERR));
    });
  });
}
