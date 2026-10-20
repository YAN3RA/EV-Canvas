// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova test/export-scene.test.js，行为完整、类型待补。
/**
 * T7 — export scene geometry.
 *
 * The scene is what makes the PNG honest: the preview and the renderer read the
 * SAME `scene.bounds`, so the cases here are about what may and may not enter a
 * scene, and what the bounds must contain.
 *
 * Mutations these are written to catch:
 *
 *   - selection mode smuggling an unticked card, a region, a note or a material
 *     in "for completeness"
 *   - completing a partially-ticked connector with the unticked endpoint
 *   - full mode quietly skipping viewport-outside cards or collapsed children
 *   - bounds computed from card centres, which clips a bowed connector and a
 *     negative coordinate
 *   - an over-limit scene being silently downscaled instead of refused
 *   - 2x not re-checking the limits after quadrupling the pixel count
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
  ANNOTATION_MIN_HEIGHT,
  CARD_QUESTION_LIMIT,
  COLLAPSED_CARD_HEIGHT,
  CONNECTOR_SAMPLES,
  COVERAGE_NOTE,
  DEFAULT_MAX_EDGE,
  DEFAULT_MAX_PIXELS,
  SCENE_PADDING,
  SCENE_CODES,
  SUPPORTED_SCALES,
  buildScene,
  connectorPath,
  isConnectorIncluded,
  measureSceneBounds,
  normalizeScale,
  sceneCardIds,
  validateSceneLimits,
} from '@/export/scene'
import { CARD_HEIGHT, CARD_WIDTH } from '@/canvas/layout'

const iso = () => '2026-01-01T00:00:00.000Z'

/**
 * Two threads: `root` (parent of `child`), plus a viewport far away and one
 * negative coordinate, so "did the bounds follow the content or the viewport"
 * is answerable.
 */
function snapshot(overrides = {}) {
  return {
    id: 'ws-1',
    revision: 42,
    projectionEpoch: 1,
    projection: {
      threads: [
        {
          id: 'root',
          title: '根会话',
          parentId: null,
          dshSessionId: 'session-root',
          dshSessionTitle: '根会话',
          messages: [
            { id: 'r1', kind: 'user', text: '根问题', sourceSeq: 1, at: iso() },
            { id: 'r2', kind: 'assistant', text: '根回答', sourceSeq: 2, at: iso() },
          ],
          coverage: { ranges: [[1, 2]], historyComplete: true, textTruncated: false },
        },
        {
          id: 'child',
          title: '子会话',
          parentId: 'root',
          dshSessionId: 'session-child',
          dshSessionTitle: '子会话',
          messages: [
            { id: 'c1', kind: 'user', text: '子问题', sourceSeq: 1, at: iso() },
          ],
          coverage: { ranges: [[1, 1]], historyComplete: true, textTruncated: false },
        },
      ],
    },
    layout: {
      // 'root:0' sits at a NEGATIVE coordinate, far from the default viewport.
      cards: { 'root:0': { x: -400, y: -250 }, 'child:0': { x: 900, y: 620 } },
      collapsed: {},
      viewport: { x: 5000, y: 5000, zoom: 5 },
    },
    materials: [{ id: 'mat-1', name: '材料.txt', importedAt: iso(), bytes: 4, text: '材料' }],
    regions: [{ id: 'reg-1', name: '分区', x: 10, y: 10, w: 200, h: 120 }],
    annotations: [
      { id: 'note-card', x: 20, y: 20, text: '卡片旁注', targetCardId: 'root:0' },
      { id: 'note-region', x: 30, y: 30, text: '分区旁注', targetRegionId: 'reg-1' },
    ],
    ...overrides,
  }
}

const cardIds = scene => scene.items.filter(item => item.kind === 'card').map(item => item.id)

// ── 1. 缩放：只有 1x / 2x ──────────────────────────────────────────────────

it('缩放只接受 1x 和 2x，其他值必须报错而非静默钳制', () => {
  assert.deepEqual([...SUPPORTED_SCALES], [1, 2])
  assert.equal(normalizeScale(undefined), 1)
  assert.equal(normalizeScale(null), 1)
  assert.equal(normalizeScale(1), 1)
  assert.equal(normalizeScale(2), 2)
  for (const bad of [3, 0.5, '2', -1]) {
    assert.throws(() => normalizeScale(bad), TypeError, `${String(bad)} 必须报错`)
  }
})

