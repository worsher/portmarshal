export interface ListenEntry {
  pid: number;
  port: number;
  address: string;
}

export interface PsRow {
  pid: number;
  ppid: number;
  pgid?: number;
  comm: string;
}

export interface DockerInfo {
  containerId: string;
  containerName: string;
  composeProject: string | null;
  composeService: string | null;
  /** 宿主机上的 Compose 工作目录或 bind mount 目录 */
  projectDir: string | null;
}

export interface Pm2Info {
  pmId: number;
  name: string;
  status: string | null;
  projectDir: string | null;
  script: string | null;
}

export interface ProcessInfo {
  pid: number;
  /** 进程组 id；用于验证 run -d 监听者确实属于受管进程组 */
  pgid?: number;
  ports: number[];
  procName: string;
  command: string;
  cwd: string | null;
  /** 从命令行参数推断的项目路径（cwd 失真时的兜底） */
  inferredProject: string | null;
  /** Docker 端口反查到的容器和宿主机项目元数据 */
  docker?: DockerInfo;
  /** PM2 jlist 反查到的应用元数据（不保留 env，避免泄露 secret） */
  pm2?: Pm2Info;
  source: string; // "claude-code" | "cursor" | "antigravity" | "vscode/electron" | "terminal" | "docker" | "pm2" | "detached" | "?"
  /** detached 进程从环境变量残留追溯的启动者。仅展示用途，不参与 gc/stop 的状态判定 */
  origin?: string;
}

export interface RegistryEntry {
  name: string;
  project: string;
  port: number;
  claimedAt: string; // ISO 8601
  claimedBy?: string;
  released?: boolean;
  lastPort?: number;
  /** run -d 托管的进程组长 pid；转 released 时清除 */
  runPid?: number;
  /** run -d 随机实例标识；与监听进程环境交叉验证，防止 PID/PGID 复用误杀 */
  runId?: string;
  /** run -d 日志文件绝对路径；release 后保留，供 logs 查上一次输出 */
  logFile?: string;
}

export type PortState = "active" | "reserved" | "unregistered" | "drift";

export interface MergedEntry {
  port: number;
  state: PortState;
  proc?: ProcessInfo;
  reg?: RegistryEntry;
  driftPeer?: number;
}

export const EXIT = {
  OK: 0,
  ERR: 1,
  NOT_FOUND: 2,
  BLOCKED: 3,
  LOCK_TIMEOUT: 4,
} as const;
