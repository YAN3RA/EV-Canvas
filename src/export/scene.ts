// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova@3fd1d00 export/scene.js，行为完整、类型标注待补。
// 来源: dsh-synapnova@3fd1d00 export/scene.js

/**
 * Export scene (T7) — pure geometry for the PNG exporter.
 *
 * Pure module: no DOM, no Canvas API, no Store, no IO, no npm dependency. The
 * input is one read-only workspace snapshot; the output is a deep, immutable
 * description of everything a renderer needs to draw and everything a preview
 * needs to report. Nothing here reads the mounted DOM, the live camera, the
 * scroll offset or `document.*`, which is what makes the picture independent of
 * what happens to be on screen right now.
 *
 * Why a scene instead of drawing while walking the model: the same scene feeds
 * BOTH the preview (bounds, card counts, pixel size, exclusions) and the actual
 * Canvas2D render. A preview that measured one thing while the renderer drew
 * another is exactly the defect the acceptance list forbids, so both read the
 * same `scene.bounds`.
 *
 * Two modes, deliberately different in what they may include:
 *
 * - `selection` — ONLY the explicitly ticked cards. A connector is drawn only
 *   when BOTH endpoints are ticked; a partially ticked edge is dropped, never
 *   completed with an unticked card. Notes travel with their selected card.
 *   Workspace regions (free-standing boxes) and workspace-level notes are NOT
 *   carried, and are listed in `excluded` with a stable reason code.
 * - `full` — EVERY projected card, including cards outside the current viewport
 *   and cards hidden behind a collapsed branch, plus materials, regions and
 *   notes. Cards are never filtered by the current branch/visibility filter: the
 *   model already carries the projection, and a UI filter is not a projection.
 *
 * What neither mode does: invent un-projected history. A snapshot that never
 * received the native backfill is exported as-is, and `COVERAGE_NOTE` stays in
 * the warnings so the preview cannot promise more than it has.
 */

import { NATURAL_ORIGIN, buildCanvasModel, cardsInsideRegion, getResolvedPosition } from '@/canvas/model'
import { CARD_HEIGHT, CARD_WIDTH } from '@/canvas/layout'
import { summarizeLongOutput } from '@/canvas/tool-details'

/** Quiet margin kept around the exported content on every side. */
export const SCENE_PADDING = 32

/** Conservative, PROVISIONAL ceilings. Capacity is not promised before 压测. */
export const DEFAULT_MAX_EDGE = 16384
export const DEFAULT_MAX_PIXELS = 32_000_000

/**
 * Folded card height.
 *
 * A folded card keeps its identity and its persisted fold state but draws its
 * body collapsed, so the exported height shrinks with the fold. PROVISIONAL,
 * mirrors the card's one-line header row.
 */
export const COLLAPSED_CARD_HEIGHT = 96

/** Character budgets, mirroring app.js so the export truncates like the board. */
export const CARD_QUESTION_LIMIT = 240
export const MATERIAL_PREVIEW_CHARS = 600

/** Annotation box metrics. Width is a cap; the measured text decides the rest. */
export const ANNOTATION_WIDTH = 220
export const ANNOTATION_MIN_HEIGHT = 48
export const ANNOTATION_TEXT_INSET = 16

/** Cubic samples per connector. Enough for an honest bounds, cheap to compute. */
export const CONNECTOR_SAMPLES = 16

/** Stable scale values. 1x is the default; 2x must be asked for explicitly. */
export const SUPPORTED_SCALES = Object.freeze([1, 2])

/** Limit reason codes. */
export const LIMIT_REASONS = Object.freeze({ maxEdge: 'max-edge', maxPixels: 'max-pixels' })

/** Warning and exclusion reason codes, stable enough for a UI to switch on. */
export const SCENE_CODES = Object.freeze({
  emptySelection: 'empty-selection',
  estimatedText: 'estimated-text-metrics',
  overLimit: 'over-limit',
  missingCardSource: 'missing-card-source',
  missingAnnotationSource: 'missing-annotation-source',
  coverageNote: 'coverage-note',
  regionExcluded: 'selection-mode-excludes-region',
  annotationExcluded: 'selection-mode-excludes-annotation',
  materialExcluded: 'selection-mode-excludes-material',
  cardExcluded: 'card-not-selected',
})

