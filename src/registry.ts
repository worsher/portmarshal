import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { RegistryEntry } from "./types.js";

export const CLAIM_STALE_MS = 30 * 60 * 1000;

/** Single source of truth for claims that are eligible for gc and must not influence live service attribution. */
export function isStaleClaim(
  entry: RegistryEntry,
  listeningPorts: Set<number>,
  now = Date.now(),
): boolean {
  if (entry.released || listeningPorts.has(entry.port)) return false;
  return now - Date.parse(entry.claimedAt) > CLAIM_STALE_MS;
}

export class LockTimeoutError extends Error {
  constructor() { super("Registry lock timed out; retry the command"); }
}

export class OwnerMismatchError extends Error {
  readonly action: "claim" | "release";
  readonly entry: RegistryEntry;

  constructor(action: "claim" | "release", entry: RegistryEntry) {
    const actor = entry.claimedBy ? ` (${entry.claimedBy})` : "";
    super(`${entry.name}@${entry.project} is owned by another agent session${actor}`);
    this.name = "OwnerMismatchError";
    this.action = action;
    this.entry = entry;
  }
}

function probeFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      // 本机没有该地址族（无 IPv6 环境）≠ 端口被占，视为该族上空闲
      resolve(code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT" || code === "EINVAL");
    });
    srv.listen({ port, host }, () => srv.close(() => resolve(true)));
  });
}

