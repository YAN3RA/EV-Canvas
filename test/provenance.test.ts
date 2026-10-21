/**
 * S3-8 只读 why 的来源解释层契约测试。
 *
 * 这一层是「卡片来源」的判定边界，因此测试的重点不在顺路成功，而在**不许猜**：
 * 缺来源、占位、推断、成环、坏版本、重复 id 都必须得到明确结论，且**输出里
 * 不能夹带正文**。所有夹具都在内存里构造，不读真实用户数据。
 */

import { describe, expect, it } from 'vitest'

import { readProvenance, PROVENANCE_KIND, PROVENANCE_REJECT } from '@/server/provenance'

const ISO = '2026-10-22T02:00:00.000Z'

/** 一段只该出现在输入、绝不该出现在输出里的正文。 */
const SECRET_BODY = 'SECRET_BODY_MARKER_正文'
const SECRET_TITLE = 'SECRET_TITLE_MARKER_标题'

interface ThreadSpec {
  [key: string]: unknown;
}

/** 一条最小用户消息。 */
function userMessage(seq: number, text = SECRET_BODY): Record<string, unknown> {
  return { id: `m${seq}-${Math.random().toString(36).slice(2, 8)}`, kind: 'user', text, sourceSeq: seq, at: ISO }
}

/** 一个最小线程；默认恰好一条提问消息，因此卡片 id 为 `<id>:0`。 */
function thread(overrides: ThreadSpec = {}): Record<string, unknown> {
  return {
    id: 'thread-a',
    title: SECRET_TITLE,
    dshSessionId: 'session-abc',
    parentId: null,
    messages: [userMessage(0)],
    coverage: { ranges: [[0, 3]], historyComplete: true, textTruncated: false },
    ...overrides,
  }
}

/** 一个最小工作区（通过冻结 schema 的最小必需字段集）。 */
function workspace(overrides: ThreadSpec = {}): Record<string, unknown> {
  return {
    id: 'ws-1',
    kind: 'manual',
    createdAt: ISO,
    updatedAt: ISO,
    revision: 1,
    projectionEpoch: 1,
    projection: { threads: [thread()] },
    layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    materials: [],
    regions: [],
    annotations: [],
    ...overrides,
  }
}

/** 一份冻结完整文档。 */
function document(workspaces: unknown[] = [workspace()], overrides: ThreadSpec = {}): Record<string, unknown> {
  return {
    format: 'dsh-evcanvas',
    schemaVersion: 1,
    updatedAt: ISO,
    hiddenSessionIds: [],
    idempotency: {},
    idempotencyFloor: null,
    workspaces,
    ...overrides,
  }
}

/** 读一次并断言成功，返回 `data`。 */
function readOk(request: unknown) {
  const result = readProvenance(request)
  if (result.ok !== true) throw new Error(`预期成功但被拒绝：${result.code}`)
  return result.data
}

/** 读一次并断言拒绝，返回完整拒绝结果。 */
function readRejected(request: unknown) {
  const result = readProvenance(request)
  if (result.ok === true) throw new Error('预期拒绝但成功了')
  return result
}

