export const C = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// 极简 East Asian Width 表：终端里占 2 列的区段（CJK/假名/谚文/全角等）
const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
  (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首、康熙部首、CJK 符号标点
  (cp >= 0x3041 && cp <= 0x33ff) || // 平假名、片假名、CJK 兼容
  (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
  (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
  (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
  (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
  (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
  (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
  (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
  (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
  (cp >= 0x20000 && cp <= 0x3fffd); // CJK 扩展 B 及以后

// 终端显示宽度（按码点迭代，正确处理代理对）
const displayWidth = (s: string): number => {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return w;
};

export function formatTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) =>
    Math.max(...all.map((r) => displayWidth(strip(r[i] ?? "")))),
  );
  const fmt = (r: string[]) =>
    r
      .map((c, i) => c + " ".repeat(widths[i] - displayWidth(strip(c))))
      .join("  ");
  return [fmt(header), ...rows.map(fmt)].join("\n");
}

import type { MergedEntry } from "./types.js";
import { displaySource, resolveProjectDir } from "./scan.js";
import { isDeadRun } from "./merge.js";

const WATCH_STATE: Record<string, string> = {
  active: `${C.green}●${C.reset}`,
  reserved: "◐",
  unregistered: "○",
  drift: `${C.yellow}⚠${C.reset}`,
};

export function formatWatchFrame(cur: MergedEntry[], prevPorts: Set<number>): string {
  const rows = cur.map((e) => {
    const isNew = !prevPorts.has(e.port);
    const proj = e.proc ? resolveProjectDir(e.proc) : e.reg?.project;
    const color = isNew ? C.green : e.proc?.source === "detached" || e.state === "drift" ? C.yellow : "";
    const end = color ? C.reset : "";
    return [
      `${color}${e.port}${end}`,
      WATCH_STATE[e.state],
      e.proc ? displaySource(e.proc) : "-",
      e.reg?.name ?? "-",
      `${color}${proj ?? "?"}${end}`,
      // spec §4：run -d 托管的 claim 进程已死但记录还在时，list/watch 都要提示 dead
      isDeadRun(e) ? `${C.red}dead${C.reset}` : "",
    ];
  });
  const now = new Date().toLocaleTimeString("en-US", { hour12: false });
  return (
    `portmarshal watch  ${C.dim}${now}  press q to quit${C.reset}\n\n` +
    formatTable(["PORT", "STATE", "SOURCE", "CLAIM", "PROJECT", ""], rows) +
    "\n"
  );
}
