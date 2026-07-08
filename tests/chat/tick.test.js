/**
 * Tests for .claude/chat/tick.js
 *
 * Run with: node tests/chat/tick.test.js
 *
 * 覆盖 ADR-0001 §"中和措施"：
 *   "tick.py 写完整测试（3 个 to 形态 × 3 个 kind 组合 = 9 个 case）"
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_CHANNEL = path.join(os.tmpdir(), `ecc-tick-test-${process.pid}-${Date.now()}.jsonl`);
process.env.ECC_CHANNEL_PATH = TMP_CHANNEL;

const channel = require('../../.claude/chat/channel');
const tick = require('../../.claude/chat/tick');

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

console.log('\n=== Testing .claude/chat/tick.js ===\n');

// ---------- analyze() ----------
console.log('analyze():');

test('returns empty buckets when channel is empty', () => {
  cleanup();
  const b = tick.analyze();
  assert.deepStrictEqual(b, { broadcasts: [], groups: [], dms: [] });
});

test('classifies 9 combinations of (to × kind) correctly', () => {
  cleanup();

  // 3 to forms × 3 kinds = 9 messages
  // Use unique msgs so we can identify each
  const fixtures = [
    { to: '*', kind: 'info', msg: 'B-info' },
    { to: '*', kind: 'task', msg: 'B-task' },
    { to: '*', kind: 'question', msg: 'B-question' },
    { to: 'architect', kind: 'info', msg: 'D-info' },
    { to: 'architect', kind: 'task', msg: 'D-task' },
    { to: 'architect', kind: 'question', msg: 'D-question' },
    { to: ['r1', 'r2'], kind: 'info', msg: 'G-info' },
    { to: ['r1', 'r2'], kind: 'task', msg: 'G-task' },
    { to: ['r1', 'r2'], kind: 'question', msg: 'G-question' },
  ];

  for (const f of fixtures) {
    channel.append({ from: 'tester', to: f.to, kind: f.kind, msg: f.msg });
  }

  const b = tick.analyze();

  // broadcast bucket
  assert.strictEqual(b.broadcasts.length, 3, 'expected 3 broadcasts');
  for (const m of b.broadcasts) {
    assert.strictEqual(m.to, '*');
    assert.ok(['B-info', 'B-task', 'B-question'].includes(m.msg));
  }

  // dm bucket
  assert.strictEqual(b.dms.length, 3, 'expected 3 dms');
  for (const m of b.dms) {
    assert.strictEqual(m.to, 'architect');
    assert.ok(['D-info', 'D-task', 'D-question'].includes(m.msg));
  }

  // group bucket
  assert.strictEqual(b.groups.length, 3, 'expected 3 groups');
  for (const m of b.groups) {
    assert.deepStrictEqual(m.to, ['r1', 'r2']);
    assert.ok(['G-info', 'G-task', 'G-question'].includes(m.msg));
  }
});

test('ignores done messages', () => {
  cleanup();
  const ts = channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q' });
  channel.markDone(ts);
  channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'still-pending' });
  const b = tick.analyze();
  assert.strictEqual(b.dms.length, 1);
  assert.strictEqual(b.dms[0].msg, 'still-pending');
});

test('counts malformed `to` as no bucket (logged to stderr)', () => {
  cleanup();
  // 手动写一行 to 为非合法值的记录
  fs.writeFileSync(
    TMP_CHANNEL,
    JSON.stringify({
      ts: new Date().toISOString(),
      from: 'x',
      to: 123, // 非法
      kind: 'question',
      msg: 'malformed-to',
      status: 'pending',
    }) + '\n'
  );
  const b = tick.analyze();
  assert.strictEqual(b.broadcasts.length, 0);
  assert.strictEqual(b.dms.length, 0);
  assert.strictEqual(b.groups.length, 0);
});

// ---------- answer() ----------
console.log('\nanswer():');

test('writes reply + marks original done', () => {
  cleanup();
  const origTs = channel.append({ from: 'planner', to: 'architect', kind: 'question', msg: 'REST?' });
  const replyTs = tick.answer({ origTs, from: 'architect', to: 'planner', kind: 'info', msg: 'REST' });

  const reply = channel.readAll().find((m) => m.ts === replyTs);
  assert.strictEqual(reply.in_reply_to, origTs);
  assert.strictEqual(reply.from, 'architect');
  assert.strictEqual(reply.to, 'planner');
  assert.strictEqual(reply.kind, 'info');

  const orig = channel.readAll().find((m) => m.ts === origTs);
  assert.strictEqual(orig.status, 'done');
});

test('returns new ts different from origTs', () => {
  cleanup();
  const origTs = channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q' });
  const replyTs = tick.answer({ origTs, from: 'b', to: 'a', msg: 'a' });
  assert.notStrictEqual(replyTs, origTs);
});

test('throws when origTs not provided', () => {
  assert.throws(() => tick.answer({ from: 'a', to: 'b', msg: 'x' }), /origTs/);
});

test('throws when from not provided', () => {
  cleanup();
  const origTs = channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q' });
  assert.throws(() => tick.answer({ origTs, to: 'a', msg: 'x' }), /from/);
});

test('throws when to not provided', () => {
  cleanup();
  const origTs = channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q' });
  assert.throws(() => tick.answer({ origTs, from: 'b', msg: 'x' }), /to/);
});

test('throws when msg not provided', () => {
  cleanup();
  const origTs = channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q' });
  assert.throws(() => tick.answer({ origTs, from: 'b', to: 'a' }), /msg/);
});

test('logs warning when origTs not found', () => {
  cleanup();
  // origTs 不存在：reply 仍会写，但 markDone 返回 false → 应记录 warning
  // 不抛错（让主 agent 继续处理其他消息）
  const origTs = 'non-existent';
  const replyTs = tick.answer({ origTs, from: 'a', to: 'b', msg: 'reply-to-ghost' });
  assert.ok(replyTs);
  const reply = channel.readAll().find((m) => m.ts === replyTs);
  assert.strictEqual(reply.in_reply_to, origTs);
});

test('preserves context in reply', () => {
  cleanup();
  const origTs = channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q' });
  const replyTs = tick.answer({ origTs, from: 'b', to: 'a', msg: 'a', context: { trace: 'X1' } });
  const reply = channel.readAll().find((m) => m.ts === replyTs);
  assert.deepStrictEqual(reply.context, { trace: 'X1' });
});

// ---------- Full Q&A cycle (E2E shape) ----------
console.log('\nFull Q&A cycle:');

test('planner asks architect → architect answers → planner sees reply (ADR §8)', () => {
  cleanup();

  // 1. planner writes question
  const qTs = channel.append({
    from: 'planner',
    to: 'architect',
    kind: 'question',
    msg: 'REST or GraphQL?',
    context: { phase: 'design' },
  });

  // 2. main agent runs tick.analyze() — finds one dm
  const b1 = tick.analyze();
  assert.strictEqual(b1.dms.length, 1);
  assert.strictEqual(b1.dms[0].ts, qTs);
  assert.strictEqual(b1.dms[0].kind, 'question');

  // 3. main agent dispatches (simulated) — architect answers
  const aTs = tick.answer({
    origTs: qTs,
    from: 'architect',
    to: 'planner',
    kind: 'info',
    msg: 'REST — simpler for CRUD admin',
    context: { decision: 'REST' },
  });

  // 4. planner checks channel — sees reply in_reply_to its question
  const all = channel.readAll();
  const reply = all.find((m) => m.ts === aTs);
  assert.strictEqual(reply.from, 'architect');
  assert.strictEqual(reply.to, 'planner');
  assert.strictEqual(reply.in_reply_to, qTs);
  assert.strictEqual(reply.msg, 'REST — simpler for CRUD admin');

  // 5. original question is now done
  const orig = all.find((m) => m.ts === qTs);
  assert.strictEqual(orig.status, 'done');

  // 6. original question is done; reply is the only remaining pending
  //    (reply is "pending" until planner consumes it — that's expected)
  const pending = channel.readPending();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].ts, aTs);
  assert.strictEqual(pending[0].in_reply_to, qTs);
});

// ---------- cleanup ----------
cleanup();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
