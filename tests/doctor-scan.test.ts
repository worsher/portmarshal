import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosticProbe, inspectScan, type Probe } from "../src/diagnostics/scan.js";

function macProbe(overrides: Partial<Record<string, string>> = {}, calls: string[] = []): Probe {
  return async (cmd, args) => {
    calls.push(cmd);
    const key = cmd === "lsof" ? (args.includes("-iTCP") ? "listeners" : "cwd")
      : cmd === "ps" ? (args.includes("pid=,command=") ? "commands" : "table") : cmd;
    const values: Record<string, string> = {
      listeners: "p101\ncnode\nn127.0.0.1:3000\n",
      cwd: "p101\nfcwd\nn/p/app\n",
      table: "101 1 101 node\n1 0 1 launchd\n",
      commands: "101 node server.js --token private-sentinel\n1 launchd\n",
      launchctl: "PID\tStatus\tLabel\n101\t0\tlocal.test\n",
      ...overrides,
    };
    return { outcome: "success", stdout: values[key] ?? "" };
  };
}

test("doctor scan: batches evidence and preserves existing attribution", async () => {
  const calls: string[] = [];
  const result = await inspectScan({ platform: "darwin", probe: macProbe({}, calls) });
  assert.equal(result.listeners, "success");
  assert.equal(result.listenerCoverage, true);
  assert.equal(result.attributionComplete, true);
  assert.equal(result.processes[0].cwd, "/p/app");
  assert.equal(result.processes[0].command.includes("private-sentinel"), false);
  assert.deepEqual(result.ports, [3000]);
  assert.equal(calls.length, 5);
});

test("doctor scan: missing/denied/timeout/truncated differ from valid no-match", async () => {
  for (const outcome of ["missing", "denied", "timeout", "truncated", "failed", "no-match"] as const) {
    const base = macProbe();
    const result = await inspectScan({
      platform: "darwin",
      probe: async (cmd, args, opts) => cmd === "lsof" && args.includes("-iTCP")
        ? { outcome, stdout: "" } : base(cmd, args, opts),
    });
    assert.equal(result.listeners, outcome);
    assert.equal(result.listenerCoverage, outcome === "no-match");
  }
});

test("doctor scan: malformed and empty successful lsof output are incomplete", async () => {
  for (const listeners of ["", "permission denied", "p101\ncnode\nn*:bad\n"]) {
    const result = await inspectScan({ platform: "darwin", probe: macProbe({ listeners }) });
    assert.equal(result.listenerCoverage, false);
    assert.equal(result.listeners, "failed");
  }
});

test("doctor scan: managed metadata is skipped without executing runtime clients", async () => {
  for (const comm of ["docker", "PM2"]) {
    const calls: string[] = [];
    const result = await inspectScan({
      platform: "darwin",
      probe: macProbe({ table: "101 1 101 " + comm + "\n1 0 1 launchd\n", launchctl: "" }, calls),
    });
    assert.equal(result.managedSkipped, true);
    assert.equal(calls.includes("docker"), false);
    assert.equal(calls.includes("pm2"), false);
  }
});

test("doctor scan: Linux PID-less sockets preserve occupancy and report limited attribution", async () => {
  const result = await inspectScan({
    platform: "linux",
    probe: async (cmd) => ({ outcome: "success", stdout: cmd === "ss"
      ? "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 128 127.0.0.1:3000 0.0.0.0:*\n"
      : "1 0 1 init\n" }),
  });
  assert.deepEqual(result.ports, [3000]);
  assert.equal(result.listenerCoverage, true);
  assert.equal(result.attributionComplete, false);
  assert.deepEqual(result.processes, []);
});

test("doctor scan: Linux proc failure stays visible", async () => {
  const result = await inspectScan({
    platform: "linux",
    probe: async (cmd) => ({ outcome: "success", stdout: cmd === "ss"
      ? 'LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=101,fd=3))\n'
      : "101 1 101 node\n1 0 1 init\n" }),
    readProcFile: async () => { throw Object.assign(new Error("secret"), { code: "EACCES" }); },
    readProcLink: async () => { throw new Error("secret"); },
  });
  assert.equal(result.attributionComplete, false);
  assert.ok(result.issues.includes("Some proc metadata was unavailable."));
  assert.equal(JSON.stringify(result.issues).includes("secret"), false);
});

test("doctor scan: total deadline returns a partial report even when an injected probe never resolves", async () => {
  let signal: AbortSignal | undefined;
  const start = Date.now();
  const result = await inspectScan({ platform: "darwin", budgetMs: 25,
    probe: async (_cmd, _args, opts) => { signal = opts.signal; return new Promise(() => {}); } });
  assert.ok(Date.now() - start < 1000);
  assert.equal(signal?.aborted, true);
  assert.equal(result.listeners, "timeout");
  assert.equal(result.listenerCoverage, false);
});

test("doctor probe: spawn errors and own-child timeouts are sanitized", async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await diagnosticProbe("portmarshal-nonexistent-probe", [], { signal, timeoutMs: 100 }),
    { outcome: "missing", stdout: "" });
  assert.deepEqual(await diagnosticProbe(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal, timeoutMs: 25 }),
    { outcome: "timeout", stdout: "" });
  assert.deepEqual(await diagnosticProbe(process.execPath, ["-e", "process.stderr.write('secret');process.exit(1)"], { signal, timeoutMs: 1000 }),
    { outcome: "failed", stdout: "" });
});
