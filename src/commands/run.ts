import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { Registry, LockTimeoutError, defaultClaimedBy } from "../registry.js";
import { projectOwnsPort, scanListeners, resolveProjectDir, displaySource } from "../scan.js";
import { logFilePath, rotateLog, tailLines } from "../runlog.js";
import { waitReady, terminateGroup } from "../ready.js";
import stop from "./stop.js";

const USAGE = "Usage: portmarshal run <name> [-d] [--wait-timeout N] [--ready-url PATH] [--prefer N] [--range A-B] [--project DIR] [--restart] -- <command...>\n";
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export function substitutePort(args: string[], port: number): string[] {
  return args.map((a) => a.split("{port}").join(String(port)));
}

async function releaseClaim(registry: Registry, name: string, project: string): Promise<boolean> {
  try {
    await registry.release(name, project);
    return true;
  } catch (error) {
    process.stderr.write(`portmarshal: failed to release claim: ${(error as Error).message}\n`);
    return false;
  }
}

async function cleanupDetached(
  registry: Registry,
  name: string,
  project: string,
  pgid: number,
): Promise<boolean> {
  try {
    await terminateGroup(pgid);
  } catch (error) {
    // 未能确认进程组已停止时保留活跃 claim，避免把仍在运行的服务伪装成已释放。
    process.stderr.write(`portmarshal: failed to stop process group ${pgid}: ${(error as Error).message}\n`);
    return false;
  }
  return releaseClaim(registry, name, project);
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

async function runDetached(
  name: string, project: string, port: number, argv: string[],
  registry: Registry, flags: Flags,
): Promise<number> {
  const logFile = logFilePath(project, name);
  let fd: Awaited<ReturnType<typeof fs.open>>;
  try {
    await rotateLog(logFile);
    fd = await fs.open(logFile, "a");
  } catch (error) {
    process.stderr.write(`portmarshal: failed to prepare log file ${logFile}: ${(error as Error).message}\n`);
    await releaseClaim(registry, name, project);
    return EXIT.ERR;
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", fd.fd, fd.fd],
      detached: true, // 自成进程组：失败清理时信号覆盖整组
      // cwd 必须钉在 project：detached 子进程没有终端 cwd 可继承参照，
      // 且 scan 的项目归属（restart 护栏、claim 复用校验）都按 cwd 匹配 project，不钉住会让旧实例识别不到自己。
      cwd: project,
      env: { ...process.env, PORT: String(port), PORTMARSHAL_SERVICE: name },
    });
  } catch (error) {
    await fd.close().catch(() => {});
    process.stderr.write(`portmarshal: failed to start ${argv[0]}: ${(error as Error).message}\n`);
    await releaseClaim(registry, name, project);
    return EXIT.ERR;
  }

  // spawn() 返回后、第一次 await 之前同步安装信号处理器。Node 只会在事件循环重新取得控制权时
  // 派发信号，因此这样可覆盖等待 spawn 事件和关闭父侧日志 fd 的窗口，避免父进程先退出而遗留 detached 子进程。
  const controller = new AbortController();
  let interruptedBy: (typeof FORWARDED)[number] | undefined;
  const handlers = new Map<(typeof FORWARDED)[number], () => void>();
  const removeSignalHandlers = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
  for (const signal of FORWARDED) {
    const handler = () => {
      interruptedBy ??= signal;
      controller.abort();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  const spawnErr = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (e) => resolve(e));
  });
  let fdCloseErr: unknown;
  try {
    await fd.close(); // 子进程持有 fd 副本，父进程侧即可关闭
  } catch (error) {
    fdCloseErr = error;
  }
  if (spawnErr || child.pid === undefined || fdCloseErr) {
    removeSignalHandlers();
    const detail = spawnErr?.message
      ?? (fdCloseErr ? `failed to close parent log descriptor: ${(fdCloseErr as Error).message}` : "no pid");
    process.stderr.write(`portmarshal: failed to start ${argv[0]}: ${detail}\n`);
    if (child.pid !== undefined) {
      await cleanupDetached(registry, name, project, child.pid);
    } else {
      await releaseClaim(registry, name, project);
    }
    return EXIT.ERR;
  }
  child.unref();

  let ready: Awaited<ReturnType<typeof waitReady>>;
  try {
    await registry.setRunInfo(name, project, { runPid: child.pid, logFile });
    ready = await waitReady({
      port, pid: child.pid, readyUrl: flags.readyUrl,
      timeoutMs: (flags.waitTimeout ?? 30) * 1000,
      signal: controller.signal,
    });
  } catch (error) {
    process.stderr.write(`portmarshal: failed while tracking ${name}@${project}: ${(error as Error).message}\n`);
    await cleanupDetached(registry, name, project, child.pid);
    return EXIT.ERR;
  } finally {
    removeSignalHandlers();
  }

  // waitReady 可能已准备返回成功，而信号恰好在 Promise 恢复到 finally 前到达；信号优先，仍执行整组清理。
  if (ready.ok && interruptedBy) {
    process.stderr.write(`portmarshal: interrupted by ${interruptedBy}; stopping ${name}@${project}\n`);
    await cleanupDetached(registry, name, project, child.pid);
    return 128 + (os.constants.signals[interruptedBy] ?? 1);
  }

  if (!ready.ok) {
    if (ready.reason === "aborted") {
      const signal = interruptedBy ?? "SIGTERM";
      process.stderr.write(`portmarshal: interrupted by ${signal}; stopping ${name}@${project}\n`);
      await cleanupDetached(registry, name, project, child.pid);
      return 128 + (os.constants.signals[signal] ?? 1);
    }
    const why = ready.reason === "died" ? "process exited before becoming ready" : "readiness wait timed out";
    const tail = await tailLines(logFile, 20).catch(() => []);
    process.stderr.write(
      `portmarshal: ${name}@${project} failed to become ready on port ${port}: ${why}\n` +
      (tail.length ? `--- last ${tail.length} log lines (${logFile}) ---\n${tail.join("\n")}\n` : ""),
    );
    await cleanupDetached(registry, name, project, child.pid);
    return EXIT.ERR;
  }
  process.stderr.write(
    `portmarshal: ready ${name}@${project} on port ${port} (pid ${child.pid}, logs: ${logFile})\n`,
  );
  return EXIT.OK;
}
