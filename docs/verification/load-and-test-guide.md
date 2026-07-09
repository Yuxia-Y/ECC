# 在其他目录载入 ECC 插件 + 测试

> 用途：把 `e:\workspace\my_working_team` 里的 plugin 装到一个**测试项目目录**，跑阶段 2 的 6 个验证场景。
>
> 适用：任何想验证多 agent 派发 / channel 协议 / 并行评审的场景。

---

## 0. 前置

- 知道 Claude Code 用户级 config 在 `~/.claude/`（Windows: `C:\Users\Administrator\.claude\`）
- 测试项目目录假设是 `D:\test-projects\demo`（**空目录**最好）
- 知道 plugin 源在 `e:\workspace\my_working_team`，marketplace 名 = `ecc`，plugin 名 = `ecc`

---

## 1. 三种载入方式（按推荐度排）

### 方式 A：本地 marketplace（推荐，开发期）

在测试项目目录里**开 Claude Code session**，执行：

```bash
# 1) 添本地 marketplace（指向 plugin 源）
/plugin marketplace add e:/workspace/my_working_team

# 2) 装 plugin
/plugin install ecc@ecc
```

优点：源文件改动自动生效（不需要重新装），方便边改边测。
缺点：依赖 `/plugin` slash command 可用。

### 方式 B：符号链接到 user plugins 目录

```bash
# Git Bash
ln -s /e/workspace/my_working_team ~/.claude/plugins/ecc

# PowerShell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\plugins\ecc" -Target "e:\workspace\my_working_team"
```

优点：不依赖 `/plugin` command；启动时自动加载。
缺点：不是所有 Claude Code 版本都自动扫 `~/.claude/plugins/`（需查版本行为）。

### 方式 C：直接拷贝

```bash
# Git Bash
cp -r /e/workspace/my_working_team ~/.claude/plugins/ecc
```

**PowerShell**（**不要**用 `cp -r /e/...`，PowerShell 会拼成 `E:\e\...` 找错路径）：

```powershell
Copy-Item -Path "e:\workspace\my_working_team" `
          -Destination "$env:USERPROFILE\.claude\plugins\ecc" `
          -Recurse -Force
```

验证拷贝成功：

```powershell
Get-ChildItem "$env:USERPROFILE\.claude\plugins\ecc" | Select-Object -First 5 Name
# 应看到 agents/, skills/, .claude-plugin/ 等
```

优点：最稳。
缺点：源文件改了要重新拷贝。

---

## 2. 验证装载成功

新开 Claude Code session（**在测试项目目录里**），跑：

```bash
/agents
```

应该看到 **18 个 agent**：

```
architect, build-error-resolver, code-explorer, code-reviewer, code-simplifier,
django-build-resolver, doc-updater, e2e-runner, java-build-resolver,
java-reviewer, planner, python-reviewer, react-build-resolver,
refactor-cleaner, security-reviewer, silent-failure-hunter, tdd-guide,
typescript-reviewer
```

如果只看到 4-5 个 built-in agent：装载失败。回头看方式选对没。

---

## 3. 跑 6 个验证场景

完整 checklist 在 `docs/verification/phase-2.md`。这里只给**最关键 3 个**（其他顺带跑）。

### 场景 3：Channel 私聊（最稳）

在 Claude Code 里说：

```
让 planner 拆解"加 SSO 登录"需求，planner 写完后我自己看 channel.jsonl
```

planner 跑完，**开一个新 Git Bash 终端**验证：

```bash
cd D:/test-projects/demo
cat .claude/chat/channel.jsonl
# 至少 1 行，JSON 格式正确，含 from/to/kind/msg/status:"pending"
```

### 场景 4：/multi-agent-chat 调度

接着场景 3 的状态，在 Claude Code 里：

```
/multi-agent-chat
```

主 agent 应该：
- 调 `node .claude/chat/tick.js analyze`
- 输出 buckets（dms 有 1 条）
- 派对应的 subagent 拿答案
- 调 `tick.js answer <ts> ...` 写回

验证：

```bash
cat .claude/chat/channel.jsonl
# 现在有 2 条：原 question + answer (带 in_reply_to)
# 原消息 status: "done"
```

### 场景 5：群发并行评审

```
给 src/auth/login.ts 这个文件同时跑 code-reviewer + security-reviewer
```

主 agent 应该**并行**发 2 个 Agent tool 调用，**不是**串行。报告合并展示。

### 其他场景（1A/1B/1C/2A/6）

按 `phase-2.md` 跑，不再赘述。

---

## 4. 跨平台路径注意

| 环境 | 路径写法 |
|------|---------|
| Git Bash | `/e/workspace/my_working_team` |
| PowerShell | `e:\workspace\my_working_team` |
| Claude Code slash command | 两种都接受，推荐 `/e/...` |

Windows 反斜杠 `\` 在 JSON 里要转义 `\\`，正斜杠 `/` 不需要。

---

## 5. 清理

测试完想完全卸载：

```bash
# 方式 A 的清理
/plugin uninstall ecc@ecc
/plugin marketplace remove ecc

# 方式 B/C 的清理
rm ~/.claude/plugins/ecc      # Git Bash
# 或
Remove-Item "$env:USERPROFILE\.claude\plugins\ecc" -Recurse -Force  # PowerShell
```

---

## 6. 已知坑

1. **`/plugin` command 不存在** → 用户级 Claude Code 太老或权限受限。换方式 B。
2. **18 个 agent 只看到一部分** → 装载未完成，`/exit` 重开 session 再试。
3. **channel.jsonl 出现但消息格式错** → 子 agent 跑了老版本，源文件改动后未生效。方式 A 不用重装，方式 C 要重 cp。
4. **并行评审变串行** → 主 agent 没用 `multi_agent` 并行模式触发。简化 prompt："**同时**跑 X + Y" 更稳。

---

## 7. 当前 repo 状态

- 源：`e:\workspace\my_working_team`
- Marketplace: `ecc`，Plugin: `ecc`，Version: `0.1.0`（**注**：跟根 `package.json` 的 `2.0.0` 不一致，pre-existing test failure，跟装载无关）
- 18 agent + channel 协议 + 6 验证场景全 ready
