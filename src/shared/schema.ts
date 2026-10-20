// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova shared/schema.js，89 处缺类型标注。
// 行为已由 52 套旧测试覆盖；类型补全单独一轮做，不与行为迁移混在一起。

/**
 * EV Canvas · 顶层文档结构与校验
 * 来源：dsh-synapnova@3fd1d00 shared/schema.js（494 行）
 * 变更：FROZEN_FORMAT 改 'dsh-evcanvas'（D23）；其余校验逻辑原样保留。
 *
 * 保留原因：这套守卫是旧版唯一经过 52 套测试验证的输入校验层，
 * 重写只会引入新漏洞。八类节点的新校验追加在节点层（见 node-schema.ts）。
 *
 * --- 以下为原文件说明（保留）---
 * Synapnova persistence schema.
 *
 *
 * Single owner of the on-disk document shape, its legacy version migrations,
 * and the field validators every write path must go through. Pure module: no
 * filesystem and no host access — `server/workspace-store.js` performs IO,
 * this file only decides whether a value is a legal Synapnova document and how
 * older versions normalise into the current one.
 *
 * This module is ALSO served to the browser: `app.js` imports it so the canvas
 * and the server share one attribute judgment. It therefore must not import any
 * `node:` specifier — a bare `node:crypto` import makes Chromium fail to resolve
 * the module graph, which took the whole canvas down as a white screen with
 * `node:crypto ... net::ERR_FAILED` in the console. Both runtimes expose
 * `globalThis.crypto.randomUUID` (Node >= 19, and every browser that can run ES
 * modules), so the helper reads the global instead of importing it.
 */

const randomUUID = () => globalThis.crypto.randomUUID()

// Legacy v4 remains readable for explicit migration only; frozen writes use the separate v1 root below.
export const LEGACY_SCHEMA_VERSION = 4
export const SCHEMA_VERSION = 1
export const FROZEN_FORMAT = 'dsh-evcanvas'
export const FROZEN_SCHEMA_VERSION = SCHEMA_VERSION
export const MAX_TITLE_LENGTH = 120
export const MAX_NOTE_LENGTH = 4_000
// Projected message text cap: longer replies truncate with a marker pointing
// at the detail view instead of silently cutting mid-sentence.
export const MAX_PROJECTION_LENGTH = 8_000
export const PROJECTION_TRUNCATED_SUFFIX = '\n——…（详情查看全文）'
export const TOPIC_COLORS = ['#0f766e', '#2563eb', '#be123c', '#7c3aed', '#b45309']

// 错误类不在此定义：从 errors.ts 重导出，保证全仓库只有一套类，
// `instanceof` 才能跨模块成立（历史教训：两套同名类让「store 抛 NotFoundError
// → 路由映射 404」静默退化成 500）。
export { InputError, NotFoundError, RevisionConflictError, IdempotencyExpiredError } from './errors'
import { IdempotencyExpiredError, InputError, NotFoundError, RevisionConflictError } from './errors'
export const IDEMPOTENCY_LIMIT = 200
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function createFrozenState(now = new Date().toISOString()) {
  return { format: FROZEN_FORMAT, schemaVersion: FROZEN_SCHEMA_VERSION, updatedAt: now, hiddenSessionIds: [], idempotency: {}, idempotencyFloor: null, workspaces: [] }
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new InputError(`${field} 必须是正安全整数`)
  return value
}
/**
 * Strict ISO-8601 calendar timestamp validator — the single time-literal owner.
 *
 * `Date.parse` is far too permissive for a persisted format: it accepts
 * date-only strings, `2026/01/01`, surrounding whitespace, lower-case `t`/`z`,
 * and rolls impossible days (2026-02-29) into the next month instead of
 * rejecting them. A projection file whose times are ambiguous cannot be sorted,
 * diffed or compared for an idempotency window, so the on-disk literal is
 * pinned to `YYYY-MM-DDTHH:mm:ss` + optional 1–3 fraction digits + `Z` or
 * `±HH:mm`. The input string is returned untouched: validation must never
 * rewrite a stored timestamp into a different spelling.
 */
const ISO_DATE_LITERAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const ISO_DATE_MESSAGE = field => `${field} 必须是严格 ISO8601 时间：YYYY-MM-DDTHH:mm:ss（可选 1–3 位毫秒）后接 Z 或 ±HH:mm`

