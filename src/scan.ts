import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { DockerInfo, ListenEntry, Pm2Info, ProcessInfo, PsRow, RegistryEntry } from "./types.js";
import { realExec, type Exec } from "./exec.js";

export function parseLsofListeners(text: string): ListenEntry[] {
  const out: ListenEntry[] = [];
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n")) {
      const addr = line.slice(1);
      const i = addr.lastIndexOf(":");
      if (i < 0) continue;
      const port = Number(addr.slice(i + 1));
      if (!Number.isFinite(port) || port <= 0) continue;
      out.push({ pid, port, address: addr.slice(0, i) });
    }
  }
  return out;
}

export function parsePsTable(text: string): Map<number, PsRow> {
  const map = new Map<number, PsRow>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    map.set(pid, { pid, ppid: Number(m[2]), comm: m[3].trim() });
  }
  return map;
}

const SOURCE_PATTERNS: Array<[RegExp, string]> = [
  [/claude/i, "claude-code"],
  [/cursor/i, "cursor"],
  [/antigrav/i, "antigravity"],
  [/code helper|vscode|electron/i, "vscode/electron"],
  [/iterm|^terminal$|warp|kitty|alacritty|wezterm|tmux/i, "terminal"],
  [/^PM2(?:\s|$)/i, "pm2"],
  [/docker/i, "docker"],
];

/** launchctl list 输出（PID\tStatus\tLabel）→ 受 launchd 管理的运行中服务 pid→label 映射 */
export function parseLaunchctlList(text: string): Map<number, string> {
  const services = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)[\t ]+\S+[\t ]+(\S+)/.exec(line);
    if (m) services.set(Number(m[1]), m[2]);
  }
  return services;
}

/** Linux: ss -tlnp 输出 → 监听条目（无 Process 列的行无法归属，跳过；多 pid 共享 socket 取第一个） */
export function parseSsListeners(text: string): ListenEntry[] {
  const out: ListenEntry[] = [];
  for (const line of text.split("\n")) {
    if (!/^LISTEN\b/.test(line)) continue;
    const pidMatch = /pid=(\d+)/.exec(line);
    if (!pidMatch) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[3] ?? "";
    const i = local.lastIndexOf(":");
    if (i < 0) continue;
    const port = Number(local.slice(i + 1));
    if (!Number.isFinite(port) || port <= 0) continue;
    out.push({ pid: Number(pidMatch[1]), port, address: local.slice(0, i) });
  }
  return out;
}

/** Linux: /proc/<pid>/cgroup → systemd 服务单元名；.scope 结尾（登录会话进程）返回 null */
export function parseCgroupServiceUnit(text: string): string | null {
  for (const line of text.split("\n")) {
    const path = line.slice(line.lastIndexOf(":") + 1);
    const last = path.split("/").filter(Boolean).pop();
    if (last?.endsWith(".service")) return last;
  }
  return null;
}

/** Linux: 批量读 /proc/<pid>/cwd 符号链接（零子进程） */
export async function linuxCwds(
  pids: number[],
  readlink: (p: string) => Promise<string> = (p) => fs.readlink(p),
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        map.set(pid, await readlink(`/proc/${pid}/cwd`));
      } catch {
        /* 进程已退出或无权限 */
      }
    }),
  );
  return map;
}

/** Linux: 批量读 /proc/<pid>/cgroup 判定 systemd 受管服务 → pid→"systemd:<unit>" */
export async function linuxServiceLabels(
  pids: number[],
  readFile: (p: string) => Promise<string> = (p) => fs.readFile(p, "utf8"),
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const unit = parseCgroupServiceUnit(await readFile(`/proc/${pid}/cgroup`));
        if (unit) map.set(pid, `systemd:${unit}`);
      } catch {
        /* 进程已退出或无权限 */
      }
    }),
  );
  return map;
}

