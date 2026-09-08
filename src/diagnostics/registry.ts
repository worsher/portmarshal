import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { Registry } from "../registry.js";
import type { RegistryEntry } from "../types.js";

export const REGISTRY_READ_LIMIT = 4 * 1024 * 1024;
export type RegistryPaths = Pick<Registry, "dir" | "file" | "legacyFile">;
export type RegistryStatus = "absent" | "valid" | "invalid" | "unreadable" | "oversized" | "non-regular" | "changing";
export interface RegistryObservation {
  status: RegistryStatus;
  entries: RegistryEntry[];
  permissions: string[];
  lock: "absent" | "present" | "unknown";
  legacy: "absent" | "present" | "unknown";
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const port = (v: unknown) => positive(v) && (v as number) <= 65535;
const nonempty = (v: unknown) => typeof v === "string" && v.trim().length > 0;

/** Return only known fields; never propagate arbitrary registry properties into downstream analysis. */
export function validateEntries(value: unknown): RegistryEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: RegistryEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const v = item as Record<string, unknown>;
    if (!nonempty(v.name) || !nonempty(v.project) || !port(v.port) ||
        typeof v.claimedAt !== "string" || !Number.isFinite(Date.parse(v.claimedAt))) return null;
    for (const key of ["claimedBy", "ownerKey", "runId", "logFile"]) {
      if (v[key] !== undefined && !nonempty(v[key])) return null;
    }
    if ((v.released !== undefined && typeof v.released !== "boolean") ||
        (v.runPid !== undefined && !positive(v.runPid)) ||
        (v.lastPort !== undefined && !port(v.lastPort))) return null;
    const entry: Record<string, unknown> = {};
    for (const key of ["name", "project", "port", "claimedAt", "claimedBy", "ownerKey",
      "released", "runPid", "runId", "lastPort", "logFile"]) {
      if (v[key] !== undefined) entry[key] = v[key];
    }
    entries.push(entry as unknown as RegistryEntry);
  }
  return entries;
}

function unchanged(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** The injectable filesystem permits deterministic permission and concurrent-rename tests. */
export async function inspectRegistry(
  paths: RegistryPaths = new Registry(),
  io: Pick<typeof fs, "lstat" | "open"> = fs,
): Promise<RegistryObservation> {
  const result: RegistryObservation = {
    status: "absent", entries: [], permissions: [], lock: "absent", legacy: "absent",
  };
  const observe = async (file: string): Promise<"absent" | "present" | "unknown"> => {
    try { await io.lstat(file); return "present"; }
    catch (e) { return missing(e) ? "absent" : "unknown"; }
  };
  const permission = (st: Stats, expected: number, label: string) => {
    if ((st.mode & 0o777) !== expected) result.permissions.push(label + " has unexpected permissions.");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      result.permissions.push(label + " is owned by another user.");
    }
  };
  try {
    const dir = await io.lstat(paths.dir);
    permission(dir, 0o700, "State directory");
    // A symlinked directory may be intentionally configured; do not change or traverse it for diagnostics.
    if (!dir.isDirectory()) { result.status = "non-regular"; return result; }
  } catch (e) {
    if (!missing(e)) { result.status = "unreadable"; return result; }
  }
  result.lock = await observe(paths.dir + "/.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const before = await io.lstat(paths.file);
      if (!before.isFile()) { result.status = "non-regular"; break; }
      if (before.size > REGISTRY_READ_LIMIT) { result.status = "oversized"; break; }
      // NOFOLLOW closes the symlink race; NONBLOCK prevents a replacement FIFO from hanging open().
      handle = await io.open(paths.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile()) { result.status = "non-regular"; break; }
      if (!unchanged(before, opened)) { result.status = "changing"; continue; }
      const buffer = Buffer.alloc(Math.min(before.size + 1, REGISTRY_READ_LIMIT));
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      const after = await handle.stat();
      const current = await io.lstat(paths.file);
      if (!unchanged(before, after) || !unchanged(after, current) || size !== before.size) {
        result.status = "changing";
        continue;
      }
      permission(after, 0o600, "Registry");
      let value: unknown;
      try { value = JSON.parse(buffer.subarray(0, size).toString("utf8")); }
      catch { result.status = "invalid"; break; }
      const entries = validateEntries(value);
      result.status = entries ? "valid" : "invalid";
      result.entries = entries ?? [];
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (missing(e)) {
        if (handle || result.status === "changing") { result.status = "changing"; continue; }
        result.status = "absent";
      } else result.status = code === "ELOOP" ? "non-regular" : "unreadable";
      break;
    } finally {
      await handle?.close();
    }
  }
  const lockAfter = await observe(paths.dir + "/.lock");
  if (lockAfter !== "absent") result.lock = lockAfter;
  if (result.status === "absent" && paths.legacyFile) result.legacy = await observe(paths.legacyFile);
  return result;
}
