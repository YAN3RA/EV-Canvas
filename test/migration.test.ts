// @ts-nocheck -- 迁移自 dsh-synapnova test/migration.test.js
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach, onTestFinished } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMigrationPlan } from '@/shared/migration'
import { normalizeFrozenState } from '@/shared/schema'
import { MigrationService } from '@/server/migration'
import { WorkspaceStore } from '@/server/workspace-store'

const ISO = '2026-10-17T10:00:00.000Z'
function legacy() {
  return { version: 4, updatedAt: ISO, hiddenSessionIds: ['hidden'], workspaces: [{
    id: 'workspace-1', kind: 'dsh', dshWorkspaceId: 'host-1', cwd: 'C:\\work', title: '工作区', createdAt: ISO, updatedAt: ISO,
    threads: [{ id: 'thread-1', title: '会话', parentId: null, sourceParentSessionId: null, sourceSeedLength: 0,
      dshSessionId: 'session-1', dshSessionTitle: '会话', color: '#0f766e', position: { x: -80, y: 42 }, createdAt: ISO, updatedAt: ISO,
      messages: [{ id: 'message-1', text: '问题', kind: 'user', sourceSeq: 3, at: ISO },
        { id: 'message-2', text: '回答', kind: 'assistant', sourceSeq: 4, at: ISO, turn: 1, step: 1,
          process: [{ callId: 'call-1', name: 'read', arguments: '{}', result: 'ok', error: null }] },
        { id: 'message-3', text: '第二个问题', kind: 'user', sourceSeq: 8, at: ISO }],
      pendingProcess: [{ callId: 'pending-1', turn: 2, step: 1, name: 'read', arguments: '{}', result: null, error: null }],
    }],
  }] }
}
const layout = () => ({ positions: [['thread-1:turn:3', { x: 200, y: 300 }], ['thread-1:turn-index:0', { x: 200, y: 300 }]], collapsed: ['thread-1:turn:8'] })
async function fixture(options) {
  const directory = await mkdtemp(join(tmpdir(), 'synapnova-migration-'))
  const dataFile = join(directory, 'workspaces.json')
  const bytes = Buffer.from(JSON.stringify(legacy(), null, 2))
  await writeFile(dataFile, bytes)
  const store = new WorkspaceStore(dataFile)
  await store.ready
  return { dataFile, bytes, store, service: new MigrationService(store, { now: () => ISO, ...options }) }
}

it('纯转换保留字段、血缘、工具、旧隐藏与原始输入，移动position且保守生成coverage', () => {
  const source = legacy(), before = structuredClone(source)
  const plan = buildMigrationPlan({ legacyState: source })
  assert.equal(plan.canCommit, true)
  assert.deepEqual(source, before)
  const ws = plan.document.workspaces[0], thread = ws.projection.threads[0]
  assert.equal(plan.document.format, 'dsh-evcanvas')
  assert.equal(plan.document.schemaVersion, 1)
  assert.equal('version' in plan.document, false)
  assert.deepEqual(plan.document.hiddenSessionIds, ['hidden'])
  assert.equal(ws.revision, 1); assert.equal(ws.projectionEpoch, 1)
  assert.equal('threads' in ws, false); assert.equal('position' in thread, false)
  assert.deepEqual(ws.layout.cards['thread-1'], { x: -80, y: 42 })
  assert.deepEqual(thread.messages, source.workspaces[0].threads[0].messages)
  assert.deepEqual(thread.pendingProcess, source.workspaces[0].threads[0].pendingProcess)
  assert.deepEqual(thread.coverage, { ranges: [[3, 4], [8, 8]], historyComplete: false, textTruncated: false })
  assert.deepEqual(ws.materials, []); assert.deepEqual(ws.regions, []); assert.deepEqual(ws.annotations, [])
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeFrozenState(plan.document).state)), plan.document)
})

it('浏览器sourceSeq及turn-index别名唯一映射到0基问题序号，快照不变', () => {
  const snapshot = layout(), original = structuredClone(snapshot)
  const plan = buildMigrationPlan({ legacyState: legacy(), browserLayout: snapshot })
  assert.equal(plan.canCommit, true)
  assert.deepEqual(plan.document.workspaces[0].layout.cards['thread-1:0'], { x: 200, y: 300 })
  assert.equal(plan.document.workspaces[0].layout.collapsed['thread-1:1'], true)
  assert.deepEqual(plan.mapping.map(item => [item.sourceSeq, item.cardId]), [[3, 'thread-1:0'], [8, 'thread-1:1']])
  assert.deepEqual(snapshot, original)
})