/** The sentence that must survive into every full-mode preview. */
export const COVERAGE_NOTE = '只包含已投影的卡片、材料、分区与旁注；DSH 原生尚未回填的历史不在导出范围内。'

const CARD_TEXT_STYLE = Object.freeze({ fontSize: 12, lineHeight: 18 })
const ANNOTATION_TEXT_STYLE = Object.freeze({ fontSize: 12, lineHeight: 18 })

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    return Object.freeze(value)
  }
  return value
}

function readPosition(value) {
  if (!isPlainObject(value) || !finite(value.x) || !finite(value.y)) return null
  return { x: value.x, y: value.y }
}

/** 1x or 2x, nothing else. Unknown scales are a programming error, not a clamp. */
export function normalizeScale(value) {
  if (value === undefined || value === null) return 1
  if (!SUPPORTED_SCALES.includes(value)) throw new TypeError(`导出缩放只支持 1x 或 2x，收到 ${String(value)}`)
  return value
}

/**
 * Width of one code point at the estimate font size.
 *
 * CJK, Hangul and full-width forms occupy roughly one em; Latin/digit roughly
 * half. This is an ESTIMATE and is always reported as one; a caller that cares
 * passes `measureText` from the real canvas.
 */
function estimateCharWidth(char, fontSize) {
  const code = char.codePointAt(0)
  if (code >= 0x2e80) return fontSize
  if (code >= 0x3000 && code <= 0x303f) return fontSize
  return fontSize * 0.55
}

function estimateLineWidth(line, fontSize) {
  let width = 0
  for (const char of line) width += estimateCharWidth(char, fontSize)
  return width
}

function wrapByWidth(text, maxWidth, fontSize) {
  const lines = []
  for (const rawLine of text.split('\n')) {
    let current = ''
    let width = 0
    for (const char of rawLine) {
      const charWidth = estimateCharWidth(char, fontSize)
      if (current !== '' && width + charWidth > maxWidth) {
        lines.push(current)
        current = char
        width = charWidth
        continue
      }
      current += char
      width += charWidth
    }
    lines.push(current)
  }
  return lines
}

/**
 * Estimated text metrics: the fallback when the caller has no measurement.
 *
 * Returns `{ width, height, lines }` for the wrapped text inside `maxWidth`.
 */
export function estimateTextMetrics(text, style = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const fontSize = finite(style.fontSize) && style.fontSize > 0 ? style.fontSize : CARD_TEXT_STYLE.fontSize
  const lineHeight = finite(style.lineHeight) && style.lineHeight > 0 ? style.lineHeight : Math.round(fontSize * 1.5)
  const maxWidth = finite(style.maxWidth) && style.maxWidth > 0 ? style.maxWidth : CARD_WIDTH - 24
  const lines = wrapByWidth(source, maxWidth, fontSize)
  let width = 0
  for (const line of lines) width = Math.max(width, estimateLineWidth(line, fontSize))
  return { width: Math.ceil(width), height: Math.max(lines.length, 1) * lineHeight, lines: lines.length, linesText: lines }
}

/**
 * Wrap an optional caller measurement.
 *
 * A measurement that is not a finite `{ width, height }` pair is ignored and the
 * estimate is used instead, so a half-finished adapter cannot poison bounds.
 * `estimated` is the flag the scene reports in its warnings.
 */
function createTextMeasurer(measureText) {
  const provided = typeof measureText === 'function'
  const measure = (text, style = {}) => {
    const source = typeof text === 'string' ? text : String(text ?? '')
    // Line breaking is always the estimate: a measurement returns one box, not
    // a wrapped line list, and the renderer needs the list. Only the BOX is
    // taken from the caller, so the picture and the bounds still agree.
    const estimated = estimateTextMetrics(source, style)
    if (provided) {
      const measured = measureText(source, style)
      if (isPlainObject(measured) && finite(measured.width) && finite(measured.height)) {
        return {
          width: Math.max(0, measured.width),
          height: Math.max(0, measured.height),
          lines: estimated.lines,
          linesText: estimated.linesText,
          measured: true,
        }
      }
    }
    return { ...estimated, measured: false }
  }
  return { measure, estimated: !provided }
}

