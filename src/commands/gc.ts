import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { scanListeners, isNoise, terminate, resolveProjectDir } from "../scan.js";
import { Registry } from "../registry.js";
import { C } from "../render.js";
import type { ProcessInfo, RegistryEntry } from "../types.js";

/**
 * gc 候选过滤：run -d 托管的服务带 PORTMARSHAL_SERVICE 标记，本应豁免清理——但豁免必须有
 * 活跃（非 released）registry 记录背书（runPid 命中该进程，或该进程占的端口正是记录声明的端口）。
 * 没有背书的场景：stop 只 kill 了监听 pid，组长（runPid）被落下，claim 已转 released、runPid 已清空，
 * 组长却还带着 PORTMARSHAL_SERVICE 环境残留——这是伪装成受管服务的无主进程，必须照常进候选，
 * 不能凭 env 标记就无条件放行。抽成纯函数便于单测覆盖，不依赖真实 scan/registry I/O。
 */
export function gcCandidates(scan: ProcessInfo[], activeEntries: RegistryEntry[]): ProcessInfo[] {
  const activeRunEntries = activeEntries.filter((e) => !e.released && e.runPid !== undefined);
  return scan.filter((p) => {
    if (p.source !== "detached" || isNoise(p.procName)) return false;
    if (!p.origin?.startsWith("run:")) return true;
    const endorsed = activeRunEntries.some((e) => e.runPid === p.pid || p.ports.includes(e.port));
    return !endorsed;
  });
}

export default async function gc(flags: Flags): Promise<number> {
  const registry = new Registry();
  const scan = await scanListeners();
  const listening = new Set(scan.flatMap((p) => p.ports));

  const removed = await registry.gcStale(listening);
  for (const e of removed) {
    process.stderr.write(`Reaped stale claim ${e.name}@${e.project} → ${e.port}\n`);
  }

  // gcStale 之后重新读一次 registry：豁免背书只能认「活跃」记录，
  // 否则刚被回收的记录仍会被当成背书，等于没做校验。
  const entries = await registry.load();
  const detached = gcCandidates(scan, entries);
  if (detached.length === 0) {
    process.stderr.write("No detached services found\n");
    return EXIT.OK;
  }
  for (const p of detached) {
    const desc = `${p.ports.join(",")} · pid ${p.pid}${p.origin ? ` · from ${p.origin}` : ""} · ${resolveProjectDir(p) ?? "?"} · ${p.command.slice(0, 60)}`;
    if (flags.killDetached) {
      try {
        const how = await terminate(p.pid);
        for (const port of p.ports) await registry.markReleasedByPort(port);
        process.stderr.write(`${C.yellow}Stopped detached service${C.reset} ${desc} (${how})\n`);
      } catch (e) {
        // 单个候选服务停止失败（如无权限）不中断整批处理
        process.stderr.write(`${C.red}Failed to stop${C.reset} ${desc}: ${(e as Error).message}\n`);
      }
    } else {
      process.stderr.write(`${C.yellow}Detached service${C.reset} ${desc}\n`);
    }
  }
  if (!flags.killDetached) {
    process.stderr.write(`\nFound ${detached.length} detached service candidate(s). Review them, then run portmarshal gc --kill-detached to stop them.\n`);
  }
  return EXIT.OK;
}
