/**
 * Tests for scripts/ci/archive-channel.js
 *
 * Run with: node tests/chat/archive-channel.test.js
 *
 * 覆盖 ADR-0001 §"中和措施"：
 *   "channel.jsonl 加清理策略（已完成 30 天的消息归档，避免无限增长）"
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离：测试用临时 channel 和临时 archive 目录
const TMP_CHANNEL = path.join(os.tmpdir(), `ecc-arch-channel-${process.pid}-${Date.now()}.jsonl`);
const TMP_ARCHIVE_DIR = path.join(os.tmpdir(), `ecc-arch-dir-${process.pid}-${Date.now()}`);
process.env.ECC_CHANNEL_PATH = TMP_CHANNEL;

// module 必须在 env 设置后 require
const channel = require('../../.claude/chat/channel');
const archiveModule = require('../../scripts/ci/archive-channel');

let passed = 0;
let failed = 0;

function test(name, fn) {
  // 同步版本：fn 不返回 Promise
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
    return Promise.resolve();
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
    return Promise.resolve();
  }
}

function writeMessage({ ts, from = 'a', to = 'b', kind = 'info', msg = 'x', status = 'pending' }) {
  // 直接写 JSONL（绕开 helper 的 ts/status 强制），便于注入历史消息
  fs.appendFileSync(TMP_CHANNEL, JSON.stringify({ ts, from, to, kind, msg, status }) + '\n', 'utf8');
}

function resetAll() {
  // 清空 channel + 清空 archive 目录（测试间隔离）
  fs.writeFileSync(TMP_CHANNEL, '');
  if (fs.existsSync(TMP_ARCHIVE_DIR)) {
    for (const f of fs.readdirSync(TMP_ARCHIVE_DIR)) {
      fs.unlinkSync(path.join(TMP_ARCHIVE_DIR, f));
    }
  }
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

console.log('\n=== Testing scripts/ci/archive-channel.js ===\n');

(async () => {

// ---------- groupByMonth ----------
console.log('groupByMonth():');

await test('groups messages by YYYY-MM prefix', () => {
  const groups = archiveModule.groupByMonth([
    { ts: '2026-01-15T00:00:00.000Z#0001', msg: 'jan1' },
    { ts: '2026-01-20T00:00:00.000Z#0002', msg: 'jan2' },
    { ts: '2026-02-01T00:00:00.000Z#0003', msg: 'feb' },
    { ts: 'not-a-ts', msg: 'skip' },
  ]);
  assert.strictEqual(groups.size, 2);
  assert.strictEqual(groups.get('2026-01').length, 2);
  assert.strictEqual(groups.get('2026-02').length, 1);
});

// ---------- archive() ----------
console.log('\narchive():');

await test('archives only done messages older than threshold', () => {
  resetAll();
  const old = '2026-01-01T00:00:00.000Z#0001';
  const recent = '2026-07-01T00:00:00.000Z#0001';
  writeMessage({ ts: old, msg: 'old-done', status: 'done' });
  writeMessage({ ts: recent, msg: 'recent-done', status: 'done' });
  writeMessage({ ts: old, msg: 'old-pending', status: 'pending' });
  writeMessage({ ts: recent, msg: 'recent-pending', status: 'pending' });

  const r = archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR });

  assert.strictEqual(r.archivedCount, 1, 'only the old done should be archived');
  assert.strictEqual(r.keptCount, 3, 'all other 3 should remain');

  const after = channel.readAll();
  assert.strictEqual(after.length, 3);
  assert.ok(after.find((m) => m.msg === 'recent-done'));
  assert.ok(after.find((m) => m.msg === 'old-pending'));
  assert.ok(after.find((m) => m.msg === 'recent-pending'));
  assert.ok(!after.find((m) => m.msg === 'old-done'), 'old-done should be gone from channel');
});

await test('writes one archive file per month', () => {
  resetAll();
  writeMessage({ ts: '2026-01-15T00:00:00.000Z#0001', msg: 'jan', status: 'done' });
  writeMessage({ ts: '2026-02-15T00:00:00.000Z#0002', msg: 'feb', status: 'done' });
  writeMessage({ ts: '2026-03-15T00:00:00.000Z#0003', msg: 'mar', status: 'done' });

  const r = archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR });

  assert.strictEqual(r.archivedCount, 3);
  assert.strictEqual(r.filesWritten.length, 3);
  assert.ok(fs.existsSync(path.join(TMP_ARCHIVE_DIR, 'channel-2026-01.jsonl')));
  assert.ok(fs.existsSync(path.join(TMP_ARCHIVE_DIR, 'channel-2026-02.jsonl')));
  assert.ok(fs.existsSync(path.join(TMP_ARCHIVE_DIR, 'channel-2026-03.jsonl')));
});

await test('archive files contain valid JSONL', () => {
  resetAll();
  writeMessage({ ts: '2026-01-15T00:00:00.000Z#0001', msg: 'jan1', status: 'done' });
  writeMessage({ ts: '2026-01-20T00:00:00.000Z#0002', msg: 'jan2', status: 'done' });

  archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR });

  const file = path.join(TMP_ARCHIVE_DIR, 'channel-2026-01.jsonl');
  const content = readFile(file);
  const lines = content.split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.strictEqual(parsed[0].msg, 'jan1');
  assert.strictEqual(parsed[1].msg, 'jan2');
});

await test('appends to existing archive file (idempotent across runs)', () => {
  resetAll();
  writeMessage({ ts: '2026-01-15T00:00:00.000Z#0001', msg: 'first', status: 'done' });
  archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR });

  // 再次写入第二条
  writeMessage({ ts: '2026-01-25T00:00:00.000Z#0002', msg: 'second', status: 'done' });
  archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR });

  const file = path.join(TMP_ARCHIVE_DIR, 'channel-2026-01.jsonl');
  const lines = readFile(file).split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2, 'archive file should have both messages');
});

await test('dry-run does not write any files', () => {
  resetAll();
  writeMessage({ ts: '2026-01-15T00:00:00.000Z#0001', msg: 'dry', status: 'done' });

  const r = archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR, dryRun: true });
  assert.strictEqual(r.archivedCount, 1);
  assert.strictEqual(r.dryRun, true);

  // 验证：channel 还在，archive 目录没创建
  assert.strictEqual(channel.readAll().length, 1);
  assert.ok(!fs.existsSync(path.join(TMP_ARCHIVE_DIR, 'channel-2026-01.jsonl')));
});

await test('creates archive dir if missing', () => {
  resetAll();
  writeMessage({ ts: '2026-01-15T00:00:00.000Z#0001', msg: 'mk', status: 'done' });
  const freshDir = path.join(os.tmpdir(), `ecc-arch-fresh-${process.pid}-${Date.now()}`);
  assert.ok(!fs.existsSync(freshDir));

  archiveModule.archive({ olderThanDays: 30, archiveDir: freshDir });

  assert.ok(fs.existsSync(freshDir), 'archive dir should be created');
});

await test('handles unparseable-ts conservatively (archives it)', () => {
  resetAll();
  writeMessage({ ts: 'not-a-real-timestamp#0001', msg: 'broken', status: 'done' });

  const r = archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR });
  assert.strictEqual(r.archivedCount, 1);
});

await test('does not archive pending messages regardless of age', () => {
  resetAll();
  writeMessage({ ts: '2020-01-01T00:00:00.000Z#0001', msg: 'ancient-pending', status: 'pending' });

  const r = archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR });
  assert.strictEqual(r.archivedCount, 0);
  assert.strictEqual(r.keptCount, 1);
});

await test('keeps done messages newer than threshold', () => {
  resetAll();
  const now = new Date().toISOString();
  writeMessage({ ts: `${now.split('.')[0]}Z#0001`, msg: 'fresh-done', status: 'done' });

  const r = archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR });
  assert.strictEqual(r.archivedCount, 0);
  assert.strictEqual(r.keptCount, 1);
});

await test('default threshold is 30 days', () => {
  assert.strictEqual(archiveModule.DEFAULT_OLDER_THAN_DAYS, 30);
});

await test('older-than-days=0 archives everything that is done', () => {
  resetAll();
  const now = new Date().toISOString();
  writeMessage({ ts: `${now.split('.')[0]}Z#0001`, msg: 'just-now-done', status: 'done' });
  writeMessage({ ts: '2026-01-15T00:00:00.000Z#0001', msg: 'old-done', status: 'done' });

  const r = archiveModule.archive({ olderThanDays: 0, archiveDir: TMP_ARCHIVE_DIR });
  assert.strictEqual(r.archivedCount, 2);
});

await test('returns cutoff ISO timestamp', () => {
  resetAll();
  const r = archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR });
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.cutoff));
});

await test('rewrites channel.jsonl to be empty when all done are archived', () => {
  resetAll();
  writeMessage({ ts: '2026-01-15T00:00:00.000Z#0001', msg: 'only-msg', status: 'done' });

  archiveModule.archive({ olderThanDays: 30, archiveDir: TMP_ARCHIVE_DIR });

  // channel.jsonl 应该是空的（或只有空白）
  const content = readFile(TMP_CHANNEL);
  const lines = content.split('\n').filter((l) => l.trim());
  assert.strictEqual(lines.length, 0, 'channel.jsonl should be empty after all done archived');
});

// ---------- cleanup ----------
console.log('\n--- cleanup ---');
if (fs.existsSync(TMP_CHANNEL)) fs.unlinkSync(TMP_CHANNEL);
if (fs.existsSync(TMP_ARCHIVE_DIR)) {
  for (const f of fs.readdirSync(TMP_ARCHIVE_DIR)) {
    fs.unlinkSync(path.join(TMP_ARCHIVE_DIR, f));
  }
  fs.rmdirSync(TMP_ARCHIVE_DIR);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);

})().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
