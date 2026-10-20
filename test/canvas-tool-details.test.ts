// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova test/canvas-tool-details.test.js，行为完整、类型待补。
/**
 * Tool details — index, lookup, folding.
 *
 * The AC-10a case is the point of this suite: host `callId`s are only unique
 * inside one session, so the same `call-1` appears in two conversations with
 * different names and results. Any index keyed by `(turnIndex, callId)` alone
 * would answer with the wrong tool, and this suite must fail when that happens.
 *
 * Fixtures are plain snapshots in the frozen document shape, so the same code
 * path works whether the caller passes a raw snapshot or a `buildCanvasModel`
 * result.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { buildCanvasModel } from '@/canvas/model'
import {
  DEFAULT_OUTPUT_LIMIT,
  TOOL_DETAIL_FIELDS,
  TOOL_STATUS,
  TRUNCATION_SUFFIX,
  indexToolCalls,
  summarizeLongOutput,
  toolCallsForTurn,
  toolDetailFor,
  toolStatus,
} from '@/canvas/tool-details'

const ISO = '2026-10-18T09:00:00.000Z'
const ISO2 = '2026-10-18T09:05:00.000Z'

const user = (id, text = '问题') => ({ id, kind: 'user', text, sourceSeq: Number(id.replace(/\D/g, '')) || 0, at: ISO })

/** An assistant message carrying folded tool records. */
function assistant(id, process, extra = {}) {
  return { id, kind: 'assistant', text: '回答', sourceSeq: 999, at: ISO, process, ...extra }
}

function record(callId, name, extra = {}) {
  return { callId, name, arguments: '{"q":"x"}', result: 'ok', error: null, ...extra }
}

/**
 * Two threads that DELIBERATELY reuse the same callId in the same turn index:
 * `session-a` calls `read`, `session-b` calls `bash`. Both also reuse `turn 1`.
 */
function snapshot() {
  return {
    id: 'workspace-a',
    revision: 3,
    projectionEpoch: 1,
    projection: {
      threads: [
        {
          id: 't-a',
          title: '会话甲',
          dshSessionId: 'session-a',
          messages: [
            user('u-a1', '甲的问题一'),
            assistant('as-a1', [record('call-1', 'read', { result: '文件甲' })]),
            user('u-a2', '甲的问题二'),
            assistant('as-a2', [record('call-1', 'bash', { result: '命令甲', error: '失败' })]),
          ],
          pendingProcess: [],
        },
        {
          id: 't-b',
          title: '会话乙',
          dshSessionId: 'session-b',
          messages: [
            user('u-b1', '乙的问题一'),
            assistant('as-b1', [record('call-1', 'web_search', { result: '结果乙' })]),
          ],
          pendingProcess: [],
        },
      ],
    },
    layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    materials: [],
    regions: [],
    annotations: [],
  }
}

it('常量：字段顺序、默认折叠上限与状态值', () => {
  assert.deepEqual([...TOOL_DETAIL_FIELDS], ['name', 'input', 'result', 'status', 'at'])
  assert.equal(DEFAULT_OUTPUT_LIMIT, 4000)
  assert.deepEqual({ ...TOOL_STATUS }, { done: 'done', error: 'error', pending: 'pending' })
})

it('indexToolCalls：按 (sessionId, turnIndex, callId) 建索引', () => {
  const index = indexToolCalls(snapshot())
  assert.equal(index.entries.size, 3)
  const first = index.entries.get(JSON.stringify(['session-a', 0, 'call-1']))
  assert.equal(first.name, 'read')
  assert.equal(first.sessionId, 'session-a')
  assert.equal(first.turnIndex, 0)
  assert.equal(first.callId, 'call-1')
  const second = index.entries.get(JSON.stringify(['session-a', 1, 'call-1']))
  assert.equal(second.name, 'bash')
  const other = index.entries.get(JSON.stringify(['session-b', 0, 'call-1']))
  assert.equal(other.name, 'web_search')
})

