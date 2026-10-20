// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova test/，行为完整、类型标注待补。
/**
 * Strict ISO-8601 literal validation (T2a tail item).
 *
 * `Date.parse` accepted date-only strings, platform-loose spellings and rolled
 * impossible calendar days forward, so a frozen document could store a
 * timestamp that cannot be ordered or compared. These tests pin the accepted
 * grammar, the calendar/clock ranges, every persisted time field, and the two
 * compatibility promises: optional fields stay optional, and the legacy
 * read-only path is not tightened.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { InputError, createFrozenState, isoDate, normalizeFrozenState, normalizeState } from '@/shared/schema'

const ISO = '2026-01-01T00:00:00.000Z'
const UUID = '00000000-0000-4000-8000-000000000001'
const OP_ID = '0199e660-0000-7000-8000-000000000001'

function frozen() {
  return {
    ...createFrozenState(ISO),
    workspaces: [{
      id: 'ws-1',
      kind: 'dsh',
      dshWorkspaceId: 'host-1',
      cwd: 'C:\\synthetic',
      title: '工作区',
      revision: 1,
      projectionEpoch: 1,
      createdAt: ISO,
      updatedAt: ISO,
      projection: { threads: [{
        id: 'th-1',
        title: '会话',
        parentId: null,
        dshSessionId: 's-1',
        dshSessionTitle: '会话',
        color: '#0f766e',
        createdAt: ISO,
        updatedAt: ISO,
        messages: [{ id: 'm-1', text: 'hi', kind: 'user', sourceSeq: 1, at: ISO }],
        pendingProcess: [],
        coverage: { ranges: [[1, 1]], historyComplete: false, textTruncated: false },
      }] },
      layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      materials: [],
      regions: [],
      annotations: [],
    }],
  }
}

it('isoDate 接受 Z 与 ±HH:mm 明确时区，且毫秒为 1–3 位', () => {
  const legal = [
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00.1Z',
    '2026-01-01T00:00:00.12Z',
    '2026-01-01T00:00:00.123Z',
    '2026-01-01T23:59:59+08:00',
    '2026-01-01T00:00:00-05:30',
    '2026-01-01T00:00:00+00:00',
    '2026-01-01T00:00:00.999-12:00',
    '2024-02-29T00:00:00.000Z',
    '2000-02-29T12:34:56Z',
    '2026-12-31T23:59:59.999Z',
  ]
  for (const value of legal) assert.equal(isoDate(value, 'at'), value, value)
})

it('isoDate 原样返回入参，不 trim、不转 Z、不补零', () => {
  const value = '2026-01-01T00:00:00.1+08:00'
  const result = isoDate(value, 'at')
  assert.equal(result, value)
  assert.equal(typeof result, 'string')
})

it('isoDate 拒绝日期-only、无时区、空白与平台宽松格式', () => {
  const illegal = [
    '2026-01-01',
    '2026-01',
    '2026-01-01T00:00:00',
    '2026-01-01T00:00:00.000',
    ' 2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z ',
    '2026-01-01T00:00:00.000Z\n',
    '2026-01-01 00:00:00.000Z',
    '2026/01/01T00:00:00.000Z',
    '2026-01-01t00:00:00.000z',
    '2026-01-01T00:00:00.000z',
    '2026-01-01T00:00Z',
    '2026-01-01T00:00:00.0000Z',
    '2026-01-01T00:00:00.Z',
    '2026-01-01T00:00:00,000Z',
    'Thu, 01 Jan 2026 00:00:00 GMT',
    '2026-01-01T00:00:00.000+0800',
    '2026-01-01T00:00:00.000UTC',
    '',
  ]
  for (const value of illegal) assert.throws(() => isoDate(value, 'at'), InputError, JSON.stringify(value))
})

it('isoDate 拒绝不真实日历日期（含闰年边界）', () => {
  const illegal = [
    '2026-02-29T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-13-10T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '2026-01-32T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z',
  ]
  for (const value of illegal) assert.throws(() => isoDate(value, 'at'), InputError, value)
})

it('isoDate 拒绝越界时分秒与时区偏移', () => {
  const illegal = [
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00.000+24:00',
    '2026-01-01T00:00:00.000+08:60',
    '2026-01-01T00:00:00.000-24:00',
    '2026-01-01T99:99:99Z',
  ]
  for (const value of illegal) assert.throws(() => isoDate(value, 'at'), InputError, value)
})

it('isoDate 拒绝非字符串时间值', () => {
  for (const value of [null, undefined, 1_760_000_000_000, new Date(ISO), { at: ISO }, [ISO], true]) {
    assert.throws(() => isoDate(value, 'at'), InputError, String(value))
  }
})

it('冻结校验：root/workspace/thread/message 时间存在即严格校验', () => {
  const cases = [
    ['root.updatedAt', document => { document.updatedAt = '2026-01-01' }],
    ['workspace.createdAt', document => { document.workspaces[0].createdAt = '2026-02-29T00:00:00Z' }],
    ['workspace.updatedAt', document => { document.workspaces[0].updatedAt = '2026-01-01T24:00:00Z' }],
    ['thread.createdAt', document => { document.workspaces[0].projection.threads[0].createdAt = '2026-01-01T00:00:00' }],
    ['thread.updatedAt', document => { document.workspaces[0].projection.threads[0].updatedAt = '2026/01/01T00:00:00Z' }],
    ['message.at', document => { document.workspaces[0].projection.threads[0].messages[0].at = '2026-01-01 00:00:00Z' }],
    ['material.importedAt', document => { document.workspaces[0].materials = [{ id: UUID, name: 'a.txt', text: 'x', bytes: 1, importedAt: '2026-01-01T00:00:00.000' }] }],
    ['idempotency.at', document => {
      document.idempotency = { [OP_ID]: { hash: 'a'.repeat(64), workspaceId: 'ws-1', revision: 1, at: 'x', response: { revision: 1, result: null } } }
    }],
  ]
  for (const [field, mutate] of cases) {
    const document = frozen()
    mutate(document)
    assert.throws(() => normalizeFrozenState(document), InputError, field)
  }
})

it('冻结校验：可选 thread/message 时间缺省仍兼容，合法时间原样保留', () => {
  const document = frozen()
  delete document.workspaces[0].projection.threads[0].createdAt
  delete document.workspaces[0].projection.threads[0].updatedAt
  delete document.workspaces[0].projection.threads[0].messages[0].at
  const { state } = normalizeFrozenState(document)
  const thread = state.workspaces[0].projection.threads[0]
  assert.equal(thread.createdAt, undefined)
  assert.equal(thread.updatedAt, undefined)
  assert.equal(thread.messages[0].at, undefined)

  const kept = frozen()
  kept.workspaces[0].projection.threads[0].messages[0].at = '2026-01-01T00:00:00.1+08:00'
  assert.equal(normalizeFrozenState(kept).state.workspaces[0].projection.threads[0].messages[0].at, '2026-01-01T00:00:00.1+08:00')
})

it('冻结校验：合法偏移时间不被改写，幂等/材料时间同样保留原串', () => {
  const document = frozen()
  document.updatedAt = '2026-01-01T00:00:00+08:00'
  document.idempotency = { [OP_ID]: { hash: 'b'.repeat(64), workspaceId: 'ws-1', revision: 1, at: '2026-01-01T00:00:00.123-05:30', response: { revision: 1, result: null } } }
  document.workspaces[0].materials = [{ id: UUID, name: 'a.txt', text: 'x', bytes: 1, importedAt: '2026-01-01T00:00:00Z' }]
  const { state } = normalizeFrozenState(document)
  assert.equal(state.updatedAt, '2026-01-01T00:00:00+08:00')
  assert.equal(state.idempotency[OP_ID].at, '2026-01-01T00:00:00.123-05:30')
  assert.equal(state.workspaces[0].materials[0].importedAt, '2026-01-01T00:00:00Z')
})

it('legacy 只读路径不收紧：宽松旧时间仍可读取，不升级、不改写', () => {
  const legacy = {
    version: 4,
    hiddenSessionIds: [],
    updatedAt: '2026-01-01',
    workspaces: [{
      id: 'ws-1',
      kind: 'dsh',
      cwd: 'C:\\legacy',
      title: '旧工作区',
      createdAt: 'x',
      updatedAt: '2026-01-01 00:00:00',
      threads: [{
        id: 'th-1',
        title: '旧会话',
        parentId: null,
        createdAt: 'legacy-time',
        updatedAt: 'legacy-time',
        messages: [{ id: 'm-1', text: 'hi', kind: 'user', sourceSeq: 1, at: '2026/01/01' }],
        pendingProcess: [],
      }],
    }],
  }
  const { state } = normalizeState(legacy)
  assert.equal(state.version, 4)
  assert.equal(state.workspaces[0].createdAt, 'x')
  assert.equal(state.workspaces[0].threads[0].messages[0].at, '2026/01/01')
})
