import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLsofListeners, parsePsTable, traceSource,
  inferProjectFromCommand, isNoise, parseLaunchctlList, parsePsCommands, parseLsofCwds,
  parseSsListeners, parseCgroupServiceUnit,
  collectGroupAncestors,
  parseDockerInspect, parsePm2Jlist, scanListeners, resolveProjectDir, displaySource,
  originFromEnv, parseMacEnvOrigins, parseEnvironOrigin,
} from "../src/scan.js";
import type { Exec } from "../src/exec.js";
import { LSOF_FPCN, PS_TABLE, LAUNCHCTL_LIST, PS_COMMANDS, LSOF_CWDS, SS_TLNP, CGROUP_SYSTEMD_SERVICE, CGROUP_USER_SERVICE, CGROUP_SESSION_SCOPE, DOCKER_INSPECT, PM2_JLIST, PS_EWW_ENV } from "./fixtures.js";

test("parseLsofListeners 解析机器格式并处理 IPv6", () => {
  const entries = parseLsofListeners(LSOF_FPCN);
  assert.deepEqual(entries, [
    { pid: 2755, port: 8901, address: "*" },
    { pid: 8660, port: 8000, address: "127.0.0.1" },
    { pid: 8660, port: 8000, address: "[::1]" },
    { pid: 31401, port: 63979, address: "127.0.0.1" },
  ]);
});

test("parsePsTable 建立 pid→行 映射", () => {
  const table = parsePsTable(PS_TABLE);
  assert.equal(table.get(8660)?.ppid, 700);
  assert.equal(table.get(2755)?.comm.endsWith("Python"), true);
});

test("collectGroupAncestors 只保留同 PGID wrapper 父链并脱敏命令", () => {
  const table = parsePsTable(`100 1 100 npm\n101 100 100 node\n50 1 50 claude\n`);
  const commands = parsePsCommands(`100 npm run dev --token secret\n101 node vite\n50 claude\n`);
  assert.deepEqual(collectGroupAncestors(101, table, commands), [{
    pid: 100,
    ppid: 1,
    pgid: 100,
    procName: "npm",
    command: "npm run dev --token [REDACTED]",
  }]);
  assert.deepEqual(collectGroupAncestors(50, table, commands), []);
});

test("traceSource 识别 cursor / detached / 未知", () => {
  const table = parsePsTable(PS_TABLE);
  assert.equal(traceSource(8660, table), "cursor");   // node→zsh→Cursor
  assert.equal(traceSource(2755, table), "detached");   // ppid=1 且无匹配
  assert.equal(traceSource(99999, table), "?");       // 不在表中
});

test("traceSource 识别 claude-code / antigravity / docker", () => {
  const table = parsePsTable(PS_TABLE);
  assert.equal(traceSource(8123, table), "claude-code");  // node→zsh→claude
  assert.equal(traceSource(9123, table), "antigravity");  // node→Antigravity
  assert.equal(traceSource(11123, table), "docker");      // docker-proxy
});

test("traceSource 识别 PM2 daemon 的子进程", () => {
  const table = parsePsTable(`1 0 /sbin/launchd
15000 1 PM2 v7.0.3: God Daemon
15010 15000 /usr/local/bin/node
15020 15010 /usr/local/bin/node
`);
  assert.equal(traceSource(15010, table), "pm2");
  assert.equal(traceSource(15020, table), "pm2");
  assert.equal(
    traceSource(15020, table, new Map([[15020, "systemd:pm2-user.service"]])),
    "pm2",
  );
});

test("traceSource 识别 macOS 自带 Terminal.app", () => {
  const table = parsePsTable(PS_TABLE);
  // python3→zsh→Terminal（comm basename 恰为 "Terminal"）
  assert.equal(traceSource(10123, table), "terminal");
});

test("inferProjectFromCommand 从命令行提取项目路径", () => {
  assert.equal(
    inferProjectFromCommand("/Users/w/.n/bin/node /Users/w/code/work/mu_frontend/node_modules/umi/bin/forkedDev.js"),
    "/Users/w/code/work/mu_frontend",
  );
  assert.equal(inferProjectFromCommand("python3 -m http.server 8901"), null);
});