export function traceSource(pid: number, table: Map<number, PsRow>, managedServices?: Map<number, string>): string {
  let cur = table.get(pid);
  if (!cur) return "?";
  let managedFallback: string | null = null;
  for (let depth = 0; cur && depth < 20; depth++) {
    // Linux 的 cgroup 标签挂在实际监听 pid 上；macOS 的 launchctl 标签通常挂在链根。
    // 先记作兜底并继续走父链，让 PM2/Docker/Agent 等更具体的来源优先于通用进程管理器。
    const managedLabel = managedServices?.get(cur.pid);
    if (managedLabel && !managedFallback) managedFallback = managedLabel;
    const base = cur.comm.split("/").pop() ?? cur.comm;
    for (const [re, label] of SOURCE_PATTERNS) {
      if (re.test(base)) return label;
    }
    if (cur.ppid === 1) {
      if (managedFallback) return managedFallback;
      // ppid=1 有三种可能，最后一种只能确认已脱离会话：
      // 1) 受管服务（macOS launchd / Linux systemd）——map 值即完整标签（launchd:xxx / systemd:xxx）
      // 2) 双 fork 自愿 daemon 化的 GUI 应用后台进程——仅认 /Applications 安装位置，
      //    避免误伤 framework 内嵌的 .app（如 homebrew Python 的 Python.app 解释器壳）
      if (/^\/(?:Applications|Users\/[^/]+\/Applications)\/.*\.app\//.test(cur.comm)) return "app";
      // 3) 父链已脱离当前会话。它可能是遗留进程，也可能是有意 daemon 化的服务，
      // 因此只标记 detached，不宣称它一定是可安全清理的“真孤儿”。
      return "detached";
    }
    if (cur.ppid <= 0) return "?";
    cur = table.get(cur.ppid);
  }
  return managedFallback ?? "?";
}

/**
 * 环境变量残留溯源：detached 进程的父链已断，但 fork 时复制的环境块仍带着启动者的标记。
 * 只查白名单 key，返回值仅为来源标签——完整 env 含 secret，绝不进入扫描结果。
 * 优先级：agent 标记 > IDE 标记 > 终端/ssh（Cursor 内置终端同时带 vscode 标记，需先认更具体的启动者）。
 */
export function originFromEnv(lookup: (key: string) => string | undefined): string | null {
  if (lookup("CLAUDECODE") === "1" || lookup("CLAUDE_CODE_ENTRYPOINT")) return "claude-code";
  const bundle = lookup("__CFBundleIdentifier") ?? "";
  if (/anthropic/i.test(bundle)) return "claude-code";
  if (bundle === "com.todesktop.230313mzl4w4u92" || /cursor/i.test(bundle)) return "cursor";
  if (/antigrav/i.test(bundle)) return "antigravity";
  // bundle id 拿不到时（Linux / 部分派生版），用 askpass 脚本的安装路径区分 VS Code 系分支
  const askpass = lookup("VSCODE_GIT_ASKPASS_MAIN") ?? "";
  if (/cursor/i.test(askpass)) return "cursor";
  if (/antigrav/i.test(askpass)) return "antigravity";
  const term = lookup("TERM_PROGRAM");
  if (term === "vscode" || /vscode/i.test(bundle)) return "vscode/electron";
  if (term) return "terminal";
  if (lookup("SSH_CONNECTION")) return "ssh";
  return null;
}

/**
 * macOS `ps eww -o pid=,command=` 批量输出 → pid→来源标签。
 * 输出里命令行与 env 以空格拼接、无法精确切分，因此只按白名单 key 做带边界的正则搜索；
 * 命令行参数恰好含 KEY=VAL 字样时可能误匹配，但白名单 key 均为启动者专属变量，风险可忽略。
 */
export function parseMacEnvOrigins(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const rest = m[2];
    const lookup = (key: string) => new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(rest)?.[1];
    const origin = originFromEnv(lookup);
    if (origin) map.set(Number(m[1]), origin);
  }
  return map;
}

/** Linux /proc/<pid>/environ（NUL 分隔）→ 来源标签 */
export function parseEnvironOrigin(text: string): string | null {
  const env = new Map<string, string>();
  for (const entry of text.split("\0")) {
    const i = entry.indexOf("=");
    if (i > 0) env.set(entry.slice(0, i), entry.slice(i + 1));
  }
  return originFromEnv((k) => env.get(k));
}

