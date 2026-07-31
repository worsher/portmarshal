import { realpathSync } from "node:fs";
import type { MergedEntry, ProcessInfo, RegistryEntry } from "./types.js";
import { resolveProjectDir } from "./scan.js";
import { pidAlive } from "./ready.js";

/**
 * macOS 上注册表可能保存符号链接路径（如 /var/folders/...），而 lsof 上报的进程 cwd 是
 * 内核解析后的真实路径（如 /private/var/folders/...）。在 drift 配对边界统一 realpath；
 * 目录已经不存在时回退原始字符串。
 */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * run -d 托管的 claim：进程已死但记录还在（无监听）→ 提示 dead。
 * 放在 merge.ts（而不是 list.ts）是因为 render.ts 的 watch 帧也要用它，
 * 而 list.ts 反过来又要从 render.ts 取 formatTable/C —— 放 list.ts 会形成循环 import。
 */
export function isDeadRun(e: MergedEntry, alive: (pid: number) => boolean = pidAlive): boolean {
  return e.state === "reserved" && e.reg?.runPid !== undefined && !alive(e.reg.runPid);
}

export function mergeScanRegistry(
  scan: ProcessInfo[],
  registry: RegistryEntry[],
): MergedEntry[] {
  const active = registry.filter((r) => !r.released);
  const regByPort = new Map(active.map((r) => [r.port, r]));
  const listening = new Set(scan.flatMap((p) => p.ports));
  const out: MergedEntry[] = [];

  for (const proc of scan) {
    for (const port of proc.ports) {
      const reg = regByPort.get(port);
      out.push({ port, state: reg ? "active" : "unregistered", proc, reg });
    }
  }
  for (const reg of active) {
    if (!listening.has(reg.port)) out.push({ port: reg.port, state: "reserved", reg });
  }

  for (const r of out) {
    if (r.state !== "reserved") continue;
    const regProject = realpathOrSelf(r.reg!.project);
    const peer = out.find((e) => {
      if (e.state !== "unregistered" || !e.proc) return false;
      const project = resolveProjectDir(e.proc);
      return project !== null && realpathOrSelf(project) === regProject;
    });
    if (peer) {
      r.state = "drift";
      r.driftPeer = peer.port;
      peer.state = "drift";
      peer.driftPeer = r.port;
    }
  }
  return out.sort((a, b) => a.port - b.port);
}
