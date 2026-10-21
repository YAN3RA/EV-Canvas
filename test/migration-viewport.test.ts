// @ts-nocheck -- 与 migration.test.ts 同风格：迁移自旧版，断言用 node:assert
/**
 * S1-8 视口状态迁移：旧版 `workspace.layout.viewport` 必须被保留。
 *
 * 故障背景（2026-10-21 实测发现）：`buildMigrationPlan` 的 `WS_FIELDS` 只收
 * `id/kind/dshWorkspaceId/cwd/title/createdAt/updatedAt`，**不含 `layout`**，
 * 而随后又把 `layout` 无条件重置为 `{ cards:{}, collapsed:{}, viewport:{x:0,y:0,zoom:1} }`。
 * 结果旧版用户真实视口被抹掉，迁移后画布跳回原点。
 *
 * 真实数据佐证（迁移前测得的旧版 `~/.dsh/synapnova/workspaces.json`）：
 *   'dsh-synapnova' viewport=(-4604.1, 144.7, 1)  非默认
 *   'agent-opt'     viewport=(-9383.5, -122.3, 1) 非默认
 * 而 vNext 里这两个工作区迁移后都是 (0,0,1)。
 *
 * 注意卡片坐标不在此列：旧版坐标来自 `thread.position`（已被单独迁移），
 * `layout.cards` 是浏览器布局快照，由 `browserLayout` 显式提供才合并。
 * 本文件只锁定**视口**这一项，避免顺手改错坐标来源。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { buildMigrationPlan } from '@/shared/migration'
import { normalizeFrozenState } from '@/shared/schema'

const ISO = '2026-10-17T10:00:00.000Z'

/** 旧版工作区，可注入 layout.viewport。 */
function legacy(viewport) {
  return {
    version: 4,
    updatedAt: ISO,
    hiddenSessionIds: [],
    workspaces: [
      {
        id: 'workspace-1',
        kind: 'dsh',
        dshWorkspaceId: 'host-1',
        cwd: 'C:\\work',
        title: '工作区',
        createdAt: ISO,
        updatedAt: ISO,
        ...(viewport === undefined ? {} : { layout: { cards: {}, collapsed: {}, viewport } }),
        threads: [
          {
            id: 'thread-1',
            title: '会话',
            parentId: null,
            sourceParentSessionId: null,
            sourceSeedLength: 0,
            dshSessionId: 'session-1',
            dshSessionTitle: '会话',
            color: '#0f766e',
            position: { x: -80, y: 42 },
            createdAt: ISO,
            updatedAt: ISO,
            messages: [{ id: 'message-1', text: '问题', kind: 'user', sourceSeq: 3, at: ISO }],
            pendingProcess: [],
          },
        ],
      },
    ],
  }
}

describe('视口迁移：旧版 viewport 必须保留', () => {
  it('非默认视口被原样带入（这是本次修复的核心）', () => {
    const viewport = { x: -4604.104187011719, y: 144.6666717529297, zoom: 1 }
    const plan = buildMigrationPlan({ legacyState: legacy(viewport) })
    assert.equal(plan.canCommit, true)
    assert.deepEqual(plan.document.workspaces[0].layout.viewport, viewport)
  })

  it('缩放不为 1 时同样保留', () => {
    const viewport = { x: 120.5, y: -33.25, zoom: 0.37 }
    const plan = buildMigrationPlan({ legacyState: legacy(viewport) })
    assert.deepEqual(plan.document.workspaces[0].layout.viewport, viewport)
  })

  it('旧版没有 layout 时回落到默认视口，不抛错', () => {
    const plan = buildMigrationPlan({ legacyState: legacy(undefined) })
    assert.equal(plan.canCommit, true)
    assert.deepEqual(plan.document.workspaces[0].layout.viewport, { x: 0, y: 0, zoom: 1 })
  })

  it('旧版 viewport 缺字段时逐字段回落，不因缺 zoom 而丢整个视口', () => {
    const plan = buildMigrationPlan({ legacyState: legacy({ x: 10, y: 20 }) })
    assert.deepEqual(plan.document.workspaces[0].layout.viewport, { x: 10, y: 20, zoom: 1 })
  })

  it('非法 zoom（<=0）只回落 zoom，保留可信的 x/y', () => {
    // 逐字段回落的意义就在这里：旧版 zoom 坏掉不代表 x/y 也坏。
    // 整块丢弃会把还能救的数据一起扔了。
    const plan = buildMigrationPlan({ legacyState: legacy({ x: 5, y: 6, zoom: 0 }) })
    assert.equal(plan.canCommit, true)
    assert.deepEqual(plan.document.workspaces[0].layout.viewport, { x: 5, y: 6, zoom: 1 })
  })

  it('x/y 非有限数时各自回落，不污染整个视口', () => {
    const plan = buildMigrationPlan({ legacyState: legacy({ x: Number.NaN, y: 6, zoom: 2 }) })
    assert.deepEqual(plan.document.workspaces[0].layout.viewport, { x: 0, y: 6, zoom: 2 })
  })

  it('迁移结果仍能通过冻结态归一化（视口不改坏其它不变量）', () => {
    const viewport = { x: -100, y: 200, zoom: 1.5 }
    const plan = buildMigrationPlan({ legacyState: legacy(viewport) })
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeFrozenState(plan.document).state)), plan.document)
  })

  it('卡片坐标仍来自 thread.position，不被 layout.cards 污染', () => {
    const plan = buildMigrationPlan({
      legacyState: legacy({ x: 1, y: 2, zoom: 1 }),
    })
    assert.deepEqual(plan.document.workspaces[0].layout.cards['thread-1'], { x: -80, y: 42 })
  })
})
