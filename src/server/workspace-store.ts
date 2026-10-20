// 来源: dsh-synapnova@3fd1d00 server/workspace-store.js

/**
 * Synapnova workspace store.
 *
 * The single writer of the plugin's canvas projection and layout metadata.
 * DSH stays the authority for session logs, titles, archiving and forks; this
 * store only owns the projected copy plus canvas coordinates.
 *
 * All HTTP writes use workspace-scoped envelopes. The synchronous business
 * helpers retain their direct-call form for trusted internal fixtures only;
 * HTTP callers never receive an envelope-free write path.
 *
 * ---
 * 类型口径（本轮新增，零行为变更）：
 * 本类在内部对文档做**原地可变写入**（push/mutate/delete 字段），而 `shared/schema`
 * 导出的是只读语义的 `FrozenState`。因此这里定义一组「可变视图」类型
 * （`MutableState` / `MutableWorkspace` / `MutableThread`），字段与冻结契约一致、
 * 但允许写入；只在跨模块边界（`normalizeFrozenState` 的入参、方法返回值）做一次
 * 断言。**没有一处条件、错误文案、默认值或执行顺序被改动。**
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  InputError,
  MAX_NOTE_LENGTH,
  MAX_TITLE_LENGTH,
  NotFoundError,
  TOPIC_COLORS,
  normalizeState,
  normalizeFrozenState,
  createFrozenState,
  RevisionConflictError,
  IdempotencyExpiredError,
  IDEMPOTENCY_LIMIT,
  UUID_V7,
  positionOf,
  requiredText,
} from '@/shared/schema'
import type { SchemaPosition, IdempotencyEntry } from '@/shared/schema'
import { contentText, errorText, projectableEvent, sessionCwd, titleFromText, workspaceTitle } from '@/server/projection'
import type { ProjectionNote } from '@/server/projection'

const LOCK_STALE_MS = 60_000
// Deferred (event-projection) writes coalesce into one save per window, so a
// burst of session events costs a single full-state write instead of one per
// event (issue #13: per-event saves pinned the main thread at ~90% CPU).
const SAVE_DEBOUNCE_MS = 800
// Windows refuses `rename` onto a target that another handle currently has
// open (EPERM/EACCES/EBUSY). A concurrent reader collides with a few percent
// of writes, and the failure is not independent: once a collision starts it
// repeats for a short burst, so a fixed backoff can phase-lock with a periodic
// reader. Retry a bounded number of times with a jittered backoff.
const SAVE_REPLACE_ATTEMPTS = 6
const SAVE_REPLACE_BACKOFF_MS = 15
const SAVE_REPLACE_JITTER_MS = 25
// Upper bound on how many directory entries one paged snapshot may accumulate
// in memory before it is rejected. The snapshot is transient (never persisted),
// but an unbounded map keyed by client-supplied ids is still a memory risk.
const MAX_DIRECTORY_SNAPSHOT_ENTRIES = 20_000
// Cold-history backfill arrives in request-sized pieces for the same reason the
// directory does (the shared parser caps a normal body at 32KiB), so the
// staging area needs its own bounds: how many distinct windows may be open at
// once, how many batches one window may take, and how many events it may hold.
const MAX_HISTORY_WINDOWS = 8
const MAX_HISTORY_WINDOW_BATCHES = 256
const MAX_HISTORY_WINDOW_EVENTS = 200_000

/** 一条投影消息（可变视图；字段与 `shared/schema` 的 MESSAGE_FIELDS 一致）。 */
export interface MutableMessage {
  id: string;
  text?: string;
  kind?: string;
  sourceSeq?: number;
  at?: string;
  turn?: number;
  step?: number;
  process?: MutableProcessEntry[];
}

/** 一条工具过程记录。 */
export interface MutableProcessEntry {
  callId?: string;
  turn?: number;
  step?: number;
  name?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
}

/** 覆盖率声明。 */
export interface MutableCoverage {
  ranges: number[][];
  historyComplete: boolean;
  textTruncated: boolean;
}

/** 一条投影线程（可变视图）。 */
export interface MutableThread {
  id: string;
  title?: string | null;
  parentId?: string | null;
  sourceParentSessionId?: string | null;
  sourceSeedLength?: number | null;
  dshSessionId?: string | null;
  dshSessionTitle?: string | null;
  color?: string | null;
  createdAt?: string;
  /** 所有写入路径都写 ISO 字符串；`dshThread` 建线程时也是 `now`。 */
  updatedAt?: string;
  messages: MutableMessage[];
  pendingProcess: MutableProcessEntry[];
  coverage?: MutableCoverage;
  /** 旧版过渡字段：由 `canonicalizeThreads` 搬到 `layout.cards` 后删除。 */
  position?: SchemaPosition;
}

/** 布局包（可变视图）。 */
export interface MutableLayout {
  cards: Record<string, SchemaPosition>;
  collapsed: Record<string, unknown>;
  viewport: { x: number; y: number; zoom: number };
}

/** 一个工作区（可变视图）。 */
export interface MutableWorkspace {
  id: string;
  kind?: string;
  dshWorkspaceId?: string | null;
  cwd?: string | null;
  title?: string;
  revision: number;
  projectionEpoch: number;
  createdAt?: string;
  updatedAt?: string;
  projection: { threads: MutableThread[] };
  layout: MutableLayout;
  materials: Record<string, unknown>[];
  regions: Record<string, unknown>[];
  annotations: Record<string, unknown>[];
  /** 旧版只读别名，仅供 `workspaceView` 的兼容读视图回退。 */
  threads?: MutableThread[];
}

/** 顶层文档（可变视图）。 */
export interface MutableState {
  format?: string;
  schemaVersion?: number;
  updatedAt: string;
  hiddenSessionIds: string[];
  idempotency: Record<string, IdempotencyEntry>;
  idempotencyFloor: string | null;
  workspaces: MutableWorkspace[];
}

/** 一个分批目录快照（仅内存，永不落盘）。 */
interface DirectorySnapshot {
  snapshotId: string;
  nextCursor: number;
  lastCursor: number;
  completed?: boolean;
  ready?: boolean;
  sessionById: Map<string, HostSessionEntry>;
  workspaceById: Map<string, HostWorkspaceEntry>;
  removed: Set<string>;
}

/** 目录快照结算后的载荷。 */
interface SettledDirectory {
  sessions: HostSessionEntry[];
  removedSessionIds: string[];
  workspaces: HostWorkspaceEntry[];
  cleanup: boolean;
  pending: DirectorySnapshot;
}

/** 宿主目录里的一行会话。 */
interface HostSessionEntry {
  id: string;
  cwd?: unknown;
  blank?: unknown;
  title?: unknown;
  parentId?: unknown;
  [key: string]: unknown;
}

/** 宿主目录里的一行工作区。 */
interface HostWorkspaceEntry {
  id: string;
  title?: unknown;
  path?: unknown;
  cwd?: unknown;
  sessionIds?: unknown;
  [key: string]: unknown;
}

/** 一个冷历史窗口（仅内存）。 */
interface HistoryWindow {
  historyId: string;
  sessionId: string;
  nextCursor: number;
  lastCursor: number;
  completed?: boolean;
  events: HistoryEvent[];
  bytes?: number;
  title?: string;
  cwd?: string;
  lowWater?: number;
  hasMore?: boolean;
  claimsComplete?: boolean;
}

/** 结算后的历史窗口。 */
interface SettledHistoryWindow {
  historyId: string;
  sessionId: string;
  title: string | undefined;
  cwd: string | undefined;
  lowWater: number | undefined;
  hasMore: boolean | undefined;
  claimsComplete: boolean | undefined;
  events: HistoryEvent[];
}

/** 一条线上事件（已收窄到投影读取的字段）。 */
export interface HistoryEvent {
  seq: number;
  type: string;
  time: number;
  data?: unknown;
}

/** 被投影进画布的宿主会话（`projectSession` / `projectEvent` 的入参形状）。 */
export interface ProjectableSession {
  id: string;
  title?: unknown;
  header?: { cwd?: unknown; parentSession?: unknown; meta?: unknown } | null;
  inheritedEventCount?: unknown;
  snapshotEvents?: () => Iterable<ProjectableEvent>;
}

/** 被投影的一条已提交事件。 */
export interface ProjectableEvent {
  seq: number;
  type: string;
  time: number;
  data?: unknown;
}

/** `validateEnvelope` 的结果。 */
type ValidatedEnvelope = Record<string, unknown> & {
  workspaceId: string;
  baseRevision: number;
  projectionEpoch: number | undefined;
  operationId: string;
  action: string;
  body: Record<string, unknown>;
  hash: string;
};

/** `mutateLocked` 的选项。 */
export interface MutateOptions {
  deferred?: boolean;
  envelope?: Record<string, unknown> | undefined;
  creating?: boolean;
  workspaceId?: string;
  targetThreadId?: string;
  beforeCommit?: (() => Promise<void>) | undefined;
}

/** `replaceFileWithRetry` 的注入点（测试用）。 */
interface ReplaceRetryOptions {
  replace?: (from: string, to: string) => Promise<void>;
  wait?: (ms: number) => Promise<unknown>;
  random?: () => number;
}

/** 构造选项。 */
export interface WorkspaceStoreOptions {
  onFlushError?: (error: unknown) => void;
}

/**
 * Union one seq interval into a coverage range list.
 *
 * `coverage.ranges` is a list of closed, sorted, non-touching intervals; a range
 * only ever grows, so merging is monotonic. Overlapping AND adjacent intervals
 * collapse ([1,3] + [4,5] -> [1,5]): a gap of zero seqs is not a gap, and
 * leaving it as two entries would make every later "is this seq covered?"
 * reader special-case adjacency.
 */
export function mergeCoverageRanges(ranges: unknown, from: unknown, to: unknown): number[][] {
  const candidates: [number, number][] = []
  for (const range of Array.isArray(ranges) ? ranges : []) {
    if (!Array.isArray(range) || range.length !== 2) continue
    const [start, end] = range as [unknown, unknown]
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (start as number) > (end as number)) continue
    candidates.push([start as number, end as number])
  }
  if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && (from as number) >= 0 && (from as number) <= (to as number)) candidates.push([from as number, to as number])
  candidates.sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: number[][] = []
  for (const range of candidates) {
    const last = merged.at(-1)
    if (last !== undefined && range[0] <= (last[1] as number) + 1) last[1] = Math.max(last[1] as number, range[1])
    else merged.push([range[0], range[1]])
  }
  return merged
}

/** JSON persistence for the Synapnova workspace graph. */
export class WorkspaceStore {
  dataFile: string;
  onFlushError: (error: unknown) => void;
  sessionOwnership: Map<string, { id: string; title: string }>;
  directorySnapshot: DirectorySnapshot | null;
  historyWindows: Map<string, HistoryWindow>;
  /**
   * 文档本身。
   *
   * 构造时字面赋值 `undefined`（旧实现如此），首个 `publishState` 之前不可读。
   * 所有公开方法都先 `await this.ready`（`load()` 已完成发布），所以运行期恒有值；
   * 这里用 definite-assignment 表达该不变量，不插入任何运行时兜底。
   */
  state!: MutableState;
  serial: Promise<unknown>;
  projectionGeneration: number;
  ready: Promise<void>;
  lastKnownMtime: number | null;
  lastKnownDigest: string | null;
  lockToken: string | null;
  dirty: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** 旧格式（无 `format` 字段）时为只读；`publishState` 会置回 false。 */
  legacyReadOnly?: boolean;

