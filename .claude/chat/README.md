# `.claude/chat/` — 多 Agent 通信通道

按 [ADR-0001](../../docs/adr/0001-multi-agent-channel-protocol.md) 实现的 sub-agent 间通信层。

## 文件清单

| 文件 | 角色 |
|------|------|
| `channel.jsonl` | Append-only 消息日志（由 helper 懒加载，首次 append 时创建） |
| `channel.js` | Node.js 读写 helper（`append` / `readPending` / `markDone` / `reply`） |
| `tick.js` | 调度分析器（由 `skills/multi-agent-chat` 调用：analyze / answer） |
| `check-channel.js` | 退出前自检脚本（检查 pending 中是否有 stale 消息） |
| `../../skills/multi-agent-chat/SKILL.md` | Skill 定义（生成式 orchestrator） |
| `../../.claude/rules/multi-agent-chat.md` | Rule 文件（所有 agent 自动加载） |

## 退出前自检（check-channel.js）

agent 在退出前可调用 `node .claude/chat/check-channel.js` 检查 channel：

- `verdict=clean` — 无 pending，正常退出
- `verdict=fresh-pending` — 有新消息但未超时，主 agent 可能尚未 tick
- `verdict=stale-pending` — 有超时 pending，应在最终总结中向用户提示

参数：
- `--stale-ms <ms>`：stale 阈值（默认 60000ms）
- `--strict`：非 clean 时 exit 1（CI/hook 用）
- `--json`：机器可读 JSON 输出

## 可选：注册为 Stop Hook

`hooks/hooks.json` 已包含 ECC 项目定制的复杂 bootstrap 链，**默认不修改**。如需注册 `check-channel.js` 为 Stop hook，可在 `Stop` 数组末尾追加：

```json
{
  "matcher": "*",
  "hooks": [
    {
      "type": "command",
      "command": "node .claude/chat/check-channel.js --stale-ms 120000",
      "timeout": 5
    }
  ],
  "description": "Warn if any channel messages remain pending for >2min at session end",
  "id": "stop:channel-check"
}
```

注意：默认 `exit 0`（非阻塞，仅 stderr 警告）。如要阻塞，改用 `--strict`。

## 消息 Schema

每行一个 JSON 对象，字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ts` | ISO-8601 UTC 字符串 | 自动 | 写入时间，由 helper 生成 |
| `from` | string | 是 | 发送方 agent 名（如 `planner`） |
| `to` | string \| string[] | 是 | `"*"` 广播 / `"agent-name"` 私聊 / `["a","b"]` 群发 |
| `kind` | `"info"` \| `"task"` \| `"question"` | 是 | 意图 |
| `msg` | string | 是 | 消息正文 |
| `context` | object | 否 | 任意附加上下文（不参与路由） |
| `status` | `"pending"` \| `"done"` | 自动 | 由 helper 管理 |
| `in_reply_to` | ISO-8601 字符串 | 否 | 回信时引用原消息的 ts |

## 调度流程（高层）

主 agent 调用 `/multi-agent-chat` skill 后，按 tick.js 的 `analyze` 输出三类 bucket：

- `broadcasts`（`to === "*"`）→ 注入 context 到所有运行中 agent，不派生 session
- `groups`（`to === ["a","b"]`）→ 并行 Agent tool 派发，收集所有答案
- `dms`（`to === "agent-name"`）→ 单个 Agent tool 派发，拿回答

每收到一个答案，调 `tick.js answer <origTs> <from> <to> <kind> <msg>` 闭环：
1. reply() 写一条 `in_reply_to=<origTs>` 的新消息
2. markDone() 关闭原消息

详见 `../../skills/multi-agent-chat/SKILL.md`。

## 使用方式（伪代码）

```js
const channel = require('./channel');

// 可选：覆盖路径（测试/CI 用，运行时一般不设）
// process.env.ECC_CHANNEL_PATH = '/tmp/my-channel.jsonl';

// subagent 写一条问题
const ts = channel.append({
  from: 'planner',
  to: 'architect',
  kind: 'question',
  msg: 'REST vs GraphQL？'
});

// 主 agent 调度
const pending = channel.readPending();
// ... 处理 pending ...

// 收到答案后写回
channel.reply({
  from: 'architect',
  to: 'planner',
  in_reply_to: ts,
  msg: 'REST 更合适',
  kind: 'info'
});

// 标记完成
channel.markDone(ts);

// 查询当前路径
console.log(channel.getChannelPath());
console.log(channel.DEFAULT_CHANNEL_PATH); // 默认 .claude/chat/channel.jsonl
```

## 维护约定

- **Append-only**：禁止改写历史行；只能新增或通过 `markDone` 更新 `status`。
- **归档策略**：已完成 30 天的消息可由 `scripts/ci/archive-channel.js` 归档到 `archive/channel-YYYY-MM.jsonl`。
- **不要提交敏感数据**：channel 是审计日志，所有内容默认公开。
