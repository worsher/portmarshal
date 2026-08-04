# PortMarshal 的 Claude Code 集成

## 方式一：skill（推荐）

把 skill 复制到用户级 skills 目录，所有会话自动可用：

```bash
mkdir -p ~/.claude/skills/portmarshal
curl -fsSL https://raw.githubusercontent.com/worsher/portmarshal/main/integrations/claude-code/skills/portmarshal/SKILL.md \
  -o ~/.claude/skills/portmarshal/SKILL.md
```

Claude Code 会在涉及「启动 dev server / 端口冲突 / 找服务」时自动调用该 skill。PortMarshal 支持 macOS 与 Linux。

## 方式二：CLAUDE.md 约定（三行）

在全局或项目 CLAUDE.md 中追加：

```
- 用 `portmarshal run <服务名> --prefer <默认端口> -- <启动命令>` 启动 dev server；只在必须自行管理生命周期时才单独 `claim`
- 找服务/怀疑端口冲突时，用 `portmarshal list --project . --json` 看本项目、`portmarshal whois <端口>` 查归属
- 端口被占需要处置时用 `portmarshal stop <端口>`；退出码 3 表示归属无法安全确认或是别人的活跃服务，向用户展示归属并请示，不要 --force
```