it('cwd仅在唯一宿主目录时映射，多个候选或无候选阻止提交', () => {
  const source = legacy(); delete source.workspaces[0].dshWorkspaceId
  const host = { id: 'host-mapped', path: 'C:\\work', title: '宿主', sessionIds: ['session-1'] }
  const plan = buildMigrationPlan({ legacyState: source, hostWorkspaces: [host] })
  assert.equal(plan.document.workspaces[0].dshWorkspaceId, 'host-mapped')
  assert.equal(plan.canCommit, true)
  for (const hosts of [[], [host, { ...host, id: 'another-host' }]]) {
    const ambiguous = buildMigrationPlan({ legacyState: source, hostWorkspaces: hosts })
    assert.equal(ambiguous.canCommit, false)
    assert.equal(ambiguous.ambiguities[0].code, 'workspace-ownership')
  }
})

it('旧key缺失、别名坐标冲突和父血缘循环均报告歧义而不猜配', () => {
  const snapshot = layout(); snapshot.positions[1][1].x = 900
  assert.equal(buildMigrationPlan({ legacyState: legacy(), browserLayout: snapshot }).canCommit, false)
  assert.equal(buildMigrationPlan({ legacyState: legacy(), browserLayout: { collapsed: ['thread-1:turn:999'] } }).ambiguities[0].code, 'card-mapping')
  const source = legacy(); source.workspaces[0].threads[0].parentId = 'thread-1'
  assert.equal(buildMigrationPlan({ legacyState: source }).ambiguities[0].code, 'parent-cycle')
})

it('仅v4、非法结构、非法seq、重复事件、重复实体、非有限坐标拒绝', () => {
  for (const version of [1, 2, 3, 5]) assert.throws(() => buildMigrationPlan({ legacyState: { ...legacy(), version } }), /仅接受 version:4/)
  assert.throws(() => buildMigrationPlan({ legacyState: { format: 'dsh-synapnova', schemaVersion: 1, workspaces: [] } }))
  for (const change of [
    source => { source.workspaces.push(null) },
    source => { source.workspaces[0].threads[0].messages[0].sourceSeq = -1 },
    source => { delete source.workspaces[0].threads[0].messages[0].sourceSeq },
    source => { source.workspaces[0].threads[0].messages[1].sourceSeq = 3 },
    source => { source.workspaces[0].threads[0].position.x = NaN },
    source => { source.workspaces[0].threads.push(structuredClone(source.workspaces[0].threads[0])) },
  ]) { const source = legacy(); change(source); assert.throws(() => buildMigrationPlan({ legacyState: source })) }
})

it('未知字段预览可见，保留runtime-context开头真实用户文字', () => {
  const source = legacy(); source.extra = { secret: 'never-in-canonical' }
  source.workspaces[0].threads[0].messages[0].text = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
  const plan = buildMigrationPlan({ legacyState: source })
  assert.equal(plan.warnings[0].code, 'unknown-field')
  assert.equal('extra' in plan.document, false)
  assert.equal(plan.document.workspaces[0].projection.threads[0].messages[0].text, source.workspaces[0].threads[0].messages[0].text)
})

it('v4加载不改字节；显式预览先备份并读回；commit后canonical往返且备份原字节保留', async () => {
  const { dataFile, bytes, store, service } = await fixture()
  assert.deepEqual(await readFile(dataFile), bytes)
  const preview = await service.preview({ browserLayout: layout() })
  assert.equal(preview.canCommit, true)
  assert.deepEqual(await readFile(dataFile), bytes)
  assert.deepEqual(await readFile(preview.backupPath), bytes)
  assert.deepEqual(JSON.parse(await readFile(preview.browserBackupPath, 'utf8')), layout())
  const result = await service.commit({ previewToken: preview.previewToken })
  assert.equal(result.migrated, true)
  const disk = JSON.parse(await readFile(dataFile, 'utf8'))
  assert.equal(disk.schemaVersion, 1); assert.equal(disk.version, undefined)
  assert.equal(store.legacyReadOnly, false)
  assert.deepEqual(JSON.parse(JSON.stringify(store.state)), disk)
  assert.deepEqual(await readFile(preview.backupPath), bytes)
  const reloaded = new WorkspaceStore(dataFile); await reloaded.ready
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.state)), disk)
  await assert.rejects(service.commit({ previewToken: preview.previewToken }), /预览已失效/)
  await assert.rejects(service.preview(), /仅接受 version:4/)
})

