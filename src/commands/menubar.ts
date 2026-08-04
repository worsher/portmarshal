import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Flags } from "../cli.js";
import { EXIT, type MergedEntry } from "../types.js";
import { scanListeners, isNoise, resolveProjectDir, displaySource } from "../scan.js";
import { mergeScanRegistry } from "../merge.js";
import { Registry } from "../registry.js";

/** SwiftBar 元数据 value 不支持转义双引号，含双引号的路径去引号后再用（极罕见，仅防解析逃逸） */
function safeParam(s: string): string {
  return s.replace(/"/g, "");
}

export function renderMenubar(entries: MergedEntry[], binPath: string): string {
  const bad = entries.filter((e) => e.state === "drift" || e.proc?.source === "detached").length;
  const lines: string[] = [];
  lines.push(bad > 0 ? `⚓${entries.length} ⚠${bad} | color=orange` : `⚓${entries.length}`);
  lines.push("---");
  if (entries.length === 0) {
    lines.push("No listening development services | color=gray");
  }
  for (const e of entries) {
    const proj = e.proc ? resolveProjectDir(e.proc) : e.reg?.project;
    const projName = proj ? path.basename(proj) : "?";
    const src = e.proc ? displaySource(e.proc) : "reserved";
    const isDetached = e.proc?.source === "detached";
    const mark = e.state === "drift" ? "⚠ " : isDetached ? "⚠ " : "";
    const suffix = isDetached || e.state === "drift" ? " | color=orange" : "";
    const label = src; // displaySource 已渲染 detached 及其 env 溯源标签

    lines.push(`${mark}${e.port} ${projName} · ${label}${suffix}`);
    const stopLabel = e.proc && !isDetached && e.state !== "drift" ? `Stop service… (${src} is active)` : "Stop service";
    if (e.proc) {
      lines.push(`-- ${stopLabel} | bash="${safeParam(binPath)}" param1=stop param2=${e.port} param3=--gui terminal=false refresh=true`);
      lines.push(`-- Copy http://localhost:${e.port} | bash=/bin/bash param1=-c param2="echo -n 'http://localhost:${e.port}' | pbcopy" terminal=false`);
    }
    if (proj) {
      lines.push(`-- Open project in Finder | bash=/usr/bin/open param1="${safeParam(proj)}" terminal=false`);
    }
  }
  lines.push("---");
  lines.push(`Clean detached services (gc) | bash="${safeParam(binPath)}" param1=gc param2=--kill-detached terminal=false refresh=true`);
  lines.push("Refresh | refresh=true");
  return lines.join("\n") + "\n";
}

async function swiftBarPluginDir(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("defaults", ["read", "com.ameba.SwiftBar", "PluginDirectory"], (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

async function install(binPath: string): Promise<number> {
  if (process.platform !== "darwin") {
    process.stderr.write(
      "menubar --install requires macOS and SwiftBar. On Linux, wire `portmarshal menubar` into an xbar-compatible host such as GNOME Argos:\n" +
      "  ln -s \"" + binPath + "\" ~/.config/argos/portmarshal.5s+.sh\n",
    );
    return EXIT.ERR;
  }
  const dir = await swiftBarPluginDir();
  if (!dir) {
    process.stderr.write(
      "SwiftBar is not configured. Run `brew install swiftbar`, launch it once, then retry;\n" +
      "or save this script as portmarshal.5s.sh in the SwiftBar plugin directory:\n\n#!/bin/bash\nexec \"" + binPath + "\" menubar\n",
    );
    return EXIT.ERR;
  }
  const plugin = path.join(dir, "portmarshal.5s.sh");
  await fs.writeFile(plugin, `#!/bin/bash\nexec "${binPath}" menubar\n`, { mode: 0o755 });
  process.stderr.write(`Installed SwiftBar plugin: ${plugin}\n`);
  return EXIT.OK;
}

export default async function menubar(flags: Flags): Promise<number> {
  const binPath = process.argv[1] ? await fs.realpath(process.argv[1]) : fileURLToPath(import.meta.url);
  if (flags.install) return install(binPath);
  const [scan, registry] = await Promise.all([
    scanListeners(undefined, undefined, !flags.showSensitiveCommand),
    new Registry().load(),
  ]);
  const filtered = scan.filter((p) => !isNoise(p.procName));
  const merged = mergeScanRegistry(filtered, registry);
  process.stdout.write(renderMenubar(merged, binPath));
  return EXIT.OK;
}
