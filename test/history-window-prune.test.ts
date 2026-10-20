// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova test/history-window-prune.test.js
/**
 * History-window bookkeeping under concurrency.
 *
 * WHY THIS FILE EXISTS
 *
 * The first real host load produced **90** `POST /synapnova/api/sessions/history`
 * → 400 responses, with zero JS exceptions. Root cause: `pruneHistoryWindows()`
 * deleted the oldest key regardless of whether that window had SETTLED. A canvas
 * with more concurrent backfills than `MAX_HISTORY_WINDOWS` therefore evicted
 * in-flight windows, and each evicted window's closing batch came back as
 * `历史窗口缺少起始批次` → 400.
 *
 * The defect was invisible to local tests because every existing test drove ONE
 * window at a time — a single window never reaches the ceiling. These tests pin
 * the behaviour that was actually broken: live windows must survive pruning.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, beforeEach, afterEach, onTestFinished } from 'vitest'

import { WorkspaceStore } from '@/server/workspace-store'

const CEILING = 8 // MAX_HISTORY_WINDOWS

/** A store on a scratch file; the caller removes `dir`. */
async function makeStore(dir) {
  const store = new WorkspaceStore(join(dir, 'state.json'))
  await store.ready
  return store
}

function caption(historyId, sessionId) {
  return {
    historyId,
    sessionId,
    title: '会话',
    cwd: 'C:/work',
    lowWater: 0,
    hasMore: false,
    historyComplete: true,
  }
}

/** Open a multi-batch window: batch 0, not yet closed. */
function openBatch(historyId, sessionId, seq = 0) {
  return { ...caption(historyId, sessionId), cursor: 0, complete: false, events: [{ seq, type: 'user/message', time: seq }] }
}

/** Close the window opened by `openBatch`. */
function closeBatch(historyId, sessionId, cursor = 1, seq = 1) {
  return { ...caption(historyId, sessionId), cursor, complete: true, events: [{ seq, type: 'assistant/message', time: seq }] }
}

it('超过上限时不会淘汰未结算窗口（宿主 90 次 400 的根因）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapnova-hist-prune-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const store = await makeStore(dir)

  const count = CEILING + 4 // more concurrent backfills than the map allows
  for (let index = 1; index <= count; index++) {
    await store.syncHistory(openBatch(`h${index}`, `sess-${index}`))
  }

  // Every live window must still be staged. Before the fix, opening the 9th
  // window silently dropped the 1st one's state.
  assert.equal(store.historyWindows.size, count,
    `未结算窗口必须全部保留，实得 ${store.historyWindows.size}/${count}`)

  // And every one of them must be closable. This is the assertion that actually
  // reproduces the host failure: `历史窗口缺少起始批次` is thrown from here.
  for (let index = 1; index <= count; index++) {
    await assert.doesNotReject(
      () => store.syncHistory(closeBatch(`h${index}`, `sess-${index}`)),
      `窗口 h${index} 收尾不应被拒（共 ${count} 个并发窗口）`,
    )
  }
})

it('结算后的窗口才会被修剪，且预算回落到上限以内', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapnova-hist-settle-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const store = await makeStore(dir)

  // 20 single-batch windows: each settles immediately, so pruning may collect
  // them freely and the map must never grow unbounded.
  for (let index = 1; index <= 20; index++) {
    await store.syncHistory({ ...caption(`s${index}`, `sess-${index}`), cursor: 0, complete: true, events: [{ seq: 0, type: 'user/message', time: 0 }] })
  }
  assert.ok(store.historyWindows.size <= CEILING,
    `已结算窗口应被修剪到上限以内，实得 ${store.historyWindows.size}`)
})

it('混合场景：已结算窗口先被淘汰，未结算窗口活到最后', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapnova-hist-mixed-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const store = await makeStore(dir)

  // Fill the map with settled windows first.
  for (let index = 1; index <= CEILING; index++) {
    await store.syncHistory({ ...caption(`done${index}`, `sess-done-${index}`), cursor: 0, complete: true, events: [{ seq: 0, type: 'user/message', time: 0 }] })
  }
  // Then open live windows; pruning must recycle the settled ones, not these.
  for (let index = 1; index <= 5; index++) {
    await store.syncHistory(openBatch(`live${index}`, `sess-live-${index}`))
  }
  for (let index = 1; index <= 5; index++) {
    assert.ok(store.historyWindows.has(`live${index}`), `未结算窗口 live${index} 不应被淘汰`)
    await assert.doesNotReject(() => store.syncHistory(closeBatch(`live${index}`, `sess-live-${index}`)),
      `未结算窗口 live${index} 必须能收尾`)
  }
})

it('同一个 historyId 重发收尾批次仍然明确拒绝（不因修复而放宽）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapnova-hist-replay-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const store = await makeStore(dir)

  await store.syncHistory({ ...caption('replay', 'sess-r'), cursor: 0, complete: true, events: [{ seq: 0, type: 'user/message', time: 0 }] })
  // The window has settled; a NEW batch under the same id is a protocol error.
  // Fixing the pruning bug must not turn this into a silent accept.
  await assert.rejects(
    () => store.syncHistory({ ...caption('replay', 'sess-r'), cursor: 1, complete: true, events: [{ seq: 1, type: 'assistant/message', time: 1 }] }),
    /历史窗口已结算/,
    '已结算窗口再收到新批次必须拒绝',
  )
})

it('缺少起始批次时仍然明确拒绝（窗口不存在就是不存在）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapnova-hist-orphan-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const store = await makeStore(dir)

  // Never opened cursor 0. The fix must not paper over a genuinely missing
  // window by inventing one — that would corrupt coverage ranges.
  await assert.rejects(
    () => store.syncHistory(closeBatch('never-opened', 'sess-o')),
    /历史窗口缺少起始批次/,
    '未开过的窗口收到收尾批次必须拒绝',
  )
})