it('备份写入或读回失败均保留原源与内存，错误报告备份路径', async () => {
  for (const mode of ['write', 'readback']) {
    const io = { readFile: async (...args) => mode === 'readback' && args[0].includes('.backup-') ? Buffer.from('{}') : readFile(...args),
      writeFile: async (...args) => { if (mode === 'write' && args[0].includes('.backup-')) throw new Error('ENOSPC fixture'); return writeFile(...args) } }
    const { dataFile, bytes, store, service } = await fixture({ io })
    const before = JSON.stringify(store.state)
    await assert.rejects(service.preview(), error => { assert.ok(error.backupPath); return true })
    assert.deepEqual(await readFile(dataFile), bytes)
    assert.equal(JSON.stringify(store.state), before)
  }
})

it('预览后源内容变化拒绝提交且不覆盖外部字节', async () => {
  const { dataFile, service, store } = await fixture()
  const preview = await service.preview()
  const external = Buffer.from(JSON.stringify({ ...legacy(), updatedAt: '2026-10-18T10:00:00.000Z' }))
  await writeFile(dataFile, external)
  const before = JSON.stringify(store.state)
  await assert.rejects(service.commit({ previewToken: preview.previewToken }), /源已变化/)
  assert.deepEqual(await readFile(dataFile), external)
  assert.equal(JSON.stringify(store.state), before)
})

it('rename失败不公布候选，原字节与可读回备份保留', async () => {
  const { dataFile, bytes, store, service } = await fixture()
  const preview = await service.preview(), before = JSON.stringify(store.state)
  store.replaceFileWithRetry = async () => { const error = new Error('EPERM fixture'); error.code = 'EPERM'; throw error }
  await assert.rejects(service.commit({ previewToken: preview.previewToken }), error => { assert.equal(error.backupPath, preview.backupPath); return true })
  assert.deepEqual(await readFile(dataFile), bytes)
  assert.deepEqual(await readFile(preview.backupPath), bytes)
  assert.equal(JSON.stringify(store.state), before)
})

it('临时候选读回损坏或pending dirty禁止替换', async () => {
  const io = { readFile: async (...args) => args[0].includes('.migration-') ? Buffer.from('{}') : readFile(...args), writeFile }
  const { dataFile, bytes, store, service } = await fixture({ io })
  const preview = await service.preview()
  await assert.rejects(service.commit({ previewToken: preview.previewToken }), /候选读回字节不一致/)
  assert.deepEqual(await readFile(dataFile), bytes)
  store.dirty = true
  await assert.rejects(service.commit({ previewToken: preview.previewToken }), /待保存事件/)
  store.dirty = false
})

it('原始浏览器键字节完整sidecar备份，篡改后拒绝提交', async () => {
  const { dataFile, bytes, service } = await fixture()
  const snapshot = { ...layout(), raw: { 'dsh-synapnova:card-positions:v2': '  [1,2]  ', 'dsh-synapnova:collapsed-cards:v1': null } }
  const preview = await service.preview({ browserLayout: snapshot })
  assert.deepEqual(JSON.parse(await readFile(preview.browserBackupPath, 'utf8')), snapshot)
  await writeFile(preview.browserBackupPath, '{}')
  await assert.rejects(service.commit({ previewToken: preview.previewToken }), /布局备份已变化/)
  assert.deepEqual(await readFile(dataFile), bytes)
})

it('sidecar后续读取篡改不能建立新基线：preview或第三次read的commit拒绝', async () => {
  for (const tamperOnRead of [2, 3]) {
    let sidecarReads = 0
    const io = {
      readFile: async (...args) => {
        if (args[0].endsWith('.browser.json') && ++sidecarReads >= tamperOnRead) {
          await writeFile(args[0], '{"positions":[],"collapsed":[]}')
        }
        return readFile(...args)
      },
      writeFile,
    }
    const { dataFile, bytes, store, service } = await fixture({ io })
    const before = JSON.stringify(store.state)
    if (tamperOnRead === 2) {
      await assert.rejects(service.preview({ browserLayout: layout() }), /布局备份已变化，拒绝预览/)
      assert.equal(service.previews.size, 0)
    } else {
      const preview = await service.preview({ browserLayout: layout() })
      assert.equal(sidecarReads, 2)
      await assert.rejects(service.commit({ previewToken: preview.previewToken }), /布局备份已变化，拒绝替换/)
      assert.equal(sidecarReads, 3)
    }
    assert.deepEqual(await readFile(dataFile), bytes)
    assert.equal(JSON.stringify(store.state), before)
  }
})