  constructor(dataFile: unknown, { onFlushError = (error: unknown) => process.emitWarning(error as Error) }: WorkspaceStoreOptions = {}) {
    if (typeof dataFile !== 'string' || dataFile.length === 0) throw new Error('synapnova: config.dataFile must be a non-empty path')
    this.dataFile = dataFile
    this.onFlushError = onFlushError
    // sessionId -> { id, title } of the owning host workspace, refreshed on
    // every directory sync so live events resolve the same canvas node.
    this.sessionOwnership = new Map()
    // The one in-flight directory snapshot, held in memory only. A directory
    // larger than one 32KiB request arrives as several batches, and until the
    // last one lands it is not a trustworthy listing. This is transient protocol
    // state, so it must never reach the document: `shared/schema.js` is a closed
    // field whitelist, and an extra key would be dropped by
    // `normalizeFrozenState` (or rejected outright) on the next normalise.
    // `this.sessionOwnership` above is the existing precedent for instance-only
    // state that is not persisted.
    this.directorySnapshot = null
    // Cold-history backfill staging, in memory only and for the same reason as
    // the directory snapshot: a backfill larger than one request arrives as
    // several batches, and a half-arrived window must not be able to claim
    // `historyComplete` or widen `coverage.ranges`. Instance state, never a
    // document field.
    this.historyWindows = new Map()
    // 旧实现此处直接写 `undefined`；保留同一赋值，类型上由 `!` 声明承担。
    this.state = undefined as unknown as MutableState
    this.serial = Promise.resolve()
    this.projectionGeneration = 0
    this.ready = this.load()
    this.lastKnownMtime = null
    // Digest of the bytes this store last read or wrote. A moved mtime alone
    // cannot detect an external rewrite that preserved the timestamp, and the
    // old two-instance warning went on to overwrite the other writer anyway.
    this.lastKnownDigest = null
    // The exact token this store wrote into the lock file, so release only ever
    // removes a lock it owns.
    this.lockToken = null
    this.dirty = false
    this.flushTimer = null
  }

  async runExclusive<T>(action: () => T | Promise<T>): Promise<T> {
    await this.ready
    const task = this.serial.then(action)
    this.serial = task.catch(() => undefined)
    return task
  }

  /**
   * 归一化 + 加载期修复。返回 `{ state, repaired }`：
   * `repaired` 表示这次是否真的发生了归并/前缀写回，`load()` 用它决定要不要回写磁盘。
   *
   * 不靠对象引用判断：`normalizeFrozenState` 总会造新对象。
   * 也不靠 `updatedAt`：别处也会改它，且 `load()` 读到的值本身就是旧的。
   */
  prepareState(state: unknown): { state: MutableState; repaired: boolean } {
    const { state: normalized } = normalizeFrozenState(state)
    // `normalizeFrozenState` 造出的就是冻结形状；本类随后原地改写它，
    // 所以这里一次性转到可变视图（结构完全相同，只是可写）。
    const mutable = normalized as unknown as MutableState
    const repaired = mergeSplitWorkspaces(mutable)
    return { state: mutable, repaired }
  }

  // Caller must prepare/validate before its atomic rename commit point.
  publishState(state: unknown): void {
    if (this.state !== undefined) this.projectionGeneration += 1
    this.state = state as MutableState
    this.legacyReadOnly = false
  }

  projectionEpochFor(session: ProjectableSession): number {
    const owner = this.sessionOwnership.get(session.id)
    const workspace = this.state?.workspaces.find(item => item.projection?.threads.some(thread => sameDshSessionId(thread.dshSessionId, session.id)) || owner && item.dshWorkspaceId === owner.id)
    return workspace?.projectionEpoch ?? 1
  }

  metadata(): { format: string | null; schemaVersion: number | null; readOnly: boolean; migrationRequired: boolean } {
    return { format: this.state.format ?? null, schemaVersion: this.state.schemaVersion ?? null, readOnly: this.legacyReadOnly === true, migrationRequired: this.legacyReadOnly === true }
  }

  async snapshot(workspaceId?: string): Promise<Record<string, unknown>> {
    return this.runExclusive(() => workspaceId === undefined
      ? { ...this.metadata(), workspaces: this.state.workspaces.map(workspace => this.summary(workspace)) }
      : { ...this.metadata(), workspace: workspaceView(this.workspace(workspaceId)) })
  }

  async list(): Promise<Record<string, unknown>[]> {
    return this.runExclusive(() => this.state.workspaces.map(workspace => this.summary(workspace)))
  }

  async get(workspaceId: string): Promise<Record<string, unknown>> {
    return this.runExclusive(() => workspaceView(this.workspace(workspaceId)))
  }

  async create(title: unknown, envelope?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.mutate(() => {
      const now = new Date().toISOString()
      const workspace = newWorkspace({ id: enrollmentWorkspaceId(envelope) ?? randomUUID(), kind: 'manual', dshWorkspaceId: null, cwd: null, title: requiredText(title, MAX_TITLE_LENGTH, 'title'), createdAt: now, updatedAt: now })
      this.state.workspaces.unshift(workspace)
      return this.summary(workspace)
    }, { envelope: envelope ? { ...envelope, action: 'workspace.create', body: { title } } : undefined, creating: true })
  }

  async createThread(workspaceId: string, input: Record<string, unknown> | null | undefined, envelope?: Record<string, unknown>): Promise<MutableThread> {
    return this.mutate(() => {
      const workspace = this.workspace(workspaceId)
      const now = new Date().toISOString()
      const thread = this.thread({
        title: input?.title,
        parentId: input?.parentId,
        dshSessionId: input?.dshSessionId,
        dshSessionTitle: input?.dshSessionTitle,
        position: input?.position,
        color: input?.color,
        now,
        order: workspace.projection.threads.length,
      })
      if (thread.parentId !== null && !workspace.projection.threads.some(item => item.id === thread.parentId)) throw new InputError('分支来源不存在')
      workspace.projection.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    }, { envelope: envelope ? { ...envelope, action: 'thread.create', body: input } : undefined, workspaceId })
  }

  async branch(threadId: string, input: Record<string, unknown> | null | undefined, envelope?: Record<string, unknown>): Promise<MutableThread> {
    return this.mutate(() => {
      const { workspace, thread: parent } = this.locateThread(threadId)
      const now = new Date().toISOString()
      const sessionId = typeof input?.dshSessionId === 'string' && input.dshSessionId.length > 0 ? input.dshSessionId : null
      // A DSH fork emits session/created while the browser receives its fork
      // response. Either path may win the race, but both must resolve to one node.
      if (sessionId !== null) {
        const existing = workspace.projection.threads.find(item => sameDshSessionId(item.dshSessionId, sessionId))
        if (existing !== undefined) {
          existing.parentId ??= parent.id
          if (typeof input?.title === 'string' && input.title.trim() !== '') existing.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
          if (typeof input?.dshSessionTitle === 'string') existing.dshSessionTitle = input.dshSessionTitle.slice(0, MAX_TITLE_LENGTH)
          existing.updatedAt = now
          workspace.updatedAt = now
          return structuredClone(existing)
        }
      }
      const siblings = workspace.projection.threads.filter(item => item.parentId === parent.id)
      const thread = this.thread({
        title: input?.title,
        parentId: parent.id,
        dshSessionId: input?.dshSessionId,
        dshSessionTitle: input?.dshSessionTitle,
        position: input?.position ?? { x: (workspace.layout.cards[parent.id]?.x ?? 86) + 420, y: (workspace.layout.cards[parent.id]?.y ?? 82) + siblings.length * 248 },
        color: input?.color ?? parent.color,
        now,
        order: workspace.projection.threads.length,
      })
      workspace.projection.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    }, { envelope: envelope ? { ...envelope, action: `thread.branch:${threadId}`, body: input } : undefined, targetThreadId: threadId })
  }

  /**
   * Keep only the canvas graph in Synapnova; DSH remains the source of session
   * truth.
   *
   * A directory that does not fit one request arrives as a paged snapshot
   * (`snapshotId` / `cursor` / `complete`). The completeness gate lives here and
   * is deliberately unavoidable:
   *
   * - A batch that is not the last one is only staged in memory; the projection
   *   is not touched at all, so a half-arrived directory can neither add nor
   *   remove a single node.
   * - Node creation/updates and **all** removal (`removedSessionIds` and the
   *   blank-session sweep) happen only when the closing batch arrives. Anything
   *   else would treat "has not arrived yet" as "was deleted", which is exactly
   *   how a paging bug silently deletes user-visible cards.
   * - Removal additionally requires the host directory to have reported
   *   `phase: 'ready'`. A pending directory is an incomplete listing, so a
   *   session missing from it is unknown, not gone. Unknown phase is treated as
   *   not-ready (fail closed).
   * - A partial snapshot is never persisted: it lives in `this.directorySnapshot`
   *   next to `this.sessionOwnership`, because the frozen document field list is
   *   closed and must not grow a protocol-only key.
   *
   * The legacy three-argument call (no envelope) is still one complete listing,
   * which is what every non-paged caller and the direct-call fixtures use.
   */
  async syncSessions(sessions: unknown, removedSessionIds: unknown = [], hostWorkspaces: unknown = [], envelope?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    if (!Array.isArray(sessions)) throw new InputError('sessions 必须是数组')
    if (!Array.isArray(removedSessionIds) || removedSessionIds.some(item => typeof item !== 'string')) throw new InputError('removedSessionIds 必须是字符串数组')
    if (!Array.isArray(hostWorkspaces)) throw new InputError('workspaces 必须是数组')
    const sessionList = sessions as HostSessionEntry[]
    const removedList = removedSessionIds as string[]
    const workspaceList = hostWorkspaces as HostWorkspaceEntry[]
    if (envelope === undefined) return this.applyDirectory(sessionList, removedList, workspaceList, true)
    // Batch accumulation is serialised with every other write. The staging area
    // is instance state, so two concurrent batches of one snapshot could
    // otherwise interleave their map writes and lose a batch (or stage a
    // half-applied cursor). `runExclusive` here also keeps the "close then
    // apply" pair atomic: a snapshot is either fully applied or still staged.
    return this.runExclusive(async () => {
      const accepted = this.acceptDirectoryBatch(sessionList, removedList, workspaceList, envelope)
      // Staged but not closed (or an idempotent replay): the projection is
      // untouched, so report the current summaries and change nothing.
      if (accepted === null) return this.state.workspaces.map(workspace => this.summary(workspace))
      try {
        return await this.applyDirectoryLocked(accepted.sessions, accepted.removedSessionIds, accepted.workspaces, accepted.cleanup)
      } catch (error) {
        // The listing never landed. Keep the snapshot open so a retry of the
        // closing batch can settle it, instead of stranding the client with a
        // snapshot id the server considers finished. The cursor is rewound to the
        // closing batch: re-folding it is harmless (sessions and workspaces are
        // keyed by id, removals are a set) and lets the retry settle for real.
        this.directorySnapshot = { ...accepted.pending, nextCursor: accepted.pending.nextCursor - 1 }
        throw error
      }
    })
  }