test("isNoise 过滤 IDE 内部进程", () => {
  assert.equal(isNoise("Cursor Helper (Plugin)"), true);
  assert.equal(isNoise("language_server_macos_arm"), true);
  assert.equal(isNoise("node"), false);
  assert.equal(isNoise("Python"), false);
});

test("isNoise 覆盖更多噪声模式与正常进程", () => {
  assert.equal(isNoise("AnyDesk"), true);
  assert.equal(isNoise("rapportd"), true);
  assert.equal(isNoise("aTrustAgent"), true);
  assert.equal(isNoise("ControlCenter"), true);
  assert.equal(isNoise("Python"), false);
  assert.equal(isNoise("vite"), false);
});

const fakeExec: Exec = async (cmd, args) => {
  if (cmd === "lsof" && args.includes("-Fpcn")) return LSOF_FPCN;
  if (cmd === "ps" && args.includes("pid=,ppid=,pgid=,comm=")) return PS_TABLE;
  if (cmd === "ps" && args.includes("pid=,command=")) return PS_COMMANDS;
  if (cmd === "launchctl") return LAUNCHCTL_LIST;
  if (cmd === "lsof" && args.includes("cwd")) {
    // 批量调用：-p 后应是逗号分隔的全部 pid
    const pids = args[args.indexOf("-p") + 1];
    if (pids.includes(",")) return LSOF_CWDS;
    return "";
  }
  return "";
};

test("scanListeners 组装 ProcessInfo：去重端口、归属 cwd、来源", async () => {
  // fixture 是 lsof/launchctl 数据，显式指定 darwin 链路（避免依赖测试机平台）
  const infos = await scanListeners(fakeExec, "darwin");
  const byPid = new Map(infos.map((p) => [p.pid, p]));
  const py = byPid.get(2755)!;
  assert.deepEqual(py.ports, [8901]);
  assert.equal(py.cwd, "/private/tmp/site-platform/scratchpad");
  assert.equal(py.source, "detached");
  const umi = byPid.get(8660)!;
  assert.deepEqual(umi.ports, [8000]); // IPv4+IPv6 去重
  assert.equal(umi.source, "cursor");
  assert.equal(umi.inferredProject, "/Users/worsher/code/work/mu_frontend");
  assert.equal(umi.ppid, 700);
});

test("resolveProjectDir 优先 cwd，cwd 为根目录时用 inferredProject", () => {
  const base = { pid: 1, ports: [1], procName: "node", command: "", source: "?" };
  assert.equal(
    resolveProjectDir({ ...base, cwd: "/a/b", inferredProject: null }),
    "/a/b",
  );
  assert.equal(
    resolveProjectDir({ ...base, cwd: "/", inferredProject: "/x/y" }),
    "/x/y",
  );
  assert.equal(
    resolveProjectDir({
      ...base,
      cwd: "/Users/w/Library/Containers/com.docker.docker/Data",
      inferredProject: null,
      docker: {
        containerId: "abc",
        containerName: "web",
        composeProject: "shop",
        composeService: "web",
        projectDir: "/Users/w/code/shop/docker",
      },
    }),
    "/Users/w/code/shop/docker",
  );
});

test("parseDockerInspect 解析端口、Compose 目录和 bind mount 目录", () => {
  const owners = parseDockerInspect(DOCKER_INSPECT);
  assert.deepEqual(owners, [
    {
      containerId: "a".repeat(64),
      containerName: "shop-web",
      composeProject: "shop",
      composeService: "web",
      projectDir: "/Users/w/code/shop/docker",
      hostPorts: [3000, 8080],
    },
    {
      containerId: "b".repeat(64),
      containerName: "api-dev",
      composeProject: null,
      composeService: null,
      projectDir: "/Users/w/code/api",
      hostPorts: [9090],
    },
  ]);
  assert.deepEqual(parseDockerInspect("not json"), []);
});

