// 来源: dsh-synapnova@3fd1d00 server/import-export.js

/**
 * T6a — JSON export, preview, replace and restore for ONE workspace.
 *
 * Protocol: `项目文档/设计与验收/T0-实施方案.md` §4.1. This module is the ONLY
 * owner of the import transaction; it never builds a second write authority. All
 * writes go through `WorkspaceStore` (serial queue, atomic replace, idempotency).
 *
 * The seven steps of §4.1, and where each lives here:
 *
 *   1. browser-side parse/validate/preview      → `previewImport` (validate+token)
 *   2. one-shot token bound to ws+rev+hash      → `issueToken` / `consumeToken`
 *   3. exclusive queue, flush, re-check revision → `commitImport`
 *   4. full backup with read-back verification   → `writeBackup`
 *   5. candidate doc, rebind ids, bump epoch     → `buildCandidate`
 *   6. events arriving during import re-append   → inherited from Store queue
 *   7. commit only after backup; restore on failure → `commitImport` / `restore`
 *
 * Scope boundaries (deliberate, from the task card):
 *   - one workspace only, never a cross-workspace merge
 *   - never creates a native Session, never sends a message
 *   - credentials are never read or written
 *   - the native logs are never touched
 *
 * 类型口径：本模块是**不受信文件内容的边界**，所有入参按 `unknown` 收窄；返回值是
 * 判别联合（`ok: true` / `ok: false`），调用方因此可以先收窄再取 `code`。与
 * `WorkspaceStore` 的耦合刻意保持在**结构化最小接口**（只用 `workspace` /
 * `commit` 两个方法），避免本文件与最高风险的 store 互相锁死类型。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { FROZEN_FORMAT, FROZEN_SCHEMA_VERSION, InputError, RevisionConflictError, normalizeFrozenState } from '@/shared/schema'

/** Refusal thresholds. PROVISIONAL: not load-tested, do not promise capacity. */
export const IMPORT_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxEvents: 50_000,
  maxCards: 10_000,
})

/** Token lifetime: a preview older than this must be re-taken. */
export const TOKEN_TTL_MS = 10 * 60 * 1000

/** Stable refusal codes so the UI can localise instead of echoing prose. */
export const IMPORT_REJECT = Object.freeze({
  tooLarge: 'too-large',
  tooManyEvents: 'too-many-events',
  tooManyCards: 'too-many-cards',
  badFormat: 'bad-format',
  badVersion: 'bad-version',
  duplicateId: 'duplicate-id',
  danglingReference: 'dangling-reference',
  notAnObject: 'not-an-object',
  workspaceMismatch: 'workspace-mismatch',
  tokenExpired: 'token-expired',
  tokenUsed: 'token-used',
  tokenUnknown: 'token-unknown',
  revisionStale: 'revision-stale',
  dirtyToken: 'content-changed',
  backupFailed: 'backup-failed',
  restoreFailed: 'restore-failed',
  interruptedTransaction: 'interrupted-transaction',
})

/** JSON 值（`contentHash` / `structuredClone` 的输入口径）。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 拒绝结果的统一形状。`code` 取自 `IMPORT_REJECT`。 */
export interface ImportRejection {
  ok: false;
  code: string;
  detail: unknown;
}

/** `inspectImport` 成功时的计数。 */
export interface ImportCounts {
  threads: number;
  events: number;
  cards: number;
  materials: number;
  regions: number;
  annotations: number;
}

/** 覆盖率告警：某个线程的投影历史并不完整。 */
export interface ImportCoverageWarning {
  threadId: unknown;
  ranges: unknown;
}

/** `inspectImport` 的成功结果。 */
export interface ImportInspection {
  ok: true;
  bytes: number;
  counts: ImportCounts;
  hash: string;
  coverageWarnings: ImportCoverageWarning[];
}

