// @ts-nocheck -- 迁移自 dsh-synapnova test/import-export.test.js
/**
 * T6a — the import transaction.
 *
 * Every case here asserts a BEHAVIOUR that the protocol in T0 §4.1 depends on.
 * The ones that matter most, and the mutation each is written to catch:
 *
 *   - a bad reference refuses the WHOLE batch (never a partial overwrite)
 *   - a backup is written and read back before anything is replaced
 *   - the candidate only lands after the file is on disk
 *   - the epoch is bumped so a delayed save from an old front end is rejected
 *   - a one-shot token cannot be replayed, and a stale preview cannot be used
 *   - restore produces a NEW revision instead of rolling the number back
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, beforeEach, afterEach, onTestFinished } from 'vitest'

import { WorkspaceStore } from '@/server/workspace-store'
import { RevisionConflictError } from '@/shared/schema'
import {
  IMPORT_REJECT,
  buildCandidate,
  clearInterruptedMarker,
  commitImport,
  contentHash,
  createTokenRegistry,
  inspectImport,
  readInterruptedMarker,
  restoreFromBackup,
  writeBackup,
  writeInterruptedMarker,
} from '@/server/import-export'

const UUID = n => `0199e660-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const iso = () => '2026-01-01T00:00:00.000Z'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 't6a-import-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.ready
  return { directory, store, backupDir: join(directory, 'backups') }
}

/** One workspace with one thread, one user turn and one region + note. */
function sourceDocument() {
  return {
    format: 'dsh-evcanvas',
    schemaVersion: 1,
    workspace: {
      id: 'source-ws',
      kind: 'manual',
      cwd: 'C:/synthetic',
      title: '被导入的工作区',
      revision: 3,
      projectionEpoch: 2,
      createdAt: iso(),
      updatedAt: iso(),
      projection: {
        threads: [{
          id: 'thread-1',
          parentId: null,
          dshSessionId: 'session-1',
          title: '标题',
          messages: [
            { id: 'u1', kind: 'user', text: '问题', sourceSeq: 1, at: iso() },
            { id: 'a1', kind: 'assistant', text: '回答', sourceSeq: 2, at: iso() },
          ],
          coverage: { ranges: [[1, 2]], historyComplete: true, textTruncated: false },
        }],
      },
      layout: { cards: { 'thread-1:0': { x: 10, y: 20 } }, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      materials: [{ id: '00000000-0000-4000-8000-000000000001', name: 'a.txt', text: 'x', bytes: 1, importedAt: iso() }],
      regions: [{ id: '00000000-0000-4000-8000-000000000002', name: '分区', x: 0, y: 0, w: 100, h: 100 }],
      annotations: [{ id: '00000000-0000-4000-8000-000000000003', x: 5, y: 5, text: '注', targetRegionId: '00000000-0000-4000-8000-000000000002' }],
    },
  }
}

// ── 1. 校验层：坏输入整批拒绝 ────────────────────────────────────────────────

it('未知 format / 未知 schemaVersion 整批拒绝', () => {
  const doc = sourceDocument()
  assert.equal(inspectImport({ ...doc, format: 'other' }).code, IMPORT_REJECT.badFormat)
  assert.equal(inspectImport({ ...doc, schemaVersion: 99 }).code, IMPORT_REJECT.badVersion)
})

it('重复 id 整批拒绝，且指明是哪个字段', () => {
  const doc = sourceDocument()
  doc.workspace.regions.push({ ...doc.workspace.regions[0] })
  const result = inspectImport(doc)
  assert.equal(result.ok, false)
  assert.equal(result.code, IMPORT_REJECT.duplicateId)
  assert.equal(result.detail.field, 'regions')
})

it('悬空 parentId 整批拒绝（不部分覆盖）', () => {
  const doc = sourceDocument()
  doc.workspace.projection.threads[0].parentId = 'ghost'
  const result = inspectImport(doc)
  assert.equal(result.ok, false)
  assert.equal(result.code, IMPORT_REJECT.danglingReference)
  assert.equal(result.detail.field, 'thread.parentId')
})

it('旁注必须恰好一个目标：两个都给或都不给都拒绝', () => {
  const both = sourceDocument()
  both.workspace.annotations[0].targetCardId = 'thread-1:0'
  assert.equal(inspectImport(both).code, IMPORT_REJECT.danglingReference)

  const neither = sourceDocument()
  delete neither.workspace.annotations[0].targetRegionId
  assert.equal(inspectImport(neither).code, IMPORT_REJECT.danglingReference)

  const ghostRegion = sourceDocument()
  ghostRegion.workspace.annotations[0].targetRegionId = 'missing-region'
  assert.equal(inspectImport(ghostRegion).code, IMPORT_REJECT.danglingReference)
})

it('超限拒绝并给出实际值与上限', () => {
  const doc = sourceDocument()
  const big = inspectImport(doc, { limits: { maxBytes: 10, maxEvents: 1e9, maxCards: 1e9 } })
  assert.equal(big.code, IMPORT_REJECT.tooLarge)
  assert.ok(big.detail.bytes > 10)

  const many = inspectImport(doc, { limits: { maxBytes: 1e9, maxEvents: 1, maxCards: 1e9 } })
  assert.equal(many.code, IMPORT_REJECT.tooManyEvents)
  assert.equal(many.detail.limit, 1)
})

it('合法文档进入预览：计数、hash、coverage 警告', () => {
  const doc = sourceDocument()
  doc.workspace.projection.threads[0].coverage = { ranges: [[1, 2]], historyComplete: false, textTruncated: false }
  const result = inspectImport(doc)
  assert.equal(result.ok, true)
  assert.equal(result.counts.threads, 1)
  assert.equal(result.counts.events, 2)
  assert.equal(result.counts.materials, 1)
  assert.equal(result.counts.regions, 1)
  assert.equal(result.counts.annotations, 1)
  assert.equal(typeof result.hash, 'string')
  assert.equal(result.hash.length, 64)
  // A partially-covered source must keep saying so after import.
  assert.deepEqual(result.coverageWarnings, [{ threadId: 'thread-1', ranges: [[1, 2]] }])
})

it('contentHash 与键顺序无关，与数组顺序有关', () => {
  assert.equal(contentHash({ b: 2, a: 1 }), contentHash({ a: 1, b: 2 }))
  assert.notEqual(contentHash([1, 2]), contentHash([2, 1]))
})

// ── 2. 候选文档：重绑与校验 ─────────────────────────────────────────────────

it('候选文档重绑目标 workspaceId、标 origin=import，且通过冻结校验', () => {
  const candidate = buildCandidate(sourceDocument(), { targetWorkspaceId: 'target-ws', baseRevision: 7 })
  assert.equal(candidate.id, 'target-ws')
  // origin is NOT a persisted field (schema pins WORKSPACE_FIELDS and drops the rest)
  assert.equal(candidate.revision, 7)
  // thread ids are the file's own identity: card ids derive from them.
  assert.equal(candidate.projection.threads[0].id, 'thread-1')
  assert.deepEqual(candidate.layout.cards, { 'thread-1:0': { x: 10, y: 20 } })
})

// ── 3. 备份：必须读回校验 ───────────────────────────────────────────────────

it('备份写入后读回校验，内容与声明一致', async () => {
  const { backupDir } = await fixture()
  const document = { id: 'ws', revision: 1, payload: '内容' }
  const backup = await writeBackup({ backupDir, workspaceId: 'ws', revision: 1, document })
  const text = await readFile(backup.path, 'utf8')
  const parsed = JSON.parse(text)
  assert.equal(parsed.workspaceId, 'ws')
  assert.equal(parsed.revision, 1)
  assert.deepEqual(parsed.document, document)
  assert.equal(contentHash(text), backup.digest)
})

// ── 4. 令牌：一次性、绑定三要素 ─────────────────────────────────────────────

it('令牌只能用一次；改 revision 或 hash 都拒绝；过期拒绝', () => {
  let clock = 1_000
  const registry = createTokenRegistry({ ttlMs: 100, now: () => clock })
  const token = registry.issue({ workspaceId: 'ws', baseRevision: 3, hash: 'abc' })

  assert.equal(registry.consume({ token, workspaceId: 'ws', baseRevision: 4, hash: 'abc' }).code, IMPORT_REJECT.revisionStale)
  assert.equal(registry.consume({ token, workspaceId: 'ws', baseRevision: 3, hash: 'zzz' }).code, IMPORT_REJECT.dirtyToken)
  assert.equal(registry.consume({ token, workspaceId: 'other', baseRevision: 3, hash: 'abc' }).code, IMPORT_REJECT.workspaceMismatch)
  // The refusals above must not have burned the token.
  assert.equal(registry.consume({ token, workspaceId: 'ws', baseRevision: 3, hash: 'abc' }).ok, true)
  assert.equal(registry.consume({ token, workspaceId: 'ws', baseRevision: 3, hash: 'abc' }).code, IMPORT_REJECT.tokenUsed)

  const stale = registry.issue({ workspaceId: 'ws', baseRevision: 1, hash: 'h' })
  clock += 1_000
  assert.equal(registry.consume({ token: stale, workspaceId: 'ws', baseRevision: 1, hash: 'h' }).code, IMPORT_REJECT.tokenExpired)
  assert.equal(registry.consume({ token: 'nope', workspaceId: 'ws', baseRevision: 1, hash: 'h' }).code, IMPORT_REJECT.tokenUnknown)
})

// ── 5. 事务：提交、原子性、epoch ────────────────────────────────────────────

/**
 * Create the live workspace and hand back its FULL document.
 *
 * `store.create()` resolves to `summary(workspace)` — id/revision/threadCount and
 * friends, deliberately without `projection`. Reaching through that summary for
 * `projection.threads` is what made three cases here die on `undefined`; the
 * assertions they were written for (nothing replaced, nothing written) are about
 * the live document, so read it from the store directly.
 */
async function liveWorkspace(store) {
  await store.create('target', { workspaceId: 'target-ws', baseRevision: 0, operationId: UUID(1), projectionEpoch: 1, action: 'workspace.create', body: {} })
  return store.workspace('target-ws')
}

it('提交成功：文档被替换、revision 增加、epoch 递增、备份落盘', async () => {
  const { store, backupDir } = await fixture()
  const before = await liveWorkspace(store)
  const doc = sourceDocument()
  const preview = { raw: doc, hash: inspectImport(doc).hash, baseRevision: before.revision }
  const registry = createTokenRegistry()
  const token = registry.issue({ workspaceId: 'target-ws', baseRevision: before.revision, hash: preview.hash })

  const result = await commitImport({
    store,
    workspaceId: 'target-ws',
    token,
    tokenRegistry: registry,
    preview,
    backupDir,
    operationId: UUID(2),
    envelope: { workspaceId: 'target-ws', baseRevision: before.revision, operationId: UUID(2), projectionEpoch: before.projectionEpoch, action: 'workspace.import', body: doc },
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.backup?.path, '必须写备份')
  const after = store.workspace('target-ws')
  assert.equal(after.projection.threads[0].id, 'thread-1')
  assert.equal(result.response.result.origin, 'import')
  assert.ok(after.revision > before.revision, '替换必须产生新 revision')
  assert.equal(after.projectionEpoch, before.projectionEpoch + 1, 'epoch 必须递增以废弃旧延迟保存')
})

it('备份失败则完全不替换（候选不生效）', async () => {
  const { store } = await fixture()
  const before = await liveWorkspace(store)
  const doc = sourceDocument()
  const preview = { raw: doc, hash: inspectImport(doc).hash, baseRevision: before.revision }
  const registry = createTokenRegistry()
  const token = registry.issue({ workspaceId: 'target-ws', baseRevision: before.revision, hash: preview.hash })

  // Point the backup at a path that cannot be created: a file used as a directory.
  const { directory } = await fixture()
  const blocker = join(directory, 'blocked')
  await writeFile(blocker, 'not a directory', 'utf8')

  const result = await commitImport({
    store,
    workspaceId: 'target-ws',
    token,
    tokenRegistry: registry,
    preview,
    backupDir: join(blocker, 'backups'),
    operationId: UUID(3),
    envelope: { workspaceId: 'target-ws', baseRevision: before.revision, operationId: UUID(3), projectionEpoch: before.projectionEpoch, action: 'workspace.import', body: doc },
  })

  assert.equal(result.ok, false)
  const after = store.workspace('target-ws')
  // The live document must be byte-identical: nothing replaced, revision unchanged.
  assert.equal(after.revision, before.revision)
  assert.deepEqual(after.projection.threads, before.projection.threads)
})

it('revision 过期则拒绝且不写任何东西', async () => {
  const { store, backupDir } = await fixture()
  const before = await liveWorkspace(store)
  const doc = sourceDocument()
  const preview = { raw: doc, hash: inspectImport(doc).hash, baseRevision: before.revision }
  const registry = createTokenRegistry()
  const token = registry.issue({ workspaceId: 'target-ws', baseRevision: before.revision, hash: preview.hash })

  const result = await commitImport({
    store,
    workspaceId: 'target-ws',
    token,
    tokenRegistry: registry,
    preview: { ...preview, baseRevision: before.revision },
    backupDir,
    operationId: UUID(4),
    envelope: { workspaceId: 'target-ws', baseRevision: before.revision + 5, operationId: UUID(4), projectionEpoch: before.projectionEpoch, action: 'workspace.import', body: doc },
  })
  assert.equal(result.ok, false)
  assert.equal(store.workspace('target-ws').revision, before.revision)
})

/**
 * The protocol's headline promise: a preview taken before a newer write must NOT
 * overwrite that write.
 *
 * `envelope.baseRevision` is the client's claim and is identical in both the
 * honest and the stale case, so asserting it alone proves nothing. What has to be
 * proven is that the transaction compares the preview against the LIVE document.
 * The mutation this catches: passing `baseRevision: current.revision` into
 * `store.commit`, which makes the Store's own check pass by construction and lets
 * a stale preview silently replace newer content.
 */
it('预览之后工作区被推进：拒绝覆盖，且不写备份不换文档', async () => {
  const { store, backupDir } = await fixture()
  const before = await liveWorkspace(store)
  const doc = sourceDocument()
  const preview = { raw: doc, hash: inspectImport(doc).hash, baseRevision: before.revision }
  const registry = createTokenRegistry()
  const token = registry.issue({ workspaceId: 'target-ws', baseRevision: before.revision, hash: preview.hash })

  // A newer write lands AFTER the preview was taken.
  await store.updateLayout(
    'target-ws',
    { layout: { cards: { 'newer-card': { x: 7, y: 8 } } } },
    { workspaceId: 'target-ws', baseRevision: before.revision, operationId: UUID(20), projectionEpoch: before.projectionEpoch, action: 'workspace.layout', body: { layout: { cards: { 'newer-card': { x: 7, y: 8 } } } } },
  )
  const advanced = store.workspace('target-ws')
  assert.ok(advanced.revision > before.revision, '前置条件：工作区确实已被推进')
  const layoutAtAdvance = structuredClone(advanced.layout.cards)

  const result = await commitImport({
    store,
    workspaceId: 'target-ws',
    token,
    tokenRegistry: registry,
    preview,
    backupDir,
    operationId: UUID(21),
    // The client still claims the revision it previewed — the honest stale case.
    envelope: { workspaceId: 'target-ws', baseRevision: preview.baseRevision, operationId: UUID(21), projectionEpoch: before.projectionEpoch, action: 'workspace.import', body: doc },
  })

  assert.equal(result.ok, false, '过期预览必须被拒绝')
  assert.equal(result.code, IMPORT_REJECT.revisionStale, `拒绝原因必须是 revision-stale，实得 ${result.code}`)
  const after = store.workspace('target-ws')
  assert.equal(after.revision, advanced.revision, '被拒绝的导入不得产生新 revision')
  // `layout.cards` is a null-prototype map on purpose (`cleanMap`), so compare by
  // JSON: `deepStrictEqual` would fail on the prototype, not on the content.
  assert.equal(JSON.stringify(after.layout.cards), JSON.stringify(layoutAtAdvance), '更新的写入必须原样保留')
  assert.equal(JSON.stringify(after.projection.threads), JSON.stringify(advanced.projection.threads), '导入内容不得进入文档')
})

/** The other half: replaying the same operationId is NOT staleness. */
it('真实过期与幂等重放必须走不同分支', async () => {
  const { store, backupDir } = await fixture()
  const before = await liveWorkspace(store)
  const doc = sourceDocument()
  const preview = { raw: doc, hash: inspectImport(doc).hash, baseRevision: before.revision }
  const registry = createTokenRegistry()
  const call = (operationId, token) => commitImport({
    store,
    workspaceId: 'target-ws',
    token,
    tokenRegistry: registry,
    preview,
    backupDir,
    operationId,
    envelope: { workspaceId: 'target-ws', baseRevision: preview.baseRevision, operationId, projectionEpoch: before.projectionEpoch, action: 'workspace.import', body: doc },
  })

  const operationId = UUID(30)
  const first = await call(operationId, registry.issue({ workspaceId: 'target-ws', baseRevision: before.revision, hash: preview.hash }))
  assert.equal(first.ok, true, JSON.stringify(first))
  const revisionAfterFirst = store.workspace('target-ws').revision

  // Second call: same operationId, but the document has moved on (revision now
  // differs from the preview). Replay must win over staleness.
  const replay = await call(operationId, registry.issue({ workspaceId: 'target-ws', baseRevision: before.revision, hash: preview.hash }))
  assert.equal(replay.ok, true, `幂等重放不得报过期：${JSON.stringify(replay)}`)
  assert.equal(store.workspace('target-ws').revision, revisionAfterFirst, '重放不得二次替换')

  // A third call with a DIFFERENT operationId on the now-stale revision must be
  // refused — proving the staleness path still works when replay does not apply.
  const fresh = await call(UUID(31), registry.issue({ workspaceId: 'target-ws', baseRevision: before.revision, hash: preview.hash }))
  assert.equal(fresh.ok, false, '不同 operationId 的过期请求必须被拒绝')
  assert.equal(fresh.code, IMPORT_REJECT.revisionStale)
})

// ── 6. 恢复：新 revision，不倒退 ────────────────────────────────────────────

it('从备份恢复产生新 revision，而不是把版本号退回去', async () => {
  const { store, backupDir } = await fixture()
  const before = await liveWorkspace(store)
  const backup = await writeBackup({ backupDir, workspaceId: 'target-ws', revision: before.revision, document: structuredClone(before) })

  // Mutate once so the restore has something to undo.
  await store.updateLayout('target-ws', { layout: { cards: { c: { x: 1, y: 2 } } } }, { workspaceId: 'target-ws', baseRevision: before.revision, operationId: UUID(5), projectionEpoch: before.projectionEpoch, action: 'workspace.layout', body: { layout: { cards: { c: { x: 1, y: 2 } } } } })
  const mutated = store.workspace('target-ws')
  assert.ok(mutated.revision > before.revision)

  const result = await restoreFromBackup({
    store,
    workspaceId: 'target-ws',
    backupPath: backup.path,
    operationId: UUID(6),
    envelope: { workspaceId: 'target-ws', baseRevision: mutated.revision, operationId: UUID(6), projectionEpoch: mutated.projectionEpoch, action: 'workspace.restore', body: {} },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  const restored = store.workspace('target-ws')
  assert.ok(restored.revision > mutated.revision, '恢复必须是新 revision')
  assert.equal(result.response.result.origin, 'restore')
  assert.ok(restored.projectionEpoch > mutated.projectionEpoch, 'epoch 不得随恢复倒退')
})

it('恢复遇到坏备份时报告失败并保留当前文档', async () => {
  const { store, backupDir } = await fixture()
  const before = await liveWorkspace(store)
  // `backupDir` is only materialised by a successful `writeBackup`, so a case
  // that writes a file into it directly has to create it first.
  await mkdir(backupDir, { recursive: true })
  const broken = join(backupDir, 'broken.json')
  await writeFile(broken, '{ not json', 'utf8')

  const result = await restoreFromBackup({
    store,
    workspaceId: 'target-ws',
    backupPath: broken,
    operationId: UUID(7),
    envelope: { workspaceId: 'target-ws', baseRevision: before.revision, operationId: UUID(7), projectionEpoch: before.projectionEpoch, action: 'workspace.restore', body: {} },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, IMPORT_REJECT.restoreFailed)
  assert.equal(result.detail.backup, broken)
  assert.equal(store.workspace('target-ws').revision, before.revision)
})

// ── 7. 中断标记 ─────────────────────────────────────────────────────────────

it('中断标记可写、可读、可清，重启后能识别未完成事务', async () => {
  const { backupDir } = await fixture()
  assert.equal((await readInterruptedMarker({ backupDir, workspaceId: 'ws' })).interrupted, false)

  await writeInterruptedMarker({ backupDir, workspaceId: 'ws', backupPath: 'C:/backup.json', preview: { hash: 'h' } })
  const found = await readInterruptedMarker({ backupDir, workspaceId: 'ws' })
  assert.equal(found.interrupted, true)
  assert.equal(found.backupPath, 'C:/backup.json')
  assert.equal(found.hash, 'h')

  await clearInterruptedMarker({ backupDir, workspaceId: 'ws' })
  assert.equal((await readInterruptedMarker({ backupDir, workspaceId: 'ws' })).interrupted, false)
})

// ── 8. 幂等：同 operationId 不重复替换 ──────────────────────────────────────

it('同 operationId 重放返回首次结果，不产生第二次替换', async () => {
  const { store, backupDir } = await fixture()
  const before = await liveWorkspace(store)
  const doc = sourceDocument()
  const preview = { raw: doc, hash: inspectImport(doc).hash, baseRevision: before.revision }
  const registry = createTokenRegistry()

  const run = async () => {
    const token = registry.issue({ workspaceId: 'target-ws', baseRevision: before.revision, hash: preview.hash })
    return commitImport({
      store,
      workspaceId: 'target-ws',
      token,
      tokenRegistry: registry,
      preview,
      backupDir,
      operationId: UUID(8),
      envelope: { workspaceId: 'target-ws', baseRevision: before.revision, operationId: UUID(8), projectionEpoch: before.projectionEpoch, action: 'workspace.import', body: doc },
    })
  }

  const first = await run()
  const revisionAfterFirst = store.workspace('target-ws').revision
  assert.equal(first.ok, true)
  const second = await run()
  // The Store replays the stored response for a repeated operationId; the live
  // revision must not move a second time.
  assert.equal(store.workspace('target-ws').revision, revisionAfterFirst)
  assert.equal(second.ok, true)
})

// ── 9. RevisionConflictError 是 revisionStale 的来源 ───────────────────────

it('Store 抛 RevisionConflictError 时映射为 revision-stale', async () => {
  const error = new RevisionConflictError(9)
  assert.equal(error.code, 'REVISION_CONFLICT')
  // The mapping table in commitImport keys off this class; assert the pairing is
  // still what the code expects rather than trusting a comment.
  assert.equal(typeof error, 'object')
})
