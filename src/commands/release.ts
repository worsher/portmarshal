import path from "node:path";
import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { OwnerMismatchError, Registry } from "../registry.js";
import { isPortFree } from "../registry.js";
import { resolveOwnerIdentity } from "../owner.js";

export default async function release(flags: Flags): Promise<number> {
  const name = flags.positional[0];
  if (!name) {
    process.stderr.write("Usage: portmarshal release <name> [--force]\n");
    return EXIT.ERR;
  }
  const project = path.resolve(flags.project ?? process.cwd());
  const registry = new Registry();
  let entry;
  try {
    entry = await registry.release(name, project, {
      ownerKey: resolveOwnerIdentity()?.key,
      force: flags.force,
    });
  } catch (error) {
    if (error instanceof OwnerMismatchError) {
      process.stderr.write(
        `Blocked: ${error.message}\n` +
        "  Review the claim, then add --force to release it without stopping its process.\n",
      );
      return EXIT.BLOCKED;
    }
    throw error;
  }
  if (!entry) {
    process.stderr.write(`No active claim found for ${name}@${project}\n`);
    return EXIT.NOT_FOUND;
  }
  process.stderr.write(`Released claim ${name} → ${entry.port}\n`);
  if (!(await isPortFree(entry.port))) {
    process.stderr.write(`Note: port ${entry.port} is still listening. release only removes the claim; stop it with portmarshal stop ${entry.port}\n`);
  }
  return EXIT.OK;
}