describe('readProvenance · 来源基本事实', () => {
  it('用户提问卡片给出 sessionId、0 基提问序，并把 sourceSeq=0 保留为 0', () => {
    const data = readOk({ document: document(), workspaceId: 'ws-1', cardId: 'thread-a:0' })

    expect(data.kind).toBe(PROVENANCE_KIND)
    expect(data.workspaceId).toBe('ws-1')
    expect(data.card).toEqual({ cardId: 'thread-a:0', threadId: 'thread-a', userQuestionSeq: 0, kind: 'question' })
    expect(data.source.sessionId).toBe('session-abc')
    // 0 是合法事件序号。`|| null` 会把它吃掉，这条断言就是那道防线。
    expect(data.source.sourceSeq).toBe(0)
    expect(data.coverage.status).toBe('declared')
  })

  it('带前缀的会话 id 归一化后指向同一会话，但原文不被改写', () => {
    const doc = document([workspace({ projection: { threads: [thread({ dshSessionId: 'session-AbC' })] } })])
    const data = readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-a:0' })

    expect(data.source.sessionId).toBe('session-AbC')
    expect(data.source.sessionIdNormalized).toBe('abc')
  })

  it('线程级占位卡片：无原生会话、无事件序号，来源明确为 null 而不是省略', () => {
    const doc = document([workspace({
      projection: { threads: [thread({ messages: [], dshSessionId: null })] },
    })])
    const data = readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-a' })

    expect(data.card).toEqual({ cardId: 'thread-a', threadId: 'thread-a', userQuestionSeq: null, kind: 'thread-placeholder' })
    expect(data.source.sessionId).toBeNull()
    expect(data.source.sessionIdNormalized).toBeNull()
    expect(data.source.sourceSeq).toBeNull()
  })

  it('快照标识照实带出，供调用方把结论钉到具体那一份输入', () => {
    const doc = document([workspace({ revision: 7, projectionEpoch: 3 })])
    const data = readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-a:0' })

    expect(data.snapshot).toEqual({ updatedAt: ISO, revision: 7, projectionEpoch: 3 })
  })
})

describe('readProvenance · 父链', () => {
  it('无 anchor 也无种子边界时，跨线程父链明示为推断', () => {
    const parent = thread({ id: 'thread-p', messages: [userMessage(1), userMessage(2)] })
    const child = thread({ id: 'thread-c', parentId: 'thread-p', messages: [userMessage(3)] })
    const doc = document([workspace({ projection: { threads: [parent, child] } })])

    const data = readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-c:0' })

    expect(data.lineage.parentId).toBe('thread-p:1')
    expect(data.lineage.parentIdInferred).toBe(true)
    expect(data.lineage.threadParentId).toBe('thread-p')
    expect(data.lineage.threadParentInWorkspace).toBe(true)
    expect(data.lineage.ancestors.map(node => node.cardId)).toEqual(['thread-p:1', 'thread-p:0'])
    expect(data.lineage.cycle).toBe(false)
  })

  it('有持久化种子边界时，父链是从父线程继承来的，不标记推断', () => {
    const parent = thread({ id: 'thread-p', messages: [userMessage(2), userMessage(3), userMessage(9)] })
    const child = thread({ id: 'thread-c', parentId: 'thread-p', sourceSeedLength: 5, messages: [userMessage(11)] })
    const doc = document([workspace({ projection: { threads: [parent, child] } })])

    const data = readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-c:0' })

    // 严格低于种子边界 5 的最后一个父提问是 seq=3，也就是 `thread-p:1`。
    expect(data.lineage.parentId).toBe('thread-p:1')
    expect(data.lineage.parentIdInferred).toBe(false)
    expect(data.lineage.ancestors[0]).toEqual({ cardId: 'thread-p:1', parentId: 'thread-p:0', parentIdInferred: false })
  })

  it('父线程不在本工作区内时如实标记，不假装它存在', () => {
    const doc = document([workspace({ projection: { threads: [thread({ id: 'thread-c', parentId: 'thread-outside' })] } })])
    const data = readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-c:0' })

    expect(data.lineage.threadParentId).toBe('thread-outside')
    expect(data.lineage.threadParentInWorkspace).toBe(false)
    // 父线程不在快照里，因此没有可上溯的祖先——这里是空的，不是猜出来的。
    expect(data.lineage.ancestors).toEqual([])
  })

  it('父链成环：报告 cycle 并在闭环节点前停止，而不是伪造一条正常父链', () => {
    const a = thread({ id: 'thread-a', parentId: 'thread-b', messages: [userMessage(1)] })
    const b = thread({ id: 'thread-b', parentId: 'thread-a', messages: [userMessage(2)] })
    const doc = document([workspace({ projection: { threads: [a, b] } })])

    const data = readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-a:0' })

    expect(data.lineage.cycle).toBe(true)
    expect(data.lineage.ancestors.map(node => node.cardId)).toEqual(['thread-b:0'])
  })

  it('线程级占位卡片没有父链祖先', () => {
    const doc = document([workspace({ projection: { threads: [thread({ messages: [] })] } })])
    const data = readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-a' })

    expect(data.lineage.parentId).toBeNull()
    expect(data.lineage.ancestors).toEqual([])
    expect(data.lineage.cycle).toBe(false)
  })
})