export function isoDate(value, field) {
  const message = ISO_DATE_MESSAGE(field)
  if (typeof value !== 'string') throw new InputError(message)
  const match = ISO_DATE_LITERAL.exec(value)
  if (match === null) throw new InputError(message)
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6])
  if (month < 1 || month > 12) throw new InputError(message)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const lastDay = month === 2 && leap ? 29 : DAYS_PER_MONTH[month - 1]
  if (day < 1 || day > lastDay) throw new InputError(message)
  if (hour > 23 || minute > 59 || second > 59) throw new InputError(message)
  // A `±24:00` offset or a 60-minute offset is not a real UTC offset; only the
  // stated clock range is allowed, never a silently normalized value.
  if (match[8] !== undefined && (Number(match[9]) > 23 || Number(match[10]) > 59)) throw new InputError(message)
  return value
}
function objectOf(value, field) {
  if (!isPlainObject(value)) throw new InputError(`${field} 必须是对象`)
  return value
}
function cleanMap(value, field, normalize) {
  const result = Object.create(null)
  for (const [key, entry] of Object.entries(objectOf(value, field))) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new InputError(`${field} 包含非法键`)
    result[key] = normalize(entry)
  }
  return result
}
function exactPosition(value) {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) throw new InputError('坐标必须是有限数值')
  return { x: value.x, y: value.y }
}
function normalizeCoverage(value) {
  objectOf(value, 'coverage')
  if (!Array.isArray(value.ranges) || value.ranges.some(range => !Array.isArray(range) || range.length !== 2 || !isEventSeq(range[0]) || !isEventSeq(range[1]) || range[0] > range[1])) throw new InputError('coverage.ranges 非法')
  if (typeof value.historyComplete !== 'boolean' || typeof value.textTruncated !== 'boolean') throw new InputError('coverage 完整性标记必须是 boolean')
  return { ranges: value.ranges.map(range => [...range]), historyComplete: value.historyComplete, textTruncated: value.textTruncated }
}
export function normalizeFrozenState(value) {
  if (value?.format !== FROZEN_FORMAT) throw new InputError('format 必须是 dsh-evcanvas；旧格式请显式迁移')
  if (value.schemaVersion !== FROZEN_SCHEMA_VERSION) throw new InputError(`不支持 schemaVersion=${value.schemaVersion}，请使用兼容版本或显式迁移`)
  if (!Array.isArray(value.workspaces) || !Array.isArray(value.hiddenSessionIds) || value.hiddenSessionIds.some(id => typeof id !== 'string')) throw new InputError('workspaces/hiddenSessionIds 非法')
  const state = createFrozenState(isoDate(value.updatedAt, 'updatedAt'))
  state.hiddenSessionIds = [...value.hiddenSessionIds]
  if (value.idempotencyFloor != null && !UUID_V7.test(value.idempotencyFloor)) throw new InputError('idempotencyFloor 必须是小写 UUIDv7')
  state.idempotencyFloor = value.idempotencyFloor ?? null
  state.idempotency = cleanMap(value.idempotency, 'idempotency', entry => {
    objectOf(entry, 'idempotency entry')
    if (!/^[0-9a-f]{64}$/.test(entry.hash) || typeof entry.workspaceId !== 'string' || !isPlainObject(entry.response)) throw new InputError('idempotency entry 非法')
    const response = JSON.parse(JSON.stringify(entry.response))
    if (response.revision !== entry.revision || !Object.hasOwn(response, 'result')) throw new InputError('idempotency 首次响应不完整')
    return { hash: entry.hash, workspaceId: entry.workspaceId, revision: positiveInteger(entry.revision, 'revision'), at: isoDate(entry.at, 'at'), response }
  })
  if (Object.keys(state.idempotency).length > IDEMPOTENCY_LIMIT || Object.keys(state.idempotency).some(id => !UUID_V7.test(id))) throw new InputError('idempotency 必须是最多 200 条 UUIDv7 记录')
  state.workspaces = value.workspaces.map(raw => {
    objectOf(raw, 'workspace')
    const workspace = pickFields(raw, WORKSPACE_FIELDS)
    workspace.kind = raw.kind ?? 'manual'
    if (!['dsh', 'manual'].includes(workspace.kind)) throw new InputError('workspace.kind 非法')
    workspace.revision = positiveInteger(raw.revision, 'revision')
    workspace.projectionEpoch = positiveInteger(raw.projectionEpoch, 'projectionEpoch')
    workspace.createdAt = isoDate(raw.createdAt, 'createdAt')
    workspace.updatedAt = isoDate(raw.updatedAt, 'updatedAt')
    if (!Array.isArray(raw.projection?.threads)) throw new InputError('projection.threads 必须是数组')
    workspace.projection = { threads: raw.projection.threads.map(rawThread => {
      objectOf(rawThread, 'thread')
      const thread = pickFields(rawThread, THREAD_FIELDS.filter(field => field !== 'position'))
      // Thread times are optional in the frozen shape (older writers may omit
      // them); when present they must still be a strict ISO literal.
      if (thread.createdAt !== undefined) isoDate(thread.createdAt, 'thread.createdAt')
      if (thread.updatedAt !== undefined) isoDate(thread.updatedAt, 'thread.updatedAt')
      if (!Array.isArray(rawThread.messages)) throw new InputError('thread.messages 必须是数组')
      thread.messages = rawThread.messages.map(rawMessage => {
        const message = normalizeMessage(rawMessage)
        if (message.at !== undefined) isoDate(message.at, 'message.at')
        return message
      })
      thread.pendingProcess = normalizeProcessList(rawThread.pendingProcess)
      thread.coverage = normalizeCoverage(rawThread.coverage ?? { ranges: [], historyComplete: false, textTruncated: false })
      return thread
    }) }
    objectOf(raw.layout, 'layout')
    workspace.layout = {
      cards: cleanMap(raw.layout.cards, 'layout.cards', exactPosition),
      collapsed: cleanMap(raw.layout.collapsed, 'layout.collapsed', entry => {
        if (typeof entry !== 'boolean') throw new InputError('collapsed 必须是 boolean')
        return entry
      }),
      viewport: { ...exactPosition(raw.layout.viewport), zoom: raw.layout.viewport?.zoom },
    }
    if (!Number.isFinite(workspace.layout.viewport.zoom) || workspace.layout.viewport.zoom <= 0) throw new InputError('viewport.zoom 必须为有限正数')
    for (const [field, fields] of Object.entries({ materials: ['id', 'name', 'importedAt', 'bytes', 'text'], regions: ['id', 'name', 'x', 'y', 'w', 'h'], annotations: ['id', 'x', 'y', 'text', 'targetCardId', 'targetRegionId'] })) {
      if (!Array.isArray(raw[field])) throw new InputError(`${field} 必须是数组`)
      const ids = new Set()
      workspace[field] = raw[field].map(item => {
        objectOf(item, field)
        if (typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id) || ids.has(item.id)) throw new InputError(`${field}.id 必须是唯一 UUID`)
        ids.add(item.id)
        if (field === 'materials') {
          if (typeof item.name !== 'string' || typeof item.text !== 'string') throw new InputError('material name/text 必须是文本')
          isoDate(item.importedAt, 'importedAt')
          if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 2 * 1024 * 1024 || Buffer.byteLength(item.text, 'utf8') > 2 * 1024 * 1024) throw new InputError('material 超出 2MiB 字节上限')
        } else {
          exactPosition(item)
          if (field === 'regions') {
            if (typeof item.name !== 'string' || !Number.isFinite(item.w) || !Number.isFinite(item.h) || item.w <= 0 || item.h <= 0) throw new InputError('region 名称或尺寸非法')
          } else {
            if (typeof item.text !== 'string') throw new InputError('annotation.text 必须是文本')
            const hasCard = Object.hasOwn(item, 'targetCardId')
            const hasRegion = Object.hasOwn(item, 'targetRegionId')
            if (hasCard === hasRegion || typeof item[hasCard ? 'targetCardId' : 'targetRegionId'] !== 'string' || item[hasCard ? 'targetCardId' : 'targetRegionId'].length === 0) throw new InputError('annotation 必须恰好指定一个非空文本来源')
          }
        }
        return pickFields(item, fields)
      })
    }
    return workspace
  })
  assertDocumentIntegrity({ workspaces: state.workspaces.map(workspace => ({ id: workspace.id, threads: workspace.projection.threads })) })
  return { state, migrated: false }
}
export function assertFrozenDocument(value) {
  normalizeFrozenState(value)
}


