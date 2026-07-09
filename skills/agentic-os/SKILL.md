---
name: agentic-os
description: MGTV team's persistent multi-agent runtime on Claude Code. 18 specialist agents + channel protocol (ADR-0001) + kernel CLAUDE.md routing. Covers dispatch triggers, inter-agent Q&A, parallel groups, and the half-self-scheduling constraint.
metadata:
  origin: ECC (forked by Yx @ MGTV, 2026-07)
  supersedes: upstream generic agentic-os pattern
---

# Agentic OS (MGTV fork)

This is the **MGTV team's operating manual** for our 18-agent Claude Code runtime. It supersedes the generic ECC upstream pattern with three concrete additions:

1. **Description-based dispatch** — the main agent matches task to specialist via the 5-section `description` template (Use when / Don't use when / Channel / Outputs), not manual intent keywords.
2. **Channel protocol (ADR-0001)** — subagents that need to ask another role a question write to `.claude/chat/channel.jsonl` and exit; the main agent routes replies. This is the only inter-agent communication channel.
3. **Half-self-scheduling** — subagents **cannot** spawn sub-subagents. Cross-role work is always routed through the main agent via channel.

Upstream concepts that are still valid: 4-layer architecture, file-based memory, scheduled automation, declarative kernel.

## When to Activate

- User says "agentic OS", "personal OS", "multi-agent", "agent coordinator", "persistent agent"
- Building a multi-agent workflow inside Claude Code
- Setting up persistent Claude Code automation that survives session restarts
- Routing work across the 18 specialist agents (planner / architect / code-explorer / code-reviewer / etc.)
- Debugging why a subagent didn't dispatch or didn't answer

## Architecture Overview

```
project-root/
├── CLAUDE.md                # Kernel: agent registry + routing rules + model policies
├── agents/                  # 18 specialist agent definitions (markdown)
├── .claude/
│   ├── rules/               # Auto-loaded rules (multi-agent-chat, guardrails, language)
│   ├── skills/              # Workflows (multi-agent-chat, code-review, tdd, ...)
│   ├── commands/            # User-facing slash commands
│   └── chat/                # Channel protocol: channel.jsonl + tick.js
├── scripts/                 # Daemon / batch scripts
└── data/                    # File-based state (JSON + markdown)
```

### Layer Responsibilities

| Layer | Purpose | Persistence |
|---|---|---|
| Kernel (`CLAUDE.md`) | Identity, agent registry, routing rules, model policies | Git-tracked |
| Agents (`agents/*.md`) | Specialist identities with 5-section `description` frontmatter | Git-tracked |
| Rules (`.claude/rules/`) | Auto-loaded context (multi-agent protocol, language rules, guardrails) | Git-tracked |
| Skills (`.claude/skills/`) | Workflows invoked by main agent or user (multi-agent-chat, tdd) | Git-tracked |
| Channel (`.claude/chat/`) | Inter-agent Q&A queue + tick dispatcher | Git-tracked (state) |
| Commands (`.claude/commands/`) | User-facing slash commands (`/code-review`, `/tdd`) | Git-tracked |
| Scripts (`scripts/`) | Daemon / batch jobs (Python or Node) | Git-tracked |
| State (`data/`) | Append-only logs, project state, decision records | Tracked or git-ignored |

## The Kernel

`CLAUDE.md` is the kernel. Claude reads it at session start. Two things must be in it for our 18-agent runtime to work:

1. **Agent Registry** — a table mapping task types to the right agent. This is the main agent's primary dispatch cue. Without it, the main agent defaults to "do it yourself" and never dispatches.
2. **Routing Rules** — explicit "for non-trivial tasks, dispatch first; do not Edit directly". Without this, the main agent may pick up a planner-shaped task and start implementing.

### Kernel Template

```markdown
# CLAUDE.md — Agentic OS Kernel

## Identity
You are the COO of [project]. You **do not write code directly** for non-trivial work.
You route tasks to specialist agents from the 12-agent registry below. You only
Edit/Write yourself for trivial changes (single-line typo, < 3 files, pure doc updates).
For implementation: dispatch to `developer` (auto-detects language), not Edit directly.

## Agent Registry (12 specialist agents)

Maps your user's workflow (PM = you = main agent; 9 roles routed to specialists + 3 supporting).

| # | Role | Dispatch to | Trigger keywords |
|---|---|---|---|
| 2 | Plan / spec / decompose | `planner` | "design", "decompose", "plan", "how to build", user story |
| 3 | Architecture / tech choice | `architect` | "architecture", "tech stack", "scalability", tech choice |
| 4 | Implement / write code | `developer` | "implement", "add feature", "write code", "refactor" + file ext |
| 5 | Code review (quality) | `code-reviewer` | "review code", "check quality", "is this OK" |
| 6 | Independent test / QA white-box | `tester` | "test X", "add tests", "verify behavior" |
| 7 | E2E test / QA black-box / UI verification | `e2e-runner` | "E2E", "playwright", "browser", "screenshot bug" |
| 8 | UI / interaction / visual design | `interaction-designer` | "design UI", "mockup flow", "how should this look" |
| 9 | Investigate / trace existing code | `code-explorer` | "how does X work", "investigate", "trace" |
| 10 | Doc / CODEMAP / ADR update | `doc-updater` | "update docs", "CODEMAP", "ADR" |
| 11 | Security audit (parallel to code-reviewer) | `security-reviewer` | "security", "vulnerability", "OWASP", "audit" |
| 12 | Silent failures / swallowed errors | `silent-failure-hunter` | "why no error", "empty catch", "swallowed" |
| (10) | Dead code / unused cleanup | `refactor-cleaner` | "remove dead", "unused", "cleanup", "ts-prune" |

## Routing Rules
1. **Parse intent first** — what type of work? (plan / explore / build / review / test / docs / clean / design)
2. **Match to registry** — pick one agent; if multiple match, prefer the more specific
3. **Dispatch via Agent tool** — `subagent_type: "<name>"` with full context
4. **Wait for result** — subagent returns; you synthesize for the user
5. **For complex tasks** — chain: `planner` (decompose) → `developer` (implement) → `code-reviewer` + `security-reviewer` (parallel review) → `tester` (independent verification)
6. **If agent declines** — only then Edit/Write directly (and flag in your summary)

## Cross-Role Communication
- Subagents that need another role's input write to `.claude/chat/channel.jsonl` and exit (see `multi-agent-chat` rule and skill)
- When the main agent sees pending messages, run `/multi-agent-chat` to drain
- Each agent has a "Working with Other Agents" section in its prompt listing relevant peers

## Model Policies
- `planner`, `architect` → opus (complex reasoning)
- `code-reviewer`, `security-reviewer`, `tester`, `e2e-runner`, `interaction-designer`, `developer` → sonnet
- `silent-failure-hunter`, `refactor-cleaner`, `doc-updater`, `code-explorer` → sonnet
- Trivial Edit/Write (yourself) → default
```

## Specialist Agents

Each agent is a standalone markdown file in `agents/`. Every one follows the **5-section `description` template** — this is what makes description-based dispatch reliable.

### The 5-Section Template (mandatory)

```yaml
---
name: <role>
description: |
  <One-sentence role summary>

  Use when: <trigger 1>, <trigger 2>, ...
  Don't use when: <boundary 1> (use <other-agent>), <boundary 2>, ...
  Cross-role communication (ADR-0001) via .claude/chat/channel.jsonl:
    - Private question: {from, to:"<role>", kind:"question", ...}
    - Group question:   {from, to:["a","b"], kind:"question", ...}
    - Broadcast FYI:    {from, to:"*", kind:"info", ...}
                       (best-effort: main agent chooses recipients; not guaranteed)
  After appending, exit. Main agent routes the message and re-invokes you with answers.

  Outputs: {<field1>, <field2>, ...}
tools: ["Read", "Grep", "Glob"]   # or wider, but be explicit
model: opus                       # or sonnet/haiku
---
```

**Why this template**:

- **Use when** — main agent matches on these triggers; specific keywords > vague intent
- **Don't use when** — hard redirect to a sibling agent; prevents mis-dispatch
- **Channel** — subagent knows the protocol and its limitations (broadcast is best-effort)
- **Outputs** — main agent can verify "did the subagent do the right thing" by checking fields
- **tools** — narrow scope; planner shouldn't Edit, code-reviewer shouldn't Write

### Real Example: `agents/planner.md`

```yaml
---
name: planner
description: |
  Planning specialist. Decomposes requirements into ordered tasks with
  dependencies, risks, and acceptance criteria. Reads code/docs, never writes
  code or runs commands.

  Use when: user requests new feature, multi-file refactor, architecture
  change, or asks "how should I build X?". Tasks touching >=3 files or
  requiring coordination across roles.

  Don't use when: change is trivial (<3 files single concern), purely
  investigative (use code-explorer), single-line fix, or pure documentation
  update (use doc-updater).

  Cross-role communication (ADR-0001) via .claude/chat/channel.jsonl: ...
  After appending, exit. Main agent routes the message and re-invokes you with answers.

  Outputs: {tasks:[{id,title,deps,risk,acceptance}], dependencies:[...],
            risks:[...], questions_for:[...]}
tools: ["Read", "Grep", "Glob"]
model: opus
---
```

## Channel-Based Collaboration (ADR-0001)

This is **the only** inter-agent communication mechanism. Subagents do **not** call each other directly. The flow:

```
planner (subagent)                    main agent
     |                                    |
     | 1. append question to              |
     |    .claude/chat/channel.jsonl      |
     |    {from:planner, to:architect,    |
     |     kind:question, msg:...}        |
     |                                    |
     | 2. exit                            |
     |                                    |
     |          3. main agent sees        |
     |             pending message        |
     |                                    |
     |          4. /multi-agent-chat      |
     |             → tick.js analyze      |
     |             → dispatch architect   |
     |                                    |
     |                          5. architect answers |
     |                                    |
     |          6. tick.js answer         |
     |             <ts> architect planner|
     |             question "..."         |
     |                                    |
     | 7. main agent re-invokes           |
     |    planner with answer in context  |
     |                                    |
     | 8. planner continues               |
```

### The Three Message Shapes

| Shape | `to` field | `kind` | Use case |
|---|---|---|---|
| Private DM | `"<role>"` | `question` / `task` | One specific role has the answer |
| Group | `["a", "b"]` | `task` / `question` | Parallel work (e.g. code-reviewer + security-reviewer) |
| Broadcast | `"*"` | `info` | FYI to all; **best-effort** — main agent decides recipients |

### Half-Self-Scheduling (CRITICAL constraint)

**Subagents cannot spawn sub-subagents.** This is a Claude Code architectural limit. Consequences:

- A subagent that needs another role's input **must** write to channel + exit
- The main agent is the **only** entity that can dispatch other agents
- If your subagent's prompt says "you can call architect", that's wrong — write to channel instead
- Cost per Q&A round = ~3 Agent calls (main scans + main dispatches target + main re-dispatches you with answer)

**Anti-pattern**: do not `Bash sleep` waiting for a reply. Append + exit. The main agent will re-invoke you when the answer arrives.

### Channel Maintenance

- File: `.claude/chat/channel.jsonl` (append-only)
- Cleanup: archive done messages older than 30 days via `.claude/chat/archive-channel.js`
- Stale check: `.claude/chat/check-channel.js` flags pending > 60s
- Self-check before subagent exit: run `check-channel.js` and surface stale-pending in your final summary

## Persistent Memory

Memory is file-based. No vector DB, no Redis, no PostgreSQL. JSON and markdown files in `data/` are the database.

```
data/
├── daily-logs/         # Append-only daily activity logs
├── projects/           # Per-project context files
├── decisions/          # Architectural and business decisions (ADR format)
├── inbox/              # New tasks or ideas awaiting triage
├── contacts/           # People, companies, relationship notes
└── templates/          # Reusable prompts and formats
```

### When to use memory vs channel

| Need | Use | Why |
|---|---|---|
| Persistent across sessions | `data/` files | Survives session restart |
| Single-session cross-agent Q&A | `channel.jsonl` | Ephemeral, structured, self-cleaning |
| Daily log of what happened | `data/daily-logs/<date>.md` | Append-only audit trail |
| Cross-session agent state | `data/projects/<name>.json` | Structured resume context |

## Scheduled Automation

Agentic OS tasks run on external cron (LaunchAgent / systemd / pm2 / Windows Task Scheduler), not Claude Code's built-in cron (which dies when the session ends). Scripts in `scripts/` should be standalone — don't depend on a live Claude session.

## Data Layer

JSON for structured state, markdown for narrative. Never rename existing fields — add new and mark old deprecated. Schema evolution without migration scripts.

## Anti-Patterns

### ❌ Monolithic single agent
"You are a full-stack developer, writer, researcher, and DevOps engineer." — Split into specialists; the kernel routes.

### ❌ Main agent Edit/Write without dispatch
Main agent picks up a planner-shaped task and starts implementing. — The kernel must say "dispatch first".

### ❌ Subagent tries to spawn sub-subagent
Subagent reads `## Agent Registry`, picks another agent, and tries to dispatch. — **Cannot work**; write to channel + exit instead.

### ❌ Subagent polls channel for reply
`Bash sleep 5 && cat .claude/chat/channel.jsonl` waiting for answer. — Append + exit; main agent re-invokes you.

### ❌ Manual intent-keyword matching in kernel
Kernel has `if (msg.includes("deploy")) dispatch ops` as code. — Keep declarative in markdown tables; the 18 agents' `description` frontmatter is the matching layer.

### ❌ External DB for solo project
PostgreSQL for a single user's notes. — Use JSON/markdown in `data/` until you have concurrent users or GBs of data.

## Best Practices

- [ ] Kernel `CLAUDE.md` is under 200 lines, declarative, contains Agent Registry + Routing Rules
- [ ] Every agent's `description` uses the 5-section template (Use when / Don't use when / Channel / Outputs)
- [ ] Every agent's `tools` is explicit (don't grant Edit/Write to read-only agents like planner)
- [ ] Cross-role Q&A goes through channel — never subagent-to-subagent direct
- [ ] Subagents append + exit; do not poll
- [ ] Channel `done` messages older than 30 days are archived
- [ ] `data/` is git-ignored for sensitive logs, tracked for decisions and specs
- [ ] Memory scope per agent is explicit ("read `data/projects/X.md`")
- [ ] One project = one kernel. Don't share `CLAUDE.md` across unrelated projects.
- [ ] When adding a new agent, validate its `description` against the 5-section template before commit