/** Linux: 批量读 /proc/<pid>/environ 溯源（同 uid 才可读，读不到即静默跳过） */
export async function linuxEnvOrigins(
  pids: number[],
  readFile: (p: string) => Promise<string> = (p) => fs.readFile(p, "utf8"),
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const origin = parseEnvironOrigin(await readFile(`/proc/${pid}/environ`));
        if (origin) map.set(pid, origin);
      } catch {
        /* 进程已退出或无权限 */
      }
    }),
  );
  return map;
}

/** ps -axo pid=,command= 全表输出 → pid→完整命令行 映射（一次调用替代 per-pid 查询） */
export function parsePsCommands(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) map.set(Number(m[1]), m[2].trim());
  }
  return map;
}

/** lsof -a -p p1,p2,... -d cwd -Fn 批量输出 → pid→cwd 映射（一次调用替代 per-pid 查询） */
export function parseLsofCwds(text: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) map.set(pid, line.slice(1));
  }
  return map;
}

interface DockerInspectContainer {
  Id?: unknown;
  Name?: unknown;
  Config?: {
    Labels?: unknown;
  };
  HostConfig?: {
    PortBindings?: unknown;
  };
  NetworkSettings?: {
    Ports?: unknown;
  };
  Mounts?: unknown;
}

export interface DockerPortOwner extends DockerInfo {
  hostPorts: number[];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

/** Docker Desktop 的 Engine VM 路径转回 macOS 宿主机路径。 */
function dockerHostPath(value: string): string {
  if (value.startsWith("/host_mnt/")) return value.slice("/host_mnt".length);
  return value;
}

function absolutePath(value: string | undefined): string | null {
  if (!value) return null;
  const hostPath = dockerHostPath(value.trim());
  return path.isAbsolute(hostPath) ? path.normalize(hostPath) : null;
}

function commonPath(paths: string[]): string | null {
  if (!paths.length) return null;
  const normalized = paths.map((p) => path.normalize(p));
  if (normalized.length === 1) return normalized[0];
  const parts = normalized.map((p) => p.split(path.sep).filter(Boolean));
  const common: string[] = [];
  for (let i = 0; i < Math.min(...parts.map((p) => p.length)); i++) {
    const segment = parts[0][i];
    if (!parts.every((p) => p[i] === segment)) break;
    common.push(segment);
  }
  return common.length ? path.sep + common.join(path.sep) : path.parse(normalized[0]).root;
}

function dockerProjectDir(container: DockerInspectContainer, labels: Record<string, string>): string | null {
  // Compose 自己记录的调用目录最可靠，且不受容器内 WorkingDir 影响。
  const composeDir = absolutePath(labels["com.docker.compose.project.working_dir"]);
  if (composeDir) return composeDir;

  const devcontainerDir = absolutePath(labels["devcontainer.local_folder"]);
  if (devcontainerDir) return devcontainerDir;

  const configFile = labels["com.docker.compose.project.config_files"]
    ?.split(",")
    .map((p) => absolutePath(p))
    .find((p): p is string => Boolean(p));
  if (configFile) return path.dirname(configFile);

  if (!Array.isArray(container.Mounts)) return null;
  const bindSources = container.Mounts.flatMap((mount) => {
    if (!mount || typeof mount !== "object") return [];
    const m = mount as { Type?: unknown; Source?: unknown };
    if (m.Type !== "bind" || typeof m.Source !== "string") return [];
    const source = absolutePath(m.Source);
    return source ? [source] : [];
  });
  return commonPath(bindSources);
}

function dockerHostPorts(value: unknown): number[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const ports = new Set<number>();
  for (const bindings of Object.values(value)) {
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      if (!binding || typeof binding !== "object") continue;
      const hostPort = Number((binding as { HostPort?: unknown }).HostPort);
      if (Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65535) ports.add(hostPort);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** docker inspect JSON → 每个运行容器的宿主机端口与项目目录。 */
export function parseDockerInspect(text: string): DockerPortOwner[] {
  let containers: unknown;
  try {
    containers = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(containers)) return [];

  const owners: DockerPortOwner[] = [];
  for (const raw of containers) {
    if (!raw || typeof raw !== "object") continue;
    const container = raw as DockerInspectContainer;
    const containerId = typeof container.Id === "string" ? container.Id : "";
    if (!containerId) continue;
    const labels = stringRecord(container.Config?.Labels);
    const networkPorts = dockerHostPorts(container.NetworkSettings?.Ports);
    const hostPorts = networkPorts.length
      ? networkPorts
      : dockerHostPorts(container.HostConfig?.PortBindings);
    if (!hostPorts.length) continue;
    const rawName = typeof container.Name === "string" ? container.Name : containerId.slice(0, 12);
    owners.push({
      containerId,
      containerName: rawName.replace(/^\//, ""),
      composeProject: labels["com.docker.compose.project"] ?? null,
      composeService: labels["com.docker.compose.service"] ?? null,
      projectDir: dockerProjectDir(container, labels),
      hostPorts,
    });
  }
  return owners;
}

/** 仅在扫描到 Docker 监听时查询；两次固定调用，不随容器数增加。 */
export async function dockerPortOwners(exec: Exec = realExec): Promise<DockerPortOwner[]> {
  const ids = (await exec("docker", ["ps", "-q", "--no-trunc"]))
    .split(/\s+/)
    .filter((id) => /^[0-9a-f]{12,64}$/i.test(id));
  if (!ids.length) return [];
  return parseDockerInspect(await exec("docker", ["inspect", ...ids]));
}

interface Pm2JlistEntry {
  pid?: unknown;
  name?: unknown;
  pm_id?: unknown;
  pm2_env?: unknown;
}

export interface Pm2ProcessOwner extends Pm2Info {
  pid: number;
}

/** pm2 jlist JSON → 运行中 PID 的安全归属信息；明确丢弃完整 env，避免把 secret 带入扫描结果。 */
export function parsePm2Jlist(text: string): Pm2ProcessOwner[] {
  let entries: unknown;
  try {
    entries = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];

  const owners: Pm2ProcessOwner[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Pm2JlistEntry;
    const pid = Number(entry.pid);
    const pmId = Number(entry.pm_id);
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(pmId) || pmId < 0 || !name) continue;
    const env = stringRecord(entry.pm2_env);
    const script = absolutePath(env.pm_exec_path);
    let projectDir = absolutePath(env.pm_cwd);
    if ((!projectDir || projectDir === path.parse(projectDir).root) && script) projectDir = path.dirname(script);
    owners.push({
      pid,
      pmId,
      name,
      status: env.status ?? null,
      projectDir,
      script,
    });
  }
  return owners;
}

/** 仅在父链识别到 PM2 时查询一次当前用户的 PM2 daemon。 */
export async function pm2ProcessOwners(exec: Exec = realExec): Promise<Pm2ProcessOwner[]> {
  return parsePm2Jlist(await exec("pm2", ["jlist"]));
}

function findPm2Owner(
  pid: number,
  table: Map<number, PsRow>,
  ownersByPid: Map<number, Pm2ProcessOwner>,
): Pm2ProcessOwner | null {
  let cur = pid;
  for (let depth = 0; depth < 20 && cur > 0; depth++) {
    const owner = ownersByPid.get(cur);
    if (owner) return owner;
    const row = table.get(cur);
    if (!row || row.ppid === cur) break;
    cur = row.ppid;
  }
  return null;
}

/** cwd 失真兜底：从命令行第一个含 node_modules 或以 / 开头的脚本参数推断项目根 */
export function inferProjectFromCommand(command: string): string | null {
  for (const tok of command.split(/\s+/)) {
    const nm = tok.indexOf("/node_modules/");
    if (nm > 0) return tok.slice(0, nm);
  }
  return null;
}

const NOISE = /^(language_server|Antigravity|Electron$|Cursor|Code Helper|ControlCenter|rapportd|sharingd|AnyDesk|aTrust|MacPacketTunnel|identityservicesd|AMPDeviceDiscoveryAgent)/i;

export function isNoise(procName: string): boolean {
  return NOISE.test(procName);
}

export async function scanListeners(exec: Exec = realExec, platform: NodeJS.Platform = process.platform): Promise<ProcessInfo[]> {
  const linux = platform === "linux";
  // 固定次数并行调用拿全量数据（不随监听进程数增长）
  const [listenOut, psOut, psCmdOut, launchctlOut] = await Promise.all([
    linux
      ? exec("ss", ["-tlnp"])
      : exec("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fpcn"]),
    exec("ps", ["-axo", "pid=,ppid=,comm="]),
    exec("ps", ["-axo", "pid=,command="]),
    linux ? Promise.resolve("") : exec("launchctl", ["list"]),
  ]);
  const listens = linux ? parseSsListeners(listenOut) : parseLsofListeners(listenOut);
  const table = parsePsTable(psOut);
  const commands = parsePsCommands(psCmdOut);

  const byPid = new Map<number, Set<number>>();
  for (const l of listens) {
    if (!byPid.has(l.pid)) byPid.set(l.pid, new Set());
    byPid.get(l.pid)!.add(l.port);
  }
  const pids = [...byPid.keys()];

  // 受管服务标签：macOS 用 launchctl list，Linux 读 /proc/<pid>/cgroup
  const managedServices = linux
    ? await linuxServiceLabels(pids)
    : new Map([...parseLaunchctlList(launchctlOut)].map(([p, l]) => [p, `launchd:${l}`] as const));

  // cwd 反查：macOS 一次 lsof 批量（-p 逗号列表），Linux 读 /proc/<pid>/cwd 符号链接
  const cwds = linux
    ? await linuxCwds(pids)
    : pids.length
      ? parseLsofCwds(await exec("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]))
      : new Map<number, string>();

  const baseInfos = pids.map((pid): ProcessInfo => {
    const ports = byPid.get(pid)!;
    const command = commands.get(pid) ?? "";
    const comm = table.get(pid)?.comm ?? "?";
    return {
      pid,
      ports: [...ports].sort((a, b) => a - b),
      procName: comm.split("/").pop() ?? "?",
      command,
      cwd: cwds.get(pid) ?? null,
      inferredProject: inferProjectFromCommand(command),
      source: traceSource(pid, table, managedServices),
    };
  });
  // detached 的进程父链已断，补一次 env 溯源（只查这几个 pid，不随监听总数增长）
  const detachedPids = baseInfos.filter((info) => info.source === "detached").map((info) => info.pid);
  const envOrigins = detachedPids.length === 0
    ? new Map<number, string>()
    : linux
      ? await linuxEnvOrigins(detachedPids)
      : parseMacEnvOrigins(await exec("ps", ["eww", "-o", "pid=,command=", "-p", detachedPids.join(",")]));
  const tracedInfos = baseInfos.map((info): ProcessInfo => {
    const origin = envOrigins.get(info.pid);
    return origin ? { ...info, origin } : info;
  });

  const [dockerPorts, pm2Owners] = await Promise.all([
    tracedInfos.some((info) => info.source === "docker") ? dockerPortOwners(exec) : [],
    tracedInfos.some((info) => info.source === "pm2") ? pm2ProcessOwners(exec) : [],
  ]);
  const pm2OwnersByPid = new Map(pm2Owners.map((owner) => [owner.pid, owner]));
  const managedInfos = tracedInfos.map((info): ProcessInfo => {
    if (info.source !== "pm2") return info;
    const owner = findPm2Owner(info.pid, table, pm2OwnersByPid);
    if (!owner) return info;
    return {
      ...info,
      pm2: {
        pmId: owner.pmId,
        name: owner.name,
        status: owner.status,
        projectDir: owner.projectDir,
        script: owner.script,
      },
    };
  });
  const ownersByPort = new Map<number, DockerPortOwner>();
  for (const owner of dockerPorts) {
    for (const port of owner.hostPorts) ownersByPort.set(port, owner);
  }

  const infos = managedInfos.flatMap((info): ProcessInfo[] => {
    if (info.source !== "docker" || !ownersByPort.size) return [info];
    const grouped = new Map<DockerPortOwner | null, number[]>();
    for (const port of info.ports) {
      const owner = ownersByPort.get(port) ?? null;
      const ports = grouped.get(owner) ?? [];
      ports.push(port);
      grouped.set(owner, ports);
    }
    return [...grouped].map(([owner, ports]) => owner
      ? {
          ...info,
          ports,
          docker: {
            containerId: owner.containerId,
            containerName: owner.containerName,
            composeProject: owner.composeProject,
            composeService: owner.composeService,
            projectDir: owner.projectDir,
          },
        }
      : { ...info, ports });
  });
  return infos.sort((a, b) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0));
}

export function resolveProjectDir(p: Omit<ProcessInfo, "cwd" | "inferredProject"> & { cwd: string | null; inferredProject: string | null }): string | null {
  if (p.pm2?.projectDir) return p.pm2.projectDir;
  if (p.docker?.projectDir) return p.docker.projectDir;
  if (p.cwd && p.cwd !== "/" && !p.cwd.startsWith("/System")) return p.cwd;
  return p.inferredProject ?? p.cwd;
}

export function displaySource(p: ProcessInfo): string {
  if (p.pm2) return `pm2:${p.pm2.name}`;
  if (p.source === "detached" && p.origin) return `detached (${p.origin})`;
  if (!p.docker) return p.source;
  const owner = p.docker.composeProject && p.docker.composeService
    ? `${p.docker.composeProject}/${p.docker.composeService}`
    : p.docker.containerName;
  return `docker:${owner}`;
}

/**
 * macOS 上 os.tmpdir() 落在 /var/folders/...，而 /var 是指向 /private/var 的符号链接；
 * lsof/proc 上报的进程 cwd 是内核解析后的真实路径（/private/var/...），字符串直接比较会误判为不同项目。
 * 在比较边界统一 realpath 消除这条符号链接落差；目录若已不存在（已被清理的临时项目目录）则回退原始字符串。
 * Linux 下 /tmp 一般不经过符号链接，realpath 通常就是原值，不影响行为。
 */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function classifyTarget(
  proc: ProcessInfo,
  callerCwd: string,
  registry: RegistryEntry[],
): "detached" | "own" | "foreign" {
  if (proc.source === "detached") return "detached";
  const normalizedCwd = realpathOrSelf(callerCwd);
  const proj = resolveProjectDir(proc);
  if (proj && (proj === normalizedCwd || proj.startsWith(normalizedCwd + "/") || normalizedCwd.startsWith(proj + "/"))) {
    return "own";
  }
  const owned = registry.find(
    (r) => !r.released && proc.ports.includes(r.port) && realpathOrSelf(r.project) === normalizedCwd,
  );
  if (owned) return "own";
  return "foreign";
}

export async function terminate(
  pid: number,
  waitMs = 3000,
  kill: (pid: number, sig: NodeJS.Signals) => void = (p, s) => process.kill(p, s),
  alive: (pid: number) => boolean = (p) => { try { process.kill(p, 0); return true; } catch { return false; } },
): Promise<"term" | "kill" | "gone"> {
  try {
    kill(pid, "SIGTERM");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return "gone";
    throw e;
  }
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 100));
    if (!alive(pid)) return "term";
  }
  try {
    kill(pid, "SIGKILL");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  return "kill";
}

/** 生成 claim 重验证回调：候选端口的监听者是否归属该项目（含父子目录）。scan 只做一次并缓存 */
export function projectOwnsPort(project: string): (port: number) => Promise<boolean> {
  let scanPromise: Promise<ProcessInfo[]> | undefined;
  const normalizedProject = realpathOrSelf(project);
  return async (candidate) => {
    scanPromise ??= scanListeners();
    const proc = (await scanPromise).find((p) => p.ports.includes(candidate));
    const owner = proc ? resolveProjectDir(proc) : null;
    if (!owner) return false;
    return owner === normalizedProject || owner.startsWith(normalizedProject + "/") || normalizedProject.startsWith(owner + "/");
  };
}
