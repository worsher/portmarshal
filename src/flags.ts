export interface Flags {
  json: boolean;
  all: boolean;
  force: boolean;
  gui: boolean;
  install: boolean;
  killDetached: boolean;
  restart: boolean;
  project?: string;
  prefer?: number;
  range?: [number, number];
  positional: string[];
  /** `--` 之后的原样参数，交给 run 作为子进程 argv */
  rest: string[];
}

export function parseFlags(args: string[]): Flags {
  const f: Flags = {
    json: false, all: false, force: false, gui: false,
    install: false, killDetached: false, restart: false,
    positional: [], rest: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--": f.rest = args.slice(i + 1); i = args.length; break;
      case "--restart": f.restart = true; break;
      case "--json": f.json = true; break;
      case "--all": f.all = true; break;
      case "--force": f.force = true; break;
      case "--gui": f.gui = true; break;
      case "--install": f.install = true; break;
      case "--kill-detached": f.killDetached = true; break;
      case "--kill-orphans": f.killDetached = true; break; // v0.2 compatibility alias
      case "--project": f.project = args[++i]; break;
      case "--prefer": {
        const port = Number(args[++i]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error("--prefer must be a TCP port between 1 and 65535");
        }
        f.prefer = port;
        break;
      }
      case "--range": {
        const m = /^(\d+)-(\d+)$/.exec(args[++i] ?? "");
        if (!m) throw new Error("--range must use A-B format, for example 3000-3999");
        const lo = Number(m[1]);
        const hi = Number(m[2]);
        if (lo < 1 || hi > 65535 || lo > hi) {
          throw new Error("--range must be an ascending TCP port range within 1-65535");
        }
        f.range = [lo, hi];
        break;
      }
      default:
        if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
        f.positional.push(a);
    }
  }
  return f;
}