  /**
   * Accumulate one paged directory batch and report whether the snapshot closed.
   *
   * Returns `null` while the snapshot is still incomplete (or when a repeat of
   * an already-settled batch arrives, which is a no-op), otherwise the complete
   * accumulated listing plus whether removal is allowed.
   */
  acceptDirectoryBatch(sessions: HostSessionEntry[], removedSessionIds: string[], hostWorkspaces: HostWorkspaceEntry[], envelope: Record<string, unknown> | undefined): SettledDirectory | null {
    const snapshotId = envelope?.snapshotId
    if (typeof snapshotId !== 'string' || snapshotId === '') throw new InputError('snapshotId 必须是非空字符串')
    const cursor = envelope?.['cursor']
    if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) throw new InputError('cursor 必须是非负安全整数')
    const cursorValue = cursor as number
    if (typeof envelope?.['complete'] !== 'boolean') throw new InputError('complete 必须是布尔值')
    let pending = this.directorySnapshot
    const sameSnapshot = pending !== null && pending.snapshotId === snapshotId
    if (sameSnapshot && pending !== null && pending.completed === true) {
      // The closing batch (or an earlier one) is being replayed after the
      // snapshot already landed. Node creation is keyed by `dshSessionId`, so a
      // second settle would not duplicate cards, but replaying the removal pass
      // is still pointless work — answer idempotently instead.
      if (cursorValue <= pending.lastCursor) return null
      throw new InputError('目录快照已结算；请使用新的 snapshotId 重新同步')
    }
    if (cursorValue === 0) {
      // Start (or restart) a snapshot: cursor 0 always begins a fresh listing,
      // so replaying a broken round under the same id is safe and idempotent.
      pending = { snapshotId, nextCursor: 0, lastCursor: -1, completed: false, ready: false, sessionById: new Map(), workspaceById: new Map(), removed: new Set() }
    } else if (!sameSnapshot) {
      throw new InputError('目录快照缺少起始批次')
    } else if (pending !== null && cursorValue < pending.nextCursor) {
      // A duplicate of a batch already folded in: ignore, so a retried request
      // cannot double-count or reorder anything.
      return null
    } else if (pending !== null && cursorValue > pending.nextCursor) {
      throw new InputError('目录快照批次不连续，请重新同步')
    }
    // 上面四条分支已保证 pending 非 null（cursor 0 时刚被赋值）。
    const staged = pending as DirectorySnapshot
    for (const item of sessions) {
      if (typeof item?.id !== 'string' || item.id === '') continue
      staged.sessionById.set(item.id, item)
    }
    for (const workspace of hostWorkspaces) {
      if (typeof workspace?.id !== 'string' || workspace.id === '') continue
      staged.workspaceById.set(workspace.id, workspace)
    }
    for (const id of removedSessionIds) staged.removed.add(id)
    staged.nextCursor = cursorValue + 1
    staged.lastCursor = cursorValue
    if (staged.sessionById.size + staged.workspaceById.size > MAX_DIRECTORY_SNAPSHOT_ENTRIES) {
      this.directorySnapshot = null
      throw new InputError('目录快照过大')
    }
    // Fail closed: only an explicitly ready directory may close a snapshot with
    // removal enabled. `complete` alone is the client's claim; `ready` is the
    // host's.
    staged.ready = envelope?.['directoryPhase'] === 'ready'
    this.directorySnapshot = staged
    if (envelope?.['complete'] !== true) return null
    const settled: SettledDirectory = {
      sessions: [...staged.sessionById.values()],
      removedSessionIds: [...staged.removed],
      workspaces: [...staged.workspaceById.values()],
      cleanup: staged.ready === true,
      // Restored verbatim if the apply step throws, so the same closing batch can
      // be retried instead of being rejected as "already settled".
      pending: staged,
    }
    // Keep only the bookkeeping needed to answer replays; the listing itself is
    // released as soon as it is applied.
    this.directorySnapshot = { snapshotId, nextCursor: staged.nextCursor, lastCursor: staged.lastCursor, completed: true, ready: staged.ready, sessionById: new Map(), workspaceById: new Map(), removed: new Set() }
    return settled
  }

  /**
   * Apply one complete listing while the caller already holds the write queue.
   *
   * `mutate` would deadlock here (it takes `runExclusive` itself), so this is the
   * unlocked body. Only `syncSessions` may call it, from inside `runExclusive`.
   */
  async applyDirectoryLocked(sessions: HostSessionEntry[], removedSessionIds: string[], hostWorkspaces: HostWorkspaceEntry[], cleanup: boolean): Promise<Record<string, unknown>[]> {
    return this.mutateLocked(this.directoryAction(sessions, removedSessionIds, hostWorkspaces, cleanup), { deferred: true }) as Promise<Record<string, unknown>[]>
  }

  /** Apply one complete listing to the projection. Removal is gated by `cleanup`. */
  async applyDirectory(sessions: HostSessionEntry[], removedSessionIds: string[], hostWorkspaces: HostWorkspaceEntry[], cleanup: boolean): Promise<Record<string, unknown>[]> {
    return this.mutate(this.directoryAction(sessions, removedSessionIds, hostWorkspaces, cleanup), { deferred: true }) as Promise<Record<string, unknown>[]>
  }

  /**
   * 判断一个未绑定行（`dshWorkspaceId == null`）是否**可以**被 `hostWorkspaceId` 收编。
   *
   * ## 问题本质
   *
   * `byCwd` 回退把「这一行没有宿主绑定」当成了「这一行属于那个宿主工作区」的
   * 证据，但它分不清两种来源：
   *
   *   - **遗留行**：升级前写下的，或 S0-6 从磁盘回填的。里面装的是宿主管不到的
   *     历史会话 —— 收编是对的，否则老数据永久失联。
   *   - **本批次未归属桶**：宿主当前确实没给这些会话分配工作区。收编就是越界：
   *     用户在 A 里看到不属于它的卡片，删掉还会从「未分组」一起消失。
   *
   * ## 判据：行内有没有「宿主列出了、却没给它归属」的会话
   *
   * 这是唯一同时满足两个场景的判据：
   *
   *   - **有** → 这一行就是本批次的未归属桶，收编会把那些会话带进别人的工作区。
   *   - **没有** → 行内的会话要么宿主压根管不到（回填的旧会话），要么已经明确
   *     归了这个工作区。两种情况收编都只是补上绑定，不搬运别人的数据。
   *
   * ## 试过但不成立的三版（都是真实教训）
   *
   *   1. 「行内所有会话都归属同一宿主工作区」→ 拒绝收编回填行（回填会话没有
   *      归属声明），画布分裂成「未分组」+「工作区」两份。
   *   2. 「只否决明确归了别人的会话」→ 泄漏重现（未归属会话同样没有声明）。
   *   3. 「按行是否本轮之前存在」→ 跨轮场景下未归属行同样早就在了，被误判成
   *      遗留行，泄漏照旧。
   *
   * 前三版都在猜「这个会话属于谁」；正解是换个问法：「这个会话，宿主现在
   * 到底有没有给它安排位置」。
   */
  private legacyRowBelongsTo(
    cwd: string | null,
    hostWorkspaceId: string,
    listedSessionIds: ReadonlySet<string>,
  ): boolean {
    if (cwd === null) return false
    const row = this.state.workspaces.find(
      item => item.kind === 'dsh' && item.dshWorkspaceId == null && item.cwd === cwd,
    )
    if (row === undefined) return false
    const rowSessionIds = row.projection.threads
      .map(thread => thread.dshSessionId)
      .filter((id): id is string => typeof id === 'string' && id !== '')
    return rowSessionIds.every(sessionId => {
      // 宿主列出了这个会话、却没给归属 → 它是本批次的未归属会话，不能收编。
      if (listedSessionIds.has(sessionId) && !this.sessionOwnership.has(sessionId)) return false
      // 明确归了别的工作区 → 更不能收编。
      const declared = this.sessionOwnership.get(sessionId)
      return declared === undefined || declared.id === hostWorkspaceId
    })
  }

  /** The locked/unlocked shared body: one complete listing written to the projection. */
  directoryAction(sessions: HostSessionEntry[], removedSessionIds: string[], hostWorkspaces: HostWorkspaceEntry[], cleanup: boolean): () => Record<string, unknown>[] {
    return () => {
      this.sessionOwnership = hostWorkspaceOwnership(hostWorkspaces)
      /**
       * 本批次 `sessions` 列表里的会话 id。
       *
       * 这是区分「遗留/回填行」与「本批次未归属桶」的依据（详见
       * `legacyRowBelongsTo` 注释）：回填的旧会话不会出现在这个列表里，
       * 而未归属会话恰恰就是列表里那些没有归属的条目。
       */
      const listedSessionIds = new Set(
        sessions.filter(item => typeof item?.id === 'string' && item.id !== '').map(item => item.id),
      )
      const blankIds = new Set(sessions.filter(item => item?.blank === true && typeof item.id === 'string').map(item => item.id))
      const removedIds = new Set(removedSessionIds)
      for (const workspace of this.state.workspaces) {
        if (workspace.kind !== 'dsh') continue
        // Both removal sets — blank rows and explicitly removed sessions — are
        // applied here and nowhere else. An incomplete or pending listing never
        // reaches this branch, so neither set can be computed from partial data.
        if (cleanup === false) continue
        workspace.projection.threads = workspace.projection.threads.filter(thread => !blankIds.has(thread.dshSessionId as string) && !removedIds.has(thread.dshSessionId as string))
      }
      // Directory projection does not remove the workspace/layout owner.
      for (const item of sessions) {
        if (typeof item?.id !== 'string' || item.id === '' || typeof item.cwd !== 'string' || item.cwd === '') continue
        if (item.blank === true) continue
        // Canvas archiving is persistent UI state. A normal DSH list refresh
        // must not recreate a session that the user deliberately archived.
        if (this.state.hiddenSessionIds.includes(item.id)) continue
        const owner = this.sessionOwnership.get(item.id)
        /**
         * `allowCwdAdoption` 的判据 —— 区分「历史残留行」与「本批次未归属桶」。
         *
         * 只看行本身分不出来（两者都是 `dshWorkspaceId == null && cwd 相同`），
         * 必须看本批次全貌：
         *
         *   - 该 cwd 在本批次没有任何宿主工作区 → 是残留，收编；
         *   - 该 cwd 有绑定，且**这个残留行里装的所有会话**都归属同一个宿主
         *     工作区 → 说明它就是那个工作区在升级前留下的行，收编（否则老数据
         *     会永久失联，画布内容分裂成「未分组」+「工作区」两份）；
         *   - 否则 → 命中的是本批次仍未归属的会话，必须单开一行，否则会被
         *     后续出现的宿主工作区吞掉（S0-7 的泄漏缺陷）。
         */
        const allowCwdAdoption = owner !== undefined && this.legacyRowBelongsTo(item.cwd, owner.id, listedSessionIds)
        const workspace = this.dshWorkspace(owner?.id ?? null, owner?.title ?? '未分组', item.cwd, allowCwdAdoption)
        const session: ProjectableSession = { id: item.id, header: { meta: { cwd: item.cwd }, parentSession: typeof item.parentId === 'string' ? item.parentId : undefined }, title: typeof item.title === 'string' ? item.title : undefined, events: [] } as unknown as ProjectableSession
        const thread = this.dshThread(workspace, session)
        if (typeof item.title === 'string' && item.title.trim() !== '') {
          thread.title = item.title.slice(0, MAX_TITLE_LENGTH)
          thread.dshSessionTitle = thread.title
        }
      }
      return this.state.workspaces.map(workspace => this.summary(workspace))
    }
  }

  async addMessage(threadId: string, text: unknown, envelope?: Record<string, unknown>): Promise<MutableThread> {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const at = new Date().toISOString()
      const message: MutableMessage = { id: randomUUID(), text: requiredText(text, MAX_NOTE_LENGTH, 'text'), kind: 'user', at }
      thread.messages.push(message)
      thread.updatedAt = at
      workspace.updatedAt = at
      return structuredClone(thread)
    }, { envelope: envelope ? { ...envelope, action: `thread.message:${threadId}`, body: { text } } : undefined, targetThreadId: threadId })
  }

  async updateThread(threadId: string, input: Record<string, unknown> | null | undefined, envelope?: Record<string, unknown>): Promise<MutableThread> {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      if (input?.title !== undefined) thread.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
      if (input?.position !== undefined) workspace.layout.cards[thread.id] = positionOf(input.position)
      thread.updatedAt = new Date().toISOString()
      workspace.updatedAt = thread.updatedAt
      return structuredClone(thread)
    }, { envelope: envelope ? { ...envelope, action: `thread.update:${threadId}`, body: input } : undefined, targetThreadId: threadId })
  }

  async removeThread(threadId: string, envelope?: Record<string, unknown>): Promise<{ removed: number }> {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const removal = new Set([thread.id])
      for (let changed = true; changed;) {
        changed = false
        for (const item of workspace.projection.threads) {
          if (item.parentId !== null && item.parentId !== undefined && removal.has(item.parentId) && !removal.has(item.id)) { removal.add(item.id); changed = true }
        }
      }
      for (const item of workspace.projection.threads) {
        if (removal.has(item.id) && item.dshSessionId !== null && item.dshSessionId !== undefined && !this.state.hiddenSessionIds.includes(item.dshSessionId)) this.state.hiddenSessionIds.push(item.dshSessionId)
      }
      workspace.projection.threads = workspace.projection.threads.filter(item => !removal.has(item.id))
      workspace.updatedAt = new Date().toISOString()
      // Empty workspaces retain their revision, layout and annotations.
      return { removed: removal.size }
    }, { envelope: envelope ? { ...envelope, action: `thread.remove:${threadId}`, body: {} } : undefined, targetThreadId: threadId })
  }

  async clearLegacy(sessions: { id: string }[]): Promise<{ cleared: true }> {
    return this.mutate(() => {
      const hidden = new Set(this.state.hiddenSessionIds)
      for (const workspace of this.state.workspaces) for (const thread of workspace.projection.threads) if (thread.dshSessionId !== null && thread.dshSessionId !== undefined) hidden.add(thread.dshSessionId)
      for (const session of sessions) hidden.add(session.id)
      this.state.hiddenSessionIds = [...hidden]
      this.state.workspaces = []
      return { cleared: true as const }
    })
  }

  /** Replay one live DSH session into the dedicated projection workspace. */
  async projectSession(session: ProjectableSession, replayFrom = 0, workspaceTitle = 'DSH 任务', projectionEpoch?: number, generation?: number): Promise<MutableThread | null> {
    return this.mutate(() => {
      if (generation !== undefined && generation !== this.projectionGeneration) return null
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspaceForSession(session, workspaceTitle)
      if (projectionEpoch !== undefined && projectionEpoch !== workspace.projectionEpoch) return null
      const thread = this.dshThread(workspace, session)
      // `snapshotEvents()` replaces the removed `session.events` getter. It is
      // marked deprecated because DSH is moving complete logs out of memory, but
      // rebuilding this canvas from history needs the full sequence and the
      // reader is the only complete-log access a plugin still has.
      //
      // 直接调用，不写 `?.()`：宿主契约里它是必有的读口，缺了就是契约破损。
      // 静默跳过会让画布少一整段历史却看不出异常——那是「假报成功」。
      const snapshotEvents = session.snapshotEvents
      if (typeof snapshotEvents !== 'function') {
        throw new TypeError('projectSession 需要 session.snapshotEvents()：宿主契约缺读口，拒绝静默跳过历史')
      }
      for (const event of snapshotEvents()) {
        if (event.seq >= replayFrom) this.projectEventInto(workspace, thread, event)
      }
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project one committed DSH session event. Repeated sequence numbers are ignored. */
  async projectEvent(session: ProjectableSession, event: ProjectableEvent, workspaceTitle = 'DSH 任务', projectionEpoch?: number): Promise<MutableThread | null> {
    return this.projectEvents(session, [event], workspaceTitle, projectionEpoch)
  }

  /** Project a batch of committed events for one session in a single write. */
  async projectEvents(session: ProjectableSession, events: ProjectableEvent[], workspaceTitle = 'DSH 任务', projectionEpoch?: number, generation?: number): Promise<MutableThread | null> {
    if (events.length === 0) return null
    return this.mutate(() => {
      if (generation !== undefined && generation !== this.projectionGeneration) return null
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspaceForSession(session, workspaceTitle)
      if (projectionEpoch !== undefined && projectionEpoch !== workspace.projectionEpoch) return null
      const thread = this.dshThread(workspace, session)
      for (const event of events) this.projectEventInto(workspace, thread, event)
      return structuredClone(thread)
    }, { deferred: true })
  }

  /**
   * Accept one cold-history backfill window.
   *
   * This is a **deferred, envelope-free background write**, exactly like
   * `projectEvents`: reading old history is not a user edit, so it carries no
   * `baseRevision`, cannot conflict, and returns no revision. Its return value
   * is a report, never a revision promise.
   *
   * Two invariants are enforced here rather than trusted from the client:
   *
   * - A window is one logical unit however many requests it takes. Only the
   *   closing batch is applied, so a half-arrived window can neither widen
   *   `coverage.ranges` nor claim `historyComplete`.
   * - `historyComplete` is a claim about the WHOLE log. It is honoured only when
   *   the reported low water mark is seq 0 and the loader says no older page
   *   remains; any other combination is stored as "not complete". `loadThrough`
   *   resolves without loading in several cases (a concurrent page, a
   *   non-open session), so a client that mistakes that for success must not be
   *   able to turn it into a persisted claim.
   */
  async syncHistory(payload: unknown): Promise<{ accepted: false } | { sessionId: string; ranges: number[][]; historyComplete: boolean }> {
    const accepted = this.acceptHistoryBatch(payload)
    if (accepted === null) return { accepted: false }
    return this.applyHistoryWindow(accepted)
  }

  /** Stage one history batch; return the settled window when it closes. */
  acceptHistoryBatch(payload: unknown): SettledHistoryWindow | null {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new InputError('历史窗口必须是对象')
    const record = payload as Record<string, unknown>
    const historyId = record['historyId']
    if (typeof historyId !== 'string' || historyId === '') throw new InputError('historyId 必须是非空字符串')
    const sessionId = record['sessionId']
    if (typeof sessionId !== 'string' || sessionId === '') throw new InputError('sessionId 必须是非空字符串')
    const cursor = record['cursor']
    if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) throw new InputError('cursor 必须是非负安全整数')
    const cursorValue = cursor as number
    if (typeof record['complete'] !== 'boolean') throw new InputError('complete 必须是布尔值')
    if (!Array.isArray(record['events'])) throw new InputError('events 必须是数组')
    const events = (record['events'] as unknown[]).map(event => this.historyEventOf(event))
    let pending = this.historyWindows.get(historyId)
    if (pending !== undefined && pending.completed === true) {
      // The window already landed: a replay changes nothing, a new batch under
      // a settled id is a protocol error.
      if (cursorValue <= pending.lastCursor) return null
      throw new InputError('历史窗口已结算；请使用新的 historyId 重新上报')
    }
    if (cursorValue === 0) {
      pending = { historyId, sessionId, nextCursor: 0, lastCursor: -1, completed: false, events: [], bytes: 0 }
    } else if (pending === undefined || pending.sessionId !== sessionId) {
      throw new InputError('历史窗口缺少起始批次')
    } else if (cursorValue < pending.nextCursor) {
      return null
    } else if (cursorValue > pending.nextCursor) {
      throw new InputError('历史窗口批次不连续，请重新上报')
    }
    // 四条分支后 pending 必然存在（cursor 0 时刚被赋值）。
    const staged = pending as HistoryWindow
    staged.events.push(...events)
    if (staged.events.length > MAX_HISTORY_WINDOW_EVENTS) {
      this.historyWindows.delete(historyId)
      throw new InputError('历史窗口过大')
    }
    if (cursorValue + 1 > MAX_HISTORY_WINDOW_BATCHES) {
      this.historyWindows.delete(historyId)
      throw new InputError('历史窗口批次过多')
    }
    staged.nextCursor = cursorValue + 1
    staged.lastCursor = cursorValue
    staged.title = typeof record['title'] === 'string' ? record['title'] : staged.title
    staged.cwd = typeof record['cwd'] === 'string' && record['cwd'] !== '' ? record['cwd'] : staged.cwd
    const lowWater = record['lowWater']
    staged.lowWater = Number.isSafeInteger(lowWater) && (lowWater as number) >= 0 ? (lowWater as number) : staged.lowWater
    staged.hasMore = record['hasMore'] === true
    staged.claimsComplete = record['historyComplete'] === true
    this.historyWindows.set(historyId, staged)
    if (record['complete'] !== true) {
      this.pruneHistoryWindows()
      return null
    }
    const settled: SettledHistoryWindow = {
      historyId,
      sessionId,
      title: staged.title,
      cwd: staged.cwd,
      lowWater: staged.lowWater,
      hasMore: staged.hasMore,
      // The claim is only ever *considered* here; `applyHistoryWindow` still
      // re-checks it against the low water mark it actually received.
      claimsComplete: staged.claimsComplete,
      events: staged.events,
    }
    this.historyWindows.set(historyId, { historyId, sessionId, nextCursor: staged.nextCursor, lastCursor: staged.lastCursor, completed: true, events: [] })
    this.pruneHistoryWindows()
    return settled
  }

  /**
   * Drop the oldest SETTLED windows so a misbehaving client cannot grow the map.
   *
   * Only settled windows are eligible. An in-flight window (one that has taken
   * `cursor: 0` but not yet its closing batch) must survive: deleting it turns
   * the next batch into a 400 "历史窗口缺少起始批次", and because the client
   * posts one window per Session the failure hits every session competing for
   * the last slot. The previous implementation ignored `completed` and simply
   * dropped the oldest key, which silently killed whichever backfill happened
   * to be oldest — the map's own docstring already promised otherwise.
   *
   * If nothing has settled yet we let the map exceed the ceiling rather than
   * abort live transfers. That is bounded in practice (one window per session)
   * and still finite, unlike the stream of 400s it replaces.
   */
  pruneHistoryWindows(): void {
    if (this.historyWindows.size <= MAX_HISTORY_WINDOWS) return
    for (const [key, value] of this.historyWindows) {
      if (this.historyWindows.size <= MAX_HISTORY_WINDOWS) return
      if (value?.completed === true) this.historyWindows.delete(key)
    }
  }

  /** Validate one wire event down to the fields the projection reads. */
  historyEventOf(event: unknown): HistoryEvent {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new InputError('历史事件必须是对象')
    const record = event as Record<string, unknown>
    const seq = record['seq']
    if (!Number.isSafeInteger(seq) || (seq as number) < 0) throw new InputError('历史事件 seq 必须是非负安全整数')
    const type = record['type']
    if (typeof type !== 'string' || type === '') throw new InputError('历史事件 type 必须是非空字符串')
    const out: HistoryEvent = { seq: seq as number, type, time: Number.isFinite(record['time']) ? (record['time'] as number) : 0 }
    if (record['data'] !== undefined) out.data = record['data']
    return out
  }

  /**
   * Project one settled window and widen `thread.coverage` accordingly.
   *
   * Deferred (no envelope, no revision contract) for the same reason as
   * `projectEvents`: a background history read is not a user edit.
   */
  async applyHistoryWindow(window: SettledHistoryWindow): Promise<{ sessionId: string; ranges: number[][]; historyComplete: boolean }> {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(window.sessionId)) return null
      // The directory projection normally created this thread already. A cold
      // session whose listing never arrived is materialized here from the same
      // host facts the directory uses, so backfill never invents a second node
      // (the lookup is by `dshSessionId`).
      const session = { id: window.sessionId, title: window.title, header: { cwd: window.cwd } }
      const workspace = this.dshWorkspaceForSession(session, 'DSH 任务')
      const thread = this.dshThread(workspace, session)
      for (const event of window.events) this.projectEventInto(workspace, thread, event)
      const coverage: MutableCoverage = thread.coverage ?? { ranges: [], historyComplete: false, textTruncated: false }
      // `coverage.ranges` may never be a single `maxSeq`: the whole point is to
      // tell a partial read apart from a contiguous one. The Session window is
      // contiguous by construction, so one window proves exactly
      // `lowWater .. lastEventSeq` was read. Two *unrelated* windows leave the
      // untouched seqs between them as a visible hole, which `maxSeq` would
      // silently absorb.
      const low = Number.isSafeInteger(window.lowWater) && (window.lowWater as number) >= 0 ? (window.lowWater as number) : null
      if (low !== null) {
        const seqs = window.events.map(event => event.seq).filter(seq => Number.isSafeInteger(seq) && seq >= 0)
        const to = seqs.length === 0 ? low : Math.max(low, ...seqs)
        coverage.ranges = mergeCoverageRanges(coverage.ranges, low, to)
      }
      // Only a window that reaches seq 0 with no older page left may claim the
      // whole log; the client's own flag can only ever *withhold* it.
      const complete = window.claimsComplete === true && low === 0 && window.hasMore !== true && coverage.ranges[0]?.[0] === 0
      if (complete) coverage.historyComplete = true
      thread.coverage = coverage
      const now = new Date().toISOString()
      thread.updatedAt = now
      workspace.updatedAt = now
      // Background write: a report, never a revision.
      return { sessionId: window.sessionId, ranges: coverage.ranges.map(range => [...range]), historyComplete: coverage.historyComplete }
    }, { deferred: true }) as Promise<{ sessionId: string; ranges: number[][]; historyComplete: boolean }>
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.dataFile), { recursive: true })
    try {
      const raw = await readFile(this.dataFile, 'utf8')
      const { state } = normalizeState(JSON.parse(raw))
      this.lastKnownDigest = digestOf(raw)
      this.lastKnownMtime = await stat(this.dataFile).then(stats => stats.mtimeMs, () => null)
      const document = state as unknown as MutableState
      if (document.format) {
        // 归并/前缀写回只在内存里生效，**不回写磁盘**。
        //
        // 这是有意为之的既有契约：加载必须对磁盘字节零副作用
        // （layout-migration / migration 两组测试对此有硬断言——「v4加载不改字节」
        // 「显式布局预览精确备份、无写回」）。把修复改成加载时自动落盘会破坏
        // 「预览/预览前备份」的可审计性：用户还没同意，文件就被改了。
        //
        // 需要真正落盘时走显式路径：`归一化session前缀.mjs --apply`
        // （Project Docs/4-测试/），它先 dry-run、断言计数不变，再原子替换。
        const { state: prepared } = this.prepareState(document)
        this.publishState(prepared)
      } else {
        // 旧格式（无 format 字段）不自动迁移，必须显式走迁移流程。
        // legacy 字节一律不重写。
        this.state = document
        this.legacyReadOnly = true
      }
    } catch (error) {
      const typed = error as { code?: string; message?: string }
      if (typed?.code !== 'ENOENT') throw new Error(`synapnova: cannot read ${this.dataFile}: ${typed.message}`)
      this.publishState(createFrozenState())
      await this.save()
    }
  }

  /**
   * Run one committed change against the document.
   *
   * Two publication rules, split by how the write lands:
   *
   * - Deferred (event projection) writes coalesce into one later save, so the
   *   change has to be visible before that write happens; a failed flush keeps
   *   `dirty` set and stays reportable.
   * - Everything else stages on a candidate copy and publishes it only after
   *   the file is on disk. A rejected write — bad input, a held lock, an
   *   external rewrite — therefore leaves memory exactly as it was, instead of
   *   applying a half-finished change to the live document.
   */
  commit(envelope: Record<string, unknown>, action: (workspace: MutableWorkspace) => unknown, { beforeCommit }: { beforeCommit?: () => Promise<void> } = {}): Promise<unknown> {
    return this.mutate(() => action(this.workspace(envelope['workspaceId'] as string)), { envelope, beforeCommit }) as Promise<unknown>
  }

  async updateLayout(workspaceId: string, input: Record<string, unknown> | null | undefined, envelope: Record<string, unknown>): Promise<{ layout: MutableLayout; regions: Record<string, unknown>[]; annotations: Record<string, unknown>[] }> {
    if (envelope?.projectionEpoch === undefined) throw new InputError('layout 写入必须携带 projectionEpoch')
    return this.mutate(() => {
      const workspace = this.workspace(workspaceId)
      const layoutInput = input?.['layout']
      if (!input || typeof input !== 'object' || !layoutInput || typeof layoutInput !== 'object' || Array.isArray(layoutInput)) throw new InputError('layout 必须是对象')
      const layoutRecord = layoutInput as Record<string, unknown>
      for (const field of ['cards', 'collapsed', 'viewport'] as const) {
        if (Object.hasOwn(layoutRecord, field)) (workspace.layout as unknown as Record<string, unknown>)[field] = structuredClone(layoutRecord[field])
      }
      // `regions` and `annotations` are TOP-LEVEL workspace fields (see
      // shared/schema.js), not members of `layout`. They used to be dropped
      // silently here, so a canvas that committed a region saw it vanish on the
      // next read. Accept them only when the caller actually sent them, so an
      // older client that only knows about `layout` cannot wipe them.
      for (const field of ['regions', 'annotations'] as const) {
        if (!Object.hasOwn(input, field)) continue
        if (!Array.isArray(input[field])) throw new InputError(`${field} 必须是数组`)
        ;(workspace as unknown as Record<string, unknown>)[field] = structuredClone(input[field])
      }
      // Normalize only the candidate: a bad layout cannot reach live state or disk.
      const normalized = normalizeFrozenState(this.state).state.workspaces.find(item => item.id === workspaceId)
      // 上面按 id 查找，命中与否由 normalizeFrozenState 的完整性校验保证
      // （候选 state 刚被整体归一化过，workspaceId 一定在其中）。
      const target = normalized as (typeof normalizeFrozenState extends never ? never : NonNullable<typeof normalized>)
      workspace.layout = target.layout as unknown as MutableLayout
      workspace.regions = target.regions as unknown as Record<string, unknown>[]
      workspace.annotations = target.annotations as unknown as Record<string, unknown>[]
      workspace.updatedAt = new Date().toISOString()
      return { layout: structuredClone(workspace.layout), regions: structuredClone(workspace.regions), annotations: structuredClone(workspace.annotations) }
    }, { envelope: { ...envelope, action: 'workspace.layout', body: input }, workspaceId })
  }

  async mutate<T>(action: () => T, options: MutateOptions = {}): Promise<T> {
    // `mutateLocked` 在 deferred + 动作返回 null 时也返回 null；旧实现的调用方
    // 一律按 `T` 使用返回值（deferred 路径的调用者自己会判断 null）。这里保持
    // 原来的 `Promise<T>` 契约，空值判定由调用方做——与迁移前逐字一致。
    return this.runExclusive(() => this.mutateLocked(action, options)) as Promise<T>
  }

  /**
   * The body of `mutate`, for callers that already hold the write queue.
   *
   * Only `syncSessions` uses this: its paged path must stage the batch, apply the
   * closing listing, and be able to reopen the snapshot if the apply fails — one
   * atomic step that a nested `runExclusive` would deadlock on.
   */
  async mutateLocked<T>(action: () => T, { deferred = false, envelope, creating = false, workspaceId, targetThreadId, beforeCommit }: MutateOptions = {}): Promise<T | null> {
    if (this.legacyReadOnly) {
      const error = new InputError('旧格式数据为只读，请先显式预览并迁移到冻结格式')
      error.code = 'MIGRATION_REQUIRED'
      throw error
    }
    let metadata: ValidatedEnvelope | undefined
    if (envelope !== undefined) {
      metadata = validateEnvelope(envelope, creating)
      const prior = this.state.idempotency[metadata.operationId]
      if (prior !== undefined) {
        if (prior.hash !== metadata.hash || prior.workspaceId !== metadata.workspaceId) throw new InputError('operationId 已用于不同请求')
        return structuredClone(prior.response) as T
      }
      const current = this.state.workspaces.find(item => item.id === metadata?.workspaceId)
      if (this.state.idempotencyFloor !== null && metadata.operationId <= this.state.idempotencyFloor) throw new IdempotencyExpiredError(current?.revision ?? 0)
      if (creating) {
        if (current) throw new RevisionConflictError(current.revision)
      } else {
        if (!current) throw new NotFoundError('工作空间不存在')
        if (metadata.baseRevision !== current.revision) throw new RevisionConflictError(current.revision)
        if (metadata.projectionEpoch !== undefined && metadata.projectionEpoch !== current.projectionEpoch) {
          const error = new RevisionConflictError(current.revision, 'projectionEpoch 已过期，请重新预览')
          // `RevisionConflictError.code` 在 errors.ts 里声明为 `readonly`，但运行期
          // 是可写的普通实例字段；旧代码就是直接覆盖它。这里只把那一处赋值
          // 显式告诉类型系统（与 errors.ts 的 `readonly` 声明不冲突）。
          ;(error as { code: string }).code = 'PROJECTION_EPOCH_CONFLICT'
          throw error
        }
      }
      if (workspaceId !== undefined && workspaceId !== metadata.workspaceId) throw new InputError('envelope.workspaceId 与目标不符')
      if (targetThreadId !== undefined && this.locateThread(targetThreadId).workspace.id !== metadata.workspaceId) throw new InputError('节点不属于 envelope.workspaceId')
    }
    // Migration backup/source checks share this queue with writes and GET.
    // Exact idempotent replay above remains valid even after preview eviction.
    if (beforeCommit) await beforeCommit()
    const published = this.state
    const ownership = this.sessionOwnership
    this.state = cloneState(published)
    try {
      const result = action()
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') throw new Error('mutate action 必须是同步函数')
      if (deferred && result === null) {
        this.state = published
        return null
      }
      // Alias adaptation is in-memory only. The disk has exactly one grouped owner.
      canonicalizeThreads(this.state, deferred)
      // The transitional `threads` alias must stay a getter/setter onto the
      // canonical group. A plain `workspace.threads = []` would instead add an
      // enumerable own key that normaliseFrozenState silently drops, so the
      // change would vanish with no error. Fail loudly if that ever happens.
      for (const workspace of this.state.workspaces) assertThreadsAlias(workspace)
      const now = new Date().toISOString()
      for (const workspace of this.state.workspaces) {
        const previous = published.workspaces.find(item => item.id === workspace.id)
        if (!previous) workspace.revision = 1
        else if (metadata?.workspaceId === workspace.id || JSON.stringify(previous) !== JSON.stringify(workspace)) workspace.revision = previous.revision + 1
      }
      this.state.updatedAt = now
      let response: unknown = result
      if (metadata) {
        const revision = this.workspace(metadata.workspaceId).revision
        const operationResult = metadata.action === 'workspace.create' ? { workspace: result }
          : metadata.action.startsWith('thread.') && !metadata.action.startsWith('thread.remove:') ? { thread: result }
            : result
        response = JSON.parse(JSON.stringify({ revision, result: operationResult === undefined ? null : operationResult }))
        this.state.idempotency[metadata.operationId] = { hash: metadata.hash, workspaceId: metadata.workspaceId, revision, at: now, response: structuredClone(response) as Record<string, unknown> }
        trimIdempotency(this.state)
      }
      // Validate without replacing references used by the current operation.
      this.state = normalizeFrozenState(this.state).state as unknown as MutableState
      if (deferred) this.markDirty()
      else await this.save()
      return response as T
    } catch (error) {
      this.state = published
      this.sessionOwnership = ownership
      throw error
    }
  }

  /** Mark the state dirty and schedule one trailing flush for the window. */
  markDirty(): void {
    this.dirty = true
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      // A failed flush remains dirty for an explicit flush or a later event;
      // do not schedule an unbounded retry loop while the filesystem is failing.
      void this.flush().catch(error => this.onFlushError(error))
    }, SAVE_DEBOUNCE_MS)
  }

  /** Persist the current state when dirty, ordered after in-flight mutations. */
  flush(): Promise<unknown> {
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    const task = this.serial.then(async () => {
      try { await this.save() } catch (error) {
        this.dirty = true
        throw error
      }
    })
    this.serial = task.catch(() => undefined)
    return task
  }

  async save(): Promise<void> {
    if (this.legacyReadOnly) throw new InputError('旧格式只读，请显式迁移后再保存')
    normalizeFrozenState(this.state)
    this.state.updatedAt = new Date().toISOString()
    // Two dsh web instances sharing one profile would clobber each other's
    // canvas state. The content digest — not just an mtime — is the guard:
    // refuse to overwrite a file this store did not write last, instead of
    // warning and then writing over the other instance's work.
    await this.acquireLock()
    try {
      // Read the baseline while holding the same lock as the atomic replace.
      // A writer that waited before acquire must observe the preceding commit.
      const before = await this.fileDigest()
      if (this.lastKnownDigest !== null && before !== null && before !== this.lastKnownDigest) {
        throw new InputError('synapnova: workspaces.json 已被另一个实例修改；已拒绝覆盖，请重新加载')
      }
      const temporaryFile = `${this.dataFile}.${process.pid}.tmp`
      const payload = `${JSON.stringify(this.state)}\n`
      await writeFile(temporaryFile, payload, 'utf8')
      await this.replaceFileWithRetry(temporaryFile)
      this.lastKnownDigest = digestOf(payload)
      this.lastKnownMtime = await stat(this.dataFile).then(stats => stats.mtimeMs, () => null)
    } finally {
      await this.releaseLock()
    }
  }

  /**
   * Atomically publish the temporary file.
   *
   * On Windows `rename` fails with EPERM/EACCES/EBUSY when another handle has
   * the target open — a concurrent reader (the regression suite polling the
   * data file, an indexer, a second store) collides with roughly 3% of writes.
   * A single attempt silently loses that projection, so retry a bounded number
   * of times with short backoff. `flush()` itself still does not auto-retry: a
   * genuinely persistent failure keeps `dirty` set and stays reportable.
   */
  async replaceFileWithRetry(
    temporaryFile: string,
    { replace = rename, wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random }: ReplaceRetryOptions = {},
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await replace(temporaryFile, this.dataFile)
        return
      } catch (error) {
        const code = (error as { code?: string }).code
        const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
        if (!transient || attempt >= SAVE_REPLACE_ATTEMPTS) throw error
        await wait(SAVE_REPLACE_BACKOFF_MS * attempt + random() * SAVE_REPLACE_JITTER_MS)
      }
    }
  }

  async fileDigest(): Promise<string | null> {
    try { return digestOf(await readFile(this.dataFile)) } catch { return null }
  }

  /**
   * Take an exclusive cross-process lock, breaking only a provably stale one.
   *
   * A live holder now makes the write fail outright. The previous behaviour was
   * to warn on stderr and then write anyway, which is precisely how two
   * instances clobbered each other's canvas.
   */
  async acquireLock(): Promise<void> {
    const lockFile = `${this.dataFile}.lock`
    if (await this.tryAcquire(lockFile)) return
    if (await this.lockIsStale(lockFile)) {
      await unlink(lockFile).catch(() => {})
      if (await this.tryAcquire(lockFile)) return
    }
    throw new InputError('synapnova: 另一个实例正持有 workspaces.json 的写锁；已拒绝写入，请只运行一个 dsh web 实例')
  }

  async tryAcquire(lockFile: string): Promise<boolean> {
    const token = `${process.pid}:${randomUUID()}`
    try {
      await writeFile(lockFile, `${token}\n`, { flag: 'wx' })
      this.lockToken = token
      return true
    } catch {
      return false
    }
  }

  /** A lock is stale when its owner PID is gone or the lock file is older than the stale window. */
  async lockIsStale(lockFile: string): Promise<boolean> {
    try {
      const [content, stats] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)])
      const tooOld = Date.now() - stats.mtimeMs > LOCK_STALE_MS
      const pid = Number.parseInt(content, 10)
      if (!Number.isInteger(pid)) return tooOld
      if (pid === process.pid) return false
      try {
        process.kill(pid, 0)
        return tooOld
      } catch {
        return true
      }
    } catch {
      return false
    }
  }

  /** Remove the lock only if this store still owns it. */
  async releaseLock(): Promise<void> {
    const token = this.lockToken
    if (token === null) return
    this.lockToken = null
    const lockFile = `${this.dataFile}.lock`
    try {
      if ((await readFile(lockFile, 'utf8')).trim() !== token) return
      await unlink(lockFile)
    } catch { /* the lock is already gone */ }
  }

  workspace(workspaceId: string): MutableWorkspace {
    const workspace = this.state.workspaces.find(item => item.id === workspaceId)
    if (workspace === undefined) throw new NotFoundError('工作空间不存在')
    return workspace
  }

  locateThread(threadId: string): { workspace: MutableWorkspace; thread: MutableThread } {
    for (const workspace of this.state.workspaces) {
      const thread = workspace.projection.threads.find(item => item.id === threadId)
      if (thread !== undefined) return { workspace, thread }
    }
    throw new NotFoundError('节点不存在')
  }

  /**
   * Resolve the projected workspace for one DSH workspace.
   *
   * The host workspace id is the authority. `cwd` is only a display label plus
   * a one-time adoption key for rows written before the binding existed, so two
   * host workspaces that happen to share a path no longer merge into one canvas
   * node. When this path has no host attribution at all (direct replay, tests
   * that drive the store without a host directory), keep the historical
   * per-cwd grouping instead of collapsing every session into one bucket.
   *
   * ## `allowCwdAdoption` 为什么必须由调用方显式传
   *
   * `byCwd` 回退本意只收「旧版本按 cwd 匹配留下的、没有 host 绑定的历史行」。
   * 但 `dshWorkspaceId == null && cwd 相同` 这个条件**同时匹配**另一种情况：
   * 本批次里确实还没有归属的会话（宿主还没把它分到任何工作区）。
   *
   * 两者形状一样，只看行本身无法区分，于是出过两个真实故障：
   *   - **同批次顺序敏感**：未归属会话排在已归属会话之前时，整个未归属桶
   *     被随后出现的宿主工作区吞掉；调换顺序就正常。
   *   - **跨轮必现**：第一轮宿主只报会话、第二轮才报工作区，那个会话被收编。
   * 后果是用户在 A 里看到不属于它的卡片，删掉还会连带从「未分组」消失。
   *
   * 所以把判断交给**知道本批次全貌**的调用方：`directoryAction` 能算出
   * 「本批次里这个 cwd 是否已有真正绑定该 host id 的工作区」。若有，说明
   * `byCwd` 命中的只可能是历史残留而不是本批次的未归属桶，才允许收编。
   * 默认 `false` —— 默认不猜，猜错的代价是数据串味。
   */
  dshWorkspace(
    hostWorkspaceId: string | null,
    fallbackTitle: string,
    cwd: string | null = null,
    allowCwdAdoption = false,
  ): MutableWorkspace {
    // Only a real host id may key the lookup: `null` means "no attribution on
    // this path", where every unbound row would otherwise collide into one.
    if (hostWorkspaceId !== null) {
      const existing = this.state.workspaces.find(item => item.kind === 'dsh' && item.dshWorkspaceId === hostWorkspaceId)
      if (existing !== undefined) return existing
    }
    // 无归属（`null`）时仍按 cwd 归并：这是「宿主完全没给工作区」的老路径，
    // 每个 cwd 自成一桶，不会串到别的宿主工作区里去。
    // 有归属时必须由调用方确认本批次该 cwd 无新绑定，才允许收编历史残留。
    if (hostWorkspaceId === null || allowCwdAdoption) {
      const byCwd = this.state.workspaces.find(item => item.kind === 'dsh' && item.dshWorkspaceId == null && item.cwd === cwd)
      if (byCwd !== undefined) {
        if (hostWorkspaceId !== null) byCwd.dshWorkspaceId = hostWorkspaceId
        return byCwd
      }
    }
    const now = new Date().toISOString()
    const workspace = newWorkspace({
      id: randomUUID(),
      kind: 'dsh',
      dshWorkspaceId: hostWorkspaceId,
      cwd,
      title: hostWorkspaceId === null ? workspaceTitle(cwd as string, fallbackTitle) : fallbackTitle,
      createdAt: now,
      updatedAt: now,
    })
    this.state.workspaces.unshift(workspace)
    return workspace
  }

  /** Which projected workspace does one live/committed session belong to? */
  dshWorkspaceForSession(session: ProjectableSession, fallbackTitle = 'DSH 任务'): MutableWorkspace {
    for (const workspace of this.state.workspaces) {
      if (workspace.kind !== 'dsh') continue
      if (workspace.projection.threads.some(thread => sameDshSessionId(thread.dshSessionId, session.id))) return workspace
    }
    const owner = this.sessionOwnership.get(session.id)
    return this.dshWorkspace(owner?.id ?? null, owner?.title ?? fallbackTitle, sessionCwd(session))
  }

  dshThread(workspace: MutableWorkspace, session: ProjectableSession): MutableThread {
    let thread = workspace.projection.threads.find(item => sameDshSessionId(item.dshSessionId, session.id))
    if (thread !== undefined) {
      if (typeof session.title === 'string' && session.title.trim() !== '') {
        const title = session.title.slice(0, MAX_TITLE_LENGTH)
        thread.title = title
        thread.dshSessionTitle = title
      }
      // `inheritedEventCount` is DSH's durable fork cut, the successor of the
      // removed `header.seedLength`. It survives restore, unlike `firstLiveSeq`.
      const seedLength = session.inheritedEventCount
      if (Number.isSafeInteger(seedLength) && (seedLength as number) >= 0) thread.sourceSeedLength = seedLength as number
      return thread
    }
    const header = session.header as { parentSession?: unknown } | null | undefined
    const parentSessionId = typeof header?.parentSession === 'string' ? header.parentSession : null
    const parent = parentSessionId === null ? undefined : workspace.projection.threads.find(item => sameDshSessionId(item.dshSessionId, parentSessionId))
    const siblings = workspace.projection.threads.filter(item => item.sourceParentSessionId === parentSessionId)
    const now = new Date().toISOString()
    const inherited = session.inheritedEventCount
    thread = {
      id: randomUUID(),
      title: typeof session.title === 'string' && session.title.trim() !== '' ? session.title.slice(0, MAX_TITLE_LENGTH) : (parent === undefined ? 'DSH 会话' : `${parent.title} 分支`),
      parentId: parent?.id ?? null,
      sourceParentSessionId: parentSessionId,
      sourceSeedLength: Number.isSafeInteger(inherited) && (inherited as number) >= 0 ? (inherited as number) : null,
      dshSessionId: session.id,
      dshSessionTitle: typeof session.title === 'string' ? session.title.slice(0, MAX_TITLE_LENGTH) : null,
      color: TOPIC_COLORS[workspace.projection.threads.length % TOPIC_COLORS.length] as string,
      // Coordinates belong to layout and are only materialized in read views.
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingProcess: [],
    }
    workspace.projection.threads.push(thread)
    // A child may arrive before its parent during startup replay. Repair that
    // relation when the missing parent later reaches the projection.
    for (const child of workspace.projection.threads) {
      if (child.sourceParentSessionId === session.id && child.parentId === null) child.parentId = thread.id
    }
    workspace.updatedAt = now
    return thread
  }

  projectEventInto(workspace: MutableWorkspace, thread: MutableThread, event: ProjectableEvent): void {
    const data = event.data as Record<string, unknown> | null | undefined
    if (event.type === 'session/title' && typeof data?.['title'] === 'string') {
      thread.title = data['title'].slice(0, MAX_TITLE_LENGTH)
      thread.dshSessionTitle = thread.title
      thread.updatedAt = new Date(event.time).toISOString()
      workspace.updatedAt = thread.updatedAt
      return
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      this.foldToolProcess(thread, event)
      workspace.updatedAt = thread.updatedAt
      return
    }
    const projection: ProjectionNote | null = projectableEvent(event)
    if (projection === null || thread.messages.some(message => message.sourceSeq === event.seq)) return
    const at = new Date(event.time).toISOString()
    const message: MutableMessage = {
      id: randomUUID(),
      text: projection.text,
      kind: projection.kind,
      sourceSeq: event.seq,
      at,
      ...(projection.kind === 'assistant' || projection.kind === 'error'
        ? { turn: data?.['turn'] as number | undefined, step: data?.['step'] as number | undefined, process: [] }
        : {}),
    }
    this.attachPendingProcess(thread, message)
    thread.messages.push(message)
    thread.updatedAt = at
    workspace.updatedAt = at
    if (thread.dshSessionTitle === null && projection.kind === 'user') {
      thread.title = titleFromText(projection.text)
      thread.dshSessionTitle = thread.title
    }
  }

  /**
   * Fold one tool call or result into the assistant message of its own
   * turn/step, keyed by `callId`, so a tool invocation never becomes a
   * separate canvas card. If a tool result arrives before its associated
   * assistant/error message, retain it on the thread until that turn appears.
   */
  foldToolProcess(thread: MutableThread, event: ProjectableEvent): void {
    const at = new Date(event.time).toISOString()
    const data = (event.data ?? {}) as Record<string, unknown>
    const target = [...thread.messages].reverse().find(message =>
      (message.kind === 'assistant' || message.kind === 'error')
      && (message.turn === (data['turn'] as number | undefined) && message.step === (data['step'] as number | undefined)
        || message.turn === undefined && message.step === undefined))
    const process = target === undefined ? (thread.pendingProcess ??= []) : (target.process ??= [])
    const messageData = data['message'] as { source?: { callId?: unknown }; content?: unknown } | null | undefined
    const callId = String(event.type === 'tool/call' ? data['callId'] : messageData?.source?.callId ?? '')
    const entry = process.find(item => item.callId === callId)
    if (event.type === 'tool/call') {
      if (entry === undefined) {
        process.push({ callId, turn: data['turn'] as number | undefined, step: data['step'] as number | undefined, name: data['name'] as string | undefined, arguments: data['arguments'], result: null, error: null })
      } else {
        entry.name = data['name'] as string | undefined
        entry.arguments = data['arguments']
      }
    } else {
      const outcome = contentText(messageData?.['content'] as unknown)
      const error = errorText(data['error'])
      if (entry === undefined) {
        process.push({ callId, turn: data['turn'] as number | undefined, step: data['step'] as number | undefined, name: '工具调用', arguments: null, result: outcome, error })
      } else {
        entry.result = outcome
        entry.error = error
      }
    }
    thread.updatedAt = at
  }

  attachPendingProcess(thread: MutableThread, message: MutableMessage): void {
    if (!Array.isArray(thread.pendingProcess) || thread.pendingProcess.length === 0 || !Array.isArray(message.process)) return
    const matching = thread.pendingProcess.filter(entry => entry.turn === message.turn && entry.step === message.step)
    if (matching.length === 0) return
    message.process.push(...matching.map(({ turn, step, ...entry }) => entry))
    thread.pendingProcess = thread.pendingProcess.filter(entry => entry.turn !== message.turn || entry.step !== message.step)
  }

  thread({ title, parentId, dshSessionId, dshSessionTitle, position, color, now, order }: {
    title?: unknown;
    parentId?: unknown;
    dshSessionId?: unknown;
    dshSessionTitle?: unknown;
    position?: unknown;
    color?: unknown;
    now: string;
    order: number;
  }): MutableThread {
    return {
      id: randomUUID(),
      title: requiredText(title, MAX_TITLE_LENGTH, 'title'),
      parentId: typeof parentId === 'string' && parentId.length > 0 ? parentId : null,
      dshSessionId: typeof dshSessionId === 'string' && dshSessionId.length > 0 ? dshSessionId : null,
      dshSessionTitle: typeof dshSessionTitle === 'string' ? dshSessionTitle.slice(0, MAX_TITLE_LENGTH) : null,
      color: TOPIC_COLORS.includes(color as string) ? (color as string) : (TOPIC_COLORS[order % TOPIC_COLORS.length] as string),
      position: positionOf(position ?? { x: 86 + (order % 3) * 410, y: 82 + Math.floor(order / 3) * 260 }),
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingProcess: [],
    }
  }

  summary(workspace: MutableWorkspace): Record<string, unknown> {
    return { id: workspace.id, kind: workspace.kind ?? 'manual', dshWorkspaceId: workspace.dshWorkspaceId ?? null, cwd: workspace.cwd ?? null, title: workspace.title, revision: workspace.revision ?? null, projectionEpoch: workspace.projectionEpoch ?? null, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, threadCount: workspace.projection.threads.length }
  }
}

