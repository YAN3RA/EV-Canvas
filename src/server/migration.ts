// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova@3fd1d00 server/migration.js，行为完整、类型标注待补。
// 来源: dsh-synapnova@3fd1d00 server/migration.js

/** Explicit in-place v4 migration, sharing the Store queue, lock and rename owner. */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import * as schema from '@/shared/schema'
import { buildMigrationPlan, buildLayoutMigrationPlan } from '@/shared/migration'
import { canonicalHash } from '@/server/workspace-store'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const defaultIO = { readFile, writeFile }

export class MigrationService {
  constructor(store, { io = defaultIO, now = () => new Date().toISOString() } = {}) {
    this.store = store
    this.io = io
    this.now = now
    this.previews = new Map()
  }

  async exclusive(action) {
    await this.store.ready
    return this.store.runExclusive(action)
  }

  assertQuiescent() {
    if (this.store.dirty) throw new schema.InputError('投影仍有待保存事件，请先保存并重新预览迁移')
  }

  validateFrozen(value) {
    const normalized = schema.normalizeFrozenState(value)
    const state = normalized.state ?? normalized
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(value)), JSON.parse(JSON.stringify(state)))) throw new schema.InputError('迁移候选规范化改变了内容，拒绝静默丢弃字段')
    return state
  }

  async backupSources(bytes, browserLayout) {
    const suffix = `${this.now().replace(/[:.]/g, '-')}-${randomUUID()}`
    const backupPath = `${this.store.dataFile}.backup-${suffix}`
    let browserBackupPath
    try {
      await this.io.writeFile(backupPath, bytes, { flag: 'wx' })
      const backup = await this.io.readFile(backupPath)
      if (hash(backup) !== hash(bytes)) throw new Error('迁移备份读回字节不一致')
      JSON.parse(backup.toString('utf8'))
      let browserBackupHash = null
      if (browserLayout !== undefined) {
        browserBackupPath = `${backupPath}.browser.json`
        const browserBytes = Buffer.from(JSON.stringify(browserLayout), 'utf8')
        browserBackupHash = hash(browserBytes)
        await this.io.writeFile(browserBackupPath, browserBytes, { flag: 'wx' })
        if (hash(await this.io.readFile(browserBackupPath)) !== browserBackupHash) throw new Error('浏览器布局备份读回字节不一致')
      }
      return { backupPath, backupHash: hash(bytes), browserBackupPath, browserBackupHash }
    } catch (error) {
      Object.assign(error, { backupPath, browserBackupPath })
      throw error
    }
  }

  async previewLayout({ workspaceId, browserLayout } = {}) {
    browserLayout = structuredClone(browserLayout)
    return this.exclusive(async () => {
      this.assertQuiescent()
      await this.store.acquireLock()
      let artifacts = {}
      try {
        const bytes = await this.io.readFile(this.store.dataFile)
        const sourceHash = hash(bytes)
        if (sourceHash !== this.store.lastKnownDigest) throw new schema.RevisionConflictError(this.store.workspace(workspaceId).revision, '迁移源已被其他实例修改，请重新加载')
        const document = this.validateFrozen(JSON.parse(bytes.toString('utf8')))
        const plan = buildLayoutMigrationPlan({ document, workspaceId, browserLayout })
        artifacts = await this.backupSources(bytes, browserLayout)
        if (hash(await this.io.readFile(this.store.dataFile)) !== sourceHash) throw new schema.RevisionConflictError(plan.baseRevision, '迁移源已变化，请重新预览')
        if (hash(await this.io.readFile(artifacts.browserBackupPath)) !== artifacts.browserBackupHash) throw new Error('浏览器布局备份已变化，拒绝预览')
        const previewToken = randomUUID()
        if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value)
        this.previews.set(previewToken, { mode: 'layout', sourceHash, ...artifacts, plan })
        const { layout, ...report } = plan
        return { ...report, previewToken, sourceHash, backupPath: artifacts.backupPath, browserBackupPath: artifacts.browserBackupPath }
      } catch (error) {
        // A failed backup already carries the exact paths it managed to create.
        Object.assign(error, artifacts)
        throw error
      } finally { await this.store.releaseLock() }
    })
  }

  async commitLayout(envelope = {}) {
    envelope = structuredClone(envelope)
    const previewToken = envelope.body?.previewToken
    if (canonicalHash(envelope.body) !== canonicalHash({ previewToken })) throw new schema.InputError('布局迁移只接受 previewToken')
    const preview = structuredClone(this.previews.get(previewToken))
    try {
      return await this.store.commit({ ...envelope, action: 'workspace.layout-migration', body: { previewToken } }, workspace => {
        workspace.layout = structuredClone(preview.plan.layout)
        workspace.updatedAt = this.now()
        return { migrated: true, layout: structuredClone(workspace.layout), backupPath: preview.backupPath, browserBackupPath: preview.browserBackupPath }
      }, { beforeCommit: async () => {
        if (!this.previews.has(previewToken) || !preview || preview.mode !== 'layout') throw new schema.InputError('布局迁移预览已失效，请重新预览')
        if (!preview.plan.canCommit) throw new schema.InputError('迁移存在歧义，不能提交')
        if (envelope.workspaceId !== preview.plan.workspaceId || envelope.baseRevision !== preview.plan.baseRevision || envelope.projectionEpoch !== preview.plan.projectionEpoch) throw new schema.RevisionConflictError(this.store.workspace(envelope.workspaceId).revision, '迁移预览与工作区版本不符，请重新预览')
        this.assertQuiescent()
        if (hash(await this.io.readFile(this.store.dataFile)) !== preview.sourceHash) throw new schema.RevisionConflictError(this.store.workspace(envelope.workspaceId).revision, '迁移源已变化，请重新预览')
        if (hash(await this.io.readFile(preview.backupPath)) !== preview.backupHash) throw new Error('迁移备份已变化，拒绝替换')
        if (hash(await this.io.readFile(preview.browserBackupPath)) !== preview.browserBackupHash) throw new Error('浏览器布局备份已变化，拒绝替换')
      } })
    } catch (error) {
      if (preview) Object.assign(error, { backupPath: preview.backupPath, browserBackupPath: preview.browserBackupPath })
      throw error
    }
  }

  /** Only an explicit user request calls preview. Backups retain exact source bytes. */
  async preview({ browserLayout, hostWorkspaces = [] } = {}) {
    browserLayout = structuredClone(browserLayout)
    hostWorkspaces = structuredClone(hostWorkspaces)
    return this.exclusive(async () => {
      this.assertQuiescent()
      await this.store.acquireLock()
      let backupPath, browserBackupPath, expectedBrowserHash = null
      try {
        const bytes = await this.io.readFile(this.store.dataFile)
        const sourceHash = hash(bytes)
        const legacyState = JSON.parse(bytes.toString('utf8'))
        const plan = buildMigrationPlan({ legacyState, browserLayout, hostWorkspaces, now: this.now() })
        // Validate before any backup when structurally invalid. Ambiguous plans
        // are backed up and shown, but can never obtain a committable candidate.
        const candidate = plan.canCommit ? this.validateFrozen(plan.document) : null
        const artifacts = await this.backupSources(bytes, browserLayout)
        ;({ backupPath, browserBackupPath } = artifacts)
        expectedBrowserHash = artifacts.browserBackupHash
        if (hash(await this.io.readFile(this.store.dataFile)) !== sourceHash) throw new schema.InputError('迁移源已变化，请重新预览')
        const previewToken = randomUUID()
        // A bounded collection avoids retaining old full-document candidates.
        if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value)
        if (browserBackupPath && hash(await this.io.readFile(browserBackupPath)) !== expectedBrowserHash) throw new Error('浏览器布局备份已变化，拒绝预览')
        this.previews.set(previewToken, { sourceHash, backupPath, browserBackupPath, browserBackupHash: expectedBrowserHash, candidate, backupHash: sourceHash })
        return { previewToken, sourceHash, backupPath, browserBackupPath, counts: plan.counts, countsMeaning: plan.countsMeaning, ambiguities: plan.ambiguities, warnings: plan.warnings, mapping: plan.mapping, canCommit: plan.canCommit }
      } catch (error) {
        error.backupPath ??= backupPath
        error.browserBackupPath ??= browserBackupPath
        throw error
      } finally {
        await this.store.releaseLock()
      }
    })
  }

  /** A token authorizes exactly the immutable candidate that was previewed. */
  async commit({ previewToken } = {}) {
    return this.exclusive(async () => {
      const preview = this.previews.get(previewToken)
      if (!preview) throw new schema.InputError('迁移预览已失效，请重新预览')
      if (!preview.candidate) throw new schema.InputError('迁移存在歧义，不能提交')
      this.assertQuiescent()
      await this.store.acquireLock()
      let temporaryFile
      try {
        const current = await this.io.readFile(this.store.dataFile)
        if (hash(current) !== preview.sourceHash) throw new schema.InputError('迁移源已变化，请重新预览')
        if (JSON.parse(current.toString('utf8')).version !== 4) throw new schema.InputError('只允许显式迁移 v4，不能覆盖已有 canonical 文档')
        if (hash(await this.io.readFile(preview.backupPath)) !== preview.backupHash) throw new Error('迁移备份已变化，拒绝替换')
        if (preview.browserBackupPath && hash(await this.io.readFile(preview.browserBackupPath)) !== preview.browserBackupHash) throw new Error('浏览器布局备份已变化，拒绝替换')
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
        error.backupPath = preview.backupPath
        error.browserBackupPath = preview.browserBackupPath
        error.temporaryFile = temporaryFile
        throw error
      } finally {
        await this.store.releaseLock()
      }
    })
  }
}