/** Thread id -> summary, so a card can report its archived/hidden visibility. */
function threadIndex(model) {
  const byThreadId = new Map()
  for (const thread of model.threads ?? []) byThreadId.set(thread.id, thread)
  return byThreadId
}

function idSetOf(value) {
  if (!Array.isArray(value)) return new Set()
  const set = new Set()
  for (const item of value) if (typeof item === 'string' && item !== '') set.add(item)
  return set
}

/**
 * Visibility of the thread a card belongs to.
 *
 * Host archive state and the plugin's hidden-session list are mirrored, never
 * invented: an archived or hidden session that already has a projection keeps
 * its card and is LABELLED, rather than silently dropped.
 */
function visibilityOf(thread, archivedSessionIds, hiddenSessionIds) {
  if (thread === undefined) return 'visible'
  if (thread.dshSessionId !== null && archivedSessionIds.has(thread.dshSessionId)) return 'archived'
  if (thread.dshSessionId !== null && hiddenSessionIds.has(thread.dshSessionId)) return 'hidden'
  return 'visible'
}

function materialsOf(snapshot) {
  const list = []
  if (!Array.isArray(snapshot.materials)) return list
  for (const material of snapshot.materials) {
    if (!isPlainObject(material) || typeof material.id !== 'string' || material.id === '') continue
    list.push({
      id: material.id,
      name: typeof material.name === 'string' ? material.name : '',
      text: typeof material.text === 'string' ? material.text : '',
      bytes: Number.isSafeInteger(material.bytes) && material.bytes >= 0 ? material.bytes : 0,
      importedAt: typeof material.importedAt === 'string' ? material.importedAt : '',
    })
  }
  return list
}

/** One cubic Bezier evaluation. */
function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

/**
 * Connector path between two card boxes.
 *
 * The path leaves the parent's right edge, bows out horizontally, and enters the
 * child's left edge. It is sampled, and the SAMPLES are what `boundsOf` consumes:
 * a curve that leaves the straight line between the two centers must grow the
 * bounds, or a distant downward branch would be clipped.
 */
export function connectorPath(from, to) {
  const p0 = { x: from.x + from.w, y: from.y + from.h / 2 }
  const p3 = { x: to.x, y: to.y + to.h / 2 }
  const dx = Math.max(24, Math.abs(p3.x - p0.x) * 0.5)
  const p1 = { x: p0.x + dx, y: p0.y }
  const p2 = { x: p3.x - dx, y: p3.y }
  const points = []
  for (let index = 0; index <= CONNECTOR_SAMPLES; index++) {
    points.push(cubicAt(p0, p1, p2, p3, index / CONNECTOR_SAMPLES))
  }
  return { points, start: p0, end: p3, curve: { p0, p1, p2, p3 } }
}

/** Bounds of a point list, or null when empty. */
function boundsOfPoints(points) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (!finite(point?.x) || !finite(point?.y)) continue
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function boxOf(item) {
  return boundsOfPoints([
    { x: item.x, y: item.y },
    { x: item.x + item.w, y: item.y + item.h },
  ])
}

/**
 * Bounds of a set of items: the union of every box, including connectors whose
 * sampled path is wider than either endpoint.
 */
function itemsBounds(items) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const item of items) {
    const box = boundsOfPoints(Array.isArray(item.points) ? item.points : [
      { x: item.x, y: item.y },
      { x: item.x + item.w, y: item.y + item.h },
    ])
    if (box === null) continue
    if (box.x < minX) minX = box.x
    if (box.y < minY) minY = box.y
    if (box.x + box.w > maxX) maxX = box.x + box.w
    if (box.y + box.h > maxY) maxY = box.y + box.h
  }
  if (minX === Infinity) return null
  return { minX, minY, maxX, maxY }
}

