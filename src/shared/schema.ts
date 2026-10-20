/**
 * EV Canvas · 顶层文档结构与校验
 * 来源: dsh-synapnova@3fd1d00 shared/schema.js（494 行）
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
 *
 * ---
 * 类型口径（本轮新增，零行为变更）：
 * 本文件是**不受信输入的边界**，因此每个导出的校验器都以 `unknown` 收窄，返回
 * 自己构造的精确形状。归一化过程本身是「逐步往字典里填字段」，中间态用
 * `Record<string, unknown>` 承载，只在入口/出口断言到具名接口——把每个中间态
 * 也建成独立类型不会提高安全性（每一步都已经过它自己的校验器），只会让校验
 * 逻辑与类型定义互相纠缠。**所有判定表达式、错误文案与执行顺序逐字保留。**
 */

const randomUUID = (): string => globalThis.crypto.randomUUID()

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

/** 二维坐标。 */
export interface SchemaPosition {
  x: number;
  y: number;
}

/** 一个已提交写入的幂等记录。 */
export interface IdempotencyEntry {
  hash: string;
  workspaceId: string;
  revision: number;
  at: string;
  response: Record<string, unknown>;
}

/** 一条投影消息（冻结文档里的形状；字段白名单见 MESSAGE_FIELDS）。 */
export interface FrozenMessage {
  id: string;
  text?: string;
  kind?: string;
  sourceSeq?: number;
  at?: string;
  turn?: number;
  step?: number;
  process?: Record<string, unknown>[];
}

/** 一条工具过程记录（PROCESS_FIELDS 白名单）。 */
export interface FrozenProcessEntry {
  callId?: string;
  turn?: number;
  step?: number;
  name?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
}

/** 覆盖率声明。 */
export interface FrozenCoverage {
  ranges: number[][];
  historyComplete: boolean;
  textTruncated: boolean;
}

/** 一条投影线程。 */
export interface FrozenThread {
  id: string;
  title?: string;
  parentId?: string | null;
  sourceParentSessionId?: string | null;
  sourceSeedLength?: number;
  dshSessionId?: string | null;
  dshSessionTitle?: string | null;
  color?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messages: FrozenMessage[];
  pendingProcess: FrozenProcessEntry[];
  coverage: FrozenCoverage;
}

/** 布局包。 */
export interface FrozenLayout {
  cards: Record<string, SchemaPosition>;
  collapsed: Record<string, boolean>;
  viewport: { x: number; y: number; zoom: number };
}

/** 材料。 */
export interface FrozenMaterial {
  id: string;
  name: string;
  importedAt: string;
  bytes: number;
  text: string;
}

/** 分区。 */
export interface FrozenRegion extends SchemaPosition {
  id: string;
  name: string;
  w: number;
  h: number;
}

/** 批注。 */
export interface FrozenAnnotation extends SchemaPosition {
  id: string;
  text: string;
  targetCardId?: string;
  targetRegionId?: string;
}

/** 一个工作区。 */
export interface FrozenWorkspace {
  id: string;
  kind: 'dsh' | 'manual';
  dshWorkspaceId?: unknown;
  cwd?: unknown;
  title?: unknown;
  createdAt: string;
  updatedAt: string;
  revision: number;
  projectionEpoch: number;
  projection: { threads: FrozenThread[] };
  layout: FrozenLayout;
  materials: FrozenMaterial[];
  regions: FrozenRegion[];
  annotations: FrozenAnnotation[];
}

/** 冻结文档根（`normalizeFrozenState` 的产物）。 */
export interface FrozenState {
  format: string;
  schemaVersion: number;
  updatedAt: string;
  hiddenSessionIds: string[];
  idempotency: Record<string, IdempotencyEntry>;
  idempotencyFloor: string | null;
  workspaces: FrozenWorkspace[];
}

/** 归一化结果 + 是否发生了迁移。 */
export interface NormalizedFrozen {
  state: FrozenState;
  migrated: boolean;
}

/** 旧版（v1–v4）文档形状。 */
export interface LegacyState {
  version: number;
  hiddenSessionIds: string[];
  workspaces: Record<string, unknown>[];
  updatedAt?: string;
}

