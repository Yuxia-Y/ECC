#!/usr/bin/env python3
"""Append 'Working with Other Agents' section to 9 keep agents."""
from pathlib import Path

PEERS = {
    "planner.md": [
        ("architect", "you need tech-choice / feasibility input for a plan"),
        ("developer", "you need an effort estimate for a task you broke down"),
        ("tester", "you want a test-strategy opinion before handing tasks to dev"),
        ("code-explorer", "your plan depends on understanding existing code first"),
    ],
    "architect.md": [
        ("planner", "downstream - your design drives planner's task breakdown"),
        ("developer", "your design needs implementation-feasibility feedback"),
        ("security-reviewer", "design decision has security implications worth checking"),
    ],
    "code-explorer.md": [
        ("planner", "downstream - your map drives planner's task list"),
        ("developer", "your map tells them what to read before changing"),
        ("architect", "your exploration feeds their architecture reasoning"),
    ],
    "code-reviewer.md": [
        ("security-reviewer", "parallel audit; main agent usually dispatches you both"),
        ("developer", "you have a clarifying question about the diff"),
        ("refactor-cleaner", "your findings include dead code / consolidation wins"),
    ],
    "security-reviewer.md": [
        ("code-reviewer", "parallel audit; share findings context"),
        ("developer", "you have a fix to suggest for a vuln you found"),
    ],
    "e2e-runner.md": [
        ("tester", "unit tests done, hand off for end-to-end"),
        ("interaction-designer", "you need UI flow states to verify against"),
        ("developer", "you need test setup / data fixture from them"),
    ],
    "doc-updater.md": [
        ("developer", "your doc update depends on what they changed"),
        ("architect", "architecture-level doc needs their input"),
        ("planner", "a planned change will require doc updates"),
    ],
    "refactor-cleaner.md": [
        ("code-explorer", "you need to find all usages of an export before removing"),
        ("developer", "you are unsure whether code is intentionally unused"),
        ("code-reviewer", "you found cleanup-worthy code during review"),
    ],
    "silent-failure-hunter.md": [
        ("code-reviewer", "parallel audit; share findings context"),
        ("developer", "you have a fix recommendation for a swallowed error"),
    ],
}

TEMPLATE_HEADER = """
## Working with Other Agents

You operate as part of a 12-agent team. You **CANNOT** directly call peers. To ask another agent a question, write to channel:

```bash
node .claude/chat/channel.js append '{{"from":"__ROLE__","to":"<peer>","kind":"question","msg":"..."}}'
```

Then **exit**. Main agent routes and re-invokes you with the answer. Never poll. Never sleep.

### Your relevant peers

| Peer | Talk to them when |
|------|-------------------|
"""

TEMPLATE_FOOTER = """
### Channel rules

- **DM**: `to:"<name>"` - one specific peer
- **Group**: `to:["a","b"]` - parallel work (rare from you)
- **Broadcast**: `to:"*"` - best-effort, main agent decides recipients
- **NEVER** put secrets / API keys / PII in `msg`
- **NEVER** set `status` manually - only `tick.js answer` does
- After appending, run `node .claude/chat/check-channel.js`; surface stale-pending in your final summary
"""

agents_dir = Path("agents")
count = 0
for fname, peers in PEERS.items():
    role = fname.replace(".md", "")
    section = TEMPLATE_HEADER.replace("__ROLE__", role)
    for peer, when in peers:
        section += f"| `{peer}` | {when} |\n"
    section += TEMPLATE_FOOTER
    fpath = agents_dir / fname
    with open(fpath, "a", encoding="utf-8") as f:
        f.write(section)
    print(f"appended to {fname}")
    count += 1
print(f"\nTotal: {count} agents appended")
