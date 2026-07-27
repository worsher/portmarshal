/** lsof -iTCP -sTCP:LISTEN -P -n -Fpcn 的机器格式样本 */
export const LSOF_FPCN = `p2755
cPython
n*:8901
p8660
cnode
n127.0.0.1:8000
n[::1]:8000
p31401
cCursor Helper (Plugin)
n127.0.0.1:63979
`;

/** ps -axo pid=,ppid=,comm= 样本：
 * 2755 为孤儿(ppid=1)；8660 父链 zsh(700)→Cursor(600)；31401 父链 →Cursor(600)；
 * 8123 父链 zsh(810)→Claude(800)；9123 父链 →Antigravity(900)；
 * 10123 父链 zsh(1010)→Terminal.app(1000)；11123 父链 →Docker(1100) */
export const PS_TABLE = `    1     0 /sbin/launchd
 2755     1 /opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python
  600     1 /Applications/Cursor.app/Contents/MacOS/Cursor
  700   600 /bin/zsh
 8660   700 /Users/worsher/.n/bin/node
31401   600 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)
  800     1 /Applications/Claude.app/Contents/MacOS/claude
  810   800 /bin/zsh
 8123   810 /usr/local/bin/node
  900     1 /Applications/Antigravity.app/Contents/MacOS/Antigravity
 9123   900 /usr/local/bin/node
 1000     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
 1010  1000 /bin/zsh
10123  1010 /usr/local/bin/python3
 1100     1 /Applications/Docker.app/Contents/MacOS/com.docker.backend
11123  1100 docker-proxy
12000     1 /Users/worsher/.openclaw/bin/openclaw-gateway
14000 12000 /usr/local/bin/node
13000     1 /Applications/Postman.app/Contents/MacOS/Postman
`;

/** launchctl list 样本：PID\tStatus\tLabel，"-" 表示未运行 */
export const LAUNCHCTL_LIST = `PID	Status	Label
-	0	com.apple.SafariHistoryServiceAgent
1513	0	com.apple.Finder
12000	0	com.openclaw.gateway
`;

/** ps -axo pid=,command= 全表样本（pid + 完整命令行） */
export const PS_COMMANDS = `    1 /sbin/launchd
 2755 python3 -m http.server 8901
 8660 /Users/worsher/.n/bin/node /Users/worsher/code/work/mu_frontend/node_modules/umi/bin/forkedDev.js
31401 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin) --type=extensionHost
`;

/** lsof -a -p p1,p2,... -d cwd -Fn 批量输出样本 */
export const LSOF_CWDS = `p2755
fcwd
n/private/tmp/site-platform/scratchpad
p8660
fcwd
n/Users/worsher/code/work/mu_frontend
`;

/** Linux: ss -tlnp 输出样本（含表头、IPv6、无权限缺 Process 列、SO_REUSEPORT 多 pid） */
export const SS_TLNP = `State    Recv-Q   Send-Q     Local Address:Port       Peer Address:Port   Process
LISTEN   0        511            127.0.0.1:8000            0.0.0.0:*       users:(("node",pid=1234,fd=20))
LISTEN   0        4096               [::1]:9000               [::]:*       users:(("python3",pid=2345,fd=3))
LISTEN   0        511              0.0.0.0:3000            0.0.0.0:*       users:(("node",pid=3456,fd=18),("node",pid=3457,fd=18))
LISTEN   0        4096             0.0.0.0:22               0.0.0.0:*
`;

/** Linux: /proc/<pid>/cgroup 样本 */
export const CGROUP_SYSTEMD_SERVICE = `0::/system.slice/openclaw-gateway.service
`;
export const CGROUP_USER_SERVICE = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/my-agent.service
`;
export const CGROUP_SESSION_SCOPE = `0::/user.slice/user-1000.slice/session-4.scope
`;

/** docker inspect 的精简样本：Compose 标签优先，普通 docker run 回退到 bind mount。 */
export const DOCKER_INSPECT = JSON.stringify([
  {
    Id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    Name: "/shop-web",
    Config: {
      Labels: {
        "com.docker.compose.project": "shop",
        "com.docker.compose.service": "web",
        "com.docker.compose.project.working_dir": "/Users/w/code/shop/docker",
      },
    },
    NetworkSettings: {
      Ports: {
        "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }],
        "3001/tcp": [
          { HostIp: "0.0.0.0", HostPort: "8080" },
          { HostIp: "::", HostPort: "8080" },
        ],
      },
    },
    Mounts: [],
  },
  {
    Id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    Name: "/api-dev",
    Config: { Labels: {} },
    NetworkSettings: {
      Ports: { "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "9090" }] },
    },
    Mounts: [
      { Type: "bind", Source: "/host_mnt/Users/w/code/api", Destination: "/app" },
    ],
  },
]);

/** pm2 jlist 的精简样本：包含运行中应用、停止应用，以及不得进入扫描结果的敏感 env。 */
export const PM2_JLIST = JSON.stringify([
  {
    pid: 15010,
    name: "api",
    pm_id: 2,
    pm2_env: {
      status: "online",
      pm_cwd: "/Users/w/code/api",
      pm_exec_path: "/Users/w/code/api/dist/server.js",
      SECRET_TOKEN: "must-not-leak",
    },
  },
  {
    pid: 0,
    name: "stopped-app",
    pm_id: 3,
    pm2_env: {
      status: "stopped",
      pm_cwd: "/Users/w/code/stopped",
      pm_exec_path: "/Users/w/code/stopped/server.js",
    },
  },
]);

/** ps eww -o pid=,command= 样本：命令行与环境变量以空格拼接（macOS 无法精确切分，只做白名单 key 搜索）
 * 2755 带 Claude Code agent 标记；60534 带 Cursor bundle id + vscode 终端标记；70001 无任何来源标记 */
export const PS_EWW_ENV = ` 2755 python3 -m http.server 8901 TERM=xterm-256color CLAUDECODE=1 CLAUDE_CODE_ENTRYPOINT=cli PATH=/usr/bin
60534 /Users/worsher/.n/bin/node tests/registry.test.ts __CFBundleIdentifier=com.todesktop.230313mzl4w4u92 TERM_PROGRAM=vscode VSCODE_GIT_ASKPASS_MAIN=/Applications/Cursor.app/Contents/Resources/app/extensions/git/dist/askpass-main.js
70001 ruby server.rb --port=3000 PATH=/usr/bin HOME=/Users/worsher
`;