test("scanListeners 将共享 Docker 后端 PID 按容器端口拆分并归属项目", async () => {
  const dockerExec: Exec = async (cmd, args) => {
    if (cmd === "lsof" && args.includes("-Fpcn")) {
      return "p777\nccom.docker.backend\nn*:3000\nn*:8080\nn*:9090\n";
    }
    if (cmd === "lsof" && args.includes("cwd")) {
      return "p777\nfcwd\nn/Users/w/Library/Containers/com.docker.docker/Data\n";
    }
    if (cmd === "ps" && args.includes("pid=,ppid=,pgid=,comm=")) {
      return "777 1 /Applications/Docker.app/Contents/MacOS/com.docker.backend\n";
    }
    if (cmd === "ps" && args.includes("pid=,command=")) {
      return "777 /Applications/Docker.app/Contents/MacOS/com.docker.backend services\n";
    }
    if (cmd === "docker" && args[0] === "ps") return `${"a".repeat(64)}\n${"b".repeat(64)}\n`;
    if (cmd === "docker" && args[0] === "inspect") return DOCKER_INSPECT;
    return "";
  };

  const infos = await scanListeners(dockerExec, "darwin");
  assert.equal(infos.length, 2);
  assert.deepEqual(infos[0].ports, [3000, 8080]);
  assert.equal(infos[0].docker?.containerName, "shop-web");
  assert.equal(displaySource(infos[0]), "docker:shop/web");
  assert.equal(resolveProjectDir(infos[0]), "/Users/w/code/shop/docker");
  assert.deepEqual(infos[1].ports, [9090]);
  assert.equal(infos[1].docker?.containerName, "api-dev");
  assert.equal(resolveProjectDir(infos[1]), "/Users/w/code/api");
});

test("parsePm2Jlist 只保留运行中应用的安全归属字段", () => {
  const owners = parsePm2Jlist(PM2_JLIST);
  assert.deepEqual(owners, [{
    pid: 15010,
    pmId: 2,
    name: "api",
    status: "online",
    projectDir: "/Users/w/code/api",
    script: "/Users/w/code/api/dist/server.js",
  }]);
  assert.equal(JSON.stringify(owners).includes("must-not-leak"), false);
  assert.deepEqual(parsePm2Jlist("not json"), []);
});

test("scanListeners 将 PM2 后代监听进程归属到应用名和 pm_cwd", async () => {
  let pm2Calls = 0;
  const pm2Exec: Exec = async (cmd, args) => {
    if (cmd === "lsof" && args.includes("-Fpcn")) return "p15020\ncnode\nn127.0.0.1:3100\n";
    if (cmd === "lsof" && args.includes("cwd")) return "p15020\nfcwd\nn/\n";
    if (cmd === "ps" && args.includes("pid=,ppid=,pgid=,comm=")) {
      return "1 0 /sbin/launchd\n15000 1 PM2 v7.0.3: God Daemon\n15010 15000 /usr/local/bin/node\n15020 15010 /usr/local/bin/node\n";
    }
    if (cmd === "ps" && args.includes("pid=,command=")) return "15020 node worker.js\n";
    if (cmd === "pm2") {
      pm2Calls++;
      assert.deepEqual(args, ["jlist"]);
      return PM2_JLIST;
    }
    return "";
  };

  const infos = await scanListeners(pm2Exec, "darwin");
  assert.equal(infos.length, 1);
  assert.equal(pm2Calls, 1);
  assert.equal(infos[0].source, "pm2");
  assert.equal(infos[0].pm2?.name, "api");
  assert.equal(infos[0].pm2?.pmId, 2);
  assert.equal(displaySource(infos[0]), "pm2:api");
  assert.equal(resolveProjectDir(infos[0]), "/Users/w/code/api");
});

test("parseLaunchctlList 提取受管服务 pid→label 映射", () => {
  const services = parseLaunchctlList(LAUNCHCTL_LIST);
  assert.equal(services.get(1513), "com.apple.Finder");
  assert.equal(services.get(12000), "com.openclaw.gateway");
  assert.equal(services.size, 2); // "-" 行不计
});

