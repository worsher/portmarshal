import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { scanListeners, resolveProjectDir, displaySource } from "../scan.js";

/** 受管服务按 label 探测服务定义文件的常规位置（macOS plist / Linux systemd unit） */
async function findServiceDefinition(source: string): Promise<{ label: string; file: string | null } | null> {
  let candidates: string[];
  let label: string;
  if (source.startsWith("launchd:")) {
    label = source.slice("launchd:".length);
    candidates = [
      path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`),
      `/Library/LaunchAgents/${label}.plist`,
      `/Library/LaunchDaemons/${label}.plist`,
      `/System/Library/LaunchAgents/${label}.plist`,
      `/System/Library/LaunchDaemons/${label}.plist`,
    ];
  } else if (source.startsWith("systemd:")) {
    label = source.slice("systemd:".length);
    candidates = [
      path.join(os.homedir(), ".config/systemd/user", label),
      `/etc/systemd/system/${label}`,
      `/usr/lib/systemd/system/${label}`,
      `/lib/systemd/system/${label}`,
    ];
  } else {
    return null;
  }
  for (const p of candidates) {
    try {
      await fs.access(p);
      return { label, file: p };
    } catch {
      /* 继续尝试下一个位置 */
    }
  }
  return { label, file: null };
}

export default async function whois(flags: Flags): Promise<number> {
  const port = Number(flags.positional[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write("Usage: portmarshal whois <port>\n");
    return EXIT.ERR;
  }
  const infos = await scanListeners(undefined, undefined, !flags.showSensitiveCommand);
  const hit = infos.find((p) => p.ports.includes(port));
  if (!hit) {
    process.stderr.write(`Nothing is listening on port ${port}\n`);
    return EXIT.NOT_FOUND;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(hit, null, 2) + "\n");
    return EXIT.OK;
  }
  const lines = [
    `Port:     ${port}`,
    `PID:      ${hit.pid}`,
    `Source:   ${displaySource(hit)}`,
    `Project:  ${resolveProjectDir(hit) ?? "?"}`,
    `Command:  ${hit.command}`,
  ];
  if (hit.docker) {
    lines.push(`Container: ${hit.docker.containerName} (${hit.docker.containerId.slice(0, 12)})`);
    if (hit.docker.composeProject) lines.push(`Compose:  ${hit.docker.composeProject}`);
    if (hit.docker.composeService) lines.push(`Service:  ${hit.docker.composeService}`);
  }
  if (hit.pm2) {
    lines.push(`PM2 app:  ${hit.pm2.name} (#${hit.pm2.pmId})`);
    if (hit.pm2.status) lines.push(`Status:   ${hit.pm2.status}`);
    if (hit.pm2.script) lines.push(`Script:   ${hit.pm2.script}`);
  }
  const svc = await findServiceDefinition(hit.source);
  if (svc) {
    lines.push(`Service:  ${svc.label}`);
    lines.push(`Unit file:${svc.file ? ` ${svc.file}` : " not found in standard locations"}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return EXIT.OK;
}
