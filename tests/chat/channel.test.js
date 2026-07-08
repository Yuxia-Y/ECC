/**
 * Tests for .claude/chat/channel.js
 *
 * Run with: node tests/chat/channel.test.js
 *
 * 用 ECC_CHANNEL_PATH 环境变量隔离测试 channel 文件，不污染 .claude/chat/channel.jsonl。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_CHANNEL = path.join(os.tmpdir(), `ecc-channel-test-${process.pid}-${Date.now()}.jsonl`);
process.env.ECC_CHANNEL_PATH = TMP_CHANNEL;

// 注意：必须在设置 env var 之后 require
const channel = require('../../.claude/chat/channel');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
    return false;
  }
}

function cleanup() {
  if (fs.existsSync(TMP_CHANNEL)) fs.unlinkSync(TMP_CHANNEL);
}

function reset() {
  cleanup();
}

console.log('\n=== Testing .claude/chat/channel.js ===\n');

// ---------- Path resolution ----------
console.log('Path resolution:');

test('getChannelPath() returns ECC_CHANNEL_PATH when set', () => {
  assert.strictEqual(channel.getChannelPath(), path.resolve(TMP_CHANNEL));
});

test('DEFAULT_CHANNEL_PATH is the in-repo default', () => {
  assert.ok(channel.DEFAULT_CHANNEL_PATH.endsWith('channel.jsonl'));
  // 跨平台：normalize 路径分隔符
  const normalized = channel.DEFAULT_CHANNEL_PATH.split(path.sep).join('/');
  assert.ok(normalized.includes('.claude/chat'), `expected .claude/chat in ${normalized}`);
});

// ---------- append ----------
console.log('\nappend():');

test('appends a minimal message and returns ts', () => {
  reset();
  const ts = channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'hi' });
  assert.ok(typeof ts === 'string');
  assert.ok(ts.length > 0);
  assert.ok(fs.existsSync(TMP_CHANNEL));
  const content = fs.readFileSync(TMP_CHANNEL, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1);
  const obj = JSON.parse(lines[0]);
  assert.strictEqual(obj.from, 'a');
  assert.strictEqual(obj.to, 'b');
  assert.strictEqual(obj.kind, 'question');
  assert.strictEqual(obj.msg, 'hi');
  assert.strictEqual(obj.status, 'pending');
  assert.strictEqual(obj.ts, ts);
});

test('ts is unique across rapid appends', () => {
  reset();
  const tss = new Set();
  for (let i = 0; i < 50; i++) {
    tss.add(channel.append({ from: 'x', to: 'y', kind: 'info', msg: `m${i}` }));
  }
  assert.strictEqual(tss.size, 50, 'expected 50 unique ts values');
});

test('appends optional context field', () => {
  reset();
  channel.append({ from: 'a', to: 'b', kind: 'task', msg: 'do it', context: { priority: 'high' } });
  const all = channel.readAll();
  assert.strictEqual(all.length, 1);
  assert.deepStrictEqual(all[0].context, { priority: 'high' });
});

test('appends in_reply_to when given', () => {
  reset();
  channel.append({ from: 'a', to: 'b', kind: 'info', msg: 'r', in_reply_to: 'orig-ts-1' });
  const all = channel.readAll();
  assert.strictEqual(all[0].in_reply_to, 'orig-ts-1');
});

test('accepts array `to`', () => {
  reset();
  channel.append({ from: 'a', to: ['b', 'c'], kind: 'task', msg: 'fan-out' });
  const all = channel.readAll();
  assert.deepStrictEqual(all[0].to, ['b', 'c']);
});

// ---------- append validation ----------
console.log('\nappend() validation:');

test('throws on missing object', () => {
  assert.throws(() => channel.append(null), /requires an object/);
});

test('throws on missing from', () => {
  assert.throws(() => channel.append({ to: 'b', kind: 'question', msg: 'x' }), /msg\.from/);
});

test('throws on missing to', () => {
  assert.throws(() => channel.append({ from: 'a', kind: 'question', msg: 'x' }), /msg\.to/);
});

test('throws on invalid to type', () => {
  assert.throws(() => channel.append({ from: 'a', to: 42, kind: 'question', msg: 'x' }), /string or string\[\]/);
});

test('throws on invalid kind', () => {
  assert.throws(() => channel.append({ from: 'a', to: 'b', kind: 'foo', msg: 'x' }), /must be one of/);
});

test('throws on missing msg', () => {
  assert.throws(() => channel.append({ from: 'a', to: 'b', kind: 'question' }), /msg\.msg/);
});

// ---------- readPending ----------
console.log('\nreadPending():');

test('returns empty array when file does not exist', () => {
  cleanup();
  assert.deepStrictEqual(channel.readPending(), []);
});

test('returns only pending messages', () => {
  reset();
  const t1 = channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q1' });
  const t2 = channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q2' });
  channel.markDone(t1);
  const pending = channel.readPending();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].ts, t2);
  assert.strictEqual(pending[0].msg, 'q2');
});

// ---------- readAll ----------
console.log('\nreadAll():');

test('returns all messages including done', () => {
  reset();
  const t1 = channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q1' });
  channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q2' });
  channel.markDone(t1);
  const all = channel.readAll();
  assert.strictEqual(all.length, 2);
  const done = all.find((m) => m.ts === t1);
  assert.strictEqual(done.status, 'done');
});

test('skips malformed lines without crashing', () => {
  reset();
  channel.append({ from: 'a', to: 'b', kind: 'info', msg: 'good' });
  fs.appendFileSync(TMP_CHANNEL, 'not-json\n', 'utf8');
  channel.append({ from: 'a', to: 'b', kind: 'info', msg: 'good2' });
  const all = channel.readAll();
  assert.strictEqual(all.length, 2);
});

// ---------- markDone ----------
console.log('\nmarkDone():');

test('marks the target message as done', () => {
  reset();
  const ts = channel.append({ from: 'a', to: 'b', kind: 'task', msg: 'work' });
  assert.strictEqual(channel.readPending().length, 1);
  const ok = channel.markDone(ts);
  assert.strictEqual(ok, true);
  assert.strictEqual(channel.readPending().length, 0);
});

test('returns false when ts not found', () => {
  reset();
  const ok = channel.markDone('does-not-exist');
  assert.strictEqual(ok, false);
});

test('returns false when already done (idempotent)', () => {
  reset();
  const ts = channel.append({ from: 'a', to: 'b', kind: 'task', msg: 'work' });
  assert.strictEqual(channel.markDone(ts), true);
  assert.strictEqual(channel.markDone(ts), false);
});

test('does not affect other messages', () => {
  reset();
  const t1 = channel.append({ from: 'a', to: 'b', kind: 'task', msg: 'm1' });
  const t2 = channel.append({ from: 'a', to: 'b', kind: 'task', msg: 'm2' });
  channel.markDone(t1);
  assert.strictEqual(channel.readAll().find((m) => m.ts === t2).status, 'pending');
});

test('throws on missing ts arg', () => {
  assert.throws(() => channel.markDone(), /ts/);
  assert.throws(() => channel.markDone(''), /ts/);
});

// ---------- reply ----------
console.log('\nreply():');

test('writes a new message with in_reply_to', () => {
  reset();
  const origTs = channel.append({ from: 'planner', to: 'architect', kind: 'question', msg: 'q' });
  const replyTs = channel.reply({ from: 'architect', to: 'planner', in_reply_to: origTs, msg: 'a' });
  assert.notStrictEqual(origTs, replyTs);
  const reply = channel.readAll().find((m) => m.ts === replyTs);
  assert.strictEqual(reply.in_reply_to, origTs);
  assert.strictEqual(reply.kind, 'info'); // default
});

test('reply does not auto-mark original as done', () => {
  reset();
  const origTs = channel.append({ from: 'p', to: 'a', kind: 'question', msg: 'q' });
  channel.reply({ from: 'a', to: 'p', in_reply_to: origTs, msg: 'a' });
  assert.strictEqual(channel.readAll().find((m) => m.ts === origTs).status, 'pending');
});

test('throws when in_reply_to missing', () => {
  assert.throws(() => channel.reply({ from: 'a', to: 'b', msg: 'x' }), /in_reply_to/);
});

// ---------- cleanup ----------
cleanup();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