/**
 * `create()` 读 `envelope.workspaceId`。
 *
 * 旧实现写的是 `envelope?.workspaceId ?? randomUUID()`；单独抽成小函数只是为了
 * 让「envelope 可能是 undefined」这一步在类型上显式，判定与取值完全相同。
 */
function enrollmentWorkspaceId(envelope: Record<string, unknown> | undefined): string | undefined {
  return envelope?.['workspaceId'] as string | undefined
}

function digestOf(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Detach the mutable document from the published one.
 *
 * `workspaces` holds every nested thread, message and tool-process entry, so a
 * shallow copy would share them and a rejected action would still have mutated
 * the live state through those references.
 */
function cloneState(state: MutableState): MutableState {
  return structuredClone(state)
}

function newWorkspace(fields: Record<string, unknown>): MutableWorkspace {
  return { ...fields, revision: 1, projectionEpoch: 1, projection: { threads: [] }, layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } }, materials: [], regions: [], annotations: [] } as unknown as MutableWorkspace
}

/**
 * Guard the single canonical thread owner before a state is published.
 *
 * `workspace.threads` used to be a non-enumerable alias onto
 * `projection.threads`; it is gone, so every consumer reads the canonical group
 * directly. A stray `workspace.threads = []` would look like a normal write,
 * add an enumerable own key, and then be dropped by `normalizeFrozenState` on
 * the next normalise — the edit would vanish without an error. Catch it here.
 */
