import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Flags } from "../cli.js";
import { EXIT, type ServiceInfo } from "../types.js";
import { scanListeners, isNoise } from "../scan.js";
import { Registry } from "../registry.js";
import { buildServiceSnapshot } from "../services.js";

/** SwiftBar 元数据 value 不支持转义双引号，含双引号的路径去引号后再用（极罕见，仅防解析逃逸） */
function safeParam(s: string): string {
  return s.replace(/"/g, "");
}

export function renderMenubar(services: ServiceInfo[], binPath: string, version = "unknown"): string {
  const bad = services.filter((service) => service.warnings.length > 0).length;
  const lines: string[] = [];
  lines.push(bad > 0 ? `⚓${services.length} ⚠${bad} | color=orange` : `⚓${services.length}`);
  lines.push("---");
  if (services.length === 0) {
    lines.push("No listening development services | color=gray");
  }
  for (const service of services) {
    const projName = service.project ? path.basename(service.project) : service.name;
    const ports = service.ports.map((port) => `:${port}`).join(",");
    const source = service.origin ?? service.source;
    const attachment = service.attachment === "detached" ? ` · ${source} · detached` : ` · ${source}`;
    const warning = service.warnings.length > 0;
    lines.push(`${warning ? "⚠ " : ""}${projName} · ${service.activity} · ${ports}${attachment}${warning ? " | color=orange" : ""}`);

    if (service.listenerPids.length) {
      lines.push(`-- Listener PID${service.listenerPids.length > 1 ? "s" : ""}: ${service.listenerPids.join(", ")} | color=gray`);
    }
    if (service.wrapperPids.length) {
      const pgid = service.pgid === undefined ? "" : ` · PGID ${service.pgid}`;
      lines.push(`-- Wrapper PID${service.wrapperPids.length > 1 ? "s" : ""}: ${service.wrapperPids.join(", ")}${pgid} | color=gray`);
    } else if (service.pgid !== undefined && service.listenerPids.length) {
      lines.push(`-- PGID: ${service.pgid} | color=gray`);
    }
    for (const claim of service.claims) {
      const prefix = claim.relation === "related" ? "Related claim" : "Claim";
      lines.push(`-- ${prefix}: ${claim.entry.name} · :${claim.entry.port} · ${claim.relation}${claim.relation === "related" ? " · review" : ""} | color=gray`);
    }

    const primaryPort = service.ports[0];
    if (service.activity === "active" && primaryPort !== undefined) {
      const stopLabel = service.stopMode === "blocked"
        ? "Review before stopping…"
        : service.stopMode === "listener-only"
          ? "Stop listener…"
          : "Stop managed service…";
      lines.push(`-- ${stopLabel} | bash="${safeParam(binPath)}" param1=stop param2=${primaryPort} param3=--gui terminal=false refresh=true`);
      for (const port of service.ports) {
        lines.push(`-- Copy http://localhost:${port} | bash=/bin/bash param1=-c param2="echo -n 'http://localhost:${port}' | pbcopy" terminal=false`);
      }
    }
    if (service.project) {
      lines.push(`-- Open project in Finder | bash=/usr/bin/open param1="${safeParam(service.project)}" terminal=false`);
    }
  }
  lines.push("---");
  lines.push(`Review stale claims and detached services… | bash="${safeParam(binPath)}" param1=gc param2=--dry-run terminal=true refresh=true`);
  lines.push(`PortMarshal ${version} | color=gray`);
  lines.push(`Executable: ${safeParam(binPath)} | color=gray`);
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
  const snapshot = buildServiceSnapshot(filtered, registry);
  const pkg = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  process.stdout.write(renderMenubar(snapshot.services, binPath, pkg.version));
  return EXIT.OK;
}
