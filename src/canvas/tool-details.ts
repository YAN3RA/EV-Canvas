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
 *
 * 类型口径：输入是不受信的快照/模型，一律 `unknown` 进、经守卫收窄；输出是本模块
 * 自己构造的冻结对象，用具名接口精确描述。
 */

/** Fields reported for one tool call, in display order. */
export const TOOL_DETAIL_FIELDS = Object.freeze(['name', 'input', 'result', 'status', 'at'])

/** Default character budget for `summarizeLongOutput`. */
export const DEFAULT_OUTPUT_LIMIT = 4000

/** Status values a tool record can resolve to. */
export const TOOL_STATUS = Object.freeze({ done: 'done', error: 'error', pending: 'pending' })

/** Long outputs end with this marker when folded (the raw text is untouched). */
export const TRUNCATION_SUFFIX = '…'

/** 工具调用状态。 */
export type ToolStatus = 'done' | 'error' | 'pending'

/** 一个详情字段的可用性。 */
export interface DetailField<T> {
  available: boolean;
  value: T | null;
  /** 仅在 `available === false` 时出现。 */
  reason?: string;
}

/** 详情里出现的五个字段。 */
export interface ToolDetailFields {
  name: DetailField<string>;
  input: DetailField<string>;
  result: DetailField<string>;
  status: DetailField<ToolStatus>;
  at: DetailField<string>;
}

/** 一个工具调用的详情（冻结）。 */
export interface ToolDetail {
  sessionId: string;
  sessionIdSource: string | null;
  threadId: string | null;
  turnIndex: number;
  callId: string;
  name: string | null;
  input: string | null;
  result: string | null;
  status: ToolStatus | null;
  at: string | null;
  pending: boolean;
  fields: ToolDetailFields;
  unavailable: string[];
  error: string | null;
  hostTurn: number | null;
  hostStep: number | null;
}

/** 被跳过的记录（无法定键）。 */
export interface SkippedToolRecord {
  reason: string;
  sessionId?: string;
  turnIndex?: number;
}

/** 同一键的重复记录。 */
export interface ConflictingToolRecord {
  sessionId: string;
  turnIndex: number;
  callId: string;
}

/** `indexToolCalls` 的产物。 */
export interface ToolCallIndex {
  entries: Map<string, ToolDetail>;
  skipped: SkippedToolRecord[];
  conflicts: ConflictingToolRecord[];
}

/** 查找入参：三部分缺一不可，可选传现成索引。 */
export interface ToolLookup {
  sessionId?: unknown;
  turnIndex?: unknown;
  callId?: unknown;
  index?: ToolCallIndex;
}

/** 查找结果：命中或未命中都有一个判别字段 `found`。 */
export type ToolLookupResult =
  | {
      found: true;
      reason: null;
      missing: string[];
      sessionId: string;
      turnIndex: number;
      callId: string;
      name: string | null;
      input: string | null;
      result: string | null;
      status: ToolStatus | null;
      at: string | null;
      pending: boolean;
      fields: ToolDetailFields;
      unavailable: string[];
      error: string | null;
      hostTurn: number | null;
      hostStep: number | null;
      sessionIdSource: string | null;
      threadId: string | null;
    }
  | {
      found: false;
      reason: 'incomplete-lookup' | 'not-found';
      missing: string[];
      sessionId: unknown;
      turnIndex: unknown;
      callId: unknown;
    };

/** `summarizeLongOutput` 的产物。 */
export interface FoldedOutput {
  preview: string;
  truncated: boolean;
  totalChars: number;
}

/** 线程边界：一个 user 轮在 messages 里的下标区间。 */
interface TurnBoundary {
  turnIndex: number;
  start: number;
  end: number;
}

/** 一条工具记录（形状不受信，只按需读取）。 */
type ToolRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value) as unknown as T
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    return Object.freeze(value) as unknown as T
  }
  return value
}

function messagesOf(thread: unknown): unknown[] {
  return isPlainObject(thread) && Array.isArray(thread['messages']) ? thread['messages'] : []
}

/**
 * Threads of a model or snapshot.
 *
 * Accepts the `buildCanvasModel` output (`model.threads` summaries), a raw
 * snapshot (`projection.threads`), or an explicit `{ threads }` bundle. Only
 * entries that still carry `messages` can yield tool records; a summary without
 * messages simply contributes nothing (never a guessed value).
 */