test("traceSource 三层判定：launchd 受管 / .app 兜底 / detached", () => {
  const table = parsePsTable(PS_TABLE);
  const launchd = new Map([[12000, "launchd:com.openclaw.gateway"]]);
  // launchd 受管服务（OpenClaw gateway 场景）——带出注册 label
  assert.equal(traceSource(12000, table, launchd), "launchd:com.openclaw.gateway");
  // 其子进程沿链归属到受管链根
  assert.equal(traceSource(14000, table, launchd), "launchd:com.openclaw.gateway");
  // 不受管但链根在 .app bundle 内（双 fork 自愿 daemon 化）
  assert.equal(traceSource(13000, table, launchd), "app");
  // 脱离会话：不受管、非 .app（原有 2755 Python）
  assert.equal(traceSource(2755, table, launchd), "detached");
  // 不传 launchd 集合时向后兼容——但 .app 兜底仍生效
  assert.equal(traceSource(2755, table), "detached");
});

test("parsePsCommands 建立 pid→完整命令行 映射", () => {
  const cmds = parsePsCommands(PS_COMMANDS);
  assert.equal(cmds.get(2755), "python3 -m http.server 8901");
  assert.equal(cmds.get(8660)?.includes("umi/bin/forkedDev.js"), true);
  assert.equal(cmds.get(31401)?.includes("--type=extensionHost"), true);
});

test("parseLsofCwds 解析批量 cwd 输出", () => {
  const cwds = parseLsofCwds(LSOF_CWDS);
  assert.equal(cwds.get(2755), "/private/tmp/site-platform/scratchpad");
  assert.equal(cwds.get(8660), "/Users/worsher/code/work/mu_frontend");
  assert.equal(cwds.has(31401), false); // 批量输出中缺失的 pid（如已退出）
});

test("parseSsListeners 解析 ss -tlnp：IPv6/多 pid 共享/无权限行", () => {
  const entries = parseSsListeners(SS_TLNP);
  assert.deepEqual(entries, [
    { pid: 1234, port: 8000, address: "127.0.0.1" },
    { pid: 2345, port: 9000, address: "[::1]" },
    { pid: 3456, port: 3000, address: "0.0.0.0" },
    { pid: 3457, port: 3000, address: "0.0.0.0" },
    // 22 端口无 Process 列（无权限）→ 无法归属，跳过
  ]);
});

test("parseCgroupServiceUnit 识别 systemd 服务与会话进程", () => {
  // 系统服务
  assert.equal(parseCgroupServiceUnit(CGROUP_SYSTEMD_SERVICE), "openclaw-gateway.service");
  // 用户级服务（user@1000.service 出现在中间不算，取末段）
  assert.equal(parseCgroupServiceUnit(CGROUP_USER_SERVICE), "my-agent.service");
  // 登录会话的普通进程（.scope 结尾）→ 非受管服务
  assert.equal(parseCgroupServiceUnit(CGROUP_SESSION_SCOPE), null);
});

test("traceSource 在 Linux 下用 systemd 标签替代孤儿判定", () => {
  const table = parsePsTable(PS_TABLE);
  const managed = new Map([[12000, "systemd:openclaw-gateway.service"]]);
  assert.equal(traceSource(12000, table, managed), "systemd:openclaw-gateway.service");
  assert.equal(traceSource(14000, table, managed), "systemd:openclaw-gateway.service"); // 子进程沿链归属
});

test("traceSource 使用生产态 cgroup 映射识别 systemd 子进程", () => {
  const table = parsePsTable(PS_TABLE);
  // linuxServiceLabels() 按监听 pid 建图；监听者是服务子进程时，标签不在 ppid=1 的链根上。
  const managed = new Map([[14000, "systemd:openclaw-gateway.service"]]);
  assert.equal(traceSource(14000, table, managed), "systemd:openclaw-gateway.service");
});