it('AC-10a：同一 callId 跨会话不串', () => {
  const source = snapshot()
  const index = indexToolCalls(source)

  const a = toolDetailFor(source, { sessionId: 'session-a', turnIndex: 0, callId: 'call-1', index })
  const b = toolDetailFor(source, { sessionId: 'session-b', turnIndex: 0, callId: 'call-1', index })
  assert.equal(a.found, true)
  assert.equal(b.found, true)
  assert.equal(a.name, 'read')
  assert.equal(b.name, 'web_search')
  assert.equal(a.result, '文件甲')
  assert.equal(b.result, '结果乙')
  assert.notEqual(a.threadId, b.threadId)
  // The same callId in the same session but a different turn is a third record.
  const a2 = toolDetailFor(source, { sessionId: 'session-a', turnIndex: 1, callId: 'call-1', index })
  assert.equal(a2.name, 'bash')
  assert.equal(a2.status, TOOL_STATUS.error)

  // A session that never ran the call must MISS, not fall back to another
  // session's record with the same callId.
  const missing = toolDetailFor(source, { sessionId: 'session-c', turnIndex: 0, callId: 'call-1', index })
  assert.equal(missing.found, false)
  assert.equal(missing.reason, 'not-found')
  assert.equal(missing.sessionId, 'session-c')
})

it('AC-10a：模型输入（buildCanvasModel 结果）同样不串', () => {
  const source = snapshot()
  const model = buildCanvasModel(source)
  // The model carries thread summaries, not messages; the snapshot fields stay
  // reachable on the same object so the detail view can still index it.
  const index = indexToolCalls({ ...model, projection: source.projection })
  const a = toolDetailFor({ projection: source.projection }, { sessionId: 'session-a', turnIndex: 0, callId: 'call-1', index })
  const b = toolDetailFor({ projection: source.projection }, { sessionId: 'session-b', turnIndex: 0, callId: 'call-1', index })
  assert.equal(a.name, 'read')
  assert.equal(b.name, 'web_search')
  // A model whose threads were reduced to summaries yields no fabricated detail.
  const summaryOnly = indexToolCalls(model)
  assert.equal(summaryOnly.entries.size, 0)
  assert.equal(toolDetailFor(model, { sessionId: 'session-a', turnIndex: 0, callId: 'call-1', index: summaryOnly }).found, false)
})

it('toolDetailFor：命中时给出完整详情，未投影字段标 unavailable 并给字段名', () => {
  const source = {
    projection: { threads: [{
      id: 't-1',
      dshSessionId: 'session-x',
      messages: [
        user('u-1'),
        // No result yet, no error, and no name — three genuinely missing fields.
        assistant('as-1', [{ callId: 'c-1', arguments: '{"a":1}', result: null, error: null }]),
      ],
      pendingProcess: [],
    }] },
  }
  const detail = toolDetailFor(source, { sessionId: 'session-x', turnIndex: 0, callId: 'c-1' })
  assert.equal(detail.found, true)
  assert.equal(detail.name, null)
  assert.equal(detail.input, '{"a":1}')
  assert.equal(detail.result, null)
  assert.equal(detail.status, TOOL_STATUS.pending)
  assert.deepEqual([...detail.unavailable], ['name', 'result'])
  assert.equal(detail.fields.name.available, false)
  assert.equal(detail.fields.name.reason, 'not-projected')
  assert.equal(detail.fields.result.reason, 'not-returned-yet')
  assert.equal(detail.fields.input.available, true)
  // Missing values are never replaced with '' — that would look like a real result.
  assert.notEqual(detail.result, '')
})

it('toolDetailFor：空字符串结果是真实值，不算缺失', () => {
  const source = {
    projection: { threads: [{
      id: 't-1',
      dshSessionId: 'session-x',
      messages: [user('u-1'), assistant('as-1', [{ callId: 'c-1', name: 'bash', arguments: '', result: '', error: null }])],
      pendingProcess: [],
    }] },
  }
  const detail = toolDetailFor(source, { sessionId: 'session-x', turnIndex: 0, callId: 'c-1' })
  assert.equal(detail.result, '')
  assert.equal(detail.input, '')
  assert.equal(detail.fields.result.available, true)
  assert.equal(detail.fields.input.available, true)
  assert.deepEqual([...detail.unavailable], [])
  assert.equal(detail.status, TOOL_STATUS.done)
})

