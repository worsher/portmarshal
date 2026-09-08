import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { scanListeners, parseLsofListeners, parsePsTable, parsePsCommands, type ScanOptions } from "../scan.js";
import type { ProcessInfo } from "../types.js";

export type ProbeOutcome = "success" | "no-match" | "missing" | "denied" | "timeout" | "truncated" | "failed";
export interface ProbeResult { outcome: ProbeOutcome; stdout: string }
export type Probe = (cmd: string, args: string[], options: { timeoutMs: number; signal: AbortSignal }) => Promise<ProbeResult>;
export interface ScanObservation {
  processes: ProcessInfo[];
  /** Includes visible Linux sockets even when their PIDs are hidden. */
  ports: number[];
  listeners: ProbeOutcome;
  attributionComplete: boolean;
  listenerCoverage: boolean;
  managedSkipped: boolean;
  timedOut: boolean;
  issues: string[];
}

/** Error text stays local to classification, never enters diagnostics or process records. */
export const diagnosticProbe: Probe = (cmd, args, options) => new Promise((resolve) => {
  if (options.signal.aborted) return resolve({ outcome: "timeout", stdout: "" });
  execFile(cmd, args, {
    timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024,
    signal: options.signal, killSignal: "SIGKILL", encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }, (error, stdout, stderr) => {
    let outcome: ProbeOutcome = "success";
    if (error) {
      const code = error.code;
      if (code === "ENOENT") outcome = "missing";
      else if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") outcome = "truncated";
      else if (options.signal.aborted || error.killed) outcome = "timeout";
      else if (code === "EACCES" || code === "EPERM" || /permission denied|operation not permitted/i.test(stderr)) outcome = "denied";
      else if (cmd === "lsof" && args.includes("-iTCP") && code === 1 && !stdout.trim() && !stderr.trim()) outcome = "no-match";
      else outcome = "failed";
    } else if (stderr.trim()) {
      // Warnings can indicate hidden processes or incomplete output, even on exit 0.
      outcome = /permission denied|operation not permitted/i.test(stderr) ? "denied" : "failed";
    }
    resolve({ outcome, stdout: outcome === "success" ? stdout : "" });
  });
});

const accepted = (outcome: ProbeOutcome) => outcome === "success" || outcome === "no-match";

export async function inspectScan(options: {
  platform?: NodeJS.Platform;
  probe?: Probe;
  readProcFile?: ScanOptions["readProcFile"];
  readProcLink?: ScanOptions["readProcLink"];
  budgetMs?: number;
  probeTimeoutMs?: number;
} = {}): Promise<ScanObservation> {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? diagnosticProbe;
  const controller = new AbortController();
  const budget = Math.min(options.budgetMs ?? 10_000, 10_000);
  const deadline = Date.now() + budget;
  const result: ScanObservation = {
    processes: [], ports: [], listeners: "failed", listenerCoverage: false,
    attributionComplete: true, managedSkipped: false, timedOut: false, issues: [],
  };
  if (platform !== "linux" && platform !== "darwin") return result;
  const issues = new Set<string>();
  const ports = new Set<number>();
  const execute = async (cmd: string, args: string[]): Promise<string> => {
    const listener = cmd === "ss" || (cmd === "lsof" && args.includes("-iTCP"));
    let response: ProbeResult;
    try {
      response = controller.signal.aborted ? { outcome: "timeout", stdout: "" } : await probe(cmd, args, {
        timeoutMs: Math.max(1, Math.min(options.probeTimeoutMs ?? 3000, 3000, deadline - Date.now())),
        signal: controller.signal,
      });
    } catch { response = { outcome: "failed", stdout: "" }; }
    if (listener) {
      result.listeners = response.outcome;
      result.listenerCoverage = accepted(response.outcome);
      if (response.outcome === "success") {
        if (platform === "linux") {
          const lines = response.stdout.trim().split("\n").filter(Boolean);
          for (const line of lines) {
            if (/^State\s/.test(line)) continue;
            if (!/^LISTEN\s/.test(line)) { result.listenerCoverage = false; continue; }
            const local = line.trim().split(/\s+/)[3] ?? "";
            const value = Number(local.slice(local.lastIndexOf(":") + 1));
            if (!Number.isInteger(value) || value < 1 || value > 65535) result.listenerCoverage = false;
            else ports.add(value);
            if (!/pid=[1-9]\d*/.test(line)) {
              result.attributionComplete = false;
              issues.add("Some sockets do not expose a listener PID.");
            }
          }
          if (!lines.length) result.listenerCoverage = false; // ss normally includes its header
        } else {
          const parsed = parseLsofListeners(response.stdout);
          const addressCount = response.stdout.split("\n").filter((line) => line.startsWith("n")).length;
          const unrecognized = response.stdout.split("\n").some((line) => line && !/^[pcnf]/.test(line));
          result.listenerCoverage = parsed.length > 0 && parsed.length === addressCount && !unrecognized &&
            parsed.every((row) => Number.isInteger(row.pid) && row.pid > 0 && Number.isInteger(row.port) && row.port <= 65535);
          for (const row of parsed) ports.add(row.port);
        }
        if (!result.listenerCoverage) {
          result.listeners = "failed";
          issues.add("Listener output was incomplete or unrecognized.");
        }
      }
    } else if (!accepted(response.outcome)) {
      result.attributionComplete = false;
      issues.add(cmd + " attribution probe: " + response.outcome + ".");
    } else if (cmd === "ps" && args.includes("-axo")) {
      const parsed = args.includes("pid=,command=") ? parsePsCommands(response.stdout) : parsePsTable(response.stdout);
      if (!parsed.size) {
        result.attributionComplete = false;
        issues.add("Process table was empty or unrecognized.");
      }
    }
    if (response.outcome === "timeout") result.timedOut = true;
    return accepted(response.outcome) ? response.stdout : "";
  };
  const readProc = async (file: string, link: boolean) => {
    try {
      if (controller.signal.aborted) throw new Error("deadline");
      return link
        ? await (options.readProcLink ?? fs.readlink)(file)
        : await (options.readProcFile ?? ((p: string) => fs.readFile(p, { encoding: "utf8", signal: controller.signal })))(file);
    } catch (e) {
      result.attributionComplete = false;
      issues.add("Some proc metadata was unavailable.");
      throw e;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, budget);
  });
  try {
    const scan = await Promise.race([
      scanListeners(execute, platform, true, {
        managedMetadata: false,
        readProcFile: (file) => readProc(file, false),
        readProcLink: (file) => readProc(file, true),
      }),
      expired,
    ]);
    if (scan === null) {
      result.timedOut = true;
      result.attributionComplete = false;
      result.listenerCoverage = false;
      result.listeners = "timeout";
      issues.add("Collection deadline exceeded.");
    } else {
      result.processes = scan;
      if (scan.some((p) => !p.cwd || !p.command || p.pgid === undefined || p.ppid === undefined || p.source === "?")) {
        result.attributionComplete = false;
        issues.add("Some listener project or ancestry evidence was unavailable.");
      }
      result.managedSkipped = scan.some((p) => p.source === "docker" || p.source === "pm2");
    }
  } catch {
    result.listeners = "failed";
    result.listenerCoverage = false;
    result.attributionComplete = false;
    issues.add("Scanner could not complete.");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  // Return a detached result: late, uncooperative injected probes cannot change an emitted report.
  return { ...result, ports: [...ports].sort((a, b) => a - b), issues: [...issues].sort() };
}