test("originFromEnv 按 agent > IDE > 终端 优先级识别启动者", () => {
  const env = (pairs: Record<string, string>) => (k: string) => pairs[k];
  // agent 标记优先于 IDE/终端标记
  assert.equal(originFromEnv(env({ CLAUDECODE: "1", TERM_PROGRAM: "vscode" })), "claude-code");
  assert.equal(originFromEnv(env({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" })), "claude-code");
  assert.equal(originFromEnv(env({ __CFBundleIdentifier: "com.anthropic.claudefordesktop" })), "claude-code");
  // Cursor 的 to-desktop bundle id 优先于 TERM_PROGRAM=vscode（Cursor 内置终端两者都带）
  assert.equal(originFromEnv(env({ __CFBundleIdentifier: "com.todesktop.230313mzl4w4u92", TERM_PROGRAM: "vscode" })), "cursor");
  assert.equal(originFromEnv(env({ __CFBundleIdentifier: "com.google.antigravity" })), "antigravity");
  // bundle id 缺失时用 askpass 路径兜底识别 VS Code 系分支
  assert.equal(originFromEnv(env({ VSCODE_GIT_ASKPASS_MAIN: "/Applications/Cursor.app/x/askpass-main.js", TERM_PROGRAM: "vscode" })), "cursor");
  assert.equal(originFromEnv(env({ TERM_PROGRAM: "vscode" })), "vscode/electron");
  assert.equal(originFromEnv(env({ TERM_PROGRAM: "iTerm.app" })), "terminal");
  assert.equal(originFromEnv(env({ SSH_CONNECTION: "1.2.3.4 50022 5.6.7.8 22" })), "ssh");
  assert.equal(originFromEnv(env({ PATH: "/usr/bin" })), null);
});

test("originFromEnv: PORTMARSHAL_SERVICE 优先级最高", () => {
  const env = new Map([
    ["PORTMARSHAL_SERVICE", "web"],
    ["CLAUDECODE", "1"],
    ["TERM_PROGRAM", "iTerm.app"],
  ]);
  assert.equal(originFromEnv((k) => env.get(k)), "run:web");
});

test("parseMacEnvOrigins 从 ps eww 合并输出按 pid 提取来源", () => {
  const m = parseMacEnvOrigins(PS_EWW_ENV);
  assert.equal(m.get(2755), "claude-code");
  assert.equal(m.get(60534), "cursor");
  assert.equal(m.has(70001), false); // 无标记的不产生条目
});

test("parseEnvironOrigin 解析 NUL 分隔的 /proc environ", () => {
  assert.equal(parseEnvironOrigin("PATH=/usr/bin\0CLAUDECODE=1\0TERM=xterm"), "claude-code");
  assert.equal(parseEnvironOrigin("PATH=/usr/bin\0HOME=/root"), null);
});

test("scanListeners 为 detached 进程补充 env 溯源 origin", async () => {
  const fakeExecWithEnv: Exec = async (cmd, args) => {
    if (cmd === "ps" && args.includes("eww")) {
      // env 查询只针对 detached 的 pid，且一次批量
      assert.equal(args[args.indexOf("-p") + 1], "2755");
      return PS_EWW_ENV;
    }
    return fakeExec(cmd, args);
  };
  const infos = await scanListeners(fakeExecWithEnv, "darwin");
  const byPid = new Map(infos.map((p) => [p.pid, p]));
  assert.equal(byPid.get(2755)!.origin, "claude-code");
  assert.equal(byPid.get(8660)!.origin, undefined); // 非 detached 不查也不标
});

test("displaySource 渲染 detached 的溯源标签", () => {
  const base = {
    pid: 1, ports: [1], procName: "node", command: "",
    cwd: null, inferredProject: null, source: "detached",
  };
  assert.equal(displaySource({ ...base, origin: "claude-code" }), "detached (claude-code)");
  assert.equal(displaySource(base), "detached");
});

test("displaySource: run: 前缀的 detached 直接显示 run:<name>", () => {
  const p = {
    pid: 1, ports: [3000], procName: "node", command: "node server.js",
    cwd: "/tmp/p", inferredProject: null, source: "detached", origin: "run:web",
  };
  assert.equal(displaySource(p as never), "run:web");
});