it('toolDetailFor：查找键不完整时明确报缺失项，不猜', () => {
  const source = snapshot()
  const index = indexToolCalls(source)
  for (const lookup of [
    { turnIndex: 0, callId: 'call-1' },
    { sessionId: 'session-a', callId: 'call-1' },
    { sessionId: 'session-a', turnIndex: 0 },
    { sessionId: '', turnIndex: 0, callId: 'call-1' },
    { sessionId: 'session-a', turnIndex: -1, callId: 'call-1' },
    { sessionId: 'session-a', turnIndex: 0.5, callId: 'call-1' },
    {},
  ]) {
    const result = toolDetailFor(source, { ...lookup, index })
    assert.equal(result.found, false, JSON.stringify(lookup))
    assert.equal(result.reason, 'incomplete-lookup')
    assert.ok(result.missing.length > 0)
  }
  assert.deepEqual(toolDetailFor(source, { index }).missing, ['sessionId', 'turnIndex', 'callId'])
  assert.deepEqual(toolDetailFor(source, { sessionId: 'session-a', turnIndex: 0, callId: 'call-1', index }).missing, [])
})

it('turnIndex 只数 user 消息：注入/assistant 消息不占序号', () => {
  const source = {
    projection: { threads: [{
      id: 't-1',
      dshSessionId: 'session-x',
      messages: [
        user('u-1'),
        { id: 'inj', kind: 'system', text: '注入内容', sourceSeq: 2, at: ISO },
        assistant('as-1', [record('c-1', 'read')]),
        user('u-2'),
        assistant('as-2', [record('c-2', 'bash')]),
      ],
      pendingProcess: [],
    }] },
  }
  const index = indexToolCalls(source)
  assert.equal(index.entries.get(JSON.stringify(['session-x', 0, 'c-1'])).name, 'read')
  assert.equal(index.entries.get(JSON.stringify(['session-x', 1, 'c-2'])).name, 'bash')
  // The injected text is never surfaced as a tool record.
  for (const detail of index.entries.values()) assert.notEqual(detail.name, '注入内容')
})

it('indexToolCalls：pendingProcess 归到最后一个 user 轮并标 pending', () => {
  const source = {
    projection: { threads: [{
      id: 't-1',
      dshSessionId: 'session-x',
      messages: [user('u-1'), assistant('as-1', [record('c-1', 'read')]), user('u-2')],
      pendingProcess: [{ callId: 'c-9', turn: 3, step: 1, name: 'bash', arguments: '{}', result: null, error: null }],
    }] },
  }
  const index = indexToolCalls(source)
  const pending = index.entries.get(JSON.stringify(['session-x', 1, 'c-9']))
  assert.equal(pending.name, 'bash')
  assert.equal(pending.pending, true)
  assert.equal(pending.status, TOOL_STATUS.pending)
  assert.equal(pending.hostTurn, 3)
  assert.equal(pending.hostStep, 1)
  // A thread with no user turn has nowhere to attribute pending records.
  const noTurn = indexToolCalls({ projection: { threads: [{ id: 't-2', dshSessionId: 'session-y', messages: [], pendingProcess: [{ callId: 'c-1', name: 'x' }] }] } })
  assert.equal(noTurn.entries.size, 0)
})

it('indexToolCalls：无 callId 的记录被跳过并计数，不共用空键', () => {
  const source = {
    projection: { threads: [{
      id: 't-1',
      dshSessionId: 'session-x',
      messages: [user('u-1'), assistant('as-1', [
        { name: 'anon-1', arguments: '{}', result: 'a', error: null },
        { callId: '', name: 'anon-2', arguments: '{}', result: 'b', error: null },
        record('c-1', 'read'),
      ])],
      pendingProcess: [],
    }] },
  }
  const index = indexToolCalls(source)
  assert.equal(index.entries.size, 1)
  assert.equal(index.skipped.length, 2)
  for (const skip of index.skipped) assert.equal(skip.reason, 'no-call-id')
  assert.equal(index.entries.has(JSON.stringify(['session-x', 0, ''])), false)
})