/**
 * Recompute the padded bounds of a scene from its items.
 *
 * The scene's own `bounds` is not trusted: a caller that mutated an item (or a
 * renderer that measured differently) still gets the honest answer here.
 */
export function measureSceneBounds(scene) {
  if (!isPlainObject(scene)) throw new TypeError('measureSceneBounds 需要 scene 对象')
  if (!Array.isArray(scene.items)) throw new TypeError('scene.items 必须是数组')
  const padding = finite(scene.padding) && scene.padding >= 0 ? scene.padding : SCENE_PADDING
  const box = itemsBounds(scene.items)
  if (box === null) return { x: 0, y: 0, w: 0, h: 0, width: 0, height: 0 }
  const bounds = {
    x: box.minX - padding,
    y: box.minY - padding,
    w: (box.maxX - box.minX) + padding * 2,
    h: (box.maxY - box.minY) + padding * 2,
  }
  return { ...bounds, width: Math.ceil(bounds.w), height: Math.ceil(bounds.h) }
}

function buildSuggestion(actual, reason) {
  const size = `${actual.width}×${actual.height}px`
  if (reason === LIMIT_REASONS.maxEdge) {
    return `当前导出为 ${size}，超过单边上限 ${actual.maxEdge}px。建议减少选中卡片（把相距很远的分支拆成两次导出），或先重新排版缩小跨度。`
  }
  return `当前导出为 ${size}（${actual.pixels} 像素），超过总面积上限 ${actual.maxPixels} 像素。建议减少选中卡片，或分多张导出。`
}

/**
 * Check a scene against the conservative export ceilings.
 *
 * Returns `{ ok, reason, actual, message, suggestion }`. The scale is part of
 * the measurement: asking for 2x quadruples the pixel count, so a scene that
 * passes at 1x can still be refused at 2x. Nothing is silently downscaled and
 * nothing falls back to the viewport — an over-limit scene is simply refused
 * with its real size and a concrete way to shrink it.
 */
export function validateSceneLimits(scene, limits = {}) {
  if (!isPlainObject(scene)) throw new TypeError('validateSceneLimits 需要 scene 对象')
  const maxEdge = Number.isSafeInteger(limits?.maxEdge) && limits.maxEdge > 0 ? limits.maxEdge : DEFAULT_MAX_EDGE
  const maxPixels = Number.isSafeInteger(limits?.maxPixels) && limits.maxPixels > 0 ? limits.maxPixels : DEFAULT_MAX_PIXELS
  const scale = normalizeScale(limits?.scale ?? scene.scale ?? 1)
  const baseWidth = finite(scene.width) ? scene.width : (finite(scene.bounds?.w) ? Math.ceil(scene.bounds.w) : 0)
  const baseHeight = finite(scene.height) ? scene.height : (finite(scene.bounds?.h) ? Math.ceil(scene.bounds.h) : 0)
  const width = Math.ceil(baseWidth * scale)
  const height = Math.ceil(baseHeight * scale)
  const pixels = width * height
  const actual = { width, height, pixels, scale, maxEdge, maxPixels }
  if (width > maxEdge || height > maxEdge) {
    return {
      ok: false,
      reason: LIMIT_REASONS.maxEdge,
      actual,
      message: `超出单边上限：${width}×${height}px > ${maxEdge}px`,
      suggestion: buildSuggestion(actual, LIMIT_REASONS.maxEdge),
    }
  }
  if (pixels > maxPixels) {
    return {
      ok: false,
      reason: LIMIT_REASONS.maxPixels,
      actual,
      message: `超出总面积上限：${width}×${height}px = ${pixels} 像素 > ${maxPixels} 像素`,
      suggestion: buildSuggestion(actual, LIMIT_REASONS.maxPixels),
    }
  }
  return { ok: true, reason: null, actual, message: null, suggestion: null }
}

