---
name: multi-agent-chat
description: Drain the .claude/chat/channel.jsonl pending queue by routing broadcasts, group
  messages, and direct messages to the right subagents. Use when an agent (or the user) wants
  to advance a multi-agent workflow that has stalled because one role is waiting on another.
  Generative orchestrator — the skill emits routing instructions; the main agent performs
  the actual Agent tool invocations.
metadata:
  origin: ECC
---

# Multi-Agent Chat (ADR-0001 Channel Tick)

A "work group" pattern for ECC subagents. Subagents write questions/tasks to `.claude/chat/channel.jsonl` when they need another role; the main agent calls this skill to **drain the queue**, **route** each message by `to` field, and **write back** the answers.

This is the orchestrator the MGTV fork added because the built-in `NEXT_STEP` chain cannot express parallel reviews or multi-turn Q&A. See `docs/adr/0001-multi-agent-channel-protocol.md`.

## When to Use

- A subagent's last message was "asking" another role (e.g., `planner` asked `architect` about REST vs GraphQL).
- The user wants to fire off parallel reviewers (`code-reviewer` + `security-reviewer`) on one PR.
- A long-running workflow has pending messages in `channel.jsonl` and you want to advance it.
- The user says "tick the channel", "drain pending messages", "advance the agent queue".

Skip when:

- The work is a single ad-hoc step — call the target agent directly with the Agent tool.
- No pending messages — `analyze` returns zero and there is nothing to do.
- The workflow is a pure linear chain — the original `NEXT_STEP` mechanism is cheaper (one fewer hop).

## Inputs

```
/multi-agent-chat [analyze | drain]
```

- `analyze` (default) — read `.claude/chat/channel.jsonl`, classify pending messages by `to` field, print a routing plan. Main agent then dispatches per the plan.
- `drain` — same as `analyze`, but also emit ready-to-execute Agent-tool call snippets for each pending message.

No CLI arguments beyond the subcommand. State lives entirely in `.claude/chat/channel.jsonl`.

## How It Works

The skill runs the script `.claude/chat/tick.js` (Node.js, ~120 lines). The script is a **dispatch analyzer**, not an autonomous scheduler — subagents cannot spawn subagents in Claude Code, so the actual `Agent` tool invocations must come from the main agent.

### Step 1 — Read pending

```bash
node .claude/chat/tick.js analyze
```

Output is JSON:

```json
{
  "summary": { "broadcasts": 1, "groups": 1, "dms": 2, "total": 4 },
  "buckets": {
    "broadcasts": [ /* messages with to === "*" */ ],
    "groups":     [ /* messages with to === ["a","b"] */ ],
    "dms":        [ /* messages with to === "<agent-name>" */ ]
  }
}
```

### Step 2 — Route by `to` field

| `to` value | Main agent action |
|------------|------------------|
| `"*"` | **Broadcast** — inject the message into all currently running agents' context. Do **not** spawn new sessions. Mark the message `done` via `tick.js answer` with `kind=info` once acknowledged. |
| `["a","b",...]` | **Group** — call `Agent` tool once per recipient in **parallel** with the same prompt. Collect all answers, then write each answer back via `tick.js answer`. |
| `"agent-name"` | **Direct message** — call `Agent` tool with the named subagent. Capture the response, then write it back via `tick.js answer`. |

### Step 3 — Write back answers

For each (origTs, from, answer_text) triple produced by Step 2:

```bash
node .claude/chat/tick.js answer <origTs> <from> <originalFrom> <kind> <answerText>
```

This:

1. Appends a new message with `in_reply_to=<origTs>`.
2. Marks the original message `status: done`.

The original subagent, if still running, will pick up the reply on its next channel poll.

### Step 4 — Repeat

Re-run `analyze`. If pending is empty, the tick is done. If new pending appeared (because a subagent woke up and asked a follow-up), continue.

## Channel Schema (summary)

```json
{
  "ts": "2026-07-08T18:30:00.123Z#0001",
  "from": "planner",
  "to": "*" | "agent-name" | ["a", "b"],
  "kind": "info" | "task" | "question",
  "msg": "...",
  "context": { "...": "..." },
  "status": "pending" | "done",
  "in_reply_to": "<origTs>"
}
```

Full schema, append-only guarantees, and the 30-day archive policy live in `.claude/chat/README.md`.

## Examples

### Example 1 — Single DM (planner asks architect)

1. planner runs:
   ```js
   channel.append({ from: 'planner', to: 'architect', kind: 'question', msg: 'REST or GraphQL?' });
   ```
2. Main agent runs `/multi-agent-chat analyze` → finds one DM to `architect`.
3. Main agent calls `Agent(agent=architect, prompt="REST or GraphQL for our new admin API?")`.
4. architect answers: "REST — simpler, fewer moving parts for a CRUD admin".
5. Main agent runs:
   ```bash
   node .claude/chat/tick.js answer 2026-07-08T12:00:00.000Z#0001 architect planner info "REST — simpler..."
   ```
6. planner's next channel poll sees the answer, continues.

### Example 2 — Parallel group (review one PR)

```bash
node .claude/chat/channel.js append \
  '{"from":"orchestrator","to":["code-reviewer","security-reviewer"],"kind":"task","msg":"review PR #42"}'
```

Main agent dispatches both reviewers in parallel with the same PR context, collects both answers, writes each back via `tick.js answer`.

### Example 3 — Broadcast (deploy done)

```bash
node .claude/chat/channel.js append \
  '{"from":"deployer","to":"*","kind":"info","msg":"v2.3 deployed to staging"}'
```

Main agent injects this into all running agents' contexts. No reply is expected; `info` kind tells recipients no work product is owed.

## Key Constraints

- **Half-scheduling.** Subagents can only *describe* their blocker (`channel.append` + exit). The main agent does the actual waking-up. This means true "anyone-can-ping-anyone" is not achievable — only the main agent can route.
- **3 Agent hops per Q&A cycle.** Main agent scans + dispatches + re-dispatches with answer. ~50% more tokens than direct chaining; budget accordingly.
- **Single-process assumption.** `tick.js` rewrites the whole JSONL on `markDone`. Fine for typical workloads (<10 MB); for very long channels, switch to per-line append with status sidecar.

## Related Files

- `.claude/chat/channel.js` — append/readPending/markDone/reply helpers.
- `.claude/chat/channel.jsonl` — append-only log (created on first append).
- `.claude/chat/tick.js` — dispatcher invoked by this skill.
- `.claude/chat/check-channel.js` — exit-time hook (see `hooks/hooks.json`).
- `.claude/rules/multi-agent-chat.md` — rule file telling all subagents this skill exists.
- `docs/adr/0001-multi-agent-channel-protocol.md` — the ADR this skill implements.