/**
 * The documented field whitelist.
 *
 * Everything outside these lists is dropped while a document is normalised, so
 * an unknown or hostile key can never reach the runtime object — including
 * `__proto__`, which `JSON.parse` keeps as an ordinary own data property and a
 * naive spread would happily carry forward.
 */
const WORKSPACE_FIELDS = ['id', 'kind', 'dshWorkspaceId', 'cwd', 'title', 'createdAt', 'updatedAt']
const THREAD_FIELDS = ['id', 'title', 'parentId', 'sourceParentSessionId', 'sourceSeedLength', 'dshSessionId', 'dshSessionTitle', 'color', 'position', 'createdAt', 'updatedAt']
const MESSAGE_FIELDS = ['id', 'text', 'kind', 'sourceSeq', 'at', 'turn', 'step']
const PROCESS_FIELDS = ['callId', 'turn', 'step', 'name', 'arguments', 'result', 'error']

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEventSeq(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/** Copy only whitelisted own fields; never spread a document we did not build. */
function pickFields(value, fields) {
  const result = {}
  for (const field of fields) {
    if (Object.hasOwn(value, field) && value[field] !== undefined) result[field] = value[field]
  }
  return result
}

function normalizeProcessList(value) {
  if (!Array.isArray(value)) return []
  return value.filter(isPlainObject).map(entry => pickFields(entry, PROCESS_FIELDS))
}

function normalizeMessage(value) {
  if (!isPlainObject(value)) throw new InputError('message 必须是对象')
  const message = pickFields(value, MESSAGE_FIELDS)
  if (message.sourceSeq !== undefined && !isEventSeq(message.sourceSeq)) throw new InputError('sourceSeq 必须是非负安全整数')
  if (Array.isArray(value.process)) message.process = normalizeProcessList(value.process)
  return message
}

function normalizeThread(value, markMigrated) {
  if (!isPlainObject(value)) throw new InputError('thread 必须是对象')
  const thread = pickFields(value, THREAD_FIELDS)
  if (Array.isArray(value.messages)) {
    const kept = value.messages.filter(message => !isRuntimeContextMessage(message))
    if (kept.length !== value.messages.length) markMigrated()
    thread.messages = kept.map(normalizeMessage)
    thread.pendingProcess = normalizeProcessList(value.pendingProcess)
    return thread
  }
  // A thread written by an older version kept its notes directly, with no
  // message/process split yet.
  markMigrated()
  thread.messages = (Array.isArray(value.notes) ? value.notes : []).map(normalizeMessage)
  thread.pendingProcess = []
  return thread
}

/**
 * Reject a document that is internally inconsistent.
 *
 * Duplicate entity ids and duplicate event keys are refused rather than
 * silently de-duplicated: a duplicate means two writers disagreed, and picking
 * one of them at load time would hide the divergence.
 */
export function assertDocumentIntegrity(state) {
  const workspaceIds = new Set()
  const threadIds = new Set()
  for (const workspace of state.workspaces) {
    if (typeof workspace.id !== 'string' || workspace.id === '') throw new InputError('workspace.id 必须是非空字符串')
    if (workspaceIds.has(workspace.id)) throw new InputError(`重复的 workspace id: ${workspace.id}`)
    workspaceIds.add(workspace.id)
    for (const thread of workspace.threads ?? []) {
      if (typeof thread.id !== 'string' || thread.id === '') throw new InputError('thread.id 必须是非空字符串')
      if (threadIds.has(thread.id)) throw new InputError(`重复的 thread id: ${thread.id}`)
      threadIds.add(thread.id)
      if (thread.position !== undefined) {
        if (!Number.isFinite(thread.position?.x) || !Number.isFinite(thread.position?.y)) throw new InputError(`thread ${thread.id} 的 position 必须包含有限坐标`)
      }
      const messageIds = new Set()
      const seenSeqs = new Set()
      for (const message of thread.messages ?? []) {
        if (typeof message.id !== 'string' || message.id === '') throw new InputError('message.id 必须是非空字符串')
        if (messageIds.has(message.id)) throw new InputError(`重复的 message id: ${message.id}`)
        messageIds.add(message.id)
        if (message.sourceSeq === undefined) continue
        if (seenSeqs.has(message.sourceSeq)) throw new InputError(`thread ${thread.id} 中重复的事件键 seq: ${message.sourceSeq}`)
        seenSeqs.add(message.sourceSeq)
      }
    }
  }
}

export function normalizeState(value) {
  if (Object.hasOwn(value ?? {}, 'format') || Object.hasOwn(value ?? {}, 'schemaVersion')) return normalizeFrozenState(value)
  return normalizeLegacyState(value)
}

// Read-only legacy compatibility; Slice 7 explicitly converts this result.
// Never label the legacy v4 result as frozen v1.
export function normalizeLegacyState(value) {
  let migrated = false
  const markMigrated = () => { migrated = true }
  let state
  if ((value?.version === 2 || value?.version === 3 || value?.version === LEGACY_SCHEMA_VERSION) && Array.isArray(value.workspaces)) {
    const hiddenSessionIds = Array.isArray(value.hiddenSessionIds) ? value.hiddenSessionIds.filter(item => typeof item === 'string') : []
    migrated = value.version < 3 || !Array.isArray(value.hiddenSessionIds)
    const workspaces = value.workspaces.filter(isPlainObject).map(workspace => {
      const normalized = pickFields(workspace, WORKSPACE_FIELDS)
      normalized.threads = Array.isArray(workspace.threads)
        ? workspace.threads.filter(isPlainObject).map(thread => normalizeThread(thread, markMigrated))
        : []
      return normalized
    })
    state = { version: value.version, hiddenSessionIds, workspaces }
    if (typeof value.updatedAt === 'string') state.updatedAt = value.updatedAt
  } else if (value?.version === 1 && Array.isArray(value.workspaces)) {
    const now = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
    state = {
      version: 3,
      hiddenSessionIds: [],
      workspaces: value.workspaces.map((workspace, index) => {
        const events = Array.isArray(workspace.events) ? workspace.events : []
        const workspaceNow = typeof workspace.updatedAt === 'string' ? workspace.updatedAt : now
        return {
          id: typeof workspace.id === 'string' ? workspace.id : randomUUID(),
          title: typeof workspace.title === 'string' && workspace.title.trim() ? workspace.title : '未命名工作空间',
          createdAt: typeof workspace.createdAt === 'string' ? workspace.createdAt : workspaceNow,
          updatedAt: workspaceNow,
          threads: events.length === 0 ? [] : [{
            id: randomUUID(), title: workspace.title || '历史记录', parentId: null, dshSessionId: null, dshSessionTitle: null,
            color: TOPIC_COLORS[index % TOPIC_COLORS.length], position: { x: 86, y: 82 }, createdAt: workspaceNow, updatedAt: workspaceNow,
            messages: events.map(event => ({ id: typeof event.id === 'string' ? event.id : randomUUID(), text: String(event.text ?? ''), at: typeof event.at === 'string' ? event.at : workspaceNow })),
          }],
        }
      }),
    }
    migrated = true
  } else {
    throw new Error('expected Synapnova data version 1, 2, 3, or 4')
  }
  if (state.version !== LEGACY_SCHEMA_VERSION) {
    if (foldLegacyToolCards(state.workspaces)) migrated = true
    state.version = LEGACY_SCHEMA_VERSION
    migrated = true
  }
  assertDocumentIntegrity(state)
  return { state, migrated }
}

/**
 * Fold v3-era standalone tool cards (kinds `tool` / `tool-result`) into the
 * preceding assistant message's `process` list, pairing each call with the
 * result that follows it in order, so every tool invocation lives in one
 * home: the assistant turn card.
 */
export function foldLegacyToolCards(workspaces) {
  let changed = false
  for (const workspace of workspaces) {
    for (const thread of workspace.threads ?? []) {
      if (!Array.isArray(thread.messages)) continue
      const folded = []
      let assistant = null
      let pending = []
      for (const message of thread.messages) {
        if (message.kind === 'assistant') {
          assistant = message
          assistant.process ??= []
          pending = []
          folded.push(message)
          continue
        }
        if (message.kind !== 'tool' && message.kind !== 'tool-result') {
          folded.push(message)
          continue
        }
        if (assistant === null) {
          folded.push(message)
          continue
        }
        changed = true
        if (message.kind === 'tool') {
          const [name = '工具调用', ...argumentLines] = message.text.split('\n')
          const entry = { callId: `legacy-${assistant.process.length}`, name, arguments: argumentLines.join('\n'), result: null, error: null }
          pending.push(entry)
          assistant.process.push(entry)
        } else {
          const entry = pending.shift() ?? (() => {
            const orphan = { callId: `legacy-orphan-${assistant.process.length}`, name: '工具调用', arguments: null, result: null, error: null }
            assistant.process.push(orphan)
            return orphan
          })()
          entry.result = message.text
        }
      }
      thread.messages = folded
    }
  }
  return changed
}

export function positionOf(value) {
  const x = Number(value?.x)
  const y = Number(value?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new InputError('position 必须包含有效坐标')
  return { x: Math.round(Math.max(-2000, Math.min(5000, x))), y: Math.round(Math.max(-2000, Math.min(5000, y))) }
}

export function requiredText(value, maxLength, field) {
  if (typeof value !== 'string') throw new InputError(`${field} 必须是文本`)
  const text = value.trim()
  if (text.length === 0) throw new InputError(`${field} 不能为空`)
  if (text.length > maxLength) throw new InputError(`${field} 超过长度限制`)
  return text
}

/**
 * The one `source.kind` value that means "a human wrote this".
 *
 * DSH v4 admission (`assertV4MessageSources` -> `source()`) only requires a
 * non-empty string that is not the retired literal `plugin`, so `kind` is an
 * OPEN set, not a closed enum. Real local logs already carry `user`,
 * `agent-instructions`, `runtime-context`, `skill-catalog`, `time-context`,
 * `plugin:dsh-project-memory`, `plugin:aegis`, `agent-message`,
 * `subagent-settled`, `schedule`, `model-selection`, `user-approval`,
 * `dsh-rewind` and `compact-checkpoint`. Attribution therefore has to be
 * decided by "is this the human kind", never by enumerating injected kinds: a
 * new injection source must be rejected without a code change.
 */
export const USER_MESSAGE_SOURCE_KIND = 'user'

/** `message.source.kind` when it is a usable attribution, otherwise null. */
export function messageSourceKind(message) {
  const kind = message?.source?.kind
  return typeof kind === 'string' && kind !== '' ? kind : null
}

/**
 * Three-way source verdict for one DSH message.
 *
 * - `user`     — attributed to the human (`source.kind === 'user'`)
 * - `injected` — attributed to any other producer
 * - `unknown`  — no attribution at all (legacy rows); the caller must fall back
 *                to text heuristics rather than guess an attribution
 *
 * Returning `unknown` instead of defaulting to either side is what keeps old
 * projections readable: dropping every unattributed row would silently erase
 * history, and accepting every unattributed row would readmit injections.
 */
export function messageSourceVerdict(message) {
  const kind = messageSourceKind(message)
  if (kind === null) return 'unknown'
  return kind === USER_MESSAGE_SOURCE_KIND ? 'user' : 'injected'
}

/**
 * The messages one committed event carries, across both durable carriers.
 *
 * `user/message` keeps a single message in `data`; `agent/inbox/spliced` stages
 * queued messages in `data.inserted[]`. Both carry the same `source`
 * attribution shape, so both must be judged by the same rule.
 */
export function eventMessages(event) {
  if (event === null || typeof event !== 'object') return []
  if (event.type === 'user/message') return event.data !== null && typeof event.data === 'object' ? [event.data] : []
  if (event.type === 'agent/inbox/spliced') return Array.isArray(event.data?.inserted) ? event.data.inserted : []
  return []
}

/**
 * Plain-text runtime-context detector. Kept as a pure text tool for the
 * unattributed fallback path (`messageSourceVerdict(...) === 'unknown'`); it is
 * deliberately no longer the only criterion for admitting a `user/message`.
 */
export function isRuntimeContextText(text) {
  return typeof text === 'string' && text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
}

/**
 * Legacy fallback for messages already persisted in the frozen document.
 *
 * `MESSAGE_FIELDS` deliberately does not carry `source` (the field table is
 * frozen), so a persisted message can never be attributed — it is exactly the
 * `unknown` case above, and the text heuristic is the only criterion available
 * for it. This is not the admission rule for incoming events.
 */
export function isRuntimeContextMessage(message) {
  return message?.kind === 'user' && isRuntimeContextText(message.text)
}