/**
 * Build the export scene for one snapshot revision.
 *
 * The snapshot is read, never written. `options.model` lets a caller reuse a
 * model it already built from the SAME snapshot; passing a model from a
 * different revision would mix revisions, which is why the scene reports the
 * revision it was built from.
 *
 * Returned shape:
 *   { mode, revision, width, height, padding, scale, items, bounds, warnings,
 *     excluded, stats, estimatedText, coverage }
 */
export function buildScene(snapshot = {}, options = {}) {
  if (!isPlainObject(snapshot)) throw new TypeError('buildScene 需要 snapshot 对象')
  if (!isPlainObject(options)) throw new TypeError('buildScene 需要 options 对象')
  const mode = options.mode === undefined ? 'selection' : options.mode
  if (mode !== 'selection' && mode !== 'full') throw new TypeError(`未知的导出模式: ${String(mode)}`)
  const scale = normalizeScale(options.scale)
  const model = options.model ?? buildCanvasModel(snapshot)
  const { measure, estimated } = createTextMeasurer(options.measureText)

  const archivedSessionIds = idSetOf(snapshot.archivedSessionIds)
  const hiddenSessionIds = idSetOf(snapshot.hiddenSessionIds)
  const threads = threadIndex(model)

  const warnings = []
  const excluded = []
  const items = []

  const requested = []
  if (Array.isArray(options.selectedCardIds)) {
    for (const cardId of options.selectedCardIds) {
      if (typeof cardId === 'string' && cardId !== '' && !requested.includes(cardId)) requested.push(cardId)
    }
  }

  // A selection export never grows beyond what was ticked. A full export takes
  // every projected card and does not consult the viewport at all.
  const includedCardIds = []
  if (mode === 'full') {
    for (const cardId of model.cardOrder) includedCardIds.push(cardId)
  } else {
    for (const cardId of requested) {
      if (model.cardsById[cardId] === undefined) {
        warnings.push({
          code: SCENE_CODES.missingCardSource,
          cardId,
          message: `勾选的卡片 ${cardId} 在本 revision 中没有投影，未绘制。`,
        })
        excluded.push({ kind: 'card', id: cardId, reason: 'source-missing' })
        continue
      }
      includedCardIds.push(cardId)
    }
    if (includedCardIds.length === 0) {
      warnings.push({ code: SCENE_CODES.emptySelection, message: '没有勾选任何卡片，无法导出。' })
    }
  }

  const cardItems = new Map()
  for (const cardId of includedCardIds) {
    const card = model.cardsById[cardId]
    const position = getResolvedPosition(model, cardId)
    if (card === undefined || position === null) {
      warnings.push({ code: SCENE_CODES.missingCardSource, cardId, message: `卡片 ${cardId} 没有可用坐标，未绘制。` })
      excluded.push({ kind: 'card', id: cardId, reason: 'source-missing' })
      continue
    }
    const collapsed = card.collapsed === true
    const visibility = visibilityOf(threads.get(card.threadId), archivedSessionIds, hiddenSessionIds)
    const question = summarizeLongOutput(typeof card.question === 'string' ? card.question : '', CARD_QUESTION_LIMIT)
    const height = collapsed ? COLLAPSED_CARD_HEIGHT : CARD_HEIGHT
    const style = { ...CARD_TEXT_STYLE, maxWidth: CARD_WIDTH - 24 }
    const metrics = measure(question.preview, style)
    const item = {
      kind: 'card',
      id: cardId,
      x: position.x,
      y: position.y,
      w: CARD_WIDTH,
      h: height,
      collapsed,
      visibility,
      threadId: card.threadId,
      userQuestionSeq: card.userQuestionSeq,
      title: typeof card.title === 'string' ? card.title : '',
      questionPreview: question.preview,
      questionTruncated: question.truncated,
      questionTotalChars: question.totalChars,
      missingSource: false,
      textStyle: style,
      textMetrics: metrics,
    }
    items.push(item)
    cardItems.set(cardId, item)
  }

  // Connectors: only edges whose BOTH endpoints made it into this scene. A
  // partially selected edge is dropped outright rather than completed with an
  // unselected card — that is the "no smuggling" rule.
  const connectorIds = []
  for (const cardId of includedCardIds) {
    const card = model.cardsById[cardId]
    if (card === undefined) continue
    const parentId = card.parentId
    if (typeof parentId !== 'string' || parentId === '') continue
    const child = cardItems.get(cardId)
    const parent = cardItems.get(parentId)
    if (child === undefined || parent === undefined) continue
    const path = connectorPath(parent, child)
    const box = boundsOfPoints(path.points)
    if (box === null) continue
    const item = {
      kind: 'connector',
      id: `${parentId}->${cardId}`,
      from: parentId,
      to: cardId,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      points: path.points,
      curve: path.curve,
    }
    items.push(item)
    connectorIds.push(item.id)
  }

  // Regions: a full export carries the boxes and their extent; a selection
  // export never adds a box the user did not tick, and says so.
  const regionItems = []
  const includedRegionIds = new Set()
  if (mode === 'full') {
    for (const region of model.regions) {
      const item = {
        kind: 'region',
        id: region.id,
        x: region.x,
        y: region.y,
        w: region.w,
        h: region.h,
        name: region.name,
        cardIds: cardsInsideRegion(model, region.id),
      }
      items.push(item)
      regionItems.push(item)
      includedRegionIds.add(region.id)
    }
  } else {
    for (const region of model.regions) {
      excluded.push({ kind: 'region', id: region.id, reason: SCENE_CODES.regionExcluded })
    }
  }

  // Notes travel with their target. A note whose target is GONE stays, marked,
  // because dropping it silently would erase the only surviving record — but
  // only in a full export, where the point is to capture everything that exists.
  //
  // The two reasons for dropping a note are different and must not be conflated:
  //   - the target exists but was not ticked  → excluded (not ours to add)
  //   - the target no longer exists at all    → kept, flagged missing-source
  // Treating both as "target absent from the scene" is what silently deleted
  // orphaned notes from full exports.
  const annotationItems = []
  for (const annotation of model.annotations) {
    const missingSource = annotation.availability === 'missing-source'
    const targetsCard = annotation.targetCardId !== null
    let keep
    if (missingSource) {
      keep = mode === 'full'
    } else {
      keep = targetsCard
        ? cardItems.has(annotation.targetCardId)
        : (mode === 'full' && includedRegionIds.has(annotation.targetRegionId))
    }
    if (!keep) {
      excluded.push({
        kind: 'annotation',
        id: annotation.id,
        reason: targetsCard ? SCENE_CODES.annotationExcluded : SCENE_CODES.regionExcluded,
        targetCardId: annotation.targetCardId,
        targetRegionId: annotation.targetRegionId,
      })
      continue
    }
    const style = { ...ANNOTATION_TEXT_STYLE, maxWidth: ANNOTATION_WIDTH - ANNOTATION_TEXT_INSET }
    const metrics = measure(annotation.text, style)
    const item = {
      kind: 'annotation',
      id: annotation.id,
      x: annotation.x,
      y: annotation.y,
      w: Math.max(80, Math.min(ANNOTATION_WIDTH, metrics.width + ANNOTATION_TEXT_INSET)),
      h: Math.max(ANNOTATION_MIN_HEIGHT, metrics.height + ANNOTATION_TEXT_INSET),
      text: annotation.text,
      targetCardId: annotation.targetCardId,
      targetRegionId: annotation.targetRegionId,
      availability: annotation.availability,
      missingSource,
      sourceLabel: missingSource ? '源缺失' : '旁注',
      typeLabel: '旁注',
      textStyle: style,
      textMetrics: metrics,
    }
    items.push(item)
    annotationItems.push(item)
    if (missingSource) {
      warnings.push({
        code: SCENE_CODES.missingAnnotationSource,
        annotationId: annotation.id,
        message: `旁注 ${annotation.id} 的目标已不存在，导出中标记为「源缺失」。`,
      })
    }
  }

  // Materials are workspace entities with their own coordinates. A full export
  // enumerates all of them; a selection export excludes them explicitly, since
  // the selection list is a card list.
  const materialItems = []
  const materials = materialsOf(snapshot)
  if (mode === 'full') {
    for (const material of materials) {
      const position = readPosition(model.layoutCards?.[material.id]) ?? { x: NATURAL_ORIGIN.x, y: NATURAL_ORIGIN.y }
      const preview = summarizeLongOutput(material.text, MATERIAL_PREVIEW_CHARS)
      const style = { ...CARD_TEXT_STYLE, maxWidth: CARD_WIDTH - 24 }
      const metrics = measure(preview.preview, style)
      const item = {
        kind: 'material',
        id: material.id,
        x: position.x,
        y: position.y,
        w: CARD_WIDTH,
        h: CARD_HEIGHT,
        name: material.name,
        bytes: material.bytes,
        importedAt: material.importedAt,
        preview: preview.preview,
        truncated: preview.truncated,
        totalChars: preview.totalChars,
        typeLabel: '材料',
        textStyle: style,
        textMetrics: metrics,
      }
      items.push(item)
      materialItems.push(item)
    }
  } else {
    for (const material of materials) {
      excluded.push({ kind: 'material', id: material.id, reason: SCENE_CODES.materialExcluded })
    }
  }

  if (estimated && items.length > 0) {
    warnings.push({
      code: SCENE_CODES.estimatedText,
      message: '文字尺寸为估算（未提供 measureText），旁注盒尺寸可能与实际渲染略有出入。',
    })
  }

  const measured = measureSceneBounds({ items, padding: SCENE_PADDING })
  const bounds = { x: measured.x, y: measured.y, w: measured.w, h: measured.h }
  const width = measured.width
  const height = measured.height

  const stats = {
    cardCount: items.filter(item => item.kind === 'card').length,
    materialCount: materialItems.length,
    regionCount: regionItems.length,
    annotationCount: annotationItems.length,
    connectorCount: connectorIds.length,
  }

  if (mode === 'full') {
    warnings.push({ code: SCENE_CODES.coverageNote, message: COVERAGE_NOTE })
  }

  const scene = {
    mode,
    revision: Number.isSafeInteger(snapshot.revision) ? snapshot.revision : model.revision ?? null,
    width,
    height,
    padding: SCENE_PADDING,
    scale,
    items,
    bounds,
    warnings,
    excluded,
    stats,
    estimatedText: estimated,
  }

  if (items.length > 0) {
    const limits = validateSceneLimits(scene, { ...(options.limits ?? {}), scale })
    if (!limits.ok) {
      warnings.push({
        code: SCENE_CODES.overLimit,
        message: `${limits.message}。${limits.suggestion}`,
        actual: limits.actual,
      })
    }
  }

  return deepFreeze(scene)
}

