#!/usr/bin/env node
/**
 * .claude/chat/check-channel.js — agent 退出前的 channel 自检（ADR-0001 §5）
 *
 * 用法：
 *   node .claude/chat/check-channel.js              # 简短摘要（人读）
 *   node .claude/chat/check-channel.js --json       # 完整 JSON（agent 读）
 *   node .claude/chat/check-channel.js --stale-ms 60000   # 超过 60s 的 pending 视为陈旧
 *   node .claude/chat/check-channel.js --strict     # 有 stale 时 exit 1
 *
 * 设计要点（按 ADR-0001 §5 + §中和措施）：
 *   - 默认 exit 0（不阻塞 agent 退出；非 critical 错误）
 *   - 有 stale pending 时往 stderr 写一行警告
 *   - --strict 用于 CI/hook 场景，可选启用为阻塞 hook
 *   - 不修改 channel.jsonl（只读检查）
 *
 * Stale 定义：status=pending 且写入时间距今 > staleMs（默认 60s）。
 * 用途：subagent 写了消息就退出 → 主 agent 没来 tick → 消息被遗忘。
 *       自检能发现这种"孤儿"消息。
 */

'use strict';

const channel = require('./channel');

const DEFAULT_STALE_MS = 60_000;

function parseArgs(argv) {
  const opts = { json: false, strict: false, staleMs: DEFAULT_STALE_MS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--stale-ms') {
      const v = Number(argv[++i]);
      opts.staleMs = Number.isFinite(v) ? v : DEFAULT_STALE_MS;
    }
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: check-channel [--json] [--strict] [--stale-ms <ms>]`);
      process.exit(0);
    }
  }
  return opts;
}

/**
 * @typedef {object} CheckReport
 * @property {number} pending          当前 pending 总数
 * @property {number} stale            其中 stale 数量
 * @property {Array<object>} staleMsgs stale 详情
 * @property {Array<object>} freshMsgs 非 stale 的 pending
 * @property {string} verdict          "clean" | "fresh-pending" | "stale-pending"
 */

/**
 * 检查 channel 中是否有未处理的 pending 消息。
 * @param {object} [opts]
 * @param {number} [opts.staleMs=60000]
 * @returns {CheckReport}
 */
function check(opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const now = Date.now();
  const pending = channel.readPending();

  const freshMsgs = [];
  const staleMsgs = [];
  for (const m of pending) {
    // ts 形如 "2026-07-08T12:00:00.123Z#0001"
    const isoPart = m.ts.split('#')[0];
    const t = Date.parse(isoPart);
    if (Number.isNaN(t)) {
      // 解析失败：保守处理为 stale，让 agent 看到
      staleMsgs.push({ ...m, ageMs: -1, reason: 'unparseable-ts' });
      continue;
    }
    const age = now - t;
    if (age > staleMs) {
      staleMsgs.push({ ...m, ageMs: age });
    } else {
      freshMsgs.push({ ...m, ageMs: age });
    }
  }

  let verdict;
  if (staleMsgs.length > 0) verdict = 'stale-pending';
  else if (freshMsgs.length > 0) verdict = 'fresh-pending';
  else verdict = 'clean';

  return {
    pending: pending.length,
    stale: staleMsgs.length,
    staleMsgs,
    freshMsgs,
    verdict,
    checkedAt: new Date().toISOString(),
    staleMs,
  };
}

module.exports = { check, DEFAULT_STALE_MS };

// ---------- CLI 入口 ----------
if (require.main === module) {
  const opts = parseArgs(process.argv);
  try {
    const report = check(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      const lines = [
        `[check-channel] verdict=${report.verdict}`,
        `[check-channel] pending=${report.pending} stale=${report.stale} (threshold=${opts.staleMs}ms)`,
      ];
      if (report.staleMsgs.length > 0) {
        lines.push('[check-channel] stale messages:');
        for (const m of report.staleMsgs) {
          lines.push(`  - ts=${m.ts} from=${m.from} to=${JSON.stringify(m.to)} kind=${m.kind} ageMs=${m.ageMs}`);
          lines.push(`    msg: ${m.msg}`);
        }
      }
      console.log(lines.join('\n'));
    }
    if (opts.strict && report.verdict !== 'clean') {
      console.error(`[check-channel] --strict: exiting 1 because verdict=${report.verdict}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[check-channel] ${err.message}`);
    process.exit(1);
  }
}
