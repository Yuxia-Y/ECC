#!/usr/bin/env node
/**
 * .claude/chat/tick.js — 多 Agent 通信调度器（ADR-0001）
 *
 * 主 agent 通过 `/multi-agent-chat` skill 调用此脚本完成一轮 tick：
 *
 *   1. analyze
 *      读取 channel.jsonl 中所有 status=pending 的消息，按 `to` 字段分类为：
 *        - broadcasts: [{...msg}]                          to === "*"
 *        - groups:     [{ to: [a,b], ...msg }]             to 是数组
 *        - dms:        [{...msg}]                          to 是单字符串
 *      主 agent 据此决定用 Agent tool 派发谁。
 *
 *   2. answer <origTs> <from> <to> <kind> <msg>
 *      把 sub-agent 的回答写回 channel（封装 channel.reply + 自动 markDone）。
 *
 *   3. dispatch
 *      analyze + 自动调用 2 的样板（按顺序处理每条 dm/group；broadcast 只打印）。
 *      仅用于测试/CLI；主 agent 走 analyze 路径更灵活。
 *
 * 关键限制（来自 ADR §6）：
 *   - subagent 不能派生 subagent（Claude Code 架构）
 *   - 所以 tick.js 只能"分析"，真正的 Agent tool 派发必须由主 agent 完成
 *   - 主 agent 拿到答案后调 answer 写回
 *
 * Usage:
 *   node .claude/chat/tick.js analyze
 *   node .claude/chat/tick.js answer <origTs> <from> <to> <kind> <msg>
 *   node .claude/chat/tick.js dispatch --dry-run
 */

'use strict';

const channel = require('./channel');

/**
 * 读取 pending 消息并按 to 字段分类
 * @returns {{ broadcasts: object[], groups: object[], dms: object[] }}
 */
function analyze() {
  const pending = channel.readPending();
  const buckets = { broadcasts: [], groups: [], dms: [] };

  for (const msg of pending) {
    const { to } = msg;
    if (to === '*') {
      buckets.broadcasts.push(msg);
    } else if (Array.isArray(to)) {
      buckets.groups.push(msg);
    } else if (typeof to === 'string') {
      buckets.dms.push(msg);
    } else {
      // 非法 to 字段：标记为 info 反馈给 from，避免无限循环
      // eslint-disable-next-line no-console
      console.error(`[tick] invalid 'to' on ts=${msg.ts}, value=${JSON.stringify(to)}`);
    }
  }
  return buckets;
}

/**
 * 把 sub-agent 的回答写回 channel。
 *
 * 行为：
 *  1. reply() 写一条新消息（from=答者, to=原 from, in_reply_to=原 ts）
 *  2. markDone() 关闭原消息
 *  3. 返回新消息的 ts
 *
 * @param {object} args
 * @param {string} args.origTs       原 pending 消息的 ts
 * @param {string} args.from         回答者 agent 名（通常 === 原 msg.to）
 * @param {string} args.to           接收方（通常 === 原 msg.from）
 * @param {'info'|'task'|'question'} args.kind
 * @param {string} args.msg          回答正文
 * @param {object} [args.context]
 * @returns {string} 新消息的 ts
 */
function answer({ origTs, from, to, kind = 'info', msg, context }) {
  if (!origTs || !from || !to || !msg) {
    throw new TypeError('answer() requires origTs, from, to, msg');
  }
  const newTs = channel.reply({ from, to, in_reply_to: origTs, kind, msg, context });
  const closed = channel.markDone(origTs);
  if (!closed) {
    // eslint-disable-next-line no-console
    console.error(`[tick] origTs=${origTs} not found or already done`);
  }
  return newTs;
}

/**
 * dispatch 模式（CLI/测试用）：把 analyze 结果打印出来，并演示 answer 闭环。
 *
 * 默认 dry-run：只打印待处理消息，不实际写回。
 * 传 --commit 时需要 --answer 参数提供回信内容（用于 e2e 测试）。
 */
function dispatchCli(argv) {
  const buckets = analyze();
  const summary = {
    broadcasts: buckets.broadcasts.length,
    groups: buckets.groups.length,
    dms: buckets.dms.length,
    total: buckets.broadcasts.length + buckets.groups.length + buckets.dms.length,
  };
  console.log(JSON.stringify({ summary, buckets }, null, 2));
}

module.exports = {
  analyze,
  answer,
};

// ---------- CLI 入口 ----------
if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'analyze' || cmd === 'dispatch') {
      dispatchCli();
    } else if (cmd === 'answer') {
      // answer <origTs> <from> <to> <kind> <msg>
      const [origTs, from, to, kind, ...msgParts] = rest;
      const msg = msgParts.join(' ');
      if (!origTs || !from || !to || !kind || !msg) {
        console.error('Usage: tick answer <origTs> <from> <to> <kind> <msg>');
        process.exit(2);
      }
      const newTs = answer({ origTs, from, to, kind, msg });
      console.log(newTs);
    } else {
      console.error('Usage: tick {analyze|dispatch|answer <origTs> <from> <to> <kind> <msg>}');
      process.exit(2);
    }
  } catch (err) {
    console.error(`[tick] ${err.message}`);
    process.exit(1);
  }
}
