// 来源: dsh-synapnova@3fd1d00 server/migration.js

/** Explicit in-place v4 migration, sharing the Store queue, lock and rename owner. */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import * as schema from '@/shared/schema'
import { buildMigrationPlan, buildLayoutMigrationPlan } from '@/shared/migration'
import type { MigrationPlan, LayoutMigrationPlan } from '@/shared/migration'
import { canonicalHash } from '@/server/workspace-store'

/**
 * 迁移服务与 `WorkspaceStore` 的耦合点。
 *
 * 只声明实际调用到的成员（队列、锁、状态发布、原子替换、脏标记、源摘要）。
 * 真实 store 的成员比这里更宽，因此真实实例可直接传入；反过来本文件也不
 * 反向 import store 类型，避免与最高风险模块形成类型环。
 */
export interface MigrationStorePort {
  ready: Promise<unknown>;
  dataFile: string;
  dirty: boolean;
  lastKnownDigest: string | null;
  lastKnownMtime: number | null;
  runExclusive: <T>(action: () => Promise<T> | T) => Promise<T>;
  acquireLock: () => Promise<unknown>;
  releaseLock: () => Promise<unknown> | unknown;
  workspace: (workspaceId: string) => { revision: number };
  prepareState: (state: unknown) => { state: unknown };
  publishState: (state: unknown) => void;
  replaceFileWithRetry: (temporaryFile: string) => Promise<void>;
  commit: (
    envelope: Record<string, unknown>,
    action: (workspace: Record<string, unknown>) => unknown,
    options?: { beforeCommit?: () => Promise<void> },
  ) => Promise<unknown>;
}

/** 读写最小接口，便于测试注入内存实现。 */
export interface MigrationIO {
  readFile: (path: string) => Promise<Buffer>;
  writeFile: (path: string, data: Buffer | string, options?: { flag?: string }) => Promise<unknown>;
}

/** `backupSources` 的产物：备份路径 + 读回校验过的摘要。 */
interface BackupArtifacts {
  backupPath: string;
  backupHash: string;
  browserBackupPath: string | undefined;
  browserBackupHash: string | null;
}

/** 一次预览在服务端保留的不可变快照。 */
interface LayoutPreviewRecord extends BackupArtifacts {
  mode: 'layout';
  sourceHash: string;
  plan: LayoutMigrationPlan;
}

/** 整文档迁移预览记录。 */
interface DocumentPreviewRecord {
  sourceHash: string;
  backupPath: string;
  browserBackupPath: string | undefined;
  browserBackupHash: string | null;
  backupHash: string;
  candidate: unknown;
}

/** 预览记录的联合。 */
type PreviewRecord = LayoutPreviewRecord | DocumentPreviewRecord;

/** 带备份路径的运行时错误（失败时把已创建的路径带回调用方）。 */
type ErrorWithArtifacts = Error & {
  backupPath?: string;
  browserBackupPath?: string;
  temporaryFile?: string;
};

const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const defaultIO: MigrationIO = { readFile, writeFile }

export class MigrationService {
  store: MigrationStorePort;
  io: MigrationIO;
  now: () => string;
  previews: Map<string, PreviewRecord>;

  constructor(store: MigrationStorePort, { io = defaultIO, now = () => new Date().toISOString() }: { io?: MigrationIO; now?: () => string } = {}) {
    this.store = store
    this.io = io
    this.now = now
    this.previews = new Map()
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    await this.store.ready
    return this.store.runExclusive(action)
  }

  assertQuiescent(): void {
    if (this.store.dirty) throw new schema.InputError('投影仍有待保存事件，请先保存并重新预览迁移')
  }