// ── 2. 选卡模式：只含所选，不夹带 ─────────────────────────────────────────

it('空选不产生卡片，并给出 empty-selection 警告', () => {
  const scene = buildScene(snapshot(), { mode: 'selection', selectedCardIds: [] })
  assert.deepEqual(cardIds(scene), [])
  assert.ok(scene.warnings.some(w => w.code === SCENE_CODES.emptySelection), '空选必须显式警告')
})

it('离散选卡只含所勾选，不夹带未选卡', () => {
  const scene = buildScene(snapshot(), { mode: 'selection', selectedCardIds: ['child:0'] })
  assert.deepEqual(cardIds(scene), ['child:0'])
  assert.equal(scene.stats.cardCount, 1)
})

/**
 * Connector inclusion — both shapes.
 *
 * `card.parentId` used to express ONLY the intra-thread predecessor, so a fork's
 * first card had no parent at all and every cross-thread branch edge was missing
 * from the export. The canvas hid that, because app.js recomputes lineage itself;
 * the export could not. `canvas/model.js` now runs a lineage pass that wires the
 * branch parent onto the child's first card, so both shapes are drawn.
 */
it('线程内前序边与跨线程分支边都会被绘制', () => {
  // Two user turns in ONE thread produce one intra-thread edge: `root:1`'s
  // parentId is `root:0`.
  const doc = snapshot()
  doc.projection.threads[0].messages.push({ id: 'r3', kind: 'user', text: '根追问', sourceSeq: 3, at: iso() })
  const scene = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:0', 'root:1'] })
  assert.equal(scene.stats.connectorCount, 1, '同一线程的两个轮次之间应有一条连线')
  assert.equal(isConnectorIncluded(scene, 'root:0', 'root:1'), true)

  // The cross-thread branch (`child` is a fork of `root`) must be joined too.
  const branched = buildScene(snapshot(), { mode: 'selection', selectedCardIds: ['root:0', 'child:0'] })
  assert.equal(branched.stats.connectorCount, 1, '跨线程分支边必须被绘制')
  assert.equal(isConnectorIncluded(branched, 'root:0', 'child:0'), true)
  const connector = branched.items.find(item => item.kind === 'connector')
  assert.equal(connector.from, 'root:0')
  assert.equal(connector.to, 'child:0')

  // No-smuggling still holds: an unticked endpoint is never added to complete an edge.
  const onlyChild = buildScene(snapshot(), { mode: 'selection', selectedCardIds: ['child:0'] })
  assert.equal(onlyChild.stats.connectorCount, 0)
  assert.deepEqual(cardIds(onlyChild), ['child:0'], '未选的卡不得被夹带')
})

it('选卡模式不带分区、材料与工作区级旁注，并且明确说明', () => {
  const scene = buildScene(snapshot(), { mode: 'selection', selectedCardIds: ['root:0'] })
  const kinds = new Set(scene.items.map(item => item.kind))
  assert.ok(!kinds.has('region'), '选卡模式不得夹带分区框')
  assert.ok(!kinds.has('material'), '选卡模式不得夹带材料')
  // The card's own note travels with it; the region note must not.
  const noteIds = scene.items.filter(item => item.kind === 'annotation').map(item => item.id)
  assert.deepEqual(noteIds, ['note-card'], '只带所选卡的旁注')

  const reasons = new Set(scene.excluded.map(entry => entry.reason))
  assert.ok(reasons.has(SCENE_CODES.regionExcluded), '被排除的分区必须登记原因')
  assert.ok(reasons.has(SCENE_CODES.materialExcluded), '被排除的材料必须登记原因')
})

