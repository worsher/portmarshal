import crypto from "node:crypto";

export interface OwnerIdentity {
  /** Non-sensitive integration label. */
  source: "explicit" | "codex";
  /** Versioned one-way fingerprint; the raw session value is never persisted. */
  key: string;
}

export function ownerFingerprint(source: string, value: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(source)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, 24);
  return `v1:${digest}`;
}

/**
 * Resolve a stable owner for separate PortMarshal invocations in the same agent session.
 * PORTMARSHAL_OWNER is the portable integration contract. Codex IDs are a best-effort
 * automatic source; neither raw value leaves this function.
 */
export function resolveOwnerIdentity(
  env: NodeJS.ProcessEnv = process.env,
): OwnerIdentity | null {
  const explicit = env.PORTMARSHAL_OWNER?.trim();
  if (explicit) {
    return { source: "explicit", key: ownerFingerprint("explicit", explicit) };
  }
  const codex = env.CODEX_THREAD_ID?.trim() || env.CODEX_SESSION_ID?.trim();
  if (codex) {
    return { source: "codex", key: ownerFingerprint("codex", codex) };
  }
  return null;
}
