import fs from "node:fs/promises";
import { realExec, type Exec } from "./exec.js";

export interface RunMarker {
  service?: string;
  runId?: string;
}

/** 只提取 PortMarshal 自己的两个标记；绝不返回完整环境。 */
export function markerFromLookup(lookup: (key: string) => string | undefined): RunMarker {
  const service = lookup("PORTMARSHAL_SERVICE");
  const runId = lookup("PORTMARSHAL_RUN_ID");
  return {
    ...(service ? { service } : {}),
    ...(runId ? { runId } : {}),
  };
}

export function parseEnvironRunMarker(text: string): RunMarker {
  const env = new Map<string, string>();
  for (const entry of text.split("\0")) {
    const i = entry.indexOf("=");
    if (i > 0) env.set(entry.slice(0, i), entry.slice(i + 1));
  }
  return markerFromLookup((key) => env.get(key));
}

export function parseMacRunMarker(text: string): RunMarker {
  const lookup = (key: string) => new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(text)?.[1];
  return markerFromLookup(lookup);
}

/** 同 uid 进程的定点标记读取；失败时返回空对象，由调用方安全阻止而不是猜测。 */
export async function readProcessRunMarker(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  exec: Exec = realExec,
): Promise<RunMarker> {
  if (platform === "linux") {
    try {
      return parseEnvironRunMarker(await fs.readFile(`/proc/${pid}/environ`, "utf8"));
    } catch {
      return {};
    }
  }
  if (platform === "darwin") {
    return parseMacRunMarker(await exec("ps", ["eww", "-o", "command=", "-p", String(pid)]));
  }
  return {};
}