/** `inspectImport` 的选项。 */
export interface InspectImportOptions {
  limits?: { maxBytes: number; maxEvents: number; maxCards: number };
}

/** 导入/还原的收据（只含备份路径与字节数，不含正文）。 */
export interface BackupReceipt {
  path: string;
  bytes: number;
  digest: string;
}

/** 预览 token 的登记项。 */
interface TokenEntry {
  workspaceId: string;
  baseRevision: number;
  hash: string;
  issuedAt: number;
  usedAt: number | null;
}

/** `createTokenRegistry` 的产物。 */
export interface TokenRegistry {
  issue: (input: { workspaceId: string; baseRevision: number; hash: string }) => string;
  consume: (input: { token: string; workspaceId: string; baseRevision: number; hash: string }) => ImportRejection | { ok: true; token: string };
  pending: () => (TokenEntry & { token: string })[];
  prune: () => void;
  clear: () => void;
  size: () => number;
}

/** 预览对象：调用方（通常是 IPC 层）在两次请求之间保存的那份。 */
export interface ImportPreview {
  raw: unknown;
  hash: string;
  baseRevision: number;
}

/**
 * `WorkspaceStore` 在本模块里的最小投影。
 *
 * 只声明实际调用的两个方法。真实 store 的方法签名比这里宽（可选参数、返回
 * Promise，`action` 收一个可变的工作区对象），因此真实实例可直接传入；而本模块
 * 也不需要反向 import store，避免与最高风险模块形成类型环。
 */
export interface ImportStorePort {
  workspace: (workspaceId: string) => Record<string, unknown>;
  commit: (
    envelope: Record<string, unknown>,
    action: (workspace: Record<string, unknown>) => unknown,
    options?: { beforeCommit?: () => Promise<void> },
  ) => Promise<unknown>;
}

/** 事务信封：转发给 Store，本模块不改写其中的 `baseRevision`。 */
export type CommitEnvelope = Record<string, unknown>;

const reject = (code: string, detail: unknown = null): ImportRejection => ({ ok: false, code, detail })
const accept = <T extends object>(value: T): T & { ok: true } => ({ ok: true, ...value })