it('prepareState失败发生rename之前，磁盘和内存都不前进', async () => {
  const { dataFile, bytes, store, service } = await fixture()
  const preview = await service.preview(), before = JSON.stringify(store.state)
  store.prepareState = () => { throw new Error('prepare fixture') }
  await assert.rejects(service.commit({ previewToken: preview.previewToken }), /prepare fixture/)
  assert.deepEqual(await readFile(dataFile), bytes)
  assert.equal(JSON.stringify(store.state), before)
})

it('锁被占用时拒绝迁移且不删除持有者锁', async () => {
  const { dataFile, bytes, service } = await fixture()
  const preview = await service.preview()
  const token = `${process.pid}:other-fixture-owner\n`
  await writeFile(`${dataFile}.lock`, token)
  await assert.rejects(service.commit({ previewToken: preview.previewToken }), /写锁/)
  assert.equal(await readFile(`${dataFile}.lock`, 'utf8'), token)
  assert.deepEqual(await readFile(dataFile), bytes)
})

it('消息乱序和多个旧工作区绑定同一宿主时禁止猜配', () => {
  const source = legacy(); source.workspaces[0].threads[0].messages.reverse()
  assert.equal(buildMigrationPlan({ legacyState: source }).ambiguities[0].code, 'event-order')
  const duplicate = legacy()
  duplicate.workspaces.push({ ...duplicate.workspaces[0], id: 'workspace-2', threads: [] })
  assert.equal(buildMigrationPlan({ legacyState: duplicate }).ambiguities[0].code, 'workspace-duplicate-binding')
})

it('独立工具卡残留不按相邻顺序猜配，缺浏览器快照不虚报迁移布局', () => {
  const source = legacy()
  source.workspaces[0].threads[0].messages[1].kind = 'tool'
  const plan = buildMigrationPlan({ legacyState: source })
  assert.equal(plan.canCommit, false)
  assert.equal(plan.ambiguities[0].code, 'legacy-tool-card')
})

it('并发Store读取排在迁移提交后，不观察候选半成品', async () => {
  const { store, service } = await fixture()
  const preview = await service.preview()
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const replace = store.replaceFileWithRetry.bind(store)
  store.replaceFileWithRetry = async temporaryFile => { started(); await gate; return replace(temporaryFile) }
  const committing = service.commit({ previewToken: preview.previewToken })
  await entered
  let readFinished = false
  const reading = store.get('workspace-1').then(value => { readFinished = true; return value })
  await Promise.resolve()
  assert.equal(readFinished, false)
  assert.equal(store.legacyReadOnly, true)
  release()
  await committing
  const view = await reading
  assert.equal(view.revision, 1)
  assert.equal(store.legacyReadOnly, false)
})

it('迁移源时间按严格ISO拒绝，不产生可提交的宽松时间计划', () => {
  for (const at of ['2026-01-01', '2026-02-29T00:00:00Z', '2026/01/01']) {
    const source = legacy(); source.updatedAt = at
    assert.throws(() => buildMigrationPlan({ legacyState: source }), /迁移源非法.*ISO8601/)
    const messageSource = legacy(); messageSource.workspaces[0].threads[0].messages[0].at = at
    assert.throws(() => buildMigrationPlan({ legacyState: messageSource }), /迁移源非法.*ISO8601/)
  }
})

it('歧义计划可备份预览但无法提交', async () => {
  const { dataFile, bytes, service } = await fixture()
  const preview = await service.preview({ browserLayout: { positions: [['missing', { x: 1, y: 2 }]] } })
  assert.equal(preview.canCommit, false)
  assert.deepEqual(await readFile(preview.backupPath), bytes)
  await assert.rejects(service.commit({ previewToken: preview.previewToken }), /存在歧义/)
  assert.deepEqual(await readFile(dataFile), bytes)
})