export async function isPortFree(port: number): Promise<boolean> {
  // 仅探 127.0.0.1 会漏掉只绑 IPv6 的监听者（如 dev server 绑 ::1），双栈都空闲才算空闲
  return (await probeFree(port, "127.0.0.1")) && (await probeFree(port, "::1"));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class Registry {
  readonly dir: string;
  readonly file: string;
  readonly legacyFile?: string;

  constructor(dir?: string, legacyFile?: string) {
    const home = os.homedir();
    const configuredDir = process.env.PORTMARSHAL_STATE_DIR;
    this.dir = dir ?? configuredDir ?? path.join(home, ".portmarshal");
    this.file = path.join(this.dir, "registry.json");
    this.legacyFile = legacyFile ?? (dir === undefined && configuredDir === undefined
      ? path.join(home, ".portscout", "registry.json")
      : undefined);
  }

  private async ensurePrivateDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
  }

  private async secureExistingState(): Promise<void> {
    await fs.chmod(this.dir, 0o700).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    });
    await fs.chmod(this.file, 0o600).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    });
  }

  private async migrateLegacyRegistry(): Promise<void> {
    if (!this.legacyFile) return;
    try {
      await fs.access(this.file);
      return;
    } catch {
      // Continue only when the new registry does not exist.
    }
    let raw: string;
    try {
      raw = await fs.readFile(this.legacyFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    await this.ensurePrivateDir();
    const tmp = `${this.file}.${process.pid}.migration.tmp`;
    await fs.writeFile(tmp, raw, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600);
    process.stderr.write(`portmarshal: migrated registry from ${this.legacyFile}\n`);
  }

  async load(): Promise<RegistryEntry[]> {
    await this.secureExistingState();
    await this.migrateLegacyRegistry();
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    try {
      return JSON.parse(raw) as RegistryEntry[];
    } catch {
      await fs.rename(this.file, this.file + ".bak").catch(() => {});
      process.stderr.write("portmarshal: registry was invalid; backed it up as registry.json.bak and started clean\n");
      return [];
    }
  }

  private async save(entries: RegistryEntry[]): Promise<void> {
    await this.ensurePrivateDir();
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockDir = path.join(this.dir, ".lock");
    const pidFile = path.join(lockDir, "pid");
    await this.ensurePrivateDir();
    const start = Date.now();
    for (;;) {
      try {
        await fs.mkdir(lockDir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() - start > 2000) {
          const holderRaw = await fs.readFile(pidFile, "utf8").catch(() => null);
          const holder = holderRaw === null ? NaN : Number(holderRaw);
          if (!Number.isFinite(holder) || holder <= 0) {
            // pid 缺失或内容无效（撕裂写入）：持有者可能正处于「mkdir 成功但还没写完 pid」的窗口期。
            // 只有当 lockDir 本身足够老（大概率是崩溃进程的残留）才视为可回收，否则耐心等待。
            const st = await fs.stat(lockDir).catch(() => null);
            if (st && Date.now() - st.mtimeMs > 10_000) {
              await fs.rm(lockDir, { recursive: true, force: true });
            }
            await new Promise((r) => setTimeout(r, 50));
            continue;
          }
          if (isAlive(holder)) throw new LockTimeoutError();
          await fs.rm(lockDir, { recursive: true, force: true });
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      try {
        await fs.chmod(lockDir, 0o700);
        await fs.writeFile(pidFile, String(process.pid), { mode: 0o600 });
        await fs.chmod(pidFile, 0o600);
        break;
      } catch (error) {
        await fs.rm(lockDir, { recursive: true, force: true });
        throw error;
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  async claim(opts: {
    name: string;
    project: string;
    prefer?: number;
    range?: [number, number];
    claimedBy?: string;
    ownerKey?: string;
    portFree?: (p: number) => Promise<boolean>;
    portOwnedByProject?: (p: number) => Promise<boolean>;
  }): Promise<{ port: number; reused: boolean; previousPort?: number }> {
    const free = opts.portFree ?? isPortFree;
    return this.withLock(async () => {
      const entries = await this.load();
      const isKey = (e: RegistryEntry) => e.project === opts.project && e.name === opts.name;
      const existing = entries.find(isKey);

      if (existing && !existing.released) {
        // An owner-bound cooperative claim is a session lease. A caller without the
        // matching fingerprint must not reuse or silently take it over.
        if (existing.ownerKey && existing.ownerKey !== opts.ownerKey) {
          throw new OwnerMismatchError("claim", existing);
        }
        // 活跃记录也必须重新核验：端口可能在 30 分钟回收窗口内被外部进程抢占。
        // 若端口仍空闲，或扫描确认监听者仍属于本项目，才保持幂等复用。
        const stillFree = await free(existing.port);
        const stillOwned = !stillFree && opts.portOwnedByProject
          ? await opts.portOwnedByProject(existing.port)
          : false;
        if (stillFree || stillOwned) {
          // v0.6.x ownerless entries are adopted on the first safe reuse by an
          // identified caller; no migration command or raw session ID is needed.
          if (!existing.ownerKey && opts.ownerKey) {
            const idx = entries.indexOf(existing);
            entries[idx] = {
              ...existing,
              ownerKey: opts.ownerKey,
              claimedBy: opts.claimedBy ?? existing.claimedBy,
            };
            await this.save(entries);
          }
          return { port: existing.port, reused: true };
        }
      }

      const taken = new Set(entries.filter((e) => !e.released).map((e) => e.port));
      const [lo, hi] = opts.range ?? [3000, 9999];
      const candidates: number[] = [];
      if (existing?.lastPort) candidates.push(existing.lastPort);
      if (opts.prefer) candidates.push(opts.prefer);
      for (let p = lo; p <= hi; p++) candidates.push(p);

      let chosen = -1;
      for (const p of candidates) {
        if (p < lo && p !== existing?.lastPort && p !== opts.prefer) continue;
        if (taken.has(p)) continue;
        if (await free(p)) { chosen = p; break; }
      }
      if (chosen < 0) throw new Error(`No free port found in range ${lo}-${hi}`);

      const entry: RegistryEntry = {
        name: opts.name,
        project: opts.project,
        port: chosen,
        claimedAt: new Date().toISOString(),
        claimedBy: opts.claimedBy,
        ownerKey: opts.ownerKey,
      };
      await this.save([...entries.filter((e) => !isKey(e)), entry]);
      return {
        port: chosen,
        reused: false,
        previousPort: existing && !existing.released ? existing.port : undefined,
      };
    });
  }

  async setRunInfo(name: string, project: string, info: { runPid: number; runId?: string; logFile: string }): Promise<void> {
    await this.withLock(async () => {
      const entries = await this.load();
      const idx = entries.findIndex((e) => e.project === project && e.name === name && !e.released);
      if (idx < 0) return;
      entries[idx] = { ...entries[idx], runPid: info.runPid, runId: info.runId, logFile: info.logFile };
      await this.save(entries);
    });
  }

  async release(
    name: string,
    project: string,
    opts: { ownerKey?: string; force?: boolean } = {},
  ): Promise<RegistryEntry | null> {
    return this.withLock(async () => {
      const entries = await this.load();
      const idx = entries.findIndex((e) => e.project === project && e.name === name && !e.released);
      if (idx < 0) return null;
      const e = entries[idx];
      if (!opts.force && e.ownerKey && e.ownerKey !== opts.ownerKey) {
        throw new OwnerMismatchError("release", e);
      }
      entries[idx] = {
        ...e,
        released: true,
        lastPort: e.port,
        ownerKey: undefined,
        runPid: undefined,
        runId: undefined,
      };
      await this.save(entries);
      return e;
    });
  }

  async markReleasedByPort(port: number): Promise<void> {
    await this.withLock(async () => {
      const entries = await this.load();
      let changed = false;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e.released && e.port === port) {
          entries[i] = {
            ...e,
            released: true,
            lastPort: e.port,
            ownerKey: undefined,
            runPid: undefined,
            runId: undefined,
          };
          changed = true;
        }
      }
      if (changed) await this.save(entries);
    });
  }

  /** 回收「已注册未监听且超过 30 分钟」的记录（转 released 保粘性），返回被回收项 */
  async gcStale(listeningPorts: Set<number>, now = Date.now()): Promise<RegistryEntry[]> {
    return this.withLock(async () => {
      const entries = await this.load();
      const removed: RegistryEntry[] = [];
      const next = entries.map((e) => {
        if (isStaleClaim(e, listeningPorts, now)) {
          removed.push(e);
          return {
            ...e,
            released: true,
            lastPort: e.port,
            ownerKey: undefined,
            runPid: undefined,
            runId: undefined,
          };
        }
        return e;
      });
      if (removed.length) await this.save(next);
      return removed;
    });
  }
}

export function defaultClaimedBy(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEX_THREAD_ID?.trim() || env.CODEX_SESSION_ID?.trim()) return "codex";
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CURSOR_AGENT) return "cursor";
  return env.TERM_PROGRAM ?? "cli";
}