function threadsOf(model: unknown): unknown[] {
  if (!isPlainObject(model)) return []
  const projection = model['projection']
  if (isPlainObject(projection) && Array.isArray(projection['threads'])) return projection['threads']
  if (Array.isArray(model['threads'])) return model['threads']
  return []
}

/** 会话键：优先 DSH 会话 id，其次线程 id。 */
interface SessionKey {
  sessionId: string | null;
  source: string | null;
}

function sessionKeyOf(thread: unknown): SessionKey {
  if (isPlainObject(thread) && typeof thread['dshSessionId'] === 'string' && thread['dshSessionId'] !== '') {
    return { sessionId: thread['dshSessionId'], source: 'dshSessionId' }
  }
  if (isPlainObject(thread) && typeof thread['id'] === 'string' && thread['id'] !== '') return { sessionId: thread['id'], source: 'threadId' }
  return { sessionId: null, source: null }
}

/**
 * User-turn ordinals of one thread, matching `buildCanvasModel`'s
 * `userQuestionSeq`: projection order, 0-based, injected/non-user messages never
 * consume an ordinal.
 */
function turnBoundaries(thread: unknown): TurnBoundary[] {
  const turns: TurnBoundary[] = []
  const messages = messagesOf(thread)
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!isPlainObject(message) || message['kind'] !== 'user') continue
    turns.push({ turnIndex: turns.length, start: index, end: messages.length })
  }
  // `end` 在构造时先占位、这里统一覆盖为最终值（相邻 user 轮的起点，末轮取
  // 消息总数）——对外读到的 `end` 与旧版逐字一致，只是把两趟循环的字段填充
  // 顺序写进了类型。
  for (let index = 0; index < turns.length; index++) {
    const current = turns[index] as TurnBoundary
    const next = turns[index + 1]
    current.end = next === undefined ? messages.length : next.start
  }
  return turns
}

/** `pending` when the call has no result yet, `error` when it failed, else `done`. */
export function toolStatus(entry: unknown): ToolStatus | null {
  if (!isPlainObject(entry)) return null
  if (entry['error'] !== null && entry['error'] !== undefined && entry['error'] !== '') return TOOL_STATUS.error
  if (entry['result'] === null || entry['result'] === undefined) return TOOL_STATUS.pending
  return TOOL_STATUS.done
}

function entryAt(entry: unknown): string | null {
  if (isPlainObject(entry) && typeof entry['at'] === 'string') return entry['at']
  return null
}

function callIdOf(entry: unknown): string | null {
  if (isPlainObject(entry) && typeof entry['callId'] === 'string' && entry['callId'] !== '') return entry['callId']
  return null
}