/** 旧版归一化结果。 */
export interface NormalizedLegacy {
  state: LegacyState;
  migrated: boolean;
}

/** `normalizeState` 的联合结果：冻结根或旧版根。 */
export interface NormalizedState {
  state: FrozenState | LegacyState;
  migrated: boolean;
}

/** `eventMessages` 读到的事件最小形状。 */
interface EventRecord {
  type?: unknown;
  data?: unknown;
}

export function createFrozenState(now: string = new Date().toISOString()): FrozenState {
  return { format: FROZEN_FORMAT, schemaVersion: FROZEN_SCHEMA_VERSION, updatedAt: now, hiddenSessionIds: [], idempotency: {}, idempotencyFloor: null, workspaces: [] }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new InputError(`${field} 必须是正安全整数`)
  return value as number
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
const ISO_DATE_MESSAGE = (field?: string): string => `${field} 必须是严格 ISO8601 时间：YYYY-MM-DDTHH:mm:ss（可选 1–3 位毫秒）后接 Z 或 ±HH:mm`

export function isoDate(value: unknown, field?: string): string {
  const message = ISO_DATE_MESSAGE(field)
  if (typeof value !== 'string') throw new InputError(message)
  const match = ISO_DATE_LITERAL.exec(value)
  if (match === null) throw new InputError(message)
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6])
  if (month < 1 || month > 12) throw new InputError(message)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const lastDay = month === 2 && leap ? 29 : DAYS_PER_MONTH[month - 1]
  // `month` 已限定在 1–12，因此下标必命中；断言只补类型，不插入兜底值。
  if (day < 1 || day > (lastDay as number)) throw new InputError(message)
  if (hour > 23 || minute > 59 || second > 59) throw new InputError(message)
  // A `±24:00` offset or a 60-minute offset is not a real UTC offset; only the
  // stated clock range is allowed, never a silently normalized value.
  if (match[8] !== undefined && (Number(match[9]) > 23 || Number(match[10]) > 59)) throw new InputError(message)
  return value
}
function objectOf(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new InputError(`${field} 必须是对象`)
}
function cleanMap<T>(value: unknown, field: string, normalize: (entry: unknown) => T): Record<string, T> {
  objectOf(value, field)
  const result: Record<string, T> = Object.create(null)
  for (const [key, entry] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new InputError(`${field} 包含非法键`)
    result[key] = normalize(entry)
  }
  return result
}
function exactPosition(value: unknown): SchemaPosition {
  if (!Number.isFinite(positionSource(value)?.x) || !Number.isFinite(positionSource(value)?.y)) throw new InputError('坐标必须是有限数值')
  return { x: positionSource(value)?.x as number, y: positionSource(value)?.y as number }
}

/**
 * `exactPosition` 的取值辅助：把 `value?.x` / `value?.y` 收窄成可读形状。
 *
 * 逐字复刻原来的两次可选访问（不是属性访问追加校验），因此对 null / 非对象 /
 * 缺字段的判定与抛错时机完全不变。
 */