/** Card ids that are inside a scene, in scene order. */
export function sceneCardIds(scene) {
  if (!isPlainObject(scene) || !Array.isArray(scene.items)) return []
  const ids = []
  for (const item of scene.items) if (item.kind === 'card') ids.push(item.id)
  return ids
}

/**
 * Whether an edge between two cards would be drawn for this scene.
 *
 * Exported so a preview can explain a dropped edge without re-deriving the rule
 * (and drifting from it) in the UI layer.
 */
export function isConnectorIncluded(scene, parentId, childId) {
  if (!isPlainObject(scene) || !Array.isArray(scene.items)) return false
  const id = `${parentId}->${childId}`
  return scene.items.some(item => item.kind === 'connector' && item.id === id)
}

export default {
  SCENE_PADDING,
  DEFAULT_MAX_EDGE,
  DEFAULT_MAX_PIXELS,
  COLLAPSED_CARD_HEIGHT,
  CARD_QUESTION_LIMIT,
  MATERIAL_PREVIEW_CHARS,
  ANNOTATION_WIDTH,
  CONNECTOR_SAMPLES,
  SUPPORTED_SCALES,
  LIMIT_REASONS,
  SCENE_CODES,
  COVERAGE_NOTE,
  normalizeScale,
  estimateTextMetrics,
  connectorPath,
  measureSceneBounds,
  validateSceneLimits,
  buildScene,
  sceneCardIds,
  isConnectorIncluded,
}
