// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova@3fd1d00 canvas/tool-details.js，行为完整、类型标注待补。
// 来源: dsh-synapnova@3fd1d00 canvas/tool-details.js

/**
 * Tool-call details — pure projection of ALREADY-projected tool records.
 *
 * Pure module: no DOM, no Store, no host access, no IO. It reads the workspace
 * snapshot (the same object `buildCanvasModel` consumes) and answers "what
 * happened in this tool call?" without executing anything.
 *
 * Three rules this module exists to enforce:
 *
 * 1. **No re-execution.** A tool detail is a read of `process[]` entries the
 *    projection already stored. Nothing here calls a tool, replays an argument,
 *    or re-derives a result from the transcript.
 * 2. **No cross-session leakage (AC-10a).** The index key is the triple
 *    `(sessionId, turnIndex, callId)`. Host `callId`s are only unique per
 *    session, so a two-part key would let one conversation's `call-1` shadow
 *    another's. Every lookup carries all three parts.
 * 3. **No fabricated values.** A field that the projection did not carry is
 *    reported as `{ available: false, value: null }` and named in
 *    `unavailable[]`. An empty result string is a real value and is never
 *    confused with "missing".
 *
 * What is deliberately NOT read: `message.text`. A projected assistant message
 * may embed runtime-context/injected content that is not a tool record; treating
 * it as tool input would surface text the model never passed to a tool.
 */

/** Fields reported for one tool call, in display order. */
export const TOOL_DETAIL_FIELDS = Object.freeze(['name', 'input', 'result', 'status', 'at'])

/** Default character budget for `summarizeLongOutput`. */
export const DEFAULT_OUTPUT_LIMIT = 4000

/** Status values a tool record can resolve to. */
export const TOOL_STATUS = Object.freeze({ done: 'done', error: 'error', pending: 'pending' })

/** Long outputs end with this marker when folded (the raw text is untouched). */
export const TRUNCATION_SUFFIX = '…'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    return Object.freeze(value)
  }
  return value
}

function messagesOf(thread) {
  return Array.isArray(thread?.messages) ? thread.messages : []
}

/**
 * Threads of a model or snapshot.
 *
 * Accepts the `buildCanvasModel` output (`model.threads` summaries), a raw
 * snapshot (`projection.threads`), or an explicit `{ threads }` bundle. Only
 * entries that still carry `messages` can yield tool records; a summary without
 * messages simply contributes nothing (never a guessed value).
 */
function threadsOf(model) {
  if (!isPlainObject(model)) return []
  if (Array.isArray(model.projection?.threads)) return model.projection.threads
  if (Array.isArray(model.threads)) return model.threads
  return []
}

function sessionKeyOf(thread) {
  if (typeof thread?.dshSessionId === 'string' && thread.dshSessionId !== '') {
    return { sessionId: thread.dshSessionId, source: 'dshSessionId' }
  }
  if (typeof thread?.id === 'string' && thread.id !== '') return { sessionId: thread.id, source: 'threadId' }
  return { sessionId: null, source: null }
}

/**
 * User-turn ordinals of one thread, matching `buildCanvasModel`'s
 * `userQuestionSeq`: projection order, 0-based, injected/non-user messages never
 * consume an ordinal.
 */
function turnBoundaries(thread) {
  const turns = []
  const messages = messagesOf(thread)
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.kind !== 'user') continue
    turns.push({ turnIndex: turns.length, start: index })
  }
  for (let index = 0; index < turns.length; index++) {
    turns[index].end = index + 1 < turns.length ? turns[index + 1].start : messages.length
  }
  return turns
}

/** `pending` when the call has no result yet, `error` when it failed, else `done`. */
export function toolStatus(entry) {
  if (!isPlainObject(entry)) return null
  if (entry.error !== null && entry.error !== undefined && entry.error !== '') return TOOL_STATUS.error
  if (entry.result === null || entry.result === undefined) return TOOL_STATUS.pending
  return TOOL_STATUS.done
}

function entryAt(entry) {
  if (typeof entry?.at === 'string') return entry.at
  return null
}

