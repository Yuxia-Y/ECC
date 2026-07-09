# 阶段 2 验证清单（真实任务测试）

> 用途：在你的 Claude Code session 里跑下面 5 个场景，验证阶段 2 改动真的 work。
> 每个场景给出"输入 / 预期 / 检查点"。

---

## 准备

在你的 Claude Code session 里:

```bash
# 1. 确认 plugin 已装（阶段 1 已装好）
/agents
# 应看到 18 个 agent 列出

# 2. 确认 channel 文件不存在或为空
ls -la .claude/chat/channel.jsonl 2>&1
# 不存在 OK；存在就清空: > .claude/chat/channel.jsonl

# 3. 准备一个测试项目目录
cd /tmp/mgtv-test   # 或任何空目录
```

---

## 场景 1: Agent Description 触发（基础）

**目的**：验证主 agent 看 description 后正确派发，不误派。

### 1A. 大任务 → planner
**输入**: "用 planner agent 帮我设计一个用户登录功能的后端"
**预期**: 主 agent 派 `planner` agent（不是 code-explorer 或 architect）
**检查**:
- [ ] 看到主 agent 说"派 planner"或类似
- [ ] planner 输出含 Use when 要求的字段: tasks/dependencies/risks

### 1B. 单行修复 → 不派 planner
**输入**: "把 src/foo.py 第 42 行的 typo 改一下"
**预期**: 主 agent **不**派 planner（task < 3 files, trivial）。可能直接 Edit 或建议"你自己改"
**检查**:
- [ ] 主 agent 没派 planner/code-reviewer
- [ ] 主 agent 给出了简单的改法

### 1C. 文档更新 → doc-updater
**输入**: "我们的新模块需要更新 CODEMAP"
**预期**: 主 agent 派 `doc-updater`
**检查**:
- [ ] 看到主 agent 派 doc-updater
- [ ] doc-updater 输出含 `updated_files` 字段

---

## 场景 2: Don't Use When 重定向

**目的**: 验证 `Don't use when` 段真的引导主 agent 派正确的 agent。

### 2A. 小调查 → code-explorer 不是 planner
**输入**: "帮我查一下 src/auth/login.ts 这个文件怎么工作的"
**预期**: 主 agent 派 `code-explorer`（planner 的 Don't use when 说"purely investigative → code-explorer"）
**检查**:
- [ ] 看到主 agent 派 code-explorer（不是 planner）
- [ ] code-explorer 输出含 `execution_path` 或 `key_files`

---

## 场景 3: Channel 协议 — 私聊

**目的**: 验证 subagent 真的能 append 到 channel.jsonl

**输入** (在 Claude Code 里):
```
让 planner 拆解"加 SSO 登录"需求，planner 写完后我自己看 channel.jsonl
```

**预期**:
- planner 跑完，**写了 1 条 question 消息**到 `.claude/chat/channel.jsonl`
- 消息含 `from:"planner"`, `to:"architect"`（或类似）, `kind:"question"`

**检查**:
```bash
cat .claude/chat/channel.jsonl
```
- [ ] 文件存在，至少 1 行
- [ ] JSON 格式正确，含 `ts`/`from`/`to`/`kind`/`msg`/`status:"pending"`
- [ ] 不是 broadcast（不是 `to:"*"`）

---

## 场景 4: /multi-agent-chat 调度

**目的**: 验证主 agent 真的能 drain pending queue

**前置**: 场景 3 留下的 channel.jsonl 至少 1 条 pending question

**输入** (在 Claude Code 里):
```
/multi-agent-chat
```

**预期**:
- 主 agent 调用 `node .claude/chat/tick.js analyze`
- 输出 buckets: `dms:[{...}]`, `groups:[]`, `broadcasts:[]`
- 主 agent 派对应的 subagent (e.g. architect)
- 拿到回答后调用 `tick.js answer <ts> ...`
- 原消息 `status: pending → done`
- channel.jsonl 多了 1 条 in_reply_to 消息

**检查**:
```bash
cat .claude/chat/channel.jsonl
```
- [ ] 有 2 条消息：原 question + answer（`in_reply_to` 引用原 ts）
- [ ] 原消息 `status: "done"`
- [ ] answer 消息 `kind` 是 "info" 或 "question"（不是 task）

---

## 场景 5: 群发（并行评审）

**目的**: 验证多角色并行派发

**输入** (在 Claude Code 里):
```
给 src/auth/login.ts 这个文件同时跑 code-reviewer + security-reviewer
```

**预期**:
- 主 agent **并行**派发 2 个 agent（不是串行）
- 2 个 reviewer 都给 findings
- 报告合并展示

**检查**:
- [ ] 看到 2 个 Agent tool 调用**同时**发出
- [ ] 报告含 2 个 reviewer 的 findings
- [ ] 不像串行（"先 X 后 Y"那种）

---

## 场景 6: Broadcast（弱保证）

**目的**: 验证 broadcast 写入 OK；注入是 best-effort

**输入** (在 Claude Code 里):
```
让 planner 广播一条 "需求拆解完成" 给所有 agent
```

**预期**:
- planner 写了 1 条 `to:"*"`, `kind:"info"` 消息
- 主 agent **可能**会提示"已广播给相关 agent"——不强求每个 agent 都收到

**检查**:
```bash
cat .claude/chat/channel.jsonl | grep '"to":"\*"'
```
- [ ] 有 broadcast 消息
- [ ] 主 agent 给出了 best-effort 的反馈（不强求每个 agent 注入）

---

## 收尾

跑完 5-6 个场景后, 把结果填到下面:

| 场景 | 通过 | 失败原因 |
|------|------|---------|
| 1A planner 派发 | ☐ | |
| 1B 小任务不派 planner | ☐ | |
| 1C doc-updater 派发 | ☐ | |
| 2A code-explorer 重定向 | ☐ | |
| 3 channel 私聊 append | ☐ | |
| 4 /multi-agent-chat 调度 | ☐ | |
| 5 群发并行评审 | ☐ | |
| 6 broadcast 弱保证 | ☐ | |

**全部通过** → 阶段 2 收尾, 进入阶段 3 (MCP) 或 4 (skills 精简)
**部分失败** → 哪个失败告诉我, 我看 description 措辞要不要调
**新发现的问题** → 直接说, 不在 checklist 里也行

---

## 已知限制

1. **Broadcast 注入是 best-effort** — 主 agent 看到 broadcast 后**自己决定**要不要注入所有 agent context, 不保证 100% 注入 (channel 派发层是 stub)
2. **/multi-agent-chat 触发靠 description 匹配** — 用户必须显式调用或主 agent 看到 pending 数量 > 0 时自动调
3. **Channel 文件不会自动清理** — 30 天前的 done 消息需手动 archive (用 `archive-channel.js`)
4. **没有 CI 强制 description 5 段** — 18 个 agent 当前都过, 后续加新 agent 时要手动保证