function assertThreadsAlias(workspace: MutableWorkspace): void {
  const descriptor = Object.getOwnPropertyDescriptor(workspace, 'threads')
  if (descriptor !== undefined) throw new Error(`synapnova: workspace ${workspace.id} 的 threads 被写成了自有属性，会绕过 projection.threads；请改 canonical 分组`)
  if (!Array.isArray(workspace.projection?.threads)) throw new Error(`synapnova: workspace ${workspace.id} 缺少 canonical projection.threads`)
}
function canonicalizeThreads(state: MutableState, projectionOnly: boolean): void {
  for (const workspace of state.workspaces) for (const thread of workspace.projection.threads) {
    if (Object.hasOwn(thread, 'position')) {
      if (!projectionOnly) workspace.layout.cards[thread.id] = positionOf(thread.position)
      delete thread.position
    }
    thread.coverage ??= { ranges: [], historyComplete: false, textTruncated: false }
  }
}
function workspaceView(workspace: MutableWorkspace): Record<string, unknown> {
  const snapshot = structuredClone(workspace) as unknown as Record<string, unknown> & { threads: MutableThread[] }
  // Compatibility is a detached read view, never round-tripped as writable state.
  snapshot.threads = structuredClone(workspace.projection?.threads ?? workspace.threads) as MutableThread[]
  for (const thread of snapshot.threads) thread.position = structuredClone(workspace.layout?.cards[thread.id] ?? thread.position ?? { x: 86, y: 82 })
  return snapshot
}
export function canonicalHash(value: unknown): string {
  function canonical(entry: unknown): unknown {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry
    if (Array.isArray(entry)) return entry.map(canonical)
    if (entry && typeof entry === 'object' && (Object.getPrototypeOf(entry) === Object.prototype || Object.getPrototypeOf(entry) === null)) {
      const record = entry as Record<string, unknown>
      const result: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(record).sort()) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new InputError('请求包含非法键')
        result[key] = canonical(record[key])
      }
      return result
    }
    throw new InputError('请求必须是有限 JSON 值')
  }
  return digestOf(JSON.stringify(canonical(value)))
}
function validateEnvelope(envelope: unknown, creating: boolean): ValidatedEnvelope {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new InputError('mutation 必须携带 envelope')
  const record = envelope as Record<string, unknown>
  if (typeof record['workspaceId'] !== 'string' || record['workspaceId'].length === 0) throw new InputError('workspaceId 必须是非空字符串')
  const baseRevision = record['baseRevision']
  if (!Number.isSafeInteger(baseRevision) || (baseRevision as number) < (creating ? 0 : 1)) throw new InputError('baseRevision 非法')
  if (creating && baseRevision !== 0) throw new InputError('新工作区 baseRevision 必须为 0')
  if (typeof record['operationId'] !== 'string' || !UUID_V7.test(record['operationId'])) throw new InputError('operationId 必须是标准小写 UUIDv7')
  const projectionEpoch = record['projectionEpoch']
  if (!Number.isSafeInteger(projectionEpoch) || (projectionEpoch as number) < 1) throw new InputError('projectionEpoch 必须是正安全整数')
  if (creating && projectionEpoch !== 1) throw new InputError('新工作区 projectionEpoch 必须为 1')
  const body = record['body']
  if (typeof record['action'] !== 'string' || !record['action'] || !body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('action/body 非法')
  return {
    ...record,
    workspaceId: record['workspaceId'],
    baseRevision: baseRevision as number,
    projectionEpoch: projectionEpoch as number,
    operationId: record['operationId'],
    action: record['action'] as string,
    body: body as Record<string, unknown>,
    hash: canonicalHash({ workspaceId: record['workspaceId'], action: record['action'], body }),
  }
}
function trimIdempotency(state: MutableState): void {
  const entries = Object.entries(state.idempotency).sort((a, b) => a[1].at.localeCompare(b[1].at) || a[0].localeCompare(b[0]))
  for (const [id] of entries.slice(0, Math.max(0, entries.length - IDEMPOTENCY_LIMIT))) {
    delete state.idempotency[id]
    if (state.idempotencyFloor === null || id > state.idempotencyFloor) state.idempotencyFloor = id
  }
}

/**
 * Map each session id to the host workspace that owns it.
 *
 * The host publishes `{ id, title, sessionIds }` per workspace, so ownership is
 * explicit rather than inferred from a path: two host workspaces that share a
 * `cwd` stay distinct, and a session the host has not grouped falls into its
 * own bucket instead of leaking into a selected workspace. First declaration
 * wins, so a duplicated session id cannot be reassigned by a later entry.
 */
function hostWorkspaceOwnership(hostWorkspaces: HostWorkspaceEntry[]): Map<string, { id: string; title: string }> {
  const ownership = new Map<string, { id: string; title: string }>()
  for (const workspace of hostWorkspaces) {
    if (typeof workspace?.id !== 'string' || workspace.id === '') continue
    const title = typeof workspace.title === 'string' && workspace.title.trim() !== '' ? workspace.title : '未分组'
    for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
      if (typeof sessionId === 'string' && sessionId !== '' && !ownership.has(sessionId)) ownership.set(sessionId, { id: workspace.id, title })
    }
  }
  return ownership
}

