#!/usr/bin/env python3
"""Generate scripts/dev/agents-desc-v2-12.json from current 12 agents.

Reads each agent's description frontmatter and writes a JSON config that the
rewrite-agent-descriptions.py script can validate against.
"""
import json
from pathlib import Path

AGENTS = [
    "architect", "code-explorer", "code-reviewer", "developer", "doc-updater",
    "e2e-runner", "interaction-designer", "planner", "refactor-cleaner",
    "security-reviewer", "silent-failure-hunter", "tester",
]

def extract_desc(filepath):
    """Extract description block (between | and next top-level field)."""
    text = filepath.read_text(encoding="utf-8")
    in_block = False
    lines = []
    for line in text.split("\n"):
        if line.startswith("description:"):
            in_block = True
            rest = line[len("description:"):].lstrip()
            if rest.startswith("|") or rest.startswith(">"):
                if rest[0] == "|":
                    payload = rest[1:].lstrip()
                else:
                    payload = rest[1:].lstrip()
                if payload:
                    lines.append(payload)
            continue
        if in_block:
            if line and not line.startswith(" "):
                break
            lines.append(line.lstrip())
    return "\n".join(lines).rstrip()


def main():
    agents_dir = Path("agents")
    config = {"_comment": "12 v2 agents matching user workflow. scripts/dev/rewrite-agent-descriptions.py validates."}
    for name in AGENTS:
        desc = extract_desc(agents_dir / f"{name}.md")
        config[f"{name}.md"] = desc
        print(f"  {name}.md: {len(desc)} chars")
    out = Path("scripts/dev/agents-desc-v2-12.json")
    out.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {out} with {len(AGENTS)} agents")


if __name__ == "__main__":
    main()
