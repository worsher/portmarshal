import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { Registry, LockTimeoutError, defaultClaimedBy } from "../registry.js";
import { projectOwnsPort, scanListeners, resolveProjectDir, displaySource } from "../scan.js";
import { logFilePath, rotateLog, tailLines } from "../runlog.js";
import { waitReady, pidAlive } from "../ready.js";
import stop from "./stop.js";

const USAGE = "Usage: portmarshal run <name> [-d] [--wait-timeout N] [--ready-url PATH] [--prefer N] [--range A-B] [--project DIR] [--restart] -- <command...>\n";
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

    // claim 重验证保证：端口仍在监听 ⇒ 监听者归属本项目（外人占用时 claim 已换新端口）
    const running = (await scanListeners()).find((p) => p.ports.includes(port));
    if (running) {
      if (!flags.restart) {
        process.stderr.write(
          `Port ${port} is already served by ${displaySource(running)} · ${resolveProjectDir(running) ?? "?"} · pid ${running.pid}\n` +
          `  Command: ${running.command}\n` +
          `  Keep using the running instance, or re-run with --restart to replace it\n`,
        );
        return EXIT.BLOCKED;
      }
      const stopped = await stop({ ...flags, project, positional: [String(port)], rest: [], force: false, gui: false, json: false });
      if (stopped !== EXIT.OK) return stopped;
      // stop 已把记录转 released；重新 claim 依靠 lastPort 粘回同端口并恢复 active 记录
      port = await claimPort(registry, name, project, flags);
    }
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      process.stderr.write(`portmarshal: ${e.message}\n`);
      return EXIT.LOCK_TIMEOUT;
    }
    throw e;
  }

  const argv = substitutePort(flags.rest, port);
  if (flags.detach) return runDetached(name, project, port, argv, registry, flags);
  process.stderr.write(`portmarshal: serving ${name}@${project} on port ${port}\n`);
  const child = spawn(argv[0], argv.slice(1), {
    // stdin 用 ignore 而非 inherit：detached 组内子进程若读控制终端会收到 SIGTTIN 而挂起
    // （子进程不在终端的前台进程组里）；run 只承诺转发输出，不转发输入。
    stdio: ["ignore", "inherit", "inherit"],
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
      void registry.release(name, project)
        .catch((e) => { process.stderr.write(`portmarshal: failed to release claim: ${(e as Error).message}\n`); })
        .then(() => resolve(code));
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

/** SIGTERM → 宽限 2s → SIGKILL，作用于整个进程组；组已消失时静默 */
async function terminateGroup(pgid: number): Promise<void> {
  try { process.kill(-pgid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 20; i++) {
    if (!pidAlive(pgid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(-pgid, "SIGKILL"); } catch { /* 组已不存在 */ }
}

async function runDetached(
  name: string, project: string, port: number, argv: string[],
  registry: Registry, flags: Flags,
): Promise<number> {
  const logFile = logFilePath(project, name);
  await rotateLog(logFile);
  const fd = await fs.open(logFile, "a");

  const child = spawn(argv[0], argv.slice(1), {
    stdio: ["ignore", fd.fd, fd.fd],
    detached: true, // 自成进程组：失败清理时信号覆盖整组
    env: { ...process.env, PORT: String(port), PORTMARSHAL_SERVICE: name },
  });
  const spawnErr = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (e) => resolve(e));
  });
  await fd.close(); // 子进程持有 fd 副本，父进程侧即可关闭
  if (spawnErr || child.pid === undefined) {
    process.stderr.write(`portmarshal: failed to start ${argv[0]}: ${spawnErr?.message ?? "no pid"}\n`);
    await registry.release(name, project).catch(() => {});
    return EXIT.ERR;
  }
  child.unref();
  await registry.setRunInfo(name, project, { runPid: child.pid, logFile });

  const ready = await waitReady({
    port, pid: child.pid, readyUrl: flags.readyUrl,
    timeoutMs: (flags.waitTimeout ?? 30) * 1000,
  });
  if (!ready.ok) {
    const why = ready.reason === "died" ? "process exited before becoming ready" : "readiness wait timed out";
    const tail = await tailLines(logFile, 20).catch(() => []);
    process.stderr.write(
      `portmarshal: ${name}@${project} failed to become ready on port ${port}: ${why}\n` +
      (tail.length ? `--- last ${tail.length} log lines (${logFile}) ---\n${tail.join("\n")}\n` : ""),
    );
    await terminateGroup(child.pid);
    await registry.release(name, project).catch(() => {});
    return EXIT.ERR;
  }
  process.stderr.write(
    `portmarshal: ready ${name}@${project} on port ${port} (pid ${child.pid}, logs: ${logFile})\n`,
  );
  return EXIT.OK;
}
