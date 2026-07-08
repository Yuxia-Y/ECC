/**
 * Tests for .claude/chat/check-channel.js
 *
 * Run with: node tests/chat/check-channel.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_CHANNEL = path.join(os.tmpdir(), `ecc-check-test-${process.pid}-${Date.now()}.jsonl`);
process.env.ECC_CHANNEL_PATH = TMP_CHANNEL;

const channel = require('../../.claude/chat/channel');
const checkModule = require('../../.claude/chat/check-channel');

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

console.log('\n=== Testing .claude/chat/check-channel.js ===\n');

// ---------- check() ----------
console.log('check():');

test('returns verdict=clean when channel is empty', () => {
  cleanup();
  const r = checkModule.check();
  assert.strictEqual(r.verdict, 'clean');
  assert.strictEqual(r.pending, 0);
  assert.strictEqual(r.stale, 0);
});

test('returns verdict=fresh-pending when messages are recent', () => {
  cleanup();
  channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q' });
  const r = checkModule.check({ staleMs: 60_000 });
  assert.strictEqual(r.verdict, 'fresh-pending');
  assert.strictEqual(r.pending, 1);
  assert.strictEqual(r.stale, 0);
  assert.strictEqual(r.freshMsgs.length, 1);
  assert.strictEqual(r.staleMsgs.length, 0);
});

test('returns verdict=stale-pending when messages exceed staleMs', () => {
  cleanup();
  channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q' });
  // 用 staleMs=0 让任何消息都视为 stale
  const r = checkModule.check({ staleMs: 0 });
  assert.strictEqual(r.verdict, 'stale-pending');
  assert.strictEqual(r.pending, 1);
  assert.strictEqual(r.stale, 1);
  assert.strictEqual(r.staleMsgs.length, 1);
  assert.strictEqual(r.freshMsgs.length, 0);
});

test('handles unparseable-ts conservatively (treated as stale)', () => {
  cleanup();
  fs.writeFileSync(
    TMP_CHANNEL,
    JSON.stringify({
      ts: 'definitely-not-a-timestamp#0001',
      from: 'a',
      to: 'b',
      kind: 'question',
      msg: 'broken-ts',
      status: 'pending',
    }) + '\n'
  );
  const r = checkModule.check({ staleMs: 60_000 });
  assert.strictEqual(r.verdict, 'stale-pending');
  assert.strictEqual(r.staleMsgs[0].reason, 'unparseable-ts');
});

test('uses DEFAULT_STALE_MS (60000) by default', () => {
  assert.strictEqual(checkModule.DEFAULT_STALE_MS, 60_000);
});

test('reports ageMs for each message', () => {
  cleanup();
  channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'q' });
  const r = checkModule.check({ staleMs: 60_000 });
  assert.ok(r.freshMsgs[0].ageMs >= 0);
});

test('mixes stale and fresh correctly', () => {
  cleanup();
  channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'will-be-stale' });
  // 等 50ms 后再写一条 → 用 staleMs=20 让第一条 stale、第二条 fresh
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return wait(50).then(() => {
    channel.append({ from: 'a', to: 'b', kind: 'question', msg: 'will-be-fresh' });
    const r = checkModule.check({ staleMs: 20 });
    assert.strictEqual(r.verdict, 'stale-pending');
    assert.strictEqual(r.pending, 2);
    assert.strictEqual(r.stale, 1);
    assert.strictEqual(r.freshMsgs.length, 1);
    assert.strictEqual(r.freshMsgs[0].msg, 'will-be-fresh');
    assert.strictEqual(r.staleMsgs[0].msg, 'will-be-stale');
  });
});

test('includes checkedAt ISO timestamp', () => {
  cleanup();
  const r = checkModule.check();
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.checkedAt));
});

// ---------- cleanup ----------
cleanup();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
