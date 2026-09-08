#!/usr/bin/env node
// Run against an extracted npm package. All state, adapters and listeners belong to a temporary project.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const packageDir = await fs.realpath(process.argv[2] ?? ".");
const cli = path.join(packageDir, "dist/cli.js");
const version = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8")).version;
const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "portmarshal-package-")));
const stateDir = path.join(project, "state");
const owner = "package-verification-owner";
const env = { ...process.env, PORTMARSHAL_STATE_DIR: stateDir, PORTMARSHAL_OWNER: owner };
const call = async (args, caller = owner) => {
  try {
    const result = await exec(process.execPath, [cli, ...args], {
      cwd: project, env: { ...env, PORTMARSHAL_OWNER: caller }, timeout: 45_000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
};
let running = false;
try {
  assert.equal((await call(["--version"])).stdout.trim(), version);
  const help = await call(["--help"]);
  assert.match(help.stdout, /doctor/);
  const copies = [
    ["integrations/codex/skills/portmarshal/SKILL.md", ".agents/skills/portmarshal/SKILL.md"],
    ["integrations/claude-code/skills/portmarshal/SKILL.md", ".claude/skills/portmarshal/SKILL.md"],
    ["integrations/cursor/rules/portmarshal.mdc", ".cursor/rules/portmarshal.mdc"],
  ];
  for (const [source, destination] of copies) {
    const target = path.join(project, destination);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(packageDir, source), target);
    assert.equal(await fs.readFile(target, "utf8"), await fs.readFile(path.join(packageDir, source), "utf8"));
  }
  // Verify executable examples without assuming a particular framework dependency is installed.
  for (const args of [["doctor", "--json"], ["doctor", "--project", ".", "--json"]]) {
    const result = await call(args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).owner.source, "explicit");
  }
  await assert.rejects(fs.stat(stateDir), { code: "ENOENT" });
  const source = 'const s=require("http").createServer((q,r)=>r.end("healthy"));s.listen(Number(process.argv[1]),"127.0.0.1",()=>console.log("fixture ready"));';
  const started = await call(["run", "-d", "web", "--range", "24000-24999", "--ready-url", "/health",
    "--", process.execPath, "-e", source, "{port}"]);
  assert.equal(started.code, 0, started.stderr);
  running = true;
  const stateFile = path.join(stateDir, "registry.json");
  const before = await fs.readFile(stateFile, "utf8");
  const beforeStat = await fs.stat(stateFile);
  const records = JSON.parse(before);
  const port = records.find((record) => record.name === "web").port;
  const logs = await call(["logs", "web", "-n", "50"]);
  assert.match(logs.stdout, /fixture ready/);
  const listed = await call(["list", "--services", "--project", ".", "--json"]);
  assert.equal(listed.code, 0);
  assert.ok(JSON.parse(listed.stdout).services.some((service) => service.ports.includes(port)));
  const whois = await call(["whois", String(port), "--json"]);
  assert.equal(whois.code, 0);
  const doctor = await call(["doctor", "--project", ".", "--json"]);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).schemaVersion, 1);
  assert.equal(doctor.stdout.includes(owner), false);
  assert.equal(await fs.readFile(stateFile, "utf8"), before);
  assert.equal((await fs.stat(stateFile)).mode, beforeStat.mode);
  assert.equal((await fs.stat(stateFile)).mtimeMs, beforeStat.mtimeMs);
  for (const args of [["claim", "web"], ["release", "web"], ["stop", String(port)],
    ["run", "-d", "web", "--restart", "--", process.execPath, "-e", source, "{port}"]]) {
    assert.equal((await call(args, "package-verification-second-owner")).code, 3, args.join(" "));
  }
  assert.equal(await fs.readFile(stateFile, "utf8"), before);
  const preview = await call(["gc", "--dry-run"]);
  assert.equal(preview.code, 0);
  const stopped = await call(["stop", String(port)]);
  assert.equal(stopped.code, 0, stopped.stderr);
  running = false;
  console.log(JSON.stringify({
    version, node: process.versions.node, platform: process.platform,
    packageConsumer: "passed", adapterCopies: copies.length,
    ownerAcrossSeparateInvocations: "passed", crossOwnerGuard: "passed",
    readOnlyDoctor: "passed", lifecycle: "start-health-logs-inspect-stop",
    hostInstructionActivation: "not tested by this script",
  }, null, 2));
} finally {
  if (running) {
    const stopped = await call(["stop", "web"]);
    if (stopped.code !== 0 && stopped.code !== 2) {
      // Preserve recovery evidence instead of deleting state while a test process might still run.
      console.error("Test service cleanup requires review; temporary project retained at " + project);
      process.exitCode = 1;
    } else await fs.rm(project, { recursive: true, force: true });
  } else await fs.rm(project, { recursive: true, force: true });
}
