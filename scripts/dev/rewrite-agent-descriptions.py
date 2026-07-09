#!/usr/bin/env python3
"""
scripts/dev/rewrite-agent-descriptions.py — 批量改 agent frontmatter 的 description

用法:
  python scripts/dev/rewrite-agent-descriptions.py --config agents-desc-v1.json
  python scripts/dev/rewrite-agent-descriptions.py --config agents-desc-v1.json --dry-run

输入 JSON 格式 (e.g. agents-desc-v1.json):
  {
    "planner.md": "5 段 description (Use when / Don't / Channel / Outputs)",
    "architect.md": "...",
    ...
  }

行为:
  - 读每个 agent 的 frontmatter (--- 块)
  - 替换 description 字段（保留 name/tools/model 不动）
  - 保留 frontmatter 后的 body 不动
  - 校验 description 含必填段 (Use when / Don't use when / Channel / Outputs)
  - --dry-run 只打印 diff 不改文件

依赖: PyYAML (可选, 没用 YAML 而用 string replace 避免依赖)
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENTS_DIR = REPO_ROOT / "agents"

REQUIRED_SECTIONS = ["Use when", "Don't use when", "channel.jsonl", "Outputs"]


def split_frontmatter(text: str):
    """Split a markdown file into (frontmatter_text, body_text). Returns None if no frontmatter."""
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
    if not m:
        return None
    return m.group(1), m.group(2)


def replace_description(fm: str, new_desc: str) -> str:
    """Replace the description: field in frontmatter (preserves other fields).

    Handles both single-line (description: foo) and block (description: |\\n  foo) styles.
    """
    # Block style: description: | or description: > followed by indented lines
    fm_new = re.sub(
        r"^description:.*?(?=\n[a-zA-Z]|\Z)",
        lambda _: f"description: |\n  {new_desc.replace(chr(10), chr(10) + '  ')}",
        fm,
        count=1,
        flags=re.MULTILINE | re.DOTALL,
    )
    return fm_new


def validate_description(desc: str) -> List[str]:
    """Return list of missing required sections."""
    return [s for s in REQUIRED_SECTIONS if s not in desc]


def rewrite_agent(agent_file: Path, new_desc: str, dry_run: bool) -> Tuple[bool, str]:
    """Rewrite one agent file. Returns (changed, message)."""
    text = agent_file.read_text(encoding="utf-8")
    parts = split_frontmatter(text)
    if not parts:
        return False, f"  SKIP: no frontmatter"
    fm, body = parts

    missing = validate_description(new_desc)
    if missing:
        return False, f"  SKIP: missing sections: {missing}"

    new_fm = replace_description(fm, new_desc)
    if new_fm == fm:
        return False, f"  NO-OP: description unchanged"

    if dry_run:
        # show first 3 lines of diff for sanity check
        new_lines = new_fm.split("\n")
        old_lines = fm.split("\n")
        diff_preview = []
        for nl, ol in list(zip(new_lines, old_lines))[:6]:
            if nl != ol:
                diff_preview.append(f"    - {ol[:80]}")
                diff_preview.append(f"    + {nl[:80]}")
        return True, f"  DRY-RUN: would rewrite\n" + "\n".join(diff_preview)

    new_text = f"---\n{new_fm}\n---\n{body}"
    agent_file.write_text(new_text, encoding="utf-8")
    return True, f"  WROTE: {agent_file.name}"


def main():
    ap = argparse.ArgumentParser(description="Batch-rewrite agent descriptions.")
    ap.add_argument("--config", required=True, help="Path to JSON config mapping agent filename -> new description")
    ap.add_argument("--dry-run", action="store_true", help="Print diffs without writing")
    args = ap.parse_args()

    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = REPO_ROOT / config_path

    if not config_path.exists():
        print(f"ERROR: config not found: {config_path}", file=sys.stderr)
        sys.exit(2)

    config = json.loads(config_path.read_text(encoding="utf-8"))

    if not isinstance(config, dict):
        print("ERROR: config must be a JSON object {filename: description}", file=sys.stderr)
        sys.exit(2)

    print(f"Config: {config_path}")
    print(f"Mode: {'DRY-RUN' if args.dry_run else 'WRITE'}")
    print(f"Agents to rewrite: {len(config)}")
    print()

    changed = 0
    skipped = 0
    for filename, new_desc in sorted(config.items()):
        # 跳过 metadata keys (e.g. _comment)
        if filename.startswith("_"):
            print(f"{filename}: SKIP (metadata key)")
            skipped += 1
            continue
        agent_path = AGENTS_DIR / filename
        if not agent_path.exists():
            print(f"{filename}: MISSING (not in agents/)")
            skipped += 1
            continue
        print(f"{filename}:")
        ok, msg = rewrite_agent(agent_path, new_desc, args.dry_run)
        print(msg)
        if ok:
            changed += 1
        else:
            skipped += 1

    print()
    print(f"Summary: {changed} changed, {skipped} skipped")
    sys.exit(0 if skipped == 0 else 1)


if __name__ == "__main__":
    main()
