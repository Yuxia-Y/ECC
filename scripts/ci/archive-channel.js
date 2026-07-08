#!/usr/bin/env node
/**
 * scripts/ci/archive-channel.js — channel.jsonl 30 天归档（ADR-0001 §中和措施）
 *
 * 把 status=done 且 ts 距今超过 `--older-than-days`（默认 30）的消息，
 * 按月份分组追加到 `.claude/chat/archive/channel-YYYY-MM.jsonl`。
 * 原 `channel.jsonl` 仅保留 pending 消息 + 未过期的 done。
 *
 * 用法：
 *   node scripts/ci/archive-channel.js                   # 默认阈值 30 天
 *   node scripts/ci/archive-channel.js --older-than-days 7
 *   node scripts/ci/archive-channel.js --dry-run         # 只报告不写
 *   node scripts/ci/archive-channel.js --json            # JSON 输出
 *   node scripts/ci/archive-channel.js --archive-dir <path>   # 自定义归档根目录
 *
 * 设计要点：
 *   - 幂等：同月可重复执行，已归档消息不再出现（因为它们已不在 channel.jsonl 中）
 *   - 追加：归档文件按月份追加，多次执行同一月不会丢失
 *   - 安全：pending 消息永远保留在原文件中（与 ADR §"Append-only" 一致）
 *
 * 可作为 cron / Stop hook 定期调用。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const channel = require('../../.claude/chat/channel');

const DEFAULT_OLDER_THAN_DAYS = 30;
const DEFAULT_ARCHIVE_DIR = path.join(__dirname, '..', '..', '.claude', 'chat', 'archive');

/**
 * 按月分组消息。月份键从 ts 字段前缀 "YYYY-MM" 提取。
 * @param {Array<object>} msgs
 * @returns {Map<string, object[]>}
 */
function groupByMonth(msgs) {
  const out = new Map();
  for (const m of msgs) {
    const month = (m.ts || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue; // 跳过无法解析的 ts
    if (!out.has(month)) out.set(month, []);
    out.get(month).push(m);
  }
  return out;
}

/**
 * 归档过期消息。返回统计信息。
 *
 * @param {object} [opts]
 * @param {number} [opts.olderThanDays=30]
 * @param {string} [opts.archiveDir]  归档根目录（默认 .claude/chat/archive/）
 * @param {boolean} [opts.dryRun=false]
 * @returns {{archivedCount:number, keptCount:number, filesWritten:Array<{file:string,month:string,count:number}>, cutoff:string, olderThanDays:number, dryRun:boolean}}
 */
function archive(opts = {}) {
  const olderThanDays = opts.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS;
  const archiveDir = opts.archiveDir || DEFAULT_ARCHIVE_DIR;
  const dryRun = !!opts.dryRun;

  const cutoffMs = Date.now() - olderThanDays * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const all = channel.readAll();

  const toArchive = [];
  const toKeep = [];

  for (const m of all) {
    if (m.status !== 'done') {
      toKeep.push(m);
      continue;
    }
    const isoPart = (m.ts || '').split('#')[0];
    const t = Date.parse(isoPart);
    // 无法解析 ts 的过期 done：保守归档（避免无限累积）
    if (Number.isNaN(t) || t < cutoffMs) {
      toArchive.push(m);
    } else {
      toKeep.push(m);
    }
  }

  const byMonth = groupByMonth(toArchive);

  const filesWritten = [];
  if (!dryRun && byMonth.size > 0) {
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const [month, msgs] of byMonth.entries()) {
      const file = path.join(archiveDir, `channel-${month}.jsonl`);
      const payload = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
      fs.appendFileSync(file, payload, 'utf8');
      filesWritten.push({ file, month, count: msgs.length });
    }
  }

  // 重写原 channel.jsonl（只保留未归档的）
  if (!dryRun) {
    const p = channel.getChannelPath();
    const body = toKeep.length > 0
      ? toKeep.map((m) => JSON.stringify(m)).join('\n') + '\n'
      : '';
    fs.writeFileSync(p, body, 'utf8');
  }

  return {
    archivedCount: toArchive.length,
    keptCount: toKeep.length,
    filesWritten,
    cutoff: cutoffIso,
    olderThanDays,
    dryRun,
    archiveDir,
  };
}

module.exports = { archive, groupByMonth, DEFAULT_OLDER_THAN_DAYS };

// ---------- CLI 入口 ----------
if (require.main === module) {
  const argv = process.argv;
  const opts = {
    olderThanDays: DEFAULT_OLDER_THAN_DAYS,
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    archiveDir: undefined,
  };

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--older-than-days') {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v >= 0) opts.olderThanDays = v;
    } else if (argv[i] === '--archive-dir') {
      opts.archiveDir = path.resolve(argv[++i]);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`Usage: archive-channel [--older-than-days <n>] [--archive-dir <path>] [--dry-run] [--json]`);
      process.exit(0);
    }
  }

  try {
    const result = archive(opts);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const lines = [
        `[archive-channel] archived=${result.archivedCount} kept=${result.keptCount} (older than ${result.olderThanDays} days, cutoff=${result.cutoff})`,
      ];
      if (result.dryRun) lines.push('[archive-channel] (dry-run: nothing written)');
      for (const f of result.filesWritten) {
        lines.push(`[archive-channel] wrote ${f.count} msgs -> ${f.file}`);
      }
      if (result.filesWritten.length === 0 && !opts.dryRun) {
        lines.push('[archive-channel] no files written (nothing to archive)');
      }
      console.log(lines.join('\n'));
    }
    process.exit(0);
  } catch (err) {
    console.error(`[archive-channel] ${err.message}`);
    process.exit(1);
  }
}