function indexKey(sessionId: string, turnIndex: number, callId: string): string {
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
export function toolIndexKey(sessionId: string, turnIndex: number, callId: string): string {
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
export function indexToolCalls(model: unknown): ToolCallIndex {
  const entries = new Map<string, ToolDetail>()
  const skipped: SkippedToolRecord[] = []
  const conflicts: ConflictingToolRecord[] = []
  for (const thread of threadsOf(model)) {
    const { sessionId, source } = sessionKeyOf(thread)
    if (sessionId === null) {
      skipped.push({ reason: 'no-session-id' })
      continue
    }
    const turns = turnBoundaries(thread)
    const messages = messagesOf(thread)
    const threadId = isPlainObject(thread) && typeof thread['id'] === 'string' ? thread['id'] : null
    for (const turn of turns) {
      for (let index = turn.start; index < turn.end; index++) {
        const message = messages[index]
        if (!isPlainObject(message) || !Array.isArray(message['process'])) continue
        for (const record of message['process'] as unknown[]) {
          const callId = callIdOf(record)
          if (callId === null) {
            skipped.push({ reason: 'no-call-id', sessionId, turnIndex: turn.turnIndex })
            continue
          }
          const key = indexKey(sessionId, turn.turnIndex, callId)
          const detail = buildDetail({
            sessionId,
            sessionIdSource: source,
            threadId,
            turnIndex: turn.turnIndex,
            callId,
            record: isPlainObject(record) ? record : {},
            at: entryAt(record) ?? (typeof message['at'] === 'string' ? message['at'] : null),
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
    const rawPendingProcess = isPlainObject(thread) && Array.isArray(thread['pendingProcess']) ? thread['pendingProcess'] : []
    const pendingProcess = rawPendingProcess as unknown[]
    if (pendingProcess.length > 0 && turns.length > 0) {
      // `turns.length > 0` 已保证末项存在。
      const turn = turns[turns.length - 1] as TurnBoundary
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
          threadId,
          turnIndex: turn.turnIndex,
          callId,
          record: isPlainObject(record) ? record : {},
          at: entryAt(record),
          pending: true,
        }))
      }
    }
  }
  return { entries, skipped, conflicts }
}

function field<T>(value: T | null | undefined, reason?: string): DetailField<T> {
  return value === null || value === undefined
    ? { available: false, value: null, reason: reason ?? 'not-projected' }
    : { available: true, value }
}

/** `buildDetail` 的入参。 */
interface BuildDetailInput {
  sessionId: string;
  sessionIdSource: string | null;
  threadId: string | null;
  turnIndex: number;
  callId: string;
  record: ToolRecord;
  at: string | null;
  pending: boolean;
}

function buildDetail({ sessionId, sessionIdSource, threadId, turnIndex, callId, record, at, pending }: BuildDetailInput): ToolDetail {
  const name = typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : null
  const input = typeof record['arguments'] === 'string' ? record['arguments'] : null
  const result = typeof record['result'] === 'string' ? record['result'] : null
  const status = toolStatus(record)
  const fields: ToolDetailFields = {
    name: field(name, 'not-projected'),
    input: field(input, 'not-projected'),
    // `result === null` means the call has not returned yet (whether the record
    // sits on a message or is still in `pendingProcess`); an empty string is a
    // real, available result and never lands here.
    result: field(result, status === TOOL_STATUS.pending ? 'not-returned-yet' : 'not-projected'),
    status: field(status, 'not-projected'),
    at: field(at, 'no-timestamp'),
  }
  const unavailable = TOOL_DETAIL_FIELDS.filter(key => (fields[key as keyof ToolDetailFields]).available === false)
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
    // call that returned the string "error" must never be conflated.
    error: typeof record['error'] === 'string' ? record['error'] : null,
    hostTurn: Number.isSafeInteger(record['turn']) ? (record['turn'] as number) : null,
    hostStep: Number.isSafeInteger(record['step']) ? (record['step'] as number) : null,
  })
}

/**
 * One tool detail, or a `found: false` record naming the missing lookup parts.
 *
 * The lookup never falls back to "any session with this callId": all three key
 * parts must match, which is what makes AC-10a hold.
 */
export function toolDetailFor(model: unknown, lookup: ToolLookup = {}): ToolLookupResult {
  const { sessionId, turnIndex, callId } = lookup
  const missing: string[] = []
  if (typeof sessionId !== 'string' || sessionId === '') missing.push('sessionId')
  if (!Number.isSafeInteger(turnIndex) || (turnIndex as number) < 0) missing.push('turnIndex')
  if (typeof callId !== 'string' || callId === '') missing.push('callId')
  if (missing.length > 0) {
    return deepFreeze({ found: false, reason: 'incomplete-lookup', missing, sessionId: sessionId ?? null, turnIndex: turnIndex ?? null, callId: callId ?? null })
  }
  const index = lookup.index ?? indexToolCalls(model)
  const detail = index.entries.get(indexKey(sessionId as string, turnIndex as number, callId as string))
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
export function summarizeLongOutput(text: unknown, limit: unknown = DEFAULT_OUTPUT_LIMIT): FoldedOutput {
  if (typeof text !== 'string') throw new TypeError('summarizeLongOutput 需要字符串')
  if (!Number.isSafeInteger(limit) || (limit as number) < 0) throw new TypeError('limit 必须是非负安全整数')
  const budget = limit as number
  const totalChars = text.length
  if (totalChars <= budget) return { preview: text, truncated: false, totalChars }
  let cut = budget
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
export function toolCallsForTurn(model: unknown, { sessionId, turnIndex }: { sessionId?: unknown; turnIndex?: unknown } = {}): ToolDetail[] {
  if (typeof sessionId !== 'string' || sessionId === '') return []
  if (!Number.isSafeInteger(turnIndex) || (turnIndex as number) < 0) return []
  const index = indexToolCalls(model)
  const list: ToolDetail[] = []
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