it('indexToolCalls：同一键的重复记录只保留第一条并记冲突', () => {
  const source = {
    projection: { threads: [{
      id: 't-1',
      dshSessionId: 'session-x',
      messages: [
        user('u-1'),
        assistant('as-1', [record('c-1', 'first', { result: '一' })]),
        assistant('as-2', [record('c-1', 'second', { result: '二' })]),
      ],
      pendingProcess: [],
    }] },
  }
  const index = indexToolCalls(source)
  assert.equal(index.entries.size, 1)
  assert.equal(index.entries.get(JSON.stringify(['session-x', 0, 'c-1'])).name, 'first')
  assert.deepEqual(index.conflicts, [{ sessionId: 'session-x', turnIndex: 0, callId: 'c-1' }])
})

it('indexToolCalls：没有 dshSessionId 时退回 threadId 并标注来源', () => {
  const source = {
    projection: { threads: [{
      id: 'thread-only',
      messages: [user('u-1'), assistant('as-1', [record('c-1', 'read')])],
      pendingProcess: [],
    }] },
  }
  const index = indexToolCalls(source)
  const detail = index.entries.get(JSON.stringify(['thread-only', 0, 'c-1']))
  assert.equal(detail.sessionId, 'thread-only')
  assert.equal(detail.sessionIdSource, 'threadId')
  assert.equal(index.skipped.length, 0)
})

it('toolStatus：error 优先于 done，未返回为 pending', () => {
  assert.equal(toolStatus({ result: 'ok', error: null }), TOOL_STATUS.done)
  assert.equal(toolStatus({ result: 'ok', error: 'boom' }), TOOL_STATUS.error)
  assert.equal(toolStatus({ result: null, error: null }), TOOL_STATUS.pending)
  assert.equal(toolStatus({ result: null, error: 'boom' }), TOOL_STATUS.error)
  assert.equal(toolStatus({}), TOOL_STATUS.pending)
  assert.equal(toolStatus(null), null)
})

it('失败调用保留 error，且不与返回字符串 "error" 混淆', () => {
  const source = {
    projection: { threads: [{
      id: 't-1',
      dshSessionId: 'session-x',
      messages: [user('u-1'), assistant('as-1', [
        { callId: 'c-fail', name: 'bash', arguments: '{}', result: '', error: '命令失败' },
        { callId: 'c-ok', name: 'bash', arguments: '{}', result: 'error', error: null },
      ])],
      pendingProcess: [],
    }] },
  }
  const failed = toolDetailFor(source, { sessionId: 'session-x', turnIndex: 0, callId: 'c-fail' })
  const ok = toolDetailFor(source, { sessionId: 'session-x', turnIndex: 0, callId: 'c-ok' })
  assert.equal(failed.error, '命令失败')
  assert.equal(failed.status, TOOL_STATUS.error)
  assert.equal(ok.error, null)
  assert.equal(ok.status, TOOL_STATUS.done)
  assert.equal(ok.result, 'error')
})

it('summarizeLongOutput：短输出原样返回', () => {
  const text = '短结果'
  assert.deepEqual(summarizeLongOutput(text, 10), { preview: text, truncated: false, totalChars: 3 })
  assert.deepEqual(summarizeLongOutput('', 10), { preview: '', truncated: false, totalChars: 0 })
})

it('summarizeLongOutput：长输出折叠，totalChars 仍是全文长度', () => {
  const text = 'x'.repeat(5000)
  const folded = summarizeLongOutput(text, 100)
  assert.equal(folded.truncated, true)
  assert.equal(folded.totalChars, 5000)
  assert.equal(folded.preview, 'x'.repeat(100) + TRUNCATION_SUFFIX)
  assert.ok(folded.preview.length < text.length)
  // The full text is not retained anywhere in the result.
  assert.equal(Object.hasOwn(folded, 'text'), false)
})

