# Claude Code 集成

从与 CLI 同版本的 npm 包中，把本目录的 `skills/portmarshal/SKILL.md` 复制到目标项目的
`.claude/skills/portmarshal/SKILL.md`。已有同名 skill 时先检查并合并，不直接覆盖。
skill 可单独使用。新开会话并显式调用 `/portmarshal`，确认宿主实际加载；文件存在不代表已生效。
也可选择用户级 `~/.claude/skills/portmarshal/SKILL.md`，参见
[Claude Code 官方文档](https://code.claude.com/docs/en/skills)。

如果更适合使用项目约定，把以下内容合并到 `CLAUDE.md`：

```text
本地开发服务首次使用前运行 portmarshal --version 与 portmarshal doctor --project . --json，检查 status 和 complete。
需要后台服务时用 portmarshal run -d <name> --prefer <port> -- <command>，框架不读取 PORT 时使用 {port} 参数。
保留已有 PORTMARSHAL_OWNER，每次工具调用都传递同一值；不要每条命令生成新 owner。
用 list --services --project . --json、whois <实际端口> --json、logs <name> 诊断。
停止用户指定的服务时用 portmarshal stop；退出码 3 先查原因，不自动 --restart、换 owner 或 --force。
清理预览用 portmarshal gc --dry-run；普通 gc 会释放旧 claim，release 不会停止服务。
```

此模板使用已有显式 owner，缺失时如实退回项目级归属。官方 skill 内容支持 `${CLAUDE_SESSION_ID}`
替换，但这不等于 shell 中存在同名环境变量；本版不自动注入该桥接或安装会话 hook。
不同 shell 工具调用不一定共享 `export`。如果宿主提供稳定身份，应在每次调用的环境中传递同一值，
不要把所有会话共享的固定值写入仓库，也不要输出原始身份。

在临时项目中验证 skill 的后台启动、`/health` readiness、日志、查询及 guarded stop 示例。
用两次独立 shell 调用运行 doctor，确认 owner 来源一致；未配置 owner 时应显示 `none` 和对应警告。
参见[共享工作流](../README.md)。