/**
 * The legacy `session-` prefix on a stored `dshSessionId`.
 *
 * 必须连 uuid 一起校验：只剥 `session-` 前缀会把非 uuid 的 id（`session-1`、
 * `session-foo`）误伤成 `1` / `foo`。宿主真实上报的旧形式一定是
 * `session-<uuid>`，所以只匹配 uuid 才不会破坏其它形态的 session id。
 */
const BARE_SESSION_PREFIX = /^session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * Compare two DSH session ids that may be spelled with or without the legacy
 * `session-` prefix.
 *
 * The Host used to report ids as `session-<uuid>` and now reports the bare
 * `<uuid>`. Rows projected by an older build carry the prefixed form, so a
 * strict `===` lookup would treat the same session as a brand-new thread and
 * project it twice. Only the prefix is normalised; two different uuids never
 * compare equal.
 */
function sameDshSessionId(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left === right) return true
  const strip = (value: string): string => value.startsWith('session-') ? value.slice('session-'.length) : value
  return strip(left) === strip(right)
}

/** How much projected content one workspace carries; higher wins a merge. */
function workspaceWeight(workspace: MutableWorkspace): { threads: number; messages: number } {
  const threads = Array.isArray(workspace?.projection?.threads) ? workspace.projection.threads : []
  let messages = 0
  for (const thread of threads) messages += Array.isArray(thread?.messages) ? thread.messages.length : 0
  return { threads: threads.length, messages }
}

