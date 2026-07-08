#!/usr/bin/env node
/**
 * .claude/chat/channel.js — 多 Agent 通信通道的读写 helper
 *
 * 按 ADR-0001 实现。提供：
 *   - append(msg)         写入一条新消息（自动补 ts/status=pending）
 *   - readPending()       读取所有 status=pending 的消息
 *   - readAll()           读取全部消息（含 done；调试/审计用）
 *   - markDone(ts)        把指定 ts 的消息标为 done
 *   - reply({...})        写回答案（封装 append + 自动 in_reply_to）
 *
 * 文件不存在时自动创建（懒加载）。所有写入追加在末尾。
 *
 * 消息 schema 见 ./README.md。
 *
 * Usage (CLI):
 *   node .claude/chat/channel.js append '{"from":"planner","to":"architect","kind":"question","msg":"REST vs GraphQL?"}'
 *   node .claude/chat/channel.js pending
 *   node .claude/chat/channel.js mark-done <ts>
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CHANNEL_PATH = path.join(__dirname, 'channel.jsonl');

/**
 * 解析当前 channel 文件路径。
 *
 * 优先级：
 *   1. ECC_CHANNEL_PATH 环境变量（测试/CI 覆盖用）
 *   2. 默认 .claude/chat/channel.jsonl
 *
 * 函数式（而非模块常量）确保 env var 在 require 之后设置也能生效。
 */
function getChannelPath() {
  const env = process.env.ECC_CHANNEL_PATH;
  if (env && env.trim()) return path.resolve(env);
  return DEFAULT_CHANNEL_PATH;
}

const VALID_KIND = new Set(['info', 'task', 'question']);
const VALID_STATUS = new Set(['pending', 'done']);

/**
 * 确保 channel.jsonl 存在（首次写入时调用）
 */
function ensureFile() {
  const p = getChannelPath();
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, '', 'utf8');
  }
}

/**
 * 生成 ISO-8601 UTC 时间戳（含毫秒 + 单调计数器后缀，确保同一毫秒内也唯一）
 *
 * 格式：2026-07-08T18:30:00.123Z#0001
 *  - 毫秒精度让 wall-clock 仍可读
 *  - 单调计数器后缀（自进程启动）保证同一毫秒内多次 append 也不冲突
 */
let _counter = 0;
function nowIso() {
  const iso = new Date().toISOString(); // 自带 .毫秒Z
  _counter = (_counter + 1) % 10000;
  return `${iso}#${String(_counter).padStart(4, '0')}`;
}

/**
 * 读取所有行（跳过空行），解析为对象数组
 * @returns {Array<object>}
 */
function readAllLines() {
  const p = getChannelPath();
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (err) {
      // 跳过损坏行（append-only 日志应自愈）
      // eslint-disable-next-line no-console
      console.error(`[channel] skip malformed line: ${err.message}`);
    }
  }
  return out;
}

/**
 * 写入一条新消息。
 *
 * 自动补充 `ts`（如未提供）和 `status='pending'`（如未提供）。
 * 校验 `kind` 必填且为合法值。
 *
 * @param {object} msg
 * @param {string} msg.from      发送方 agent 名
 * @param {string|string[]} msg.to  接收方
 * @param {'info'|'task'|'question'} msg.kind
 * @param {string} msg.msg       消息正文
 * @param {object} [msg.context] 附加上下文
 * @param {string} [msg.in_reply_to] 引用的原消息 ts
 * @returns {string} 写入消息的 ts
 */
function append(msg) {
  if (!msg || typeof msg !== 'object') {
    throw new TypeError('append() requires an object');
  }
  if (!msg.from || typeof msg.from !== 'string') {
    throw new TypeError('append() requires msg.from (string)');
  }
  if (msg.to === undefined || msg.to === null) {
    throw new TypeError('append() requires msg.to (string or string[])');
  }
  if (typeof msg.to !== 'string' && !Array.isArray(msg.to)) {
    throw new TypeError('append() msg.to must be string or string[]');
  }
  if (!VALID_KIND.has(msg.kind)) {
    throw new TypeError(`append() msg.kind must be one of ${[...VALID_KIND].join('|')}, got: ${msg.kind}`);
  }
  if (typeof msg.msg !== 'string') {
    throw new TypeError('append() requires msg.msg (string)');
  }

  const record = {
    ts: msg.ts || nowIso(),
    from: msg.from,
    to: msg.to,
    kind: msg.kind,
    msg: msg.msg,
    status: msg.status || 'pending',
  };
  if (msg.context !== undefined) record.context = msg.context;
  if (msg.in_reply_to !== undefined) record.in_reply_to = msg.in_reply_to;

  ensureFile();
  fs.appendFileSync(getChannelPath(), JSON.stringify(record) + '\n', 'utf8');
  return record.ts;
}

/**
 * 读取所有 status=pending 的消息。
 * @returns {Array<object>}
 */
function readPending() {
  return readAllLines().filter((m) => m.status === 'pending');
}

/**
 * 把指定 ts 的消息标为 done。
 *
 * 实现方式：读全部 → 替换目标行 → 原子重写。
 * （JSONL 文件通常 < 10MB，单进程场景下重写可接受。）
 *
 * @param {string} ts
 * @returns {boolean} 是否实际标记了某条消息
 */
function markDone(ts) {
  if (!ts || typeof ts !== 'string') {
    throw new TypeError('markDone() requires ts (string)');
  }
  const all = readAllLines();
  let updated = false;
  const next = all.map((m) => {
    if (m.ts === ts && m.status !== 'done') {
      updated = true;
      return { ...m, status: 'done' };
    }
    return m;
  });
  if (updated) {
    ensureFile();
    fs.writeFileSync(getChannelPath(), next.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
  }
  return updated;
}

/**
 * 回信 helper：写一条 in_reply_to=原 ts 的新消息。
 *
 * 不会自动 markDone（由调用方决定是否同时关闭原消息）。
 *
 * @param {object} reply
 * @param {string} reply.from
 * @param {string|string[]} reply.to
 * @param {string} reply.in_reply_to
 * @param {'info'|'task'|'question'} [reply.kind='info']
 * @param {string} reply.msg
 * @param {object} [reply.context]
 * @returns {string} 新消息的 ts
 */
function reply({ from, to, in_reply_to, kind = 'info', msg, context }) {
  if (!in_reply_to) {
    throw new TypeError('reply() requires in_reply_to');
  }
  return append({ from, to, kind, msg, context, in_reply_to });
}

module.exports = {
  getChannelPath,
  DEFAULT_CHANNEL_PATH,
  append,
  readPending,
  readAll: readAllLines,
  markDone,
  reply,
};

// ---------- CLI 入口 ----------
if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'append') {
      const payload = JSON.parse(rest.join(' '));
      const ts = append(payload);
      console.log(ts);
    } else if (cmd === 'pending') {
      const list = readPending();
      console.log(JSON.stringify(list, null, 2));
    } else if (cmd === 'all') {
      const list = readAllLines();
      console.log(JSON.stringify(list, null, 2));
    } else if (cmd === 'mark-done') {
      const ts = rest[0];
      const ok = markDone(ts);
      console.log(ok ? 'marked' : 'not-found');
      process.exit(ok ? 0 : 1);
    } else {
      console.error('Usage: channel {append|pending|all|mark-done <ts>}');
      process.exit(2);
    }
  } catch (err) {
    console.error(`[channel] ${err.message}`);
    process.exit(1);
  }
}