/** Canonical hash of any JSON-able value: key order must not change the digest. */
export function contentHash(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`
    if (input !== null && typeof input === 'object') {
      const record = input as Record<string, unknown>
      const keys = Object.keys(record).sort()
      return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
    }
    return JSON.stringify(input ?? null)
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}

/**
 * Validate one imported document against the frozen shape, WITHOUT writing.
 *
 * Returns the counts the preview screen shows plus a per-problem list. A single
 * bad reference rejects the whole batch: §4.1 step 4 says "任一引用映射失败拒绝
 * 整次导入，不部分覆盖", so this never repairs and never drops quietly.
 */
export function inspectImport(input: unknown, { limits = IMPORT_LIMITS }: InspectImportOptions = {}): ImportRejection | ImportInspection {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return reject(IMPORT_REJECT.notAnObject)

  const envelope = input as Record<string, unknown>
  const raw: unknown = envelope['workspace'] ?? input
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return reject(IMPORT_REJECT.notAnObject)
  const rawRecord = raw as Record<string, unknown>

  // Format/version are checked from the FILE, not from the running store: an
  // older file is a legitimate import source as long as it declares itself.
  const format = envelope['format'] ?? rawRecord['format'] ?? null
  if (format !== null && format !== FROZEN_FORMAT) return reject(IMPORT_REJECT.badFormat, { format })
  const declaredVersion = envelope['schemaVersion'] ?? rawRecord['schemaVersion'] ?? null
  if (declaredVersion !== null && declaredVersion !== FROZEN_SCHEMA_VERSION) return reject(IMPORT_REJECT.badVersion, { declaredVersion })

  const bytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
  if (bytes > limits.maxBytes) return reject(IMPORT_REJECT.tooLarge, { bytes, limit: limits.maxBytes })

  const projection = (rawRecord['projection'] ?? { threads: [] }) as { threads?: unknown } | null | undefined
  const threads: unknown[] | null = Array.isArray(projection?.threads) ? (projection.threads as unknown[]) : null
  if (threads === null) return reject(IMPORT_REJECT.badFormat, { field: 'projection.threads' })

  // Duplicate ids inside one collection are a hard reject: a silent overwrite
  // would make "which one was imported" unanswerable.
  const duplicate = (list: unknown, field: string): { field: string; id: string } | null => {
    if (!Array.isArray(list)) return null
    const seen = new Set<string>()
    for (const item of list as unknown[]) {
      const id = (item as { id?: unknown } | null | undefined)?.id
      if (typeof id !== 'string' || id === '') return { field, id: String(id) }
      if (seen.has(id)) return { field, id }
      seen.add(id)
    }
    return null
  }
  for (const [field, list] of [
    ['projection.threads', threads],
    ['materials', rawRecord['materials']],
    ['regions', rawRecord['regions']],
    ['annotations', rawRecord['annotations']],
  ] as [string, unknown][]) {
    const clash = duplicate(list, field)
    if (clash !== null) return reject(IMPORT_REJECT.duplicateId, clash)
  }

  // Dangling references: a card or note that points at something the file does
  // not carry cannot be remapped, so the whole import is refused.
  const threadRecords = threads as Record<string, unknown>[]
  const threadIds = new Set(threadRecords.map(thread => thread?.['id']))
  const danglingParents = threadRecords.filter(thread => typeof thread['parentId'] === 'string' && !threadIds.has(thread['parentId']))
  if (danglingParents.length > 0) {
    return reject(IMPORT_REJECT.danglingReference, { field: 'thread.parentId', ids: danglingParents.map(item => item['id']) })
  }
  const rawRegions: unknown[] = Array.isArray(rawRecord['regions']) ? (rawRecord['regions'] as unknown[]) : []
  const rawAnnotations: unknown[] = Array.isArray(rawRecord['annotations']) ? (rawRecord['annotations'] as unknown[]) : []
  const regionIds = new Set(rawRegions.map(region => (region as { id?: unknown } | null | undefined)?.id))
  const badNotes = rawAnnotations.filter(note => {
    const noteRecord = (note ?? {}) as Record<string, unknown>
    const hasCard = typeof noteRecord['targetCardId'] === 'string' && noteRecord['targetCardId'] !== ''
    const hasRegion = typeof noteRecord['targetRegionId'] === 'string' && noteRecord['targetRegionId'] !== ''
    if (hasCard === hasRegion) return true
    return hasRegion && !regionIds.has(noteRecord['targetRegionId'])
  })
  if (badNotes.length > 0) {
    return reject(IMPORT_REJECT.danglingReference, { field: 'annotations', ids: badNotes.map(item => (item as { id?: unknown } | null | undefined)?.id) })
  }

  const events = threadRecords.reduce((total, thread) => total + (Array.isArray(thread['messages']) ? (thread['messages'] as unknown[]).length : 0), 0)
  const cards = threadRecords.reduce((total, thread) => {
    const messages: unknown[] = Array.isArray(thread['messages']) ? (thread['messages'] as unknown[]) : []
    return total + messages.filter(message => (message as { kind?: unknown } | null | undefined)?.kind === 'user').length || total + 1
  }, 0)
  if (events > limits.maxEvents) return reject(IMPORT_REJECT.tooManyEvents, { events, limit: limits.maxEvents })
  if (cards > limits.maxCards) return reject(IMPORT_REJECT.tooManyCards, { cards, limit: limits.maxCards })

  return accept({
    bytes,
    counts: {
      threads: threads.length,
      events,
      cards,
      materials: (Array.isArray(rawRecord['materials']) ? (rawRecord['materials'] as unknown[]) : []).length,
      regions: rawRegions.length,
      annotations: rawAnnotations.length,
    },
    hash: contentHash(raw),
    // The preview screen must keep saying this: a truncated or partially
    // backfilled source will not be magically complete after import.
    coverageWarnings: threadRecords
      .filter(thread => (thread['coverage'] as { historyComplete?: unknown } | null | undefined)?.historyComplete === false)
      .map(thread => ({
        threadId: thread['id'],
        ranges: (thread['coverage'] as { ranges?: unknown } | null | undefined)?.ranges ?? [],
      })),
  })
}

/**
 * Rebind an imported document onto `targetWorkspaceId`.
 *
 * Reuses the SAME thread ids (they are the file's own identity and the card ids
 * derive from them), rewrites the workspace id, and keeps only fields the frozen
 * document legally carries.
 *
 * NOTE on `origin`: §4.1 step 6 says the imported copy is marked
 * `origin=import`. `shared/schema.js` pins the workspace to exactly
 * `WORKSPACE_FIELDS = ['id','kind','dshWorkspaceId','cwd','title','createdAt','updatedAt']`
 * and `pickFields` DROPS everything else — so a persisted `origin` would vanish on
 * the next normalisation and silently look like it never worked. The marker is
 * therefore returned as transaction METADATA (`origin: 'import'` in the commit
 * result) rather than stored in the document. Storing it would require widening
 * the frozen schema, which is a data-format change outside this task's remit.
 */
export function buildCandidate(raw: unknown, { targetWorkspaceId, baseRevision }: { targetWorkspaceId: string; baseRevision: number }): Record<string, unknown> {
  const source = ((raw as { workspace?: unknown } | null | undefined)?.workspace ?? raw) as Record<string, unknown>
  const clone = structuredClone(source) as Record<string, unknown>
  const now = new Date().toISOString()
  const cloneProjection = (clone['projection'] ?? {}) as { threads?: unknown }
  const cloneLayout = (clone['layout'] ?? {}) as Record<string, unknown>
  const candidate: Record<string, unknown> = {
    id: targetWorkspaceId,
    kind: typeof clone['kind'] === 'string' ? clone['kind'] : 'manual',
    cwd: clone['cwd'] ?? null,
    title: typeof clone['title'] === 'string' && clone['title'] !== '' ? clone['title'] : '导入的工作区',
    revision: baseRevision,
    // Bumped by the Store on commit; the field must exist and be an integer.
    projectionEpoch: 1,
    createdAt: typeof clone['createdAt'] === 'string' ? clone['createdAt'] : now,
    updatedAt: now,
    projection: { threads: Array.isArray(cloneProjection.threads) ? cloneProjection.threads : [] },
    layout: {
      cards: cloneLayout['cards'] ?? {},
      collapsed: cloneLayout['collapsed'] ?? {},
      viewport: cloneLayout['viewport'] ?? { x: 0, y: 0, zoom: 1 },
    },
    materials: Array.isArray(clone['materials']) ? clone['materials'] : [],
    regions: Array.isArray(clone['regions']) ? clone['regions'] : [],
    annotations: Array.isArray(clone['annotations']) ? clone['annotations'] : [],
  }
  // Validate the candidate BEFORE it can reach the live document. Whatever this
  // throws is the caller's refusal reason, not a half-applied document.
  //
  // The frozen document root carries more than `workspaces` (see
  // `createFrozenState`): `updatedAt`, `hiddenSessionIds`, `idempotency` and
  // `idempotencyFloor`. Passing only `workspaces` fails the root check, so the
  // throwaway envelope mirrors the real one exactly.
  normalizeFrozenState({
    format: FROZEN_FORMAT,
    schemaVersion: FROZEN_SCHEMA_VERSION,
    updatedAt: now,
    hiddenSessionIds: [],
    idempotency: {},
    idempotencyFloor: null,
    workspaces: [candidate],
  })
  return candidate
}

/**
 * Write a read-back-verified backup of the CURRENT workspace document.
 *
 * §4.1 step 3: "写可读回校验的完整旧工作区备份，备份失败则不替换". So this either
 * returns a path that really contains the bytes it claims, or it throws — there
 * is no "probably wrote it" outcome.
 */
export async function writeBackup({ backupDir, workspaceId, revision, document, label = 'before-import' }: {
  backupDir: string;
  workspaceId: string;
  revision: number;
  document: unknown;
  label?: string;
}): Promise<BackupReceipt> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(backupDir, `${workspaceId}.${label}.${stamp}.r${revision}.json`)
  const body = JSON.stringify({ workspaceId, revision, capturedAt: new Date().toISOString(), document }, null, 2)
  await mkdir(dirname(file), { recursive: true })

  // Write to a sibling temp name, then rename: a crash mid-write must not leave a
  // truncated file that later looks like a valid backup.
  const temporary = `${file}.tmp`
  await writeFile(temporary, body, 'utf8')
  await rename(temporary, file)

  // Read back and compare the digest. A backup nobody verified is not a backup.
  const roundTrip = await readFile(file, 'utf8')
  if (contentHash(roundTrip) !== contentHash(body)) {
    throw new InputError(`备份读回校验失败：${file}`)
  }
  return { path: file, bytes: Buffer.byteLength(body, 'utf8'), digest: contentHash(body) }
}

/**
 * One-shot preview tokens.
 *
 * A token binds (workspaceId, baseRevision, contentHash) so a stale preview can
 * never be replayed onto a newer document. It is consumed on first successful
 * commit; a second use is a distinct refusal, not a silent re-import.
 */
export function createTokenRegistry({ ttlMs = TOKEN_TTL_MS, now = () => Date.now() }: { ttlMs?: number; now?: () => number } = {}): TokenRegistry {
  const tokens = new Map<string, TokenEntry>()

  const issue = ({ workspaceId, baseRevision, hash }: { workspaceId: string; baseRevision: number; hash: string }): string => {
    const token = randomUUID()
    tokens.set(token, { workspaceId, baseRevision, hash, issuedAt: now(), usedAt: null })
    return token
  }

  const consume = ({ token, workspaceId, baseRevision, hash }: { token: string; workspaceId: string; baseRevision: number; hash: string }): ImportRejection | { ok: true; token: string } => {
    const entry = tokens.get(token)
    if (entry === undefined) return reject(IMPORT_REJECT.tokenUnknown)
    if (entry.usedAt !== null) return reject(IMPORT_REJECT.tokenUsed)
    if (now() - entry.issuedAt > ttlMs) return reject(IMPORT_REJECT.tokenExpired, { ageMs: now() - entry.issuedAt })
    if (entry.workspaceId !== workspaceId) return reject(IMPORT_REJECT.workspaceMismatch, { expected: entry.workspaceId, actual: workspaceId })
    if (entry.baseRevision !== baseRevision) return reject(IMPORT_REJECT.revisionStale, { previewed: entry.baseRevision, current: baseRevision })
    if (entry.hash !== hash) return reject(IMPORT_REJECT.dirtyToken, { previewed: entry.hash, actual: hash })
    // Mark used only AFTER every check passed, so a refused attempt does not
    // burn the token and force an unnecessary re-preview.
    entry.usedAt = now()
    return accept({ token })
  }

  const pending = (): (TokenEntry & { token: string })[] => [...tokens.entries()].filter(([, entry]) => entry.usedAt === null).map(([token, entry]) => ({ token, ...entry }))
  const prune = (): void => { for (const [token, entry] of tokens) if (now() - entry.issuedAt > ttlMs) tokens.delete(token) }
  return { issue, consume, pending, prune, clear: () => tokens.clear(), size: () => tokens.size }
}

/** `commitImport` 的成功结果。`origin` 是事务元数据，不写进文档。 */
export interface CommitImportSuccess {
  ok: true;
  response: unknown;
  backup: BackupReceipt | string | null;
}

/** `commitImport` 的入参。 */
export interface CommitImportInput {
  store: ImportStorePort;
  workspaceId: string;
  token: string;
  tokenRegistry: TokenRegistry;
  preview: ImportPreview;
  backupDir: string;
  operationId: string;
  envelope: CommitEnvelope;
}

/**
 * The transaction itself.
 *
 * Runs ENTIRELY inside the Store's serial queue, so a Host event that arrives
 * during the import is enqueued behind it and appended afterwards — that is how
 * §4.1 step 5 ("导入期间到达的 Host 事件…之后按来源去重追加") is satisfied without a
 * second queue.
 *
 * `beforeCommit` writes the backup. Because `mutate` publishes only after the
 * file lands, a backup failure leaves memory untouched.
 */
export async function commitImport({ store, workspaceId, token, tokenRegistry, preview, backupDir, operationId, envelope }: CommitImportInput): Promise<ImportRejection | CommitImportSuccess> {
  const current = store.workspace(workspaceId)
  const consumed = tokenRegistry.consume({
    token,
    workspaceId,
    baseRevision: preview.baseRevision,
    hash: preview.hash,
  })
  if (consumed.ok !== true) return consumed

  // §4.1 step 3: "确认后…再检查baseRevision；已有新事件导致过期则重新预览，不带旧预览直接覆盖".
  //
  // `envelope.baseRevision` is forwarded UNCHANGED. An earlier version rewrote it
  // to `current.revision`, which made the Store's own check pass by construction
  // and let a stale preview silently overwrite newer content — the exact failure
  // this protocol exists to prevent.
  //
  // The staleness verdict is deliberately left to the Store rather than decided
  // here, because the Store consults its idempotency table BEFORE the revision
  // check: an exact replay of the same operationId must return the first response
  // instead of being rejected as stale. Checking staleness in this function would
  // break that replay path.

  let backup: BackupReceipt | null = null
  try {
    // One `commit` call = one queue slot = one atomic replace.
    const response = await store.commit(
      { ...envelope, workspaceId, operationId, action: 'workspace.import', body: preview.raw },
      workspace => {
        const candidate = buildCandidate(preview.raw, { targetWorkspaceId: workspaceId, baseRevision: workspace['revision'] as number })
        // Replace the document in place on the CANDIDATE copy: the Store has
        // already cloned the published state, so mutating this object affects
        // only the candidate that is about to be validated and swapped in.
        for (const key of Object.keys(workspace)) delete workspace[key]
        Object.assign(workspace, candidate)
        // §4.1 step 4: bump the epoch so any delayed save from an old front end
        // is rejected rather than silently overwriting the imported copy.
        workspace['projectionEpoch'] = ((current['projectionEpoch'] as number | undefined) ?? 1) + 1
        return { imported: true, origin: 'import', revision: workspace['revision'], projectionEpoch: workspace['projectionEpoch'] }
      },
      {
        beforeCommit: async () => {
          backup = await writeBackup({
            backupDir,
            workspaceId,
            revision: current['revision'] as number,
            document: structuredClone(current),
            label: 'before-import',
          })
        },
      },
    )
    return accept({ response, backup })
  } catch (error) {
    // §4.1 step 7: the candidate never took effect. Report the backup location so
    // the reader can see what was preserved, and never claim a rollback happened.
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      code: error instanceof RevisionConflictError ? IMPORT_REJECT.revisionStale : (backup === null ? IMPORT_REJECT.backupFailed : IMPORT_REJECT.interruptedTransaction),
      detail: { message, backup: (backup as BackupReceipt | null)?.path ?? null },
    }
  }
}

/** `restoreFromBackup` 的入参。 */
export interface RestoreFromBackupInput {
  store: ImportStorePort;
  workspaceId: string;
  backupPath: string;
  operationId: string;
  envelope: CommitEnvelope;
}

/**
 * Restore one workspace from a backup file.
 *
 * A restore is a NEW revision, never a version rollback (§4.1 last line). The
 * backup itself is read and validated before anything is replaced.
 */
export async function restoreFromBackup({ store, workspaceId, backupPath, operationId, envelope }: RestoreFromBackupInput): Promise<ImportRejection | CommitImportSuccess> {
  let parsed: { workspaceId?: unknown; document?: unknown } | undefined
  try {
    parsed = JSON.parse(await readFile(backupPath, 'utf8')) as { workspaceId?: unknown; document?: unknown }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: IMPORT_REJECT.restoreFailed, detail: { message: `备份无法读取：${message}`, backup: backupPath } }
  }
  if (parsed?.workspaceId !== workspaceId || parsed?.document === undefined) {
    return { ok: false, code: IMPORT_REJECT.restoreFailed, detail: { message: '备份与目标工作区不匹配', backup: backupPath } }
  }
  const current = store.workspace(workspaceId)
  const backupDocument = parsed.document
  try {
    const response = await store.commit(
      { ...envelope, workspaceId, baseRevision: current['revision'], operationId, action: 'workspace.restore', body: {} },
      workspace => {
        const restored = structuredClone(backupDocument) as Record<string, unknown>
        for (const key of Object.keys(workspace)) delete workspace[key]
        Object.assign(workspace, restored)
        workspace['id'] = workspaceId
        // A restore must not move the epoch backwards either: a delayed request
        // from before the restore would otherwise become valid again.
        workspace['projectionEpoch'] = ((current['projectionEpoch'] as number | undefined) ?? 1) + 1
        return { restored: true, origin: 'restore' }
      },
    )
    return accept({ response, backup: backupPath })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: IMPORT_REJECT.restoreFailed, detail: { message, backup: backupPath } }
  }
}

/** `readInterruptedMarker` 的产物。 */
export type InterruptedMarker =
  | { interrupted: true; marker: string; [key: string]: unknown }
  | { interrupted: false; marker: null };

/**
 * Find a transaction that never finished.
 *
 * §4.1 step 7: "重启检测未完成导入事务并优先恢复". The marker is written before the
 * commit and removed after it, so a leftover marker means the process died in
 * between — the caller must restore before accepting writes for that workspace.
 */
export async function readInterruptedMarker({ backupDir, workspaceId }: { backupDir: string; workspaceId: string }): Promise<InterruptedMarker> {
  const marker = join(backupDir, `${workspaceId}.import-in-flight.json`)
  try {
    const text = await readFile(marker, 'utf8')
    const parsed = JSON.parse(text) as Record<string, unknown>
    return { interrupted: true, marker, ...parsed }
  } catch {
    return { interrupted: false, marker: null }
  }
}

/** 写入「导入进行中」标记，返回标记文件路径。 */
export async function writeInterruptedMarker({ backupDir, workspaceId, backupPath, preview }: { backupDir: string; workspaceId: string; backupPath: string; preview?: { hash?: unknown } | null }): Promise<string> {
  const marker = join(backupDir, `${workspaceId}.import-in-flight.json`)
  await mkdir(dirname(marker), { recursive: true })
  await writeFile(marker, JSON.stringify({ workspaceId, backupPath, hash: (preview?.hash ?? null), startedAt: new Date().toISOString() }, null, 2), 'utf8')
  return marker
}

/** 清除「导入进行中」标记（已不存在时静默忽略），返回标记文件路径。 */
export async function clearInterruptedMarker({ backupDir, workspaceId }: { backupDir: string; workspaceId: string }): Promise<string> {
  const marker = join(backupDir, `${workspaceId}.import-in-flight.json`)
  const { unlink } = await import('node:fs/promises')
  await unlink(marker).catch(() => undefined)
  return marker
}