function callIdOf(entry) {
  if (typeof entry?.callId === 'string' && entry.callId !== '') return entry.callId
  return null
}

function indexKey(sessionId, turnIndex, callId) {
  // A JSON tuple, not a delimiter join: session ids and call ids are opaque and
  // may themselves contain any delimiter we could pick.
  return JSON.stringify([sessionId, turnIndex, callId])
}

/**
 * The exact index key for one lookup.
 *
 * Exported so a caller (and the tests) can address `index.entries` without
 * duplicating the key format, and so a wrong key can never be silently spelled
 * differently in two places.
 */
export function toolIndexKey(sessionId, turnIndex, callId) {
  return indexKey(sessionId, turnIndex, callId)
}

/**
 * Build the `(sessionId, turnIndex, callId)` → detail index.
 *
 * Sources, in order of authority:
 * - `process[]` on assistant/error messages (the normal, folded shape);
 * - `thread.pendingProcess` (result arrived before its message was projected),
 *   attributed to the last user turn and flagged `pending: true`.
 *
 * Records with an empty/missing `callId` are counted in `skipped` instead of
 * being keyed under `''`, which would collide across every unnamed call.
 */
export function indexToolCalls(model) {
  const entries = new Map()
  const skipped = []
  const conflicts = []
  for (const thread of threadsOf(model)) {
    const { sessionId, source } = sessionKeyOf(thread)
    if (sessionId === null) {
      skipped.push({ reason: 'no-session-id' })
      continue
    }
    const turns = turnBoundaries(thread)
    const messages = messagesOf(thread)
    for (const turn of turns) {
      for (let index = turn.start; index < turn.end; index++) {
        const message = messages[index]
        if (!Array.isArray(message?.process)) continue
        for (const record of message.process) {
          const callId = callIdOf(record)
          if (callId === null) {
            skipped.push({ reason: 'no-call-id', sessionId, turnIndex: turn.turnIndex })
            continue
          }
          const key = indexKey(sessionId, turn.turnIndex, callId)
          const detail = buildDetail({
            sessionId,
            sessionIdSource: source,
            threadId: typeof thread.id === 'string' ? thread.id : null,
            turnIndex: turn.turnIndex,
            callId,
            record,
            at: entryAt(record) ?? (typeof message.at === 'string' ? message.at : null),
            pending: false,
          })
          if (entries.has(key)) {
            conflicts.push({ sessionId, turnIndex: turn.turnIndex, callId })
            continue
          }
          entries.set(key, detail)
        }
      }
    }
    // Thread-level pending records belong to the newest user turn: that is the
    // only turn that can still be running.
    const pendingProcess = Array.isArray(thread.pendingProcess) ? thread.pendingProcess : []
    if (pendingProcess.length > 0 && turns.length > 0) {
      const turn = turns[turns.length - 1]
      for (const record of pendingProcess) {
        const callId = callIdOf(record)
        if (callId === null) {
          skipped.push({ reason: 'no-call-id', sessionId, turnIndex: turn.turnIndex })
          continue
        }
        const key = indexKey(sessionId, turn.turnIndex, callId)
        if (entries.has(key)) continue
        entries.set(key, buildDetail({
          sessionId,
          sessionIdSource: source,
          threadId: typeof thread.id === 'string' ? thread.id : null,
          turnIndex: turn.turnIndex,
          callId,
          record,
          at: entryAt(record),
          pending: true,
        }))
      }
    }
  }
  return { entries, skipped, conflicts }
}

function field(value, reason) {
  return value === null || value === undefined
    ? { available: false, value: null, reason: reason ?? 'not-projected' }
    : { available: true, value }
}