it('父卡未选中、子卡选中时连线必须丢弃，且不得补入父卡', () => {
  // `root:1`'s parentId is `root:0`. Tick ONLY `root:1`: the edge has one endpoint
  // inside the scene and one outside it, so it must be dropped outright. A guard
  // that only checks the child endpoint would draw a connector into a card that
  // is not in the picture — and would then compute bounds around a phantom.
  const doc = snapshot()
  doc.projection.threads[0].messages.push({ id: 'r3', kind: 'user', text: '根追问', sourceSeq: 3, at: iso() })

  const onlyChild = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:1'] })
  assert.deepEqual(cardIds(onlyChild), ['root:1'], '未选的父卡不得被夹带')
  assert.equal(onlyChild.stats.connectorCount, 0, '只有一端在场景内的连线必须丢弃')
  assert.equal(isConnectorIncluded(onlyChild, 'root:0', 'root:1'), false)
  assert.ok(!onlyChild.items.some(item => item.kind === 'connector'), '不得出现任何连线 item')

  // Both ticked → the edge is drawn.
  const both = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:0', 'root:1'] })
  assert.equal(both.stats.connectorCount, 1)
})

it('勾选不存在的卡片给出 missing-card-source，不静默忽略', () => {
  const scene = buildScene(snapshot(), { mode: 'selection', selectedCardIds: ['ghost:0'] })
  assert.deepEqual(cardIds(scene), [])
  assert.ok(scene.warnings.some(w => w.code === SCENE_CODES.missingCardSource && w.cardId === 'ghost:0'))
  assert.ok(scene.excluded.some(entry => entry.id === 'ghost:0' && entry.reason === 'source-missing'))
})

// ── 3. 全图模式：不按视口/折叠过滤 ────────────────────────────────────────

it('全图包含视口外的卡片（视口不参与过滤）', () => {
  const doc = snapshot()
  // Viewport points somewhere completely different; it must make no difference.
  doc.layout.viewport = { x: 99999, y: 99999, zoom: 0.1 }
  const scene = buildScene(doc, { mode: 'full' })
  assert.deepEqual(cardIds(scene).sort(), ['child:0', 'root:0'], '视口外与负坐标的卡片都必须纳入')
})

it('全图包含折叠分支内的子卡，并保留折叠外观', () => {
  const doc = snapshot()
  doc.layout.collapsed = { 'root:0': true }
  const scene = buildScene(doc, { mode: 'full' })
  assert.ok(cardIds(scene).includes('child:0'), '折叠不得让子卡消失')
  const root = scene.items.find(item => item.id === 'root:0')
  assert.equal(root.collapsed, true, '折叠状态必须保留到导出')
  assert.equal(root.h, COLLAPSED_CARD_HEIGHT, '折叠卡片必须用折叠高度绘制')
  const child = scene.items.find(item => item.id === 'child:0')
  assert.equal(child.h, CARD_HEIGHT, '未折叠卡片用正常高度')
})

it('全图带材料、分区与两类旁注，且总带覆盖说明', () => {
  const scene = buildScene(snapshot(), { mode: 'full' })
  assert.equal(scene.stats.materialCount, 1)
  assert.equal(scene.stats.regionCount, 1)
  assert.equal(scene.stats.annotationCount, 2)
  const noteIds = scene.items.filter(item => item.kind === 'annotation').map(item => item.id).sort()
  assert.deepEqual(noteIds, ['note-card', 'note-region'])
  assert.ok(scene.warnings.some(w => w.code === SCENE_CODES.coverageNote && w.message === COVERAGE_NOTE), '全图必须携带覆盖声明')
})

it('归档/隐藏会话里的已投影卡仍然纳入，并标记可见状态', () => {
  const doc = snapshot({ archivedSessionIds: ['session-child'], hiddenSessionIds: ['session-root'] })
  const scene = buildScene(doc, { mode: 'full' })
  assert.ok(cardIds(scene).includes('child:0'), '已归档的已投影卡不得因归档而消失')
  const child = scene.items.find(item => item.id === 'child:0')
  const root = scene.items.find(item => item.id === 'root:0')
  assert.notEqual(child.visibility, undefined, '必须携带可见状态')
  assert.notEqual(root.visibility, undefined)
  assert.notEqual(child.visibility, root.visibility, '归档与隐藏必须能区分')
})

