import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectRegistry, REGISTRY_READ_LIMIT, validateEntries } from "../src/diagnostics/registry.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-doctor-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { dir: root + "/state", file: root + "/state/registry.json", legacyFile: root + "/legacy.json" };
}
const entry = { name: "web", project: "/p/app", port: 3000, claimedAt: "2026-09-08T00:00:00Z" };

test("doctor state: first use and legacy state remain untouched", async (t) => {
  const paths = await fixture(t);
  assert.equal((await inspectRegistry(paths)).status, "absent");
  await fs.writeFile(paths.legacyFile, JSON.stringify([entry]));
  const result = await inspectRegistry(paths);
  assert.equal(result.legacy, "present");
  assert.deepEqual(result.entries, []);
  await assert.rejects(fs.stat(paths.dir), { code: "ENOENT" });
});

test("doctor state: malformed data and insecure modes are reported without repair", async (t) => {
  const paths = await fixture(t);
  await fs.mkdir(paths.dir, { mode: 0o755 });
  await fs.writeFile(paths.file, "{broken", { mode: 0o644 });
  const before = await fs.stat(paths.file);
  const result = await inspectRegistry(paths);
  assert.equal(result.status, "invalid");
  assert.equal(result.permissions.length, 2);
  assert.equal(await fs.readFile(paths.file, "utf8"), "{broken");
  const after = await fs.stat(paths.file);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(paths.dir), ["registry.json"]);
});

test("doctor state: valid records tolerate additive fields; invalid known fields fail", () => {
  assert.deepEqual(validateEntries([{ ...entry, future: "sentinel" }]), [entry]);
  for (const value of [{}, [null], [{ ...entry, port: 65536 }], [{ ...entry, claimedAt: "bad" }],
    [{ ...entry, released: "false" }], [{ ...entry, runPid: -1 }], [{ ...entry, ownerKey: 7 }]]) {
    assert.equal(validateEntries(value), null);
  }
});

test("doctor state: oversized files, symlinks, and locks are never cleaned up", async (t) => {
  const paths = await fixture(t);
  await fs.mkdir(paths.dir, { mode: 0o700 });
  await fs.writeFile(paths.file, " ".repeat(REGISTRY_READ_LIMIT + 1));
  assert.equal((await inspectRegistry(paths)).status, "oversized");
  await fs.unlink(paths.file);
  await fs.writeFile(paths.legacyFile, JSON.stringify([entry]));
  await fs.symlink(paths.legacyFile, paths.file);
  assert.equal((await inspectRegistry(paths)).status, "non-regular");
  await fs.unlink(paths.file);
  await fs.writeFile(paths.file, JSON.stringify([entry]), { mode: 0o600 });
  await fs.mkdir(paths.dir + "/.lock");
  const result = await inspectRegistry(paths);
  assert.equal(result.status, "valid");
  assert.equal(result.lock, "present");
  assert.deepEqual(result.entries, [entry]);
  assert.equal((await fs.stat(paths.dir + "/.lock")).isDirectory(), true);
});

test("doctor state: denied read is not interpreted as an empty registry", async (t) => {
  const paths = await fixture(t);
  await fs.mkdir(paths.dir, { mode: 0o700 });
  await fs.writeFile(paths.file, "[]");
  const result = await inspectRegistry(paths, {
    lstat: fs.lstat,
    open: (async () => { throw Object.assign(new Error("private sentinel"), { code: "EACCES" }); }) as typeof fs.open,
  });
  assert.equal(result.status, "unreadable");
  assert.equal(JSON.stringify(result).includes("private sentinel"), false);
});

test("doctor state: concurrent replacement is retried once and never returned as valid", async (t) => {
  const paths = await fixture(t);
  await fs.mkdir(paths.dir, { mode: 0o700 });
  await fs.writeFile(paths.file, JSON.stringify([entry]));
  let opens = 0;
  const result = await inspectRegistry(paths, {
    lstat: fs.lstat,
    open: (async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      opens++;
      await fs.writeFile(paths.file + ".new", JSON.stringify([{ ...entry, port: 3000 + opens }]));
      await fs.rename(paths.file + ".new", paths.file);
      return handle;
    }) as typeof fs.open,
  });
  assert.equal(opens, 2);
  assert.equal(result.status, "changing");
  assert.deepEqual(result.entries, []);
});