/**
 * Collapse workspaces that describe the same canvas but were split apart by an
 * earlier version of the adoption rule.
 *
 * Before the host workspace id became the lookup key, rows were matched by
 * `cwd` alone. A row written while no host attribution was available (`null`)
 * therefore stayed behind as its own canvas once the host id appeared, and the
 * canvas then opened on whichever duplicate the list happened to put first —
 * typically the empty one — so already-projected sessions looked missing.
 *
 * Merge rule, applied per `cwd` group of `kind === 'dsh'` rows:
 *  - only rows that carry **no host id** (`null`, `''`, or absent) are merge
 *    candidates. Two rows bound to *different* host ids are two real host
 *    workspaces that happen to share a path; the host id stays authoritative and
 *    they must never be collapsed;
 *  - an unbound row folds into the heaviest *bound* row of the same `cwd` when
 *    one exists — that is exactly the leftover the adoption rule stranded;
 *  - when several unbound rows share a `cwd`, they collapse into one, keeping
 *    the skeleton of a thread that has no messages as history;
 *  - a `dsh-ungrouped` row never absorbs rows that carry messages, and is only
 *    itself absorbed when it is empty: it holds sessions the host has not
 *    grouped, and dropping that content would lose sessions the user still
 *    expects to see.
 *
 * The function is pure on its input and idempotent: already-canonical documents
 * come back untouched, so a load that changes nothing still rewrites nothing.
 */