describe('readProvenance · coverage', () => {
  it('快照没写 coverage 时报 unknown，不把归一化默认值冒充成一份声明', () => {
    const bare = thread({ messages: [userMessage(0)] })
    delete bare['coverage']
    const doc = document([workspace({ projection: { threads: [bare] } })])

    const data = readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-a:0' })

    expect(data.coverage).toEqual({
      status: 'unknown',
      ranges: [],
      historyComplete: null,
      textTruncated: null,
      nativeLogComplete: 'unknown',
    })
  })

  it('快照写了 coverage 时照实报告原标记，且原生日志完整性永为 unknown', () => {
    const doc = document([workspace({
      projection: {
        threads: [thread({
          coverage: { ranges: [[4, 9]], historyComplete: false, textTruncated: true },
        })],
      },
    })])

    const data = readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-a:0' })

    expect(data.coverage.status).toBe('declared')
    expect(data.coverage.ranges).toEqual([[4, 9]])
    expect(data.coverage.historyComplete).toBe(false)
    expect(data.coverage.textTruncated).toBe(true)
    // 关键区分：插件的投影自述**不是**原生日志完整性的证据。
    expect(data.coverage.nativeLogComplete).toBe('unknown')
  })

  it('historyComplete=true 也绝不升级成「原生日志完整」', () => {
    const data = readOk({ document: document(), workspaceId: 'ws-1', cardId: 'thread-a:0' })

    expect(data.coverage.historyComplete).toBe(true)
    expect(data.coverage.nativeLogComplete).toBe('unknown')
  })
})

