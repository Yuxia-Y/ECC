# ADR 0001: 多 Agent 通信使用 Channel + 调度 Skill 模式

- 状态: Accepted
- 日期: 2026-07-08
- 适用范围: MGTV fork of everything-claude-code (ecc 插件)

---

## 上下文

MGTV 工程团队的 multi-agent 协作 fork 基于 `affaan-m/everything-claude-code`, 内置 18 个 role-based sub-agent (planner / architect / engineer / reviewer / tester 等)。Fork 文档 (`MULTI-ROLE-AGENT.md` §1.1) 描述了"链式调度"模式, 即 subagent 输出 `NEXT_STEP: <role>` 标记, 主 agent 顺序派发。

**链式调度的局限**:

1. **串行而非并行**: 现实工作流里多个角色 (如多个 reviewer 审同一份代码) 应当**同时**工作, 链式调度做不到。
2. **subagent 之间无法通信**: planner 阶段常需要问 architect 技术细节, 链式调度要求 planner 一次性写完所有问题让 architect 一次性回, 真实场景是**多轮对话**。
3. **Claude Code 架构限制**: subagent 不能调 Agent tool 派生 sub-subagent, 所有派发必须由主 agent 完成。这意味着**纯 subagent-to-subagent 自调度不可行**。

**业务诉求**: 像真实工作群一样, agent 之间能互相问问题, 能广播公告, 能并行分工。

---

## 决策

采用 **Channel 文件 + 调度 Skill** 模式, 在不重写 Claude Code runtime 的前提下实现"工作群"语义。

### 1. 通信介质: `.claude/chat/channel.jsonl`

Append-only 日志文件, 每行一条 JSON 消息:

```json
{
  "ts": "2026-07-08T18:30:00Z",
  "from": "planner",
  "to": "*" | "agent-name" | ["a", "b", "c"],
  "kind": "info" | "task" | "question",
  "msg": "消息内容",
  "context": { "可选": "..." },
  "status": "pending" | "done",
  "in_reply_to": "2026-07-08T18:25:00Z"
}
```

### 2. `to` 字段三种取值

| 取值 | 语义 | 主 agent 行为 |
|------|------|--------------|
| `"*"` | 广播 | 通知所有相关 agent, 不要求回话 |
| `"agent-name"` | 私聊 | 派发该 agent, 拿到回答, 回写 channel |
| `["a", "b"]` | 群发 | 并行派发 a 和 b, 收集所有回答 |

### 3. `kind` 字段三种意图

| 取值 | 语义 | 适用场景 |
|------|------|---------|
| `"info"` | 信息通知 | "需求已拆解" — 所有人看到即可, 无需回话 |
| `"task"` | 任务派发 | "审这份代码" — 收件人必须给出 work product |
| `"question"` | 提问 | "REST vs GraphQL?" — 收件人必须给回答 |

### 4. 调度 Skill: `/multi-agent-chat`

主 agent 调起该 skill 后执行 `tick.py` (~100 行 Python):

```python
def tick():
    pending = read_channel_pending()
    if not pending: return "no_pending"

    for msg in pending:
        to = msg["to"]
        if to == "*":
            # 广播: 注入 context 到所有运行中 agent (不派生新 session)
            broadcast(msg)
        elif isinstance(to, list):
            # 群发: 并行派发, 收集回答
            parallel([invoke(a, msg) for a in to])
        else:
            # 私聊: 派发, 拿回答, 写回 channel
            answer = invoke(to, msg)
            append_channel(reply(to, msg["from"], answer))
```

### 5. 18 个 agent description 各加 2 句协议提示

不改 agent body 的核心 system prompt, 只在 frontmatter `description` 字段增加:

```
When blocked on another role's input, append a question to
.claude/chat/channel.jsonl (format: {from, to, kind, msg, status: pending})
and exit. Main agent will route the question and re-invoke you with the answer.
```

### 6. 半自调度的本质

- **subagent 不能派生 subagent** (Claude Code 限制)
- 所以"自调度"指 subagent **自描述**它的问题到 channel (append + 退出)
- 真正调度由**主 agent** 完成 (扫 channel + 派 target + 喂回 from)
- 一次"问-答"周期 = 3 次 Agent tool 调用 (主 agent 扫 + 派 target + 派回 from)

---

## 后果

### 正面

- **并行 work**: 多 reviewer 审同一份代码可并发, 减少总时长
- **多轮对话支持**: planner 问 architect 细节, 拿回答再继续, 不需要"两轮链式"的强约束
- **可审计**: channel.jsonl 是真实记录, 团队能复盘 agent 之间的所有交互
- **解耦**: subagent 不需要互相知道存在, 只通过 channel 通信
- **小改动**: 18 个 agent body 不动, 只改 description 加 2 句, 主 agent 加 1 个 skill

### 负面

- **token 成本**: 一次问-答 = 3 次 Agent 调用 + 1 次 channel 读写, 比直接链式 (~2 次) 多 50%
- **context 累积**: 每轮"问-答"都要喂前序状态给新 session, 长任务 token 增长快
- **延迟**: 多轮对话场景下, 每个问题要等主 agent 调度一轮
- **复杂度**: 主 agent 必须正确实现 tick.py 的三种 to 分支, bug 风险增加
- **不是真自调度**: 用户期望的"工作群"里所有人都能主动 @ 别人, 当前实现下只有"主 agent"能叫醒别人

### 中和措施

- 单问题场景下用方案 A (线性两轮链) 更省, channel 留给多问题并行场景
- channel.jsonl 加清理策略 (已完成 30 天的消息归档, 避免无限增长)
- tick.py 写完整测试 (3 个 to 形态 × 3 个 kind 组合 = 9 个 case)

---

## 备选方案

### 方案 A: 线性两轮链 (未选)

planner 一次性把所有问题列在输出里, architect 一次性回答所有。简单, 但不支持多轮追问。

### 方案 C: 等 Claude Code 原生支持 (未选)

affaan-m 在 ECC 里有 chief-of-staff agent 雏形, 但当前没有稳定 API。等会显著延后项目进度。

---

## 实施计划

| 阶段 | 任务 |
|------|------|
| 阶段 2 (Agent 精简) | 改 18 个 agent description, 加 channel 协议 2 句 |
| 阶段 4 (Skills) | 写 `/multi-agent-chat` skill + tick.py |
| 阶段 4 | 写 `.claude/chat/channel.jsonl` 初始化 + 读写 helper |
| 阶段 5 (Rules + Hooks) | 写 hook: 任何 agent 退出前确保 channel 没有未写消息 |
| 阶段 8 (验证) | E2E 测试: planner 问 architect, 验证 channel 完整往返 |

---

## 参考

- `MULTI-ROLE-AGENT.md` §1.1 链式调度 (本次决策的起点)
- `MULTI-ROLE-AGENT.md` §10.2 统一输出 schema (本设计的 kind 字段对应)
- Claude Code 官方文档 - Parallel tasks (主 agent 并行派发)
- Michael Nygard ADR 模板 (本文档结构)