it('summarizeLongOutput：默认上限 4000，边界恰好等于上限不折叠', () => {
  const exactly = 'y'.repeat(DEFAULT_OUTPUT_LIMIT)
  const folded = summarizeLongOutput(exactly)
  assert.equal(folded.truncated, false)
  assert.equal(folded.preview, exactly)
  assert.equal(folded.totalChars, DEFAULT_OUTPUT_LIMIT)
  const over = summarizeLongOutput('y'.repeat(DEFAULT_OUTPUT_LIMIT + 1))
  assert.equal(over.truncated, true)
  assert.equal(over.totalChars, DEFAULT_OUTPUT_LIMIT + 1)
  assert.equal(over.preview.length, DEFAULT_OUTPUT_LIMIT + TRUNCATION_SUFFIX.length)
})

it('summarizeLongOutput：不切断代理对（emoji 不产生孤立代理）', () => {
  const text = '🚀'.repeat(5) // 10 UTF-16 units, 5 code points
  const folded = summarizeLongOutput(text, 4)
  assert.equal(folded.truncated, true)
  assert.equal(folded.preview, '🚀🚀' + TRUNCATION_SUFFIX)
  // No lone high surrogate at the cut.
  const last = folded.preview.charCodeAt(folded.preview.length - 1 - TRUNCATION_SUFFIX.length)
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), String(last))
})

it('summarizeLongOutput：limit 0 与非法参数', () => {
  assert.deepEqual(summarizeLongOutput('abc', 0), { preview: TRUNCATION_SUFFIX, truncated: true, totalChars: 3 })
  assert.deepEqual(summarizeLongOutput('', 0), { preview: '', truncated: false, totalChars: 0 })
  for (const limit of [-1, 1.5, Number.NaN, '10', null]) assert.throws(() => summarizeLongOutput('abc', limit), TypeError)
  assert.throws(() => summarizeLongOutput(1), TypeError)
})

it('toolCallsForTurn：按会话+轮列出，顺序与投影一致', () => {
  const source = {
    projection: { threads: [
      { id: 't-a', dshSessionId: 'session-a', messages: [user('u-a1'), assistant('as-a1', [record('c-1', 'read'), record('c-2', 'bash')]), user('u-a2'), assistant('as-a2', [record('c-3', 'edit')])], pendingProcess: [] },
      { id: 't-b', dshSessionId: 'session-b', messages: [user('u-b1'), assistant('as-b1', [record('c-1', 'web_search')])], pendingProcess: [] },
    ] },
  }
  const turn0 = toolCallsForTurn(source, { sessionId: 'session-a', turnIndex: 0 })
  assert.deepEqual(turn0.map(detail => detail.name), ['read', 'bash'])
  const turn1 = toolCallsForTurn(source, { sessionId: 'session-a', turnIndex: 1 })
  assert.deepEqual(turn1.map(detail => detail.name), ['edit'])
  const other = toolCallsForTurn(source, { sessionId: 'session-b', turnIndex: 0 })
  assert.deepEqual(other.map(detail => detail.name), ['web_search'])
  assert.deepEqual(toolCallsForTurn(source, { sessionId: 'session-a', turnIndex: 9 }), [])
  assert.deepEqual(toolCallsForTurn(source, { sessionId: '', turnIndex: 0 }), [])
  assert.deepEqual(toolCallsForTurn(source, {}), [])
})

it('返回值冻结，调用方无法改写详情', () => {
  const source = snapshot()
  const detail = toolDetailFor(source, { sessionId: 'session-a', turnIndex: 0, callId: 'call-1' })
  assert.ok(Object.isFrozen(detail))
  assert.ok(Object.isFrozen(detail.fields))
  assert.throws(() => { 'use strict'; detail.name = 'x' }, TypeError)
})

it('不重复执行工具：索引与查找都是纯读，输入快照不被修改', () => {
  const source = snapshot()
  const before = JSON.stringify(source)
  const index = indexToolCalls(source)
  toolDetailFor(source, { sessionId: 'session-a', turnIndex: 0, callId: 'call-1', index })
  toolDetailFor(source, { sessionId: 'session-b', turnIndex: 0, callId: 'call-1', index })
  summarizeLongOutput('x'.repeat(9000))
  assert.equal(JSON.stringify(source), before)
  // The index exposes only data — no callable that could run a tool.
  for (const detail of index.entries.values()) {
    for (const value of Object.values(detail)) assert.notEqual(typeof value, 'function')
  }
})