function positionSource(value: unknown): { x?: unknown; y?: unknown } | null | undefined {
  return value as { x?: unknown; y?: unknown } | null | undefined
}
function normalizeCoverage(value: unknown): FrozenCoverage {
  objectOf(value, 'coverage')
  if (!Array.isArray(value.ranges) || value.ranges.some((range: unknown) => !Array.isArray(range) || range.length !== 2 || !isEventSeq(range[0]) || !isEventSeq(range[1]) || range[0] > range[1])) throw new InputError('coverage.ranges 非法')
  if (typeof value.historyComplete !== 'boolean' || typeof value.textTruncated !== 'boolean') throw new InputError('coverage 完整性标记必须是 boolean')
  return { ranges: (value.ranges as number[][]).map((range: number[]) => [...range]), historyComplete: value.historyComplete, textTruncated: value.textTruncated }
}
export function normalizeFrozenState(value: unknown): NormalizedFrozen {
  const document = (value ?? {}) as FrozenDocumentInput
  if (document.format !== FROZEN_FORMAT) throw new InputError('format 必须是 dsh-evcanvas；旧格式请显式迁移')
  if (document.schemaVersion !== FROZEN_SCHEMA_VERSION) throw new InputError(`不支持 schemaVersion=${String(document.schemaVersion)}，请使用兼容版本或显式迁移`)
  const rawWorkspaces = document.workspaces
  const rawHiddenSessionIds = document.hiddenSessionIds
  if (!Array.isArray(rawWorkspaces) || !Array.isArray(rawHiddenSessionIds) || (rawHiddenSessionIds as unknown[]).some((id: unknown) => typeof id !== 'string')) throw new InputError('workspaces/hiddenSessionIds 非法')
  const state = createFrozenState(isoDate(document.updatedAt, 'updatedAt'))
  state.hiddenSessionIds = [...(rawHiddenSessionIds as string[])]
  if (document.idempotencyFloor != null && !UUID_V7.test(document.idempotencyFloor as string)) throw new InputError('idempotencyFloor 必须是小写 UUIDv7')
  state.idempotencyFloor = (document.idempotencyFloor ?? null) as string | null
  state.idempotency = cleanMap(document.idempotency, 'idempotency', entry => {
    objectOf(entry, 'idempotency entry')
    if (!/^[0-9a-f]{64}$/.test(entry.hash as string) || typeof entry.workspaceId !== 'string' || !isPlainObject(entry.response)) throw new InputError('idempotency entry 非法')
    const response: Record<string, unknown> = JSON.parse(JSON.stringify(entry.response))
    if (response.revision !== entry.revision || !Object.hasOwn(response, 'result')) throw new InputError('idempotency 首次响应不完整')
    return { hash: entry.hash as string, workspaceId: entry.workspaceId, revision: positiveInteger(entry.revision, 'revision'), at: isoDate(entry.at, 'at'), response }
  })
  if (Object.keys(state.idempotency).length > IDEMPOTENCY_LIMIT || Object.keys(state.idempotency).some(id => !UUID_V7.test(id))) throw new InputError('idempotency 必须是最多 200 条 UUIDv7 记录')
  const workspaces: unknown[] = rawWorkspaces
  state.workspaces = workspaces.map(raw => {
    objectOf(raw, 'workspace')
    const workspace = pickFields(raw, WORKSPACE_FIELDS)
    workspace['kind'] = raw['kind'] ?? 'manual'
    if (!['dsh', 'manual'].includes(workspace['kind'] as string)) throw new InputError('workspace.kind 非法')
    workspace['revision'] = positiveInteger(raw['revision'], 'revision')
    workspace['projectionEpoch'] = positiveInteger(raw['projectionEpoch'], 'projectionEpoch')
    workspace['createdAt'] = isoDate(raw['createdAt'], 'createdAt')
    workspace['updatedAt'] = isoDate(raw['updatedAt'], 'updatedAt')
    const rawProjection = (raw['projection'] ?? {}) as { threads?: unknown }
    const rawThreads = rawProjection.threads
    if (!Array.isArray(rawThreads)) throw new InputError('projection.threads 必须是数组')
    workspace['projection'] = { threads: (rawThreads as unknown[]).map(rawThread => {
      objectOf(rawThread, 'thread')
      const thread = pickFields(rawThread, THREAD_FIELDS.filter(field => field !== 'position'))
      // Thread times are optional in the frozen shape (older writers may omit
      // them); when present they must still be a strict ISO literal.
      if (thread['createdAt'] !== undefined) isoDate(thread['createdAt'], 'thread.createdAt')
      if (thread['updatedAt'] !== undefined) isoDate(thread['updatedAt'], 'thread.updatedAt')
      const rawMessages = rawThread['messages']
      if (!Array.isArray(rawMessages)) throw new InputError('thread.messages 必须是数组')
      thread['messages'] = (rawMessages as unknown[]).map(rawMessage => {
        const message = normalizeMessage(rawMessage)
        if (message['at'] !== undefined) isoDate(message['at'], 'message.at')
        return message
      })
      thread['pendingProcess'] = normalizeProcessList(rawThread['pendingProcess'])
      thread['coverage'] = normalizeCoverage(rawThread['coverage'] ?? { ranges: [], historyComplete: false, textTruncated: false })
      return thread as unknown as FrozenThread
    }) }
    const rawLayout = (raw['layout'] ?? {}) as { [field: string]: unknown }
    objectOf(raw['layout'], 'layout')
    // 原实现是一次性构造对象字面量；这里拆成逐步赋值以保持**求值顺序**
    // （cards → collapsed → viewport → zoom 校验）与原表达式完全一致。
    const layoutDraft: Record<string, unknown> = {}
    layoutDraft['cards'] = cleanMap(rawLayout['cards'], 'layout.cards', exactPosition)
    layoutDraft['collapsed'] = cleanMap(rawLayout['collapsed'], 'layout.collapsed', entry => {
      if (typeof entry !== 'boolean') throw new InputError('collapsed 必须是 boolean')
      return entry
    })
    const rawViewport = rawLayout['viewport'] as { x?: unknown; y?: unknown; zoom?: unknown } | null | undefined
    const viewportDraft = { ...exactPosition(rawLayout['viewport']), zoom: rawViewport?.zoom }
    layoutDraft['viewport'] = viewportDraft
    workspace['layout'] = layoutDraft
    if (!Number.isFinite(viewportDraft.zoom) || (viewportDraft.zoom as number) <= 0) throw new InputError('viewport.zoom 必须为有限正数')
    for (const [field, fields] of Object.entries({ materials: ['id', 'name', 'importedAt', 'bytes', 'text'], regions: ['id', 'name', 'x', 'y', 'w', 'h'], annotations: ['id', 'x', 'y', 'text', 'targetCardId', 'targetRegionId'] })) {
      const candidate = raw[field]
      if (!Array.isArray(candidate)) throw new InputError(`${field} 必须是数组`)
      const rawItems: unknown[] = candidate
      const ids = new Set<unknown>()
      workspace[field] = rawItems.map(item => {
        objectOf(item, field)
        if (typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id) || ids.has(item.id)) throw new InputError(`${field}.id 必须是唯一 UUID`)
        ids.add(item.id)
        if (field === 'materials') {
          if (typeof item.name !== 'string' || typeof item.text !== 'string') throw new InputError('material name/text 必须是文本')
          isoDate(item.importedAt, 'importedAt')
          const bytes = item.bytes
          if (!Number.isSafeInteger(bytes) || (bytes as number) < 0 || (bytes as number) > 2 * 1024 * 1024 || Buffer.byteLength(item.text as string, 'utf8') > 2 * 1024 * 1024) throw new InputError('material 超出 2MiB 字节上限')
        } else {
          exactPosition(item)
          if (field === 'regions') {
            if (typeof item.name !== 'string' || !Number.isFinite(item.w) || !Number.isFinite(item.h) || (item.w as number) <= 0 || (item.h as number) <= 0) throw new InputError('region 名称或尺寸非法')
          } else {
            if (typeof item.text !== 'string') throw new InputError('annotation.text 必须是文本')
            const hasCard = Object.hasOwn(item, 'targetCardId')
            const hasRegion = Object.hasOwn(item, 'targetRegionId')
            const targetKey = hasCard ? 'targetCardId' : 'targetRegionId'
            if (hasCard === hasRegion || typeof item[targetKey] !== 'string' || (item[targetKey] as string).length === 0) throw new InputError('annotation 必须恰好指定一个非空文本来源')
          }
        }
        return pickFields(item, fields)
      })
    }
    return workspace as unknown as FrozenWorkspace
  })
  assertDocumentIntegrity({ workspaces: state.workspaces.map(workspace => ({ id: workspace.id, threads: workspace.projection.threads })) })
  return { state, migrated: false }
}
export function assertFrozenDocument(value: unknown): void {
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

/** `normalizeFrozenState` 读到的不受信根形状。 */
interface FrozenDocumentInput {
  format?: unknown;
  schemaVersion?: unknown;
  updatedAt?: unknown;
  workspaces?: unknown;
  hiddenSessionIds?: unknown;
  idempotency?: unknown;
  idempotencyFloor?: unknown;
  [key: string]: unknown;
}

/** `assertDocumentIntegrity` 读到的最小文档形状。 */
interface IntegrityThread {
  id?: unknown;
  position?: unknown;
  messages?: readonly unknown[];
}

interface IntegrityWorkspace {
  id?: unknown;
  threads?: readonly IntegrityThread[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEventSeq(value: unknown): value is number {
  // `Number.isSafeInteger` 对非数字一律 false，所以 `value >= 0` 只在数字时求值；
  // 判定结果与旧的 `Number.isSafeInteger(value) && value >= 0` 逐字一致。
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** Copy only whitelisted own fields; never spread a document we did not build. */
function pickFields(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    if (Object.hasOwn(value, field) && value[field] !== undefined) result[field] = value[field]
  }
  return result
}

function normalizeProcessList(value: unknown): FrozenProcessEntry[] {
  if (!Array.isArray(value)) return []
  return (value as unknown[]).filter(isPlainObject).map(entry => pickFields(entry, PROCESS_FIELDS) as unknown as FrozenProcessEntry)
}

function normalizeMessage(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new InputError('message 必须是对象')
  const message = pickFields(value, MESSAGE_FIELDS)
  if (message['sourceSeq'] !== undefined && !isEventSeq(message['sourceSeq'])) throw new InputError('sourceSeq 必须是非负安全整数')
  if (Array.isArray(value['process'])) message['process'] = normalizeProcessList(value['process'])
  return message
}

function normalizeThread(value: unknown, markMigrated: () => void): Record<string, unknown> {
  if (!isPlainObject(value)) throw new InputError('thread 必须是对象')
  const thread = pickFields(value, THREAD_FIELDS)
  if (Array.isArray(value['messages'])) {
    const rawMessages: unknown[] = value['messages']
    const kept = rawMessages.filter(message => !isRuntimeContextMessage(message))
    if (kept.length !== rawMessages.length) markMigrated()
    thread['messages'] = kept.map(normalizeMessage)
    thread['pendingProcess'] = normalizeProcessList(value['pendingProcess'])
    return thread
  }
  // A thread written by an older version kept its notes directly, with no
  // message/process split yet.
  markMigrated()
  const notes = value['notes']
  thread['messages'] = (Array.isArray(notes) ? (notes as unknown[]) : []).map(normalizeMessage)
  thread['pendingProcess'] = []
  return thread
}

/**
 * Reject a document that is internally inconsistent.
 *
 * Duplicate entity ids and duplicate event keys are refused rather than
 * silently de-duplicated: a duplicate means two writers disagreed, and picking
 * one of them at load time would hide the divergence.
 */
export function assertDocumentIntegrity(state: unknown): void {
  const document = state as { workspaces: readonly unknown[] }
  const workspaceIds = new Set<string>()
  const threadIds = new Set<string>()
  for (const workspace of document.workspaces) {
    const workspaceRecord = workspace as IntegrityWorkspace
    if (typeof workspaceRecord.id !== 'string' || workspaceRecord.id === '') throw new InputError('workspace.id 必须是非空字符串')
    if (workspaceIds.has(workspaceRecord.id)) throw new InputError(`重复的 workspace id: ${workspaceRecord.id}`)
    workspaceIds.add(workspaceRecord.id)
    for (const thread of workspaceRecord.threads ?? []) {
      if (typeof thread.id !== 'string' || thread.id === '') throw new InputError('thread.id 必须是非空字符串')
      if (threadIds.has(thread.id)) throw new InputError(`重复的 thread id: ${thread.id}`)
      threadIds.add(thread.id)
      if (thread.position !== undefined) {
        const position = thread.position as { x?: unknown; y?: unknown } | null | undefined
        if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) throw new InputError(`thread ${thread.id} 的 position 必须包含有限坐标`)
      }
      const messageIds = new Set<string>()
      const seenSeqs = new Set<unknown>()
      for (const message of thread.messages ?? []) {
        const messageRecord = message as { id?: unknown; sourceSeq?: unknown }
        if (typeof messageRecord.id !== 'string' || messageRecord.id === '') throw new InputError('message.id 必须是非空字符串')
        if (messageIds.has(messageRecord.id)) throw new InputError(`重复的 message id: ${messageRecord.id}`)
        messageIds.add(messageRecord.id)
        if (messageRecord.sourceSeq === undefined) continue
        if (seenSeqs.has(messageRecord.sourceSeq)) throw new InputError(`thread ${thread.id} 中重复的事件键 seq: ${messageRecord.sourceSeq as string | number}`)
        seenSeqs.add(messageRecord.sourceSeq)
      }
    }
  }
}

export function normalizeState(value: unknown): NormalizedState {
  if (Object.hasOwn((value ?? {}) as object, 'format') || Object.hasOwn((value ?? {}) as object, 'schemaVersion')) return normalizeFrozenState(value)
  return normalizeLegacyState(value)
}

// Read-only legacy compatibility; Slice 7 explicitly converts this result.
// Never label the legacy v4 result as frozen v1.
export function normalizeLegacyState(value: unknown): NormalizedLegacy {
  const document = (value ?? {}) as { version?: unknown; workspaces?: unknown; hiddenSessionIds?: unknown; updatedAt?: unknown }
  let migrated = false
  const markMigrated = (): void => { migrated = true }
  let state: LegacyState
  if ((document.version === 2 || document.version === 3 || document.version === LEGACY_SCHEMA_VERSION) && Array.isArray(document.workspaces)) {
    const hiddenSessionIds = Array.isArray(document.hiddenSessionIds) ? (document.hiddenSessionIds as unknown[]).filter((item): item is string => typeof item === 'string') : []
    migrated = (document.version as number) < 3 || !Array.isArray(document.hiddenSessionIds)
    const workspaces = (document.workspaces as unknown[]).filter(isPlainObject).map(workspace => {
      const normalized = pickFields(workspace, WORKSPACE_FIELDS)
      const rawThreads = workspace['threads']
      normalized['threads'] = Array.isArray(rawThreads)
        ? (rawThreads as unknown[]).filter(isPlainObject).map(thread => normalizeThread(thread, markMigrated))
        : []
      return normalized
    })
    state = { version: document.version, hiddenSessionIds, workspaces }
    if (typeof document.updatedAt === 'string') state.updatedAt = document.updatedAt
  } else if (document.version === 1 && Array.isArray(document.workspaces)) {
    const now = typeof document.updatedAt === 'string' ? document.updatedAt : new Date().toISOString()
    state = {
      version: 3,
      hiddenSessionIds: [],
      workspaces: (document.workspaces as unknown[]).map((workspace, index) => {
        const workspaceRecord = (workspace ?? {}) as Record<string, unknown>
        const events = Array.isArray(workspaceRecord['events']) ? (workspaceRecord['events'] as unknown[]) : []
        const workspaceNow = typeof workspaceRecord['updatedAt'] === 'string' ? workspaceRecord['updatedAt'] : now
        return {
          id: typeof workspaceRecord['id'] === 'string' ? workspaceRecord['id'] : randomUUID(),
          title: typeof workspaceRecord['title'] === 'string' && workspaceRecord['title'].trim() ? workspaceRecord['title'] : '未命名工作空间',
          createdAt: typeof workspaceRecord['createdAt'] === 'string' ? workspaceRecord['createdAt'] : workspaceNow,
          updatedAt: workspaceNow,
          threads: events.length === 0 ? [] : [{
            id: randomUUID(), title: workspaceRecord['title'] || '历史记录', parentId: null, dshSessionId: null, dshSessionTitle: null,
            color: TOPIC_COLORS[index % TOPIC_COLORS.length], position: { x: 86, y: 82 }, createdAt: workspaceNow, updatedAt: workspaceNow,
            messages: events.map(event => {
              const eventRecord = (event ?? {}) as Record<string, unknown>
              return { id: typeof eventRecord['id'] === 'string' ? eventRecord['id'] : randomUUID(), text: String(eventRecord['text'] ?? ''), at: typeof eventRecord['at'] === 'string' ? eventRecord['at'] : workspaceNow }
            }),
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
export function foldLegacyToolCards(workspaces: readonly unknown[]): boolean {
  let changed = false
  for (const workspace of workspaces) {
    const workspaceRecord = (workspace ?? {}) as { threads?: readonly unknown[] }
    for (const thread of workspaceRecord.threads ?? []) {
      const threadRecord = (thread ?? {}) as { messages?: unknown }
      if (!Array.isArray(threadRecord.messages)) continue
      const messages: unknown[] = threadRecord.messages
      const folded: unknown[] = []
      let assistant: Record<string, unknown> | null = null
      let pending: FoldedToolEntry[] = []
      for (const message of messages) {
        const messageRecord = (message ?? {}) as Record<string, unknown>
        if (messageRecord['kind'] === 'assistant') {
          assistant = messageRecord
          assistant['process'] ??= []
          pending = []
          folded.push(message)
          continue
        }
        if (messageRecord['kind'] !== 'tool' && messageRecord['kind'] !== 'tool-result') {
          folded.push(message)
          continue
        }
        if (assistant === null) {
          folded.push(message)
          continue
        }
        changed = true
        if (messageRecord['kind'] === 'tool') {
          const [name = '工具调用', ...argumentLines] = (messageRecord['text'] as string).split('\n')
          const entry: FoldedToolEntry = { callId: `legacy-${(assistant['process'] as unknown[]).length}`, name, arguments: argumentLines.join('\n'), result: null, error: null }
          pending.push(entry)
          ;(assistant['process'] as unknown[]).push(entry)
        } else {
          const entry = pending.shift() ?? (() => {
            const orphan: FoldedToolEntry = { callId: `legacy-orphan-${(assistant['process'] as unknown[]).length}`, name: '工具调用', arguments: null, result: null, error: null }
            ;(assistant['process'] as unknown[]).push(orphan)
            return orphan
          })()
          entry.result = messageRecord['text'] as string
        }
      }
      ;(thread as { messages?: unknown[] }).messages = folded
    }
  }
  return changed
}

/** `foldLegacyToolCards` 折叠出来的过程记录。 */
interface FoldedToolEntry {
  callId: string;
  name: string;
  arguments: string | null;
  result: string | null;
  error: string | null;
}

export function positionOf(value: unknown): SchemaPosition {
  const source = positionSource(value)
  const x = Number(source?.x)
  const y = Number(source?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new InputError('position 必须包含有效坐标')
  return { x: Math.round(Math.max(-2000, Math.min(5000, x))), y: Math.round(Math.max(-2000, Math.min(5000, y))) }
}

export function requiredText(value: unknown, maxLength: number, field: string): string {
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
export function messageSourceKind(message: unknown): string | null {
  const source = (message as { source?: { kind?: unknown } } | null | undefined)?.source
  const kind = source?.kind
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
export function messageSourceVerdict(message: unknown): 'user' | 'injected' | 'unknown' {
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
export function eventMessages(event: unknown): unknown[] {
  if (event === null || typeof event !== 'object') return []
  const record = event as EventRecord
  if (record.type === 'user/message') return record.data !== null && typeof record.data === 'object' ? [record.data] : []
  if (record.type === 'agent/inbox/spliced') {
    const data = record.data as { inserted?: unknown } | null | undefined
    return Array.isArray(data?.inserted) ? (data.inserted as unknown[]) : []
  }
  return []
}

/**
 * Plain-text runtime-context detector. Kept as a pure text tool for the
 * unattributed fallback path (`messageSourceVerdict(...) === 'unknown'`); it is
 * deliberately no longer the only criterion for admitting a `user/message`.
 */
export function isRuntimeContextText(text: unknown): boolean {
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
export function isRuntimeContextMessage(message: unknown): boolean {
  const record = message as { kind?: unknown; text?: unknown } | null | undefined
  return record?.kind === 'user' && isRuntimeContextText(record.text)
}
