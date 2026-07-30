import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { scanListeners, isNoise, terminate, resolveProjectDir } from "../scan.js";
import { Registry } from "../registry.js";
import { C } from "../render.js";

export default async function gc(flags: Flags): Promise<number> {
  const registry = new Registry();
  const scan = await scanListeners();
  const listening = new Set(scan.flatMap((p) => p.ports));

  const removed = await registry.gcStale(listening);
  for (const e of removed) {
    process.stderr.write(`Reaped stale claim ${e.name}@${e.project} → ${e.port}\n`);
  }

  // run -d 托管的服务带 PORTMARSHAL_SERVICE 标记，是被管理的，不是清理对象
  const detached = scan.filter(
    (p) => p.source === "detached" && !isNoise(p.procName) && !p.origin?.startsWith("run:"),
  );
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
