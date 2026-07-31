import path from "node:path";
import { execFile } from "node:child_process";
import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { scanListeners, classifyTarget, terminate, resolveProjectDir, displaySource } from "../scan.js";
import { Registry } from "../registry.js";
import { processGroupAlive, terminateGroup } from "../ready.js";

function osascript(script: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], (err) => resolve({ ok: !err }));
  });
}

/** 转义字符串用于嵌入 AppleScript 双引号字面量 */
function asStr(s: string | number): string {
  return JSON.stringify(String(s)); // 产出带引号的字面量，AppleScript 转义规则与 JSON 兼容
}

function notify(msg: string): void {
  void osascript(`display notification ${JSON.stringify(msg)} with title "portmarshal"`);
}

function stopDockerContainer(containerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("docker", ["stop", containerId], { timeout: 20_000 }, (err) => err ? reject(err) : resolve());
  });
}

function stopPm2Process(pmId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("pm2", ["stop", String(pmId)], { timeout: 20_000 }, (err) => err ? reject(err) : resolve());
  });
}

export default async function stop(flags: Flags): Promise<number> {
  const target = flags.positional[0];
  if (!target) {
    process.stderr.write("Usage: portmarshal stop <port|name> [--force|--gui]\n");
    return EXIT.ERR;
  }
  if (flags.gui && process.platform !== "darwin") {
    process.stderr.write("--gui requires macOS osascript; review the target and use --force on this platform\n");
    return EXIT.ERR;
  }
  const registry = new Registry();
  const entries = await registry.load();
  const callerCwd = path.resolve(flags.project ?? process.cwd());

  let port = Number(target);
  if (!Number.isFinite(port)) {
    const reg = entries.find((e) => !e.released && e.name === target && e.project === callerCwd);
    if (!reg) {
      process.stderr.write(`No active claim found for ${target}@${callerCwd}\n`);
      return EXIT.NOT_FOUND;
    }
    port = reg.port;
  } else if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`Invalid TCP port: ${target}\n`);
    return EXIT.ERR;
  }

  const scan = await scanListeners();
  const proc = scan.find((p) => p.ports.includes(port));
  if (!proc) {
    process.stderr.write(`Nothing is listening on port ${port}\n`);
    if (flags.gui) notify(`Nothing is listening on port ${port}`);
    return EXIT.NOT_FOUND;
  }

  // Docker Desktop 的一个后端 PID 会承载多个项目的全部映射端口；没有容器元数据时绝不能 kill 它。
  if (proc.source === "docker" && !proc.docker) {
    process.stderr.write(
      `Blocked: Docker container metadata is unavailable for port ${port}; refusing to signal the shared Docker host process\n`,
    );
    return EXIT.BLOCKED;
  }
  // 直接 kill PM2 子进程只会触发自动拉起；必须能定位 pm_id 后再交给 PM2 停止。
  if (proc.source === "pm2" && !proc.pm2) {
    process.stderr.write(
      `Blocked: PM2 application metadata is unavailable for port ${port}; refusing to signal a managed child process\n`,
    );
    return EXIT.BLOCKED;
  }

  const kind = classifyTarget(proc, callerCwd, entries);
  const identity = proc.pm2
    ? `PM2 app ${proc.pm2.name} (#${proc.pm2.pmId})`
    : proc.docker
      ? `container ${proc.docker.containerName}`
      : `pid ${proc.pid}`;
  const desc = `${port} (${displaySource(proc)} · ${resolveProjectDir(proc) ?? "?"} · ${identity})`;

  if (kind === "foreign" && !flags.force) {
    if (flags.gui) {
      const proj = resolveProjectDir(proc) ?? "?";
      const dialogText = `"Port " & ${asStr(port)} & " is an active " & ${asStr(displaySource(proc))} & " service in " & ${asStr(proj)} & ". Stop it?"`;
      const { ok } = await osascript(
        `display dialog ${dialogText} with title "portmarshal" buttons {"Cancel","Stop"} default button "Cancel" cancel button "Cancel" with icon caution`,
      );
      if (!ok) return EXIT.OK; // 用户取消
    } else {
      const info = { port, pid: proc.pid, source: displaySource(proc), project: resolveProjectDir(proc), command: proc.command, docker: proc.docker, pm2: proc.pm2 };
      if (flags.json) {
        process.stdout.write(JSON.stringify({ blocked: true, ...info }) + "\n");
      } else {
        process.stderr.write(`Blocked: ${desc} belongs to another active service\n  Command: ${proc.command}\n  Review the attribution, then add --force to stop it\n`);
      }
      return EXIT.BLOCKED;
    }
  }

  // run -d 托管目标：registry 记的 runPid 是进程组组长，真正监听端口的可能是它 spawn 出来的孙进程
  // （比如 wrapper 脚本自己再 spawn 一个 nodemon）。只 kill 监听 pid 会把组长晾在原地——
  // 此时 claim 即将转 released、runPid 会被清空，组长却还带着 PORTMARSHAL_SERVICE 环境变量残留，
  // 会被 gc 的 run:* 豁免误认成受管服务，永远进不了清理候选。这里先对整组发信号兜底。
  const runEntry = entries.find((e) => !e.released && e.port === port && e.runPid !== undefined);

  let how: "term" | "kill" | "gone" | "docker-stop" | "pm2-stop";
  try {
    // 组长可以在真正的监听进程启动后自行退出（daemon/wrapper 常见行为），
    // 但原 PGID 只要还有成员就仍然有效，因此不能用正 PID 存活与否决定是否跳过整组清理。
    if (runEntry?.runPid !== undefined && processGroupAlive(runEntry.runPid)) {
      await terminateGroup(runEntry.runPid);
    }
    if (proc.pm2) {
      await stopPm2Process(proc.pm2.pmId);
      how = "pm2-stop";
    } else if (proc.docker) {
      await stopDockerContainer(proc.docker.containerId);
      how = "docker-stop";
    } else {
      how = await terminate(proc.pid);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to stop ${desc}: ${detail}\n`);
    return EXIT.ERR;
  }
  // 进程可能监听多个端口，全部预留记录一并清理
  for (const p of proc.ports) await registry.markReleasedByPort(p);
  const msg = how === "gone" ? "Process was already gone; cleared its claim" : `Stopped ${desc}${how === "kill" ? " (SIGKILL)" : ""}`;
  if (flags.json) {
    process.stdout.write(JSON.stringify({ stopped: true, port, pid: proc.pid, how }) + "\n");
  } else {
    process.stderr.write(msg + "\n");
  }
  if (flags.gui) notify(msg);
  return EXIT.OK;
}
