import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { scanListeners, isNoise } from "../scan.js";
import { mergeScanRegistry } from "../merge.js";
import { Registry } from "../registry.js";
import { formatServiceWatchFrame, formatWatchFrame } from "../render.js";
import { buildServiceSnapshot } from "../services.js";

export default async function watch(_flags: Flags): Promise<number> {
  let prevPorts = new Set<number>();
  let prevServiceIds = new Set<string>();
  let running = true;

  if (!process.stdin.isTTY) {
    // 非交互环境没有退出路径（q 键不可用），渲染单帧快照后退出，避免死循环挂住调用方
    const [scan, registry] = await Promise.all([
      scanListeners(undefined, undefined, !_flags.showSensitiveCommand),
      new Registry().load(),
    ]);
    const filtered = scan.filter((p) => !isNoise(p.procName));
    if (_flags.services) {
      const snapshot = buildServiceSnapshot(filtered, registry);
      process.stdout.write(formatServiceWatchFrame(snapshot.services, prevServiceIds));
    } else {
      const merged = mergeScanRegistry(filtered, registry);
      process.stdout.write(formatWatchFrame(merged, prevPorts));
    }
    process.stderr.write("watch needs an interactive terminal; rendered one snapshot and exited\n");
    return EXIT.OK;
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf) => {
      const key = buf.toString();
      if (key === "q" || key === "\x03") running = false; // q 或 Ctrl-C
    });
  }

  try {
    while (running) {
      const [scan, registry] = await Promise.all([
        scanListeners(undefined, undefined, !_flags.showSensitiveCommand),
        new Registry().load(),
      ]);
      const filtered = scan.filter((p) => !isNoise(p.procName));
      if (_flags.services) {
        const snapshot = buildServiceSnapshot(filtered, registry);
        process.stdout.write("\x1b[2J\x1b[H" + formatServiceWatchFrame(snapshot.services, prevServiceIds));
        prevServiceIds = new Set(snapshot.services.map((service) => service.id));
      } else {
        const merged = mergeScanRegistry(filtered, registry);
        process.stdout.write("\x1b[2J\x1b[H" + formatWatchFrame(merged, prevPorts));
        prevPorts = new Set(merged.map((e) => e.port));
      }
      for (let i = 0; i < 20 && running; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } finally {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return EXIT.OK;
}