export function mergeSplitWorkspaces(state: unknown): boolean {
  const mutable = state as { workspaces?: unknown; updatedAt?: string } | null | undefined
  const workspaces = Array.isArray(mutable?.workspaces) ? (mutable?.workspaces as MutableWorkspace[]) : null
  if (workspaces === null) return false
  // 加载期把历史遗留的 `session-<uuid>` 写回裸 `<uuid>`。
  //
  // 为什么必须写回而不是只靠比较期归一化：`sameDshSessionId()` 只在**比较**时
  // 剥前缀，磁盘上的 id 一直是旧形式。目前不炸是因为所有消费点都走归一化比较，
  // 但任何新增的直接 `===` / `includes()` 比对都会把同一会话投影成两条 thread
  // （本项目已因严格匹配踩过一次，ins_51c832c4）。写回后两侧形式一致，归一化
  // 退化成恒等比较，不再依赖每个消费点都记得剥前缀。
  //
  // 撞车保护：归一化后若同一 workspace 内出现重复 dshSessionId，整行回退到
  // 原值并保持未归一化 —— 宁可留着前缀（比较期仍能正确归一化），也绝不制造
  // 重复 thread 或丢消息。
  // 两阶段：这里只**规划**改写，真正落定推迟到确认要提交时。
  // 否则「没有发生归并、函数提前返回」的路径也会把 state 悄悄改掉 ——
  // 与「pure on its input」的契约冲突，且会让不写盘的返回路径产生未声明的副作用。
  const renames: { thread: MutableThread; next: string }[] = []
  for (const workspace of workspaces) {
    const threads = Array.isArray(workspace?.projection?.threads) ? workspace.projection.threads : []
    if (threads.length === 0) continue
    const plan: { thread: MutableThread; next: string }[] = []
    const projected = new Set<string>()
    let clash = false
    for (const thread of threads) {
      const raw = thread?.dshSessionId
      if (typeof raw !== 'string') continue
      const bare = BARE_SESSION_PREFIX.exec(raw)
      // 正则有一个捕获组，命中时 `bare[1]` 必然是 string。
      const next = bare === null ? raw : (bare[1] as string)
      if (projected.has(next)) { clash = true; break }
      projected.add(next)
      if (bare !== null) plan.push({ thread, next })
    }
    if (clash) continue
    renames.push(...plan)
  }
  const groups = new Map<string, MutableWorkspace[]>()
  for (const workspace of workspaces) {
    if (workspace?.kind !== 'dsh') continue
    if (typeof workspace.cwd !== 'string' || workspace.cwd === '') continue
    const bucket = groups.get(workspace.cwd)
    if (bucket === undefined) groups.set(workspace.cwd, [workspace])
    else bucket.push(workspace)
  }
  const unboundOf = (workspace: MutableWorkspace): boolean => typeof workspace.dshWorkspaceId !== 'string' || workspace.dshWorkspaceId === ''
  const dropped = new Set<MutableWorkspace>()
  let changed = false
  for (const bucket of groups.values()) {
    const unbound = bucket.filter(unboundOf)
    if (unbound.length === 0) continue
    const bound = bucket.filter(workspace => !unboundOf(workspace))
    // Prefer folding leftovers into a real bound canvas; otherwise collapse the
    // unbound rows among themselves into a single adopted canvas.
    const pool = bound.length > 0 ? bound : unbound
    if (bound.length === 0 && unbound.length < 2) continue
    // Heaviest first; ties keep document order so the outcome is deterministic.
    const ranked = pool
      .map((workspace, index) => ({ workspace, index, weight: workspaceWeight(workspace) }))
      .sort((a, b) => b.weight.messages - a.weight.messages || b.weight.threads - a.weight.threads || a.index - b.index)
    const target = (ranked[0] as { workspace: MutableWorkspace }).workspace
    const followers = bound.length > 0 ? unbound : ranked.slice(1).map(entry => entry.workspace)
    const seen = new Set((target.projection?.threads ?? []).map(thread => thread?.dshSessionId).filter(id => typeof id === 'string'))
    for (const workspace of followers) {
      const threads = workspace.projection?.threads
      const hasMessages = (Array.isArray(threads) ? threads : []).some(thread => Array.isArray(thread.messages) && thread.messages.length > 0)
      // The ungrouped bucket is a holding area, never a source of truth to absorb
      // unless it is empty; and an empty ungrouped row is pure residue.
      if (workspace.dshWorkspaceId === 'dsh-ungrouped' && hasMessages) continue
      let moved = 0
      let kept = 0
      for (const thread of Array.isArray(threads) ? threads : []) {
        const sessionId = thread?.dshSessionId
        if (typeof sessionId !== 'string') {
          target.projection.threads.push(thread)
          moved += 1
          continue
        }
        const existing = target.projection.threads.find(item => sameDshSessionId(item.dshSessionId, sessionId))
        if (existing === undefined) {
          target.projection.threads.push(thread)
          seen.add(sessionId)
          moved += 1
          continue
        }
        // Both rows projected this session. The richer body wins: an older
        // adoption path could leave an empty skeleton in the bound row while the
        // unbound row kept the replayed messages. Compare message counts, then
        // `updatedAt`, so the surviving copy is the one carrying content.
        const existingMessages = Array.isArray(existing.messages) ? existing.messages.length : 0
        const donatedMessages = Array.isArray(thread.messages) ? thread.messages.length : 0
        const richer = donatedMessages > existingMessages
          || (donatedMessages === existingMessages && typeof thread.updatedAt === 'string'
            && typeof existing.updatedAt === 'string' && thread.updatedAt > existing.updatedAt)
        if (richer) {
          target.projection.threads[target.projection.threads.indexOf(existing)] = thread
          moved += 1
        } else {
          kept += 1
        }
      }
      // A row whose threads all lost on content is still removed — it donated
      // nothing the target lacked. A row that kept a thread unchanged stays, so a
      // peer that genuinely holds different data is never deleted.
      if (kept > 0 && moved === 0) continue
      if (Array.isArray(workspace.annotations)) target.annotations.push(...workspace.annotations)
      dropped.add(workspace)
      // 关键：**只要丢掉了任何一行**就是变更，不能只在 moved > 0 时才置位。
      // 否则「0 thread 的空壳行」会让 moved=0、kept=0 走进 dropped，却因
      // `if (!changed) return state` 原样返回，磁盘上永远留着那个空壳
      // （实测：43d9ab5c 空壳长期滞留，workspaces 卡在 5 个）。
      changed = true
    }
  }
  // 归一化写回本身也是变更：不置位就会因 `if (!changed)` 提前返回，改写被丢弃。
  if (renames.length > 0) changed = true
  if (!changed) return false
  for (const { thread, next } of renames) thread.dshSessionId = next
  if (mutable) mutable.workspaces = workspaces.filter(workspace => !dropped.has(workspace))
  if (mutable) mutable.updatedAt = new Date().toISOString()
  return true
}