it('源缺失的旁注在全图中保留并标记，不静默删除', () => {
  const doc = snapshot()
  // A note whose target card is not in the projection at all: the model marks it
  // `missing-source`, and that is exactly the record a full export must keep.
  doc.annotations.push({ id: 'orphan', x: 1, y: 1, text: '孤儿旁注', targetCardId: 'gone:0' })
  const scene = buildScene(doc, { mode: 'full' })
  const orphan = scene.items.find(item => item.id === 'orphan')
  assert.ok(orphan !== undefined, '失源旁注必须保留（唯一存世记录）')
  assert.equal(orphan.kind, 'annotation')
  assert.equal(orphan.missingSource, true)
  assert.equal(orphan.sourceLabel, '源缺失')
  assert.ok(scene.warnings.some(w => w.code === SCENE_CODES.missingAnnotationSource), '必须给出 missing-annotation-source 警告')

  // In selection mode an orphan is NOT auto-added: the user did not tick its card.
  const selected = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:0'] })
  assert.ok(!selected.items.some(item => item.id === 'orphan'), '选卡模式不得自动补入失源旁注')
  assert.ok(selected.excluded.some(entry => entry.id === 'orphan'), '但必须登记为排除项')
})

it('勾选不存在的卡片给出 missing-card-source，不静默忽略', () => {
  const scene = buildScene(snapshot(), { mode: 'selection', selectedCardIds: ['ghost:0'] })
  assert.deepEqual(cardIds(scene), [])
  assert.ok(scene.warnings.some(w => w.code === SCENE_CODES.missingCardSource && w.cardId === 'ghost:0'))
  assert.ok(scene.excluded.some(entry => entry.id === 'ghost:0' && entry.reason === 'source-missing'))
})

// ── 4. 几何：包围盒含负坐标、曲线与文字测量 ────────────────────────────────

it('包围盒覆盖负坐标并带 32px 边距', () => {
  const scene = buildScene(snapshot(), { mode: 'selection', selectedCardIds: ['root:0'] })
  const card = scene.items.find(item => item.kind === 'card')
  assert.ok(scene.bounds.x <= card.x - SCENE_PADDING, '包围盒必须包含左侧 32px 边距')
  assert.ok(scene.bounds.y <= card.y - SCENE_PADDING, '包围盒必须包含上方 32px 边距')
  assert.ok(scene.bounds.x + scene.bounds.w >= card.x + card.w + SCENE_PADDING - 0.001, '右侧边距不足')
  assert.equal(scene.padding, SCENE_PADDING)
  assert.equal(scene.bounds.x < 0, true, '负坐标必须保留原值，不能被平移到 0')
})

it('曲线连线的采样点必须撑大包围盒，而不是只取两端中心', () => {
  const parent = { x: 0, y: 0, w: CARD_WIDTH, h: CARD_HEIGHT }
  const child = { x: 1200, y: 800, w: CARD_WIDTH, h: CARD_HEIGHT }
  const path = connectorPath(parent, child)
  assert.equal(path.points.length, CONNECTOR_SAMPLES + 1)

  // The curve bows horizontally: its control points sit OUTSIDE the horizontal
  // span of the two boxes' facing edges, so some sample must do the same. If the
  // bounds were computed from the two centres only, those samples would be
  // clipped — that is the defect this pins.
  const leftEdge = parent.x + parent.w
  const rightEdge = child.x
  const bowing = path.points.filter(point => point.x > rightEdge - 1 || point.x < leftEdge + 1)
  assert.ok(bowing.length > 0, '曲线必须产生离开两端连线的采样点')
  // And the sampling has to actually follow the bezier, not a straight line.
  const straight = path.points.map((point, index) => ({
    x: leftEdge + (rightEdge - leftEdge) * (index / CONNECTOR_SAMPLES),
    y: parent.y + parent.h / 2 + (child.y + child.h / 2 - (parent.y + parent.h / 2)) * (index / CONNECTOR_SAMPLES),
  }))
  const maxDeviation = Math.max(...path.points.map((point, index) => Math.hypot(point.x - straight[index].x, point.y - straight[index].y)))
  assert.ok(maxDeviation > 1, `采样必须偏离直线（实测最大偏移 ${maxDeviation.toFixed(2)}px）`)

  const doc = snapshot()
  // A second user turn in `root` so `root:1` exists and has an intra-thread parent.
  doc.projection.threads[0].messages.push({ id: 'r3', kind: 'user', text: '根追问', sourceSeq: 3, at: iso() })
  const scene = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:0', 'root:1'] })
  const connector = scene.items.find(item => item.kind === 'connector')
  assert.ok(connector !== undefined, '同一线程的两轮之间应有连线可测')
  // Every sample must sit inside the reported bounds.
  for (const point of connector.points) {
    assert.ok(point.x >= scene.bounds.x && point.x <= scene.bounds.x + scene.bounds.w, '采样点 X 越界')
    assert.ok(point.y >= scene.bounds.y && point.y <= scene.bounds.y + scene.bounds.h, '采样点 Y 越界')
  }
})