  validateFrozen(value: unknown): schema.FrozenState {
    const normalized = schema.normalizeFrozenState(value)
    const state = normalized.state ?? normalized
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(value)), JSON.parse(JSON.stringify(state)))) throw new schema.InputError('迁移候选规范化改变了内容，拒绝静默丢弃字段')
    return state
  }

  async backupSources(bytes: Buffer, browserLayout: unknown): Promise<BackupArtifacts> {
    const suffix = `${this.now().replace(/[:.]/g, '-')}-${randomUUID()}`
    const backupPath = `${this.store.dataFile}.backup-${suffix}`
    let browserBackupPath: string | undefined
    try {
      await this.io.writeFile(backupPath, bytes, { flag: 'wx' })
      const backup = await this.io.readFile(backupPath)
      if (hash(backup) !== hash(bytes)) throw new Error('迁移备份读回字节不一致')
      JSON.parse(backup.toString('utf8'))
      let browserBackupHash: string | null = null
      if (browserLayout !== undefined) {
        browserBackupPath = `${backupPath}.browser.json`
        const browserBytes = Buffer.from(JSON.stringify(browserLayout), 'utf8')
        browserBackupHash = hash(browserBytes)
        await this.io.writeFile(browserBackupPath, browserBytes, { flag: 'wx' })
        if (hash(await this.io.readFile(browserBackupPath)) !== browserBackupHash) throw new Error('浏览器布局备份读回字节不一致')
      }
      return { backupPath, backupHash: hash(bytes), browserBackupPath, browserBackupHash }
    } catch (error) {
      const typed = error as ErrorWithArtifacts
      Object.assign(typed, { backupPath, browserBackupPath })
      throw typed
    }
  }

  async previewLayout({ workspaceId, browserLayout }: { workspaceId: string; browserLayout?: unknown } = {} as { workspaceId: string; browserLayout?: unknown }): Promise<Record<string, unknown>> {
    const snapshot = structuredClone(browserLayout)
    return this.exclusive(async () => {
      this.assertQuiescent()
      await this.store.acquireLock()
      let artifacts: Partial<BackupArtifacts> = {}
      try {
        const bytes = await this.io.readFile(this.store.dataFile)
        const sourceHash = hash(bytes)
        if (sourceHash !== this.store.lastKnownDigest) throw new schema.RevisionConflictError(this.store.workspace(workspaceId).revision, '迁移源已被其他实例修改，请重新加载')
        const document = this.validateFrozen(JSON.parse(bytes.toString('utf8')))
        const plan = buildLayoutMigrationPlan({ document, workspaceId, browserLayout: snapshot as never })
        artifacts = await this.backupSources(bytes, snapshot)
        if (hash(await this.io.readFile(this.store.dataFile)) !== sourceHash) throw new schema.RevisionConflictError(plan.baseRevision, '迁移源已变化，请重新预览')
        if (hash(await this.io.readFile(artifacts.browserBackupPath as string)) !== artifacts.browserBackupHash) throw new Error('浏览器布局备份已变化，拒绝预览')
        const previewToken = randomUUID()
        // 上界 20：删掉最早插入的一条（Map 迭代序即插入序，与旧实现一致）。
        const oldest = this.previews.keys().next().value
        if (this.previews.size >= 20 && oldest !== undefined) this.previews.delete(oldest)
        this.previews.set(previewToken, { mode: 'layout', sourceHash, ...(artifacts as BackupArtifacts), plan })
        const { layout, ...report } = plan
        void layout
        return { ...report, previewToken, sourceHash, backupPath: artifacts.backupPath, browserBackupPath: artifacts.browserBackupPath }
      } catch (error) {
        // A failed backup already carries the exact paths it managed to create.
        Object.assign(error as ErrorWithArtifacts, artifacts)
        throw error
      } finally { await this.store.releaseLock() }
    })
  }

  async commitLayout(envelope: Record<string, unknown> = {}): Promise<unknown> {
    const body = structuredClone(envelope)
    const previewToken = (body['body'] as { previewToken?: unknown } | null | undefined)?.previewToken
    if (canonicalHash(body['body']) !== canonicalHash({ previewToken })) throw new schema.InputError('布局迁移只接受 previewToken')
    const preview = structuredClone(this.previews.get(previewToken as string)) as PreviewRecord | undefined
    const layoutPreview = preview !== undefined && 'plan' in preview ? preview : undefined
    try {
      return await this.store.commit({ ...body, action: 'workspace.layout-migration', body: { previewToken } }, workspace => {
        workspace['layout'] = structuredClone(layoutPreview?.plan.layout as unknown)
        workspace['updatedAt'] = this.now()
        return { migrated: true, layout: structuredClone(workspace['layout']), backupPath: preview?.backupPath, browserBackupPath: preview?.browserBackupPath }
      }, { beforeCommit: async () => {
        const livePreview = this.previews.get(previewToken as string)
        if (!this.previews.has(previewToken as string) || layoutPreview === undefined || livePreview === undefined || !('mode' in livePreview) || livePreview.mode !== 'layout') throw new schema.InputError('布局迁移预览已失效，请重新预览')
        if (!layoutPreview.plan.canCommit) throw new schema.InputError('迁移存在歧义，不能提交')
        if (body['workspaceId'] !== layoutPreview.plan.workspaceId || body['baseRevision'] !== layoutPreview.plan.baseRevision || body['projectionEpoch'] !== layoutPreview.plan.projectionEpoch) throw new schema.RevisionConflictError(this.store.workspace(body['workspaceId'] as string).revision, '迁移预览与工作区版本不符，请重新预览')
        this.assertQuiescent()
        if (hash(await this.io.readFile(this.store.dataFile)) !== layoutPreview.sourceHash) throw new schema.RevisionConflictError(this.store.workspace(body['workspaceId'] as string).revision, '迁移源已变化，请重新预览')
        if (hash(await this.io.readFile(layoutPreview.backupPath)) !== layoutPreview.backupHash) throw new Error('迁移备份已变化，拒绝替换')
        if (layoutPreview.browserBackupPath !== undefined && hash(await this.io.readFile(layoutPreview.browserBackupPath)) !== layoutPreview.browserBackupHash) throw new Error('浏览器布局备份已变化，拒绝替换')
      } })
    } catch (error) {
      if (preview !== undefined) Object.assign(error as ErrorWithArtifacts, { backupPath: preview.backupPath, browserBackupPath: preview.browserBackupPath })
      throw error
    }
  }

  /** Only an explicit user request calls preview. Backups retain exact source bytes. */
  async preview({ browserLayout, hostWorkspaces = [] }: { browserLayout?: unknown; hostWorkspaces?: unknown } = {}): Promise<Record<string, unknown>> {
    const layoutSnapshot = structuredClone(browserLayout)
    const hostSnapshot = structuredClone(hostWorkspaces)
    return this.exclusive(async () => {
      this.assertQuiescent()
      await this.store.acquireLock()
      let backupPath: string | undefined, browserBackupPath: string | undefined, expectedBrowserHash: string | null = null
      try {
        const bytes = await this.io.readFile(this.store.dataFile)
        const sourceHash = hash(bytes)
        const legacyState: unknown = JSON.parse(bytes.toString('utf8'))
        const plan: MigrationPlan = buildMigrationPlan({ legacyState, browserLayout: layoutSnapshot as never, hostWorkspaces: hostSnapshot, now: this.now() })
        // Validate before any backup when structurally invalid. Ambiguous plans
        // are backed up and shown, but can never obtain a committable candidate.
        const candidate = plan.canCommit ? this.validateFrozen(plan.document) : null
        const artifacts = await this.backupSources(bytes, layoutSnapshot)
        ;({ backupPath, browserBackupPath } = artifacts)
        expectedBrowserHash = artifacts.browserBackupHash
        if (hash(await this.io.readFile(this.store.dataFile)) !== sourceHash) throw new schema.InputError('迁移源已变化，请重新预览')
        const previewToken = randomUUID()
        // A bounded collection avoids retaining old full-document candidates.
        const oldest = this.previews.keys().next().value
        if (this.previews.size >= 20 && oldest !== undefined) this.previews.delete(oldest)
        if (browserBackupPath !== undefined && hash(await this.io.readFile(browserBackupPath)) !== expectedBrowserHash) throw new Error('浏览器布局备份已变化，拒绝预览')
        this.previews.set(previewToken, { sourceHash, backupPath, browserBackupPath, browserBackupHash: expectedBrowserHash, candidate, backupHash: sourceHash })
        return { previewToken, sourceHash, backupPath, browserBackupPath, counts: plan.counts, countsMeaning: plan.countsMeaning, ambiguities: plan.ambiguities, warnings: plan.warnings, mapping: plan.mapping, canCommit: plan.canCommit }
      } catch (error) {
        const typed = error as ErrorWithArtifacts
        typed.backupPath ??= backupPath
        typed.browserBackupPath ??= browserBackupPath
        throw typed
      } finally {
        await this.store.releaseLock()
      }
    })
  }

  /** A token authorizes exactly the immutable candidate that was previewed. */
  async commit({ previewToken }: { previewToken?: string } = {}): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const found = this.previews.get(previewToken as string)
      if (!found) throw new schema.InputError('迁移预览已失效，请重新预览')
      // `commit` 只消费整文档预览；layout 预览走 `commitLayout`。旧实现里两种记录
      // 同住一个 Map，`candidate` 缺失时同样落到这条「存在歧义」错误上。
      const preview = found as DocumentPreviewRecord
      if (!preview.candidate) throw new schema.InputError('迁移存在歧义，不能提交')
      this.assertQuiescent()
      await this.store.acquireLock()
      let temporaryFile: string | undefined
      try {
        const current = await this.io.readFile(this.store.dataFile)
        if (hash(current) !== preview.sourceHash) throw new schema.InputError('迁移源已变化，请重新预览')
        if ((JSON.parse(current.toString('utf8')) as { version?: unknown }).version !== 4) throw new schema.InputError('只允许显式迁移 v4，不能覆盖已有 canonical 文档')
        if (hash(await this.io.readFile(preview.backupPath)) !== preview.backupHash) throw new Error('迁移备份已变化，拒绝替换')
        if (preview.browserBackupPath !== undefined && hash(await this.io.readFile(preview.browserBackupPath)) !== preview.browserBackupHash) throw new Error('浏览器布局备份已变化，拒绝替换')
        const candidate = this.validateFrozen(preview.candidate)
        const payload = Buffer.from(`${JSON.stringify(candidate)}\n`, 'utf8')
        temporaryFile = `${this.store.dataFile}.${process.pid}.migration-${randomUUID()}.tmp`
        await this.io.writeFile(temporaryFile, payload, { flag: 'wx' })
        const roundTrip = await this.io.readFile(temporaryFile)
        if (hash(roundTrip) !== hash(payload)) throw new Error('迁移候选读回字节不一致')
        const checked = this.validateFrozen(JSON.parse(roundTrip.toString('utf8')))
        const { state: prepared } = this.store.prepareState(checked)
        if (hash(await this.io.readFile(this.store.dataFile)) !== preview.sourceHash) throw new schema.InputError('迁移源已变化，请重新预览')
        // The only commit point; no fallible filesystem work follows rename.
        // publishState is the Store's synchronous publication hook.
        await this.store.replaceFileWithRetry(temporaryFile)
        this.store.publishState(prepared)
        this.store.lastKnownDigest = hash(roundTrip)
        this.store.lastKnownMtime = null
        this.store.dirty = false
        this.previews.clear()
        return { migrated: true, sourceHash: preview.sourceHash, backupPath: preview.backupPath, browserBackupPath: preview.browserBackupPath }
      } catch (error) {
        const typed = error as ErrorWithArtifacts
        typed.backupPath = preview.backupPath
        typed.browserBackupPath = preview.browserBackupPath
        typed.temporaryFile = temporaryFile
        throw typed
      } finally {
        await this.store.releaseLock()
      }
    })
  }
}
