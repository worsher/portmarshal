import path from "node:path";
import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { Registry, LockTimeoutError, OwnerMismatchError, defaultClaimedBy } from "../registry.js";
import { projectOwnsPort } from "../scan.js";
import { resolveOwnerIdentity } from "../owner.js";

export default async function claim(flags: Flags): Promise<number> {
  const name = flags.positional[0];
  if (!name) {
    process.stderr.write("Usage: portmarshal claim <name> [--prefer N] [--range A-B]\n");
    return EXIT.ERR;
  }
  const project = path.resolve(flags.project ?? process.cwd());
  const registry = new Registry();
  const owner = resolveOwnerIdentity();
  try {
    const { port, reused, previousPort } = await registry.claim({
      name, project,
      prefer: flags.prefer,
      range: flags.range,
      claimedBy: defaultClaimedBy(),
      ownerKey: owner?.key,
      portOwnedByProject: projectOwnsPort(project),
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify({ name, project, port, reused, previousPort }) + "\n");
    } else {
      process.stdout.write(String(port) + "\n"); // Keep stdout machine-safe for PORT=$(...).
      process.stderr.write(
        reused
          ? `Reused claim ${name}@${project} → ${port}\n`
          : previousPort
            ? `Previous claim ${previousPort} is owned by another process; reassigned ${name}@${project} → ${port}\n`
            : `Claimed ${name}@${project} → ${port}\n`,
      );
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      process.stderr.write(`portmarshal: ${e.message}\n`);
      return EXIT.LOCK_TIMEOUT;
    }
    if (e instanceof OwnerMismatchError) {
      process.stderr.write(
        `Blocked: ${e.message}\n` +
        "  Use the same PORTMARSHAL_OWNER to hand off deliberately, or review and release the old claim with --force.\n",
      );
      return EXIT.BLOCKED;
    }
    throw e;
  }
}