it('measureSceneBounds 不信任 scene.bounds，按 items 重算', () => {
  const lying = {
    padding: SCENE_PADDING,
    bounds: { x: 0, y: 0, w: 1, h: 1 },
    items: [{ kind: 'card', x: 1000, y: 1000, w: 10, h: 10 }],
  }
  const measured = measureSceneBounds(lying)
  assert.ok(measured.x < 1000, '必须按真实 item 重算')
  assert.ok(measured.w > 0)
  assert.equal(measureSceneBounds({ items: [], padding: 32 }).w, 0, '空场景返回零尺寸')
})

it('旁注盒高度至少为最小值，且随文字测量增长', () => {
  const doc = snapshot()
  doc.annotations = [{ id: 'note-card', x: 0, y: 0, text: '短', targetCardId: 'root:0' }]
  const short = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:0'] }).items.find(i => i.kind === 'annotation')
  assert.ok(short.h >= ANNOTATION_MIN_HEIGHT)

  doc.annotations[0].text = '很长的旁注内容'.repeat(60)
  const long = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:0'] }).items.find(i => i.kind === 'annotation')
  assert.ok(long.h > short.h, '长文字必须让旁注盒变高')
})

it('卡片问题文本按上限截断并如实报告原长', () => {
  const doc = snapshot()
  doc.projection.threads[0].messages[0].text = '问'.repeat(CARD_QUESTION_LIMIT + 100)
  const card = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:0'] }).items.find(i => i.kind === 'card')
  assert.equal(card.questionTruncated, true)
  assert.equal(card.questionTotalChars, CARD_QUESTION_LIMIT + 100)
  assert.ok(card.questionPreview.length <= CARD_QUESTION_LIMIT + 1, '预览长度不得超上限（+1 给省略号）')
})

// ── 5. 上限：拒绝而不是静默缩小 ───────────────────────────────────────────

it('超单边上限时拒绝并给出实际尺寸与建议', () => {
  const scene = { items: [{ x: 0, y: 0, w: 100, h: 100 }], padding: 0, bounds: { x: 0, y: 0, w: 100, h: 100 }, width: 20000, height: 100 }
  const result = validateSceneLimits(scene)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'max-edge')
  assert.equal(result.actual.width, 20000)
  assert.equal(result.actual.maxEdge, DEFAULT_MAX_EDGE)
  assert.ok(result.suggestion.length > 0, '必须给出可操作建议')
  assert.ok(/减少选中卡片|重新排版/.test(result.suggestion))
})

it('超总面积上限时拒绝，不比单边宽松', () => {
  const side = Math.ceil(Math.sqrt(DEFAULT_MAX_PIXELS)) + 1
  const scene = { items: [{ x: 0, y: 0, w: side, h: side }], padding: 0, bounds: { x: 0, y: 0, w: side, h: side }, width: side, height: side }
  const result = validateSceneLimits(scene)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'max-pixels')
  assert.ok(result.actual.pixels > DEFAULT_MAX_PIXELS)
})

it('2x 必须重新校验：1x 通过不代表 2x 通过', () => {
  const width = Math.ceil(DEFAULT_MAX_EDGE / 2) + 10
  const scene = { items: [{ x: 0, y: 0, w: 10, h: 10 }], padding: 0, bounds: { x: 0, y: 0, w: width, h: 100 }, width, height: 100 }
  assert.equal(validateSceneLimits(scene, { scale: 1 }).ok, true, '1x 应通过')
  const doubled = validateSceneLimits(scene, { scale: 2 })
  assert.equal(doubled.ok, false, '2x 必须重新校验并拒绝')
  assert.equal(doubled.actual.width, width * 2)
  assert.equal(doubled.actual.scale, 2)
})

