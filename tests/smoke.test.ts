import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const CLI = path.resolve("dist/cli.js");
const PORT = 18923;
let server: ChildProcess;
let projDir: string;
let stateDir: string;

function waitListening(port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      const sock = net.connect({ port, host: "127.0.0.1" }, () => { sock.destroy(); resolve(); });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("timeout waiting for port"));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

async function cli(args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileP("node", [CLI, ...args], {
      env: { ...process.env, PORTMARSHAL_STATE_DIR: stateDir },
    });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; code?: number };
    return { stdout: err.stdout ?? "", code: err.code ?? 1 };
  }
}

before(async () => {
  projDir = await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-smoke-"));
  stateDir = path.join(projDir, ".portmarshal");
  // 用当前 node 自身起测试服务器，不依赖 CI 环境是否预装 python3
  server = spawn(
    process.execPath,
    ["-e", `require("http").createServer((_q,r)=>r.end("ok")).listen(${PORT},"127.0.0.1")`],
    { cwd: projDir, stdio: "ignore" },
  );
  await waitListening(PORT);
});

after(async () => {
  server.kill("SIGKILL");
  await fs.rm(projDir, { recursive: true, force: true });
});

test("list --all --json 能归属到正确 cwd", async () => {
  const { stdout } = await cli(["list", "--all", "--json"]);
  const entries = JSON.parse(stdout) as Array<{ port: number; proc?: { cwd: string } }>;
  const hit = entries.find((e) => e.port === PORT);
  assert.ok(hit, `端口 ${PORT} 应在扫描结果中`);
  assert.equal(await fs.realpath(hit!.proc!.cwd), await fs.realpath(projDir));
});

test("whois 未监听端口 exit=2", async () => {
  const { code } = await cli(["whois", "1"]);
  assert.equal(code, 2);
});

test("claim 幂等返回同一端口且端口真实空闲", async () => {
  const { stdout: p1 } = await cli(["claim", "smoke-web", "--project", projDir, "--prefer", "18930"]);
  const { stdout: p2 } = await cli(["claim", "smoke-web", "--project", projDir]);
  assert.equal(p1.trim(), p2.trim());
  const free = await new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port: Number(p1), host: "127.0.0.1" }, () => srv.close(() => resolve(true)));
  });
  assert.equal(free, true);
  await cli(["release", "smoke-web", "--project", projDir]);
});

test("stop --force 能停止服务并且端口释放", async () => {
  const { code } = await cli(["stop", String(PORT), "--force"]);
  assert.equal(code, 0);
  await new Promise((r) => setTimeout(r, 500));
  const { code: whoisCode } = await cli(["whois", String(PORT)]);
  assert.equal(whoisCode, 2);
});

test("watch 非 TTY 输出单帧后退出而非死循环", async () => {
  const { code } = await cli(["watch"]);
  assert.equal(code, 0);
});

test("-v / --version 输出 semver 版本号", async () => {
  const { stdout, code } = await cli(["-v"]);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  const { stdout: s2 } = await cli(["--version"]);
  assert.equal(s2, stdout);
});

test("--help 使用 PortMarshal 品牌和英文默认输出", async () => {
  const { stdout, code } = await cli(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /^portmarshal — agent-aware local port ownership/);
  assert.match(stdout, /Usage:/);
});

function waitFree(port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      const sock = net.connect({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("timeout waiting for port to free"));
        else setTimeout(tryOnce, 150);
      });
      sock.on("error", () => { sock.destroy(); resolve(); });
    };
    tryOnce();
  });
}

test("run: SIGTERM 转发到进程组（含孙进程）并自动 release", async () => {
  const runPort = 18931;
  // sh -c 制造孙进程：sh 是子进程，真正监听的 node 是孙进程
  const script =
    'require("http").createServer((_q,r)=>r.end("ok")).listen(process.env.PORT,"127.0.0.1");setInterval(()=>{},1000)';
  const runner = spawn(
    "node",
    [CLI, "run", "smoke-run", "--prefer", String(runPort), "--project", projDir,
      "--", "sh", "-c", `"${process.execPath}" -e '${script}'`],
    { cwd: projDir, env: { ...process.env, PORTMARSHAL_STATE_DIR: stateDir }, stdio: "ignore" },
  );
  await waitListening(runPort);

  runner.kill("SIGTERM");
  const code = await new Promise<number>((resolve) => {
    runner.once("exit", (c, s) => resolve(s ? -1 : (c ?? -1)));
  });
  assert.equal(code, 143); // 128 + SIGTERM(15)：supervisor 收到信号→转发进程组→子进程被 TERM

  await waitFree(runPort); // 孙进程也被组信号终止，端口已释放
  const reg = JSON.parse(await fs.readFile(path.join(stateDir, "registry.json"), "utf8")) as
    Array<{ name: string; released?: boolean; lastPort?: number }>;
  const entry = reg.find((e) => e.name === "smoke-run");
  assert.ok(entry);
  assert.equal(entry.released, true);
  assert.equal(entry.lastPort, runPort);
});
