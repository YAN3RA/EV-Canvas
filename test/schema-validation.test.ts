// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova test/，行为完整、类型标注待补。
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { InputError, assertDocumentIntegrity, normalizeState } from '@/shared/schema'

const ISO = '2026-01-01T00:00:00.000Z'

/** A minimal but fully legal v4 document; callers mutate the copy. */
function document() {
  return {
    version: 4,
    hiddenSessionIds: [],
    workspaces: [
      {
        id: 'ws-1',
        kind: 'dsh',
        cwd: 'C:\\synthetic',
        title: '工作区',
        createdAt: ISO,
        updatedAt: ISO,
        threads: [
          {
            id: 'th-1',
            title: '会话',
            parentId: null,
            dshSessionId: 's-1',
            dshSessionTitle: '会话',
            color: '#0f766e',
            position: { x: 10, y: 20 },
            createdAt: ISO,
            updatedAt: ISO,
            messages: [{ id: 'm-1', text: 'hi', kind: 'user', sourceSeq: 0, at: ISO }],
            pendingProcess: [],
          },
        ],
      },
    ],
  }
}

it('合法 v4 文档原样通过，且不标记迁移', () => {
  const { state, migrated } = normalizeState(document())
  assert.equal(migrated, false)
  assert.equal(state.version, 4)
  assert.equal(state.workspaces[0].threads[0].messages[0].text, 'hi')
})

it('重复的 workspace id 被拒绝而不是静默去重', () => {
  const doc = document()
  doc.workspaces.push({ ...doc.workspaces[0], threads: [] })
  assert.throws(() => normalizeState(doc), InputError)
})

it('重复的 thread id 被拒绝（跨工作区）', () => {
  const doc = document()
  doc.workspaces.push({ ...doc.workspaces[0], id: 'ws-2' })
  assert.throws(() => normalizeState(doc), /重复的 thread id/)
})

it('重复的 message id 被拒绝', () => {
  const doc = document()
  doc.workspaces[0].threads[0].messages.push({ id: 'm-1', text: 'dup', kind: 'user', sourceSeq: 1, at: ISO })
  assert.throws(() => normalizeState(doc), /重复的 message id/)
})

it('同一线程内重复的事件键 seq 被拒绝', () => {
  const doc = document()
  doc.workspaces[0].threads[0].messages.push({ id: 'm-2', text: 'dup', kind: 'user', sourceSeq: 0, at: ISO })
  assert.throws(() => normalizeState(doc), /重复的事件键/)
})

it('非法的 sourceSeq 被拒绝（负数／小数／字符串／NaN／越界）', () => {
  for (const bad of [-1, 1.5, '3', Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const doc = document()
    doc.workspaces[0].threads[0].messages[0].sourceSeq = bad
    assert.throws(() => normalizeState(doc), InputError, `sourceSeq=${String(bad)}`)
  }
})

it('缺少 sourceSeq 的消息仍然合法（旧格式消息无事件键）', () => {
  const doc = document()
  delete doc.workspaces[0].threads[0].messages[0].sourceSeq
  const { state } = normalizeState(doc)
  assert.equal(state.workspaces[0].threads[0].messages.length, 1)
})

it('非有限坐标被拒绝', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'x', null]) {
    const doc = document()
    doc.workspaces[0].threads[0].position = { x: bad, y: 0 }
    assert.throws(() => normalizeState(doc), InputError, `x=${String(bad)}`)
  }
})

it('缺失 position 的线程不因坐标校验被拒', () => {
  const doc = document()
  delete doc.workspaces[0].threads[0].position
  assert.equal(normalizeState(doc).state.workspaces[0].threads[0].position, undefined)
})

it('__proto__ 等原型污染键被丢弃，且不污染 Object.prototype', () => {
  const raw = JSON.parse('{"version":4,"hiddenSessionIds":[],"__proto__":{"polluted":"top"},"workspaces":[{"id":"ws-1","title":"t","createdAt":"' + ISO + '","updatedAt":"' + ISO + '","__proto__":{"polluted":"ws"},"threads":[]}]}')
  assert.equal(Object.hasOwn(raw, '__proto__'), true, '前提：JSON.parse 保留了自身属性')
  const { state } = normalizeState(raw)
  assert.equal(Object.hasOwn(state, '__proto__'), false)
  assert.equal(Object.hasOwn(state.workspaces[0], '__proto__'), false)
  assert.equal({}.polluted, undefined)
})

it('未知字段在各层级都被白名单丢弃', () => {
  const doc = document()
  doc.evilTop = 1
  doc.workspaces[0].evilWs = 1
  doc.workspaces[0].threads[0].evilThread = 1
  doc.workspaces[0].threads[0].messages[0].evilMessage = 1
  doc.workspaces[0].threads[0].messages[0].process = [{ callId: 'c-1', name: 'tool', evilProcess: 1 }]
  const { state } = normalizeState(doc)
  const thread = state.workspaces[0].threads[0]
  assert.equal(Object.hasOwn(state, 'evilTop'), false)
  assert.equal(Object.hasOwn(state.workspaces[0], 'evilWs'), false)
  assert.equal(Object.hasOwn(thread, 'evilThread'), false)
  assert.equal(Object.hasOwn(thread.messages[0], 'evilMessage'), false)
  assert.deepEqual(thread.messages[0].process, [{ callId: 'c-1', name: 'tool' }])
})

it('未知或缺失版本被拒绝', () => {
  assert.throws(() => normalizeState({ version: 9, workspaces: [] }), /expected Synapnova data version/)
  assert.throws(() => normalizeState({ workspaces: [] }), /expected Synapnova data version/)
  assert.throws(() => normalizeState(null), /expected Synapnova data version/)
})

it('runtime-context 注入消息在规范化时被丢弃并标记迁移', () => {
  const doc = document()
  doc.workspaces[0].threads[0].messages.push({
    id: 'm-injected',
    kind: 'user',
    text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    sourceSeq: 1,
    at: ISO,
  })
  const { state, migrated } = normalizeState(doc)
  assert.equal(migrated, true)
  assert.deepEqual(state.workspaces[0].threads[0].messages.map(item => item.id), ['m-1'])
})

it('非对象的 thread 条目被过滤，不使整份文档失败', () => {
  const doc = document()
  doc.workspaces[0].threads.push(null, 'nope', 42)
  const { state } = normalizeState(doc)
  assert.equal(state.workspaces[0].threads.length, 1)
})

it('assertDocumentIntegrity 可直接校验已构建的 state', () => {
  const bad = { workspaces: [{ id: 'a', threads: [{ id: 'b', messages: [{ id: 'c', sourceSeq: 1 }, { id: 'd', sourceSeq: 1 }] }] }] }
  assert.throws(() => assertDocumentIntegrity(bad), /重复的事件键/)
  assert.doesNotThrow(() => assertDocumentIntegrity({ workspaces: [] }))
})