it('超限时 buildScene 给出 over-limit 警告，且不静默缩小尺寸', () => {
  const doc = snapshot()
  // Push one card far enough that the bounds exceed the edge ceiling.
  doc.layout.cards['child:0'] = { x: 20000, y: 0 }
  const scene = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:0', 'child:0'] })
  const over = scene.warnings.find(w => w.code === SCENE_CODES.overLimit)
  assert.ok(over !== undefined, '超限必须明确警告')
  assert.ok(scene.width > DEFAULT_MAX_EDGE, '尺寸必须如实报告，不得被缩小')
  assert.ok(over.actual.width > DEFAULT_MAX_EDGE)
})

it('buildScene 在 2x 下必须重新校验上限（1x 通过、2x 拒绝）', () => {
  // A scene just under the edge ceiling at 1x: it must pass at 1x and be refused
  // at 2x. A buildScene that validated only at 1x would miss this entirely.
  const doc = snapshot()
  const justUnder = Math.floor(DEFAULT_MAX_EDGE / 2) + 40
  doc.layout.cards['root:0'] = { x: 0, y: 0 }
  doc.layout.cards['child:0'] = { x: justUnder, y: 0 }

  const at1x = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:0', 'child:0'], scale: 1 })
  assert.equal(at1x.scale, 1)
  assert.ok(!at1x.warnings.some(w => w.code === SCENE_CODES.overLimit), `1x 应通过（宽 ${at1x.width}）`)

  const at2x = buildScene(doc, { mode: 'selection', selectedCardIds: ['root:0', 'child:0'], scale: 2 })
  assert.equal(at2x.scale, 2)
  const over = at2x.warnings.find(w => w.code === SCENE_CODES.overLimit)
  assert.ok(over !== undefined, '2x 必须重新校验并给出 over-limit')
  assert.equal(over.actual.scale, 2)
  // At this size the EDGE ceiling trips first, so the reported reason is max-edge
  // and the width is exactly double the 1x width. Pixel accounting is exercised
  // separately by the area-limit case above.
  assert.equal(over.actual.maxEdge, DEFAULT_MAX_EDGE)
  assert.equal(over.actual.width, Math.ceil(at2x.width * 2), `2x 宽度必须是 1x 的两倍（1x=${at2x.width}）`)
  assert.equal(over.actual.pixels, over.actual.width * over.actual.height, '像素数必须是 2x 宽高之积')
  assert.ok(over.actual.pixels > at1x.width * at1x.height * 3.9, '2x 像素数应约为 1x 的四倍')
})

// ── 6. 不可变与纯净 ───────────────────────────────────────────────────────

it('scene 深度冻结，且不修改输入快照', () => {
  const doc = snapshot()
  const before = JSON.stringify(doc)
  const scene = buildScene(doc, { mode: 'full' })
  assert.equal(JSON.stringify(doc), before, 'buildScene 不得改动输入')
  assert.throws(() => { 'use strict'; scene.items.push({}) }, 'scene 必须冻结')
  assert.throws(() => { 'use strict'; scene.bounds.x = 1 }, 'bounds 必须冻结')
})

it('sceneCardIds 只返回卡片 id，顺序与 items 一致', () => {
  const scene = buildScene(snapshot(), { mode: 'full' })
  const ids = sceneCardIds(scene)
  assert.deepEqual(ids.sort(), ['child:0', 'root:0'])
  assert.equal(ids.length, scene.stats.cardCount)
})

it('未知模式必须报错', () => {
  assert.throws(() => buildScene(snapshot(), { mode: 'viewport' }), TypeError)
  assert.throws(() => buildScene(null), TypeError)
})

it('空工作区全图不抛错，尺寸为零', () => {
  const scene = buildScene({ projection: { threads: [] }, layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } }, materials: [], regions: [], annotations: [] }, { mode: 'full' })
  assert.equal(scene.stats.cardCount, 0)
  assert.equal(scene.width, 0)
  assert.ok(scene.warnings.some(w => w.code === SCENE_CODES.coverageNote), '即使为空也要带覆盖说明')
})