function buildDetail({ sessionId, sessionIdSource, threadId, turnIndex, callId, record, at, pending }) {
  const name = typeof record.name === 'string' && record.name !== '' ? record.name : null
  const input = typeof record.arguments === 'string' ? record.arguments : null
  const result = typeof record.result === 'string' ? record.result : null
  const status = toolStatus(record)
  const fields = {
    name: field(name, 'not-projected'),
    input: field(input, 'not-projected'),
    // `result === null` means the call has not returned yet (whether the record
    // sits on a message or is still in `pendingProcess`); an empty string is a
    // real, available result and never lands here.
    result: field(result, status === TOOL_STATUS.pending ? 'not-returned-yet' : 'not-projected'),
    status: field(status, 'not-projected'),
    at: field(at, 'no-timestamp'),
  }
  const unavailable = TOOL_DETAIL_FIELDS.filter(key => fields[key].available === false)
  return deepFreeze({
    sessionId,
    sessionIdSource,
    threadId,
    turnIndex,
    callId,
    name,
    input,
    result,
    status,
    at,
    pending,
    fields,
    unavailable,
    // `error` is kept separate from `result` on purpose: a failed call and a
    // call that returned the string "error" must stay distinguishable.
    error: typeof record.error === 'string' ? record.error : null,
    hostTurn: Number.isSafeInteger(record.turn) ? record.turn : null,
    hostStep: Number.isSafeInteger(record.step) ? record.step : null,
  })
}

/**
 * One tool detail, or a `found: false` record naming the missing lookup parts.
 *
 * The lookup never falls back to "any session with this callId": all three key
 * parts must match, which is what makes AC-10a hold.
 */
export function toolDetailFor(model, lookup = {}) {
  const { sessionId, turnIndex, callId } = lookup
  const missing = []
  if (typeof sessionId !== 'string' || sessionId === '') missing.push('sessionId')
  if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) missing.push('turnIndex')
  if (typeof callId !== 'string' || callId === '') missing.push('callId')
  if (missing.length > 0) {
    return deepFreeze({ found: false, reason: 'incomplete-lookup', missing, sessionId: sessionId ?? null, turnIndex: turnIndex ?? null, callId: callId ?? null })
  }
  const index = lookup.index ?? indexToolCalls(model)
  const detail = index.entries.get(indexKey(sessionId, turnIndex, callId))
  if (detail === undefined) {
    return deepFreeze({ found: false, reason: 'not-found', missing: [], sessionId, turnIndex, callId })
  }
  return deepFreeze({ found: true, reason: null, missing: [], ...detail })
}

/**
 * Fold a long tool output for display.
 *
 * `limit` is the character budget (default 4000, caller-configurable). Returns
 * `{ preview, truncated, totalChars }`; `totalChars` is always the FULL length,
 * so a caller can render "1 234 / 18 000 字符" without keeping the raw text.
 *
 * The cut never splits a surrogate pair, so `preview` stays valid UTF-16.
 */
export function summarizeLongOutput(text, limit = DEFAULT_OUTPUT_LIMIT) {
  if (typeof text !== 'string') throw new TypeError('summarizeLongOutput 需要字符串')
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit 必须是非负安全整数')
  const totalChars = text.length
  if (totalChars <= limit) return { preview: text, truncated: false, totalChars }
  let cut = limit
  // A high surrogate at the boundary means the pair would be split; back off by
  // one so the preview does not end with a lone surrogate.
  const code = text.charCodeAt(cut - 1)
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1
  return { preview: text.slice(0, cut) + TRUNCATION_SUFFIX, truncated: true, totalChars }
}

/**
 * Every tool call of one turn, in projection order.
 *
 * Convenience for the detail panel: it uses the same index, so the panel and a
 * single lookup can never disagree.
 */
export function toolCallsForTurn(model, { sessionId, turnIndex } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return []
  if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) return []
  const index = indexToolCalls(model)
  const list = []
  for (const detail of index.entries.values()) {
    if (detail.sessionId === sessionId && detail.turnIndex === turnIndex) list.push(detail)
  }
  return list
}

export default {
  TOOL_DETAIL_FIELDS,
  DEFAULT_OUTPUT_LIMIT,
  TOOL_STATUS,
  TRUNCATION_SUFFIX,
  toolStatus,
  toolIndexKey,
  indexToolCalls,
  toolDetailFor,
  summarizeLongOutput,
  toolCallsForTurn,
}