describe('readProvenance · 输入严格性与明确拒绝', () => {
  it('非对象输入被拒绝', () => {
    expect(readRejected({ document: null, workspaceId: 'ws-1', cardId: 'thread-a:0' }).code).toBe(PROVENANCE_REJECT.notAnObject)
    expect(readRejected(null).code).toBe(PROVENANCE_REJECT.notAnObject)
  })

  it('workspace/card 必须显式指定，没有默认值', () => {
    const doc = document()
    expect(readRejected({ document: doc, workspaceId: '', cardId: 'thread-a:0' })).toMatchObject({
      code: PROVENANCE_REJECT.workspaceRequired,
      field: 'workspaceId',
    })
    expect(readRejected({ document: doc, workspaceId: 'ws-1' })).toMatchObject({
      code: PROVENANCE_REJECT.cardRequired,
      field: 'cardId',
    })
  })

  it('只接受当前冻结完整文档：旧版 v1–v4 被判 bad-format', () => {
    const legacy = { version: 4, hiddenSessionIds: [], workspaces: [] }
    expect(readRejected({ document: legacy, workspaceId: 'ws-1', cardId: 'thread-a:0' })).toMatchObject({
      code: PROVENANCE_REJECT.badFormat,
      field: 'format',
    })
  })

  it('单工作区信封与 projection 片段都不被当成冻结文档', () => {
    const envelope = { format: 'dsh-evcanvas', schemaVersion: 1, workspace: workspace() }
    expect(readRejected({ document: envelope, workspaceId: 'ws-1', cardId: 'thread-a:0' }).code).toBe(PROVENANCE_REJECT.invalidDocument)

    const fragment = { threads: [thread()], layout: { cards: {} } }
    expect(readRejected({ document: fragment, workspaceId: 'ws-1', cardId: 'thread-a:0' }).code).toBe(PROVENANCE_REJECT.badFormat)
  })

  it('错误的 schemaVersion 被判 bad-version', () => {
    const doc = document(undefined, { schemaVersion: 2 })
    expect(readRejected({ document: doc, workspaceId: 'ws-1', cardId: 'thread-a:0' })).toMatchObject({
      code: PROVENANCE_REJECT.badVersion,
      field: 'schemaVersion',
    })
  })

  it('重复的实体 id 被判 duplicate-id，而不是悄悄取一个', () => {
    const twice = document([workspace(), workspace()])
    expect(readRejected({ document: twice, workspaceId: 'ws-1', cardId: 'thread-a:0' }).code).toBe(PROVENANCE_REJECT.duplicateId)

    const dupThread = document([workspace({ projection: { threads: [thread(), thread()] } })])
    expect(readRejected({ document: dupThread, workspaceId: 'ws-1', cardId: 'thread-a:0' }).code).toBe(PROVENANCE_REJECT.duplicateId)
  })

  it('其它 schema 违规归为 invalid-document', () => {
    const badTime = document(undefined, { updatedAt: '2026/10/22 02:00' })
    expect(readRejected({ document: badTime, workspaceId: 'ws-1', cardId: 'thread-a:0' }).code).toBe(PROVENANCE_REJECT.invalidDocument)
  })

  it('快照里没有该 workspace 时明确报 workspace-not-found', () => {
    expect(readRejected({ document: document(), workspaceId: 'ws-missing', cardId: 'thread-a:0' })).toMatchObject({
      code: PROVENANCE_REJECT.workspaceNotFound,
      field: 'workspaceId',
    })
  })

  it('快照里没有该卡片时明确报 card-not-found，不退回最近一张卡', () => {
    expect(readRejected({ document: document(), workspaceId: 'ws-1', cardId: 'thread-a:9' })).toMatchObject({
      code: PROVENANCE_REJECT.cardNotFound,
      field: 'cardId',
    })
    expect(readRejected({ document: document(), workspaceId: 'ws-1', cardId: 'thread-nope:0' }).code).toBe(PROVENANCE_REJECT.cardNotFound)
  })

  it('同一份快照里的两个工作区互不串味', () => {
    const other = workspace({
      id: 'ws-2',
      projection: { threads: [thread({ id: 'thread-z', dshSessionId: 'session-zzz' })] },
    })
    const doc = document([workspace(), other])

    // 拿 ws-1 的卡片去问 ws-2：必须拒绝，绝不能解释到另一张卡上。
    expect(readRejected({ document: doc, workspaceId: 'ws-2', cardId: 'thread-a:0' }).code).toBe(PROVENANCE_REJECT.cardNotFound)
    // 反过来同样成立。
    expect(readRejected({ document: doc, workspaceId: 'ws-1', cardId: 'thread-z:0' }).code).toBe(PROVENANCE_REJECT.cardNotFound)
    // 各自的卡片各自解释。
    expect(readOk({ document: doc, workspaceId: 'ws-2', cardId: 'thread-z:0' }).source.sessionId).toBe('session-zzz')
  })
})

describe('readProvenance · 不泄露正文', () => {
  it('成功结果只含元数据，不含标题、正文或工具内容', () => {
    const withTools = thread({
      pendingProcess: [{ callId: 'c1', name: 'SECRET_TOOL_MARKER', arguments: 'SECRET_ARGS_MARKER', result: 'SECRET_RESULT_MARKER' }],
    })
    const doc = document([workspace({ projection: { threads: [withTools] } })])

    const serialized = JSON.stringify(readOk({ document: doc, workspaceId: 'ws-1', cardId: 'thread-a:0' }))

    expect(serialized).not.toContain(SECRET_BODY)
    expect(serialized).not.toContain(SECRET_TITLE)
    expect(serialized).not.toContain('SECRET_TOOL_MARKER')
    expect(serialized).not.toContain('SECRET_ARGS_MARKER')
    expect(serialized).not.toContain('SECRET_RESULT_MARKER')
  })

  it('拒绝结果也不回显正文或标识原文', () => {
    const badVersion = document([workspace()], { schemaVersion: 99 })
    badVersion['title'] = SECRET_TITLE
    const serialized = JSON.stringify(readRejected({ document: badVersion, workspaceId: 'ws-1', cardId: 'thread-a:0' }))

    expect(serialized).not.toContain(SECRET_BODY)
    expect(serialized).not.toContain(SECRET_TITLE)
    // 拒绝只给码与字段名。
    expect(serialized).toBe(JSON.stringify({ ok: false, code: PROVENANCE_REJECT.badVersion, field: 'schemaVersion' }))
  })
})