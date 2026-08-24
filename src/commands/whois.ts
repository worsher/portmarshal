import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Flags } from "../cli.js";
import { EXIT } from "../types.js";
import { scanListeners, resolveProjectDir, displaySource } from "../scan.js";
import { Registry } from "../registry.js";
import { buildServiceSnapshot, findServicesByPort } from "../services.js";

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
  const [infos, registry] = await Promise.all([
    scanListeners(undefined, undefined, !flags.showSensitiveCommand),
    new Registry().load(),
  ]);
  const hit = infos.find((p) => p.ports.includes(port));
  if (!hit) {
    process.stderr.write(`Nothing is listening on port ${port}\n`);
    return EXIT.NOT_FOUND;
  }
  const services = findServicesByPort(buildServiceSnapshot(infos, registry), port);
  const service = services[0] ?? null;
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...hit, service, services }, null, 2) + "\n");
    return EXIT.OK;
  }
  const lines = [
    `Port:     ${port}`,
    `PID:      ${hit.pid}`,
    `Source:   ${displaySource(hit)}`,
    `Project:  ${resolveProjectDir(hit) ?? "?"}`,
    `Command:  ${hit.command}`,
  ];
  if (service) {
    lines.push(`Service:  ${service.name} (${service.id})`);
    lines.push(`Activity: ${service.activity} · ${service.attachment} · ${service.confidence}`);
    lines.push(`Ports:    ${service.ports.join(", ")}`);
    lines.push(`Listeners:${service.listenerPids.length ? ` ${service.listenerPids.join(", ")}` : " none"}`);
    if (service.wrapperPids.length) lines.push(`Wrappers: ${service.wrapperPids.join(", ")}`);
    if (service.pgid !== undefined) lines.push(`PGID:     ${service.pgid}`);
    if (service.claims.length) {
      lines.push(`Claims:   ${service.claims.map((claim) => `${claim.entry.name}@${claim.entry.port} (${claim.relation})`).join(", ")}`);
    }
    lines.push(`Stop plan: ${service.stopMode}`);
    if (services.length > 1) {
      lines.push(`Conflict: ${services.length} distinct services share port ${port}`);
      lines.push(`Owners:   ${services.map((owner) => `${owner.project ?? "?"} [${owner.listenerPids.join(",")}]`).join("; ")}`);
    }
  }
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
