// 来源: dsh-synapnova@3fd1d00 export/png.js

/**
 * PNG export (T7) — Canvas2D drawing over a scene, plus the encode pipeline.
 *
 * The whole module talks to an ABSTRACT 2D context: it calls `ctx.*` methods and
 * never reaches for `document`, `window`, `HTMLCanvasElement` or `OffscreenCanvas`.
 * Two consequences, both intended:
 *
 * 1. The node test runner can render a scene into a recording context and assert
 *    what was actually drawn — the acceptance list forbids "assert the function
 *    exists" tests, so drawing has to be observable.
 * 2. The one thing that genuinely needs a browser (`toBlob`) is injected as an
 *    `adapter`, so the exporter cannot quietly depend on the live document, and
 *    a caller in a worker can pass a different encoder.
 *
 * Encode discipline: `toBlob`'s success callback plus a NON-EMPTY Blob check.
 * A Blob with `size === 0` is a failed encode that happened to resolve, and a
 * `null` Blob is a failed encode that was reported; both surface as
 * `encode-failed` instead of being handed back as a "successful" export.
 *
 * ## TypeScript 迁移说明
 *
 * 本模块零 `node:*` 依赖：只用 `setTimeout` / `clearTimeout`（DOM 与 Node 都
 * 提供的 Web 兼容计时器）与 `Promise`。旧实现里的 `timer.unref()` 是 Node 的
 * 附加能力，这里保留「存在就调用」的运行时分支（`unrefTimer`），因此在浏览器
 * 里只是不生效，而不是报错。
 *
 * 类型全部是结构化描述（`PngContext2D` 是 `CanvasRenderingContext2D` 的鸭子
 * 类型子集，`PngCanvasAdapter` 只要求两个方法），这样真实浏览器 context、测试
 * 里的 recording stub、worker 里的替代编码器都能直接传入，不需要假装成 DOM 类型。
 */

import { SCENE_CODES, measureSceneBounds, validateSceneLimits } from './scene'

/** Failure kinds a caller can switch on. */
export const EXPORT_FAILURES = Object.freeze({
  tooLarge: 'too-large',
  allocFailed: 'alloc-failed',
  fontTimeout: 'font-timeout',
  encodeFailed: 'encode-failed',
  emptyScene: 'empty-scene',
} as const)

/** One failure kind from `EXPORT_FAILURES`. */
export type ExportFailureKind = (typeof EXPORT_FAILURES)[keyof typeof EXPORT_FAILURES]

/** Default budget for `adapter.waitFonts()`. */
export const DEFAULT_FONT_TIMEOUT_MS = 3000

export const PNG_MIME = 'image/png'

/** Background and palette. A fixed light surface keeps the PNG readable anywhere. */
export const CANVAS_BACKGROUND = '#ffffff'

export const PAINT = Object.freeze({
  surface: '#ffffff',
  cardFill: '#ffffff',
  cardStroke: '#cfd8e3',
  cardHeader: '#f5f8fc',
  title: '#16202c',
  body: '#374151',
  muted: '#6b7280',
  connector: '#8aa0b8',
  regionFill: 'rgba(52, 120, 246, 0.06)',
  regionStroke: '#9dbbee',
  annotationFill: '#fffbeb',
  annotationStroke: '#e5c76b',
  note: '#8a6a12',
  badge: '#334155',
  badgeFill: '#eef2f7',
  missing: '#b91c1c',
  missingFill: '#fef2f2',
  materialFill: '#fbfdff',
  materialStroke: '#c7d7e6',
} as const)

/** Default font stack: a CJK-capable family is part of the contract, not a nicety. */
export const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif'

// ── 结构类型：抽象 2D 上下文 / 画布 / 场景 ─────────────────────────────────

/** A `{ x, y }` pair. */
export interface PointLike {
  x: number
  y: number
}

/** Padded rectangle in world coordinates. */
export interface SceneBounds {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The 2D context surface this module paints through.
 *
 * A structural subset of `CanvasRenderingContext2D`, so a real browser context is
 * assignable and a recording stub with the same methods/fields works too. Every
 * method here is one the exporter actually calls; nothing else is required.
 */
export interface PngContext2D {
  save(): void
  restore(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  translate(x: number, y: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
  closePath(): void
  fill(): void
  stroke(): void
  clip(): void
  fillText(text: string, x: number, y: number): void
  /** Optional on purpose: `paintBadge` falls back to a character-width estimate. */
  measureText?(text: string): { width: number }
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
}

/** Text metrics attached to a scene item by `buildScene`. */
export interface SceneTextMetricsLike {
  width?: number
  height?: number
  lines?: number
  linesText?: readonly string[]
  measured?: boolean
}

/** Text style attached to a scene item by `buildScene`. */
export interface TextStyleLike {
  fontFamily?: string
  fontSize: number
  lineHeight: number
  maxWidth?: number
}

/** One paintable scene item, as produced by `buildScene`. */
export interface SceneItemLike {
  kind: string
  id?: string
  x: number
  y: number
  w: number
  h: number
  // card
  collapsed?: boolean
  visibility?: string
  threadId?: string | null
  userQuestionSeq?: number | null
  title?: string
  questionPreview?: string
  questionTruncated?: boolean
  questionTotalChars?: number
  missingSource?: boolean
  // material
  name?: string
  bytes?: number
  importedAt?: string
  preview?: string
  truncated?: boolean
  totalChars?: number
  // region / card / material
  typeLabel?: string
  // annotation
  text?: string
  // connector
  points?: readonly PointLike[]
  // shared
  textStyle?: TextStyleLike
  textMetrics?: SceneTextMetricsLike
}

/** A scene warning; only `code` and `message` are read here. */
export interface SceneWarningLike {
  code?: string
  message?: string
  [key: string]: unknown
}

/** The scene shape `renderScene` reads. */
export interface RenderSceneInput {
  mode?: string
  revision?: number | null
  width?: number
  height?: number
  padding?: number
  scale?: number
  bounds?: SceneBounds | null
  items?: readonly SceneItemLike[]
  warnings?: readonly SceneWarningLike[]
  excluded?: readonly unknown[]
  stats?: Record<string, number>
}

/** The scene shape `exportPng` / `describeEmptyScene` read. */
export type ExportSceneInput = RenderSceneInput

/** Options for `renderScene`. */
export interface RenderOptions {
  scale?: number
  fontFamily?: string
  background?: string
}

/** Per-kind counts of what was actually painted. */
export interface DrawnCounts {
  card: number
  material: number
  region: number
  annotation: number
  connector: number
}

/** Drawing report returned by `renderScene`. */
export interface RenderReport {
  width: number
  height: number
  originX: number
  originY: number
  drawn: DrawnCounts
  itemCount: number
}

/** The actual size (and ceilings) a limit check measured. */
export interface SceneLimitActual {
  width: number
  height: number
  pixels: number
  scale: number
  maxEdge: number
  maxPixels: number
}

/** Result shape of `validateSceneLimits`. */
export interface SceneLimitsCheck {
  ok: boolean
  reason: string | null
  actual: SceneLimitActual
  message: string | null
  suggestion: string | null
}

/** A value that stands in for a real `Blob` (size is the only trustworthy bit). */
export interface BlobLike {
  size: number
  type?: string
}

/** The injected browser capability: allocate a canvas and encode it. */
export interface PngCanvasAdapter {
  createCanvas(width: number, height: number): unknown
  toBlob(canvas: unknown): Promise<unknown> | unknown
  waitFonts?: () => Promise<unknown> | unknown
}

/** Options for `exportPng`. */
export interface ExportOptions {
  scale?: number
  limits?: { maxEdge?: number; maxPixels?: number }
  fontTimeoutMs?: number
  encodeAttempts?: number
}

/** Font-wait outcome. */
export interface FontWaitResult {
  ok: boolean
  waited: boolean
  timedOut: boolean
  error?: unknown
}

/** Common shape of every refused export. */
export interface ExportFailureBase {
  ok: false
  failure: ExportFailureKind
  reason: string
  scene: unknown
  blob: null
  canvas: null
  report: RenderReport | null
  attempts: number
}

/** A refused export, with the limit check that produced or followed it. */
export interface ExportFailure extends ExportFailureBase {
  limits: SceneLimitsCheck
}

/** A successful export. */
export interface ExportSuccess {
  ok: true
  failure: null
  reason: null
  blob: BlobLike
  canvas: unknown
  scene: ExportSceneInput
  report: RenderReport
  limits: SceneLimitsCheck
  width: number
  height: number
  scale: number
  attempts: number
  fonts: { waited: boolean }
}

/** Either branch of `exportPng`. */
export type ExportResult = ExportSuccess | ExportFailure

/** Result of `describeEmptyScene`. */
export interface EmptySceneDescription {
  ok: false
  failure: ExportFailureKind
  reason: string
  scene: unknown
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/**
 * Whether an item carries text a fresh canvas has to lay out.
 *
 * `measureText` on the context is used for widths, but line boxes come from the
 * scene, so no per-item re-measure happens here.
 */
function textOf(item: SceneItemLike): string {
  if (item.kind === 'card') return item.questionPreview ?? ''
  if (item.kind === 'material') return item.preview ?? ''
  if (item.kind === 'annotation') return item.text ?? ''
  return ''
}

/** Line list for an item, falling back to a single line when none was prepared. */
function linesOf(item: SceneItemLike): readonly string[] {
  const metrics = item.textMetrics
  if (metrics !== undefined && Array.isArray(metrics.linesText)) return metrics.linesText
  const text = textOf(item)
  return text === '' ? [] : [text]
}

function styleOf(item: SceneItemLike): TextStyleLike {
  return item.textStyle ?? { fontSize: 12, lineHeight: 18 }
}

/**
 * Node's `timer.unref()` is an extra, not a requirement.
 *
 * Kept as a runtime dispatch so the same module runs in a browser (where the
 * timer handle is a plain number and `unref` does not exist) without a `node:*`
 * import and without throwing.
 */
type TimerHandle = ReturnType<typeof setTimeout>

function unrefTimer(timer: TimerHandle): void {
  const candidate = timer as unknown as { unref?: () => void }
  if (typeof candidate.unref === 'function') candidate.unref()
}

/**
 * `error?.message ?? '未知错误'`, for an `unknown` catch variable.
 *
 * Same reachable outcomes as the old JS: a non-object error has no `message`, a
 * `message` of `null`/`undefined` falls back, anything else is stringified.
 */
function failureDetail(error: unknown): string {
  if (error === null || error === undefined) return '未知错误'
  const message = (error as { message?: unknown }).message
  return message === null || message === undefined ? '未知错误' : String(message)
}

function roundRectPath(ctx: PngContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

function paintBadge(ctx: PngContext2D, label: string, x: number, y: number, style: TextStyleLike): number {
  const fontSize = 10
  const padX = 6
  const height = 16
  ctx.font = `${fontSize}px ${style.fontFamily}`
  const width = (typeof ctx.measureText === 'function' ? ctx.measureText(label).width : label.length * fontSize * 0.6) + padX * 2
  roundRectPath(ctx, x, y, width, height, 4)
  ctx.fillStyle = PAINT.badgeFill
  ctx.fill()
  ctx.fillStyle = PAINT.badge
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + padX, y + height / 2)
  return width
}

/**
 * Draw one card. `x`/`y` are the already-translated screen coordinates.
 *
 * A folded card draws its header and a fold badge but no body text — the fold
 * is a persisted appearance, not a zoom artifact, so it survives to the PNG.
 */
function drawCard(ctx: PngContext2D, item: SceneItemLike, x: number, y: number, style: TextStyleLike): void {
  ctx.save()
  roundRectPath(ctx, x, y, item.w, item.h, 8)
  ctx.fillStyle = PAINT.cardFill
  ctx.fill()
  ctx.strokeStyle = PAINT.cardStroke
  ctx.lineWidth = 1
  ctx.stroke()

  roundRectPath(ctx, x, y, item.w, 44, 8)
  ctx.save()
  ctx.clip()
  ctx.fillStyle = PAINT.cardHeader
  ctx.fillRect(x, y, item.w, 44)
  ctx.restore()

  ctx.beginPath()
  ctx.moveTo(x, y + 44)
  ctx.lineTo(x + item.w, y + 44)
  ctx.strokeStyle = PAINT.cardStroke
  ctx.stroke()

  // Title question, folded to one line like the board header.
  ctx.font = `600 ${style.fontSize}px ${style.fontFamily}`
  ctx.fillStyle = PAINT.title
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const title = typeof item.questionPreview === 'string' ? item.questionPreview : ''
  // `noUncheckedIndexedAccess`: every `split('\n')` result has at least one
  // element, so the `?? ''` never fires and the drawing is unchanged.
  const firstLine = title.split('\n')[0] ?? ''
  ctx.fillText(firstLine.slice(0, 80), x + 12, y + 22)

  // Type and visibility badges: an archived or hidden card must still say so.
  let badgeX = x + 12
  const badgeY = y + 28
  if (typeof item.typeLabel === 'string' && item.typeLabel !== '') {
    badgeX += paintBadge(ctx, item.typeLabel, badgeX, badgeY, style) + 4
  }
  if (item.visibility === 'archived') badgeX += paintBadge(ctx, '已归档', badgeX, badgeY, style) + 4
  if (item.visibility === 'hidden') badgeX += paintBadge(ctx, '已隐藏', badgeX, badgeY, style) + 4
  if (item.collapsed === true) paintBadge(ctx, '已折叠', badgeX, badgeY, style)

  if (item.collapsed === true) {
    ctx.restore()
    return
  }

  ctx.font = `${style.fontSize}px ${style.fontFamily}`
  ctx.fillStyle = PAINT.body
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const lines = linesOf(item)
  let lineY = y + 56
  for (const line of lines) {
    if (lineY + style.lineHeight > y + item.h - 8) break
    ctx.fillText(line, x + 12, lineY)
    lineY += style.lineHeight
  }

  if (item.questionTruncated === true) {
    ctx.fillStyle = PAINT.muted
    ctx.fillText('…（正文已截断）', x + 12, y + item.h - style.lineHeight - 6)
  }
  ctx.restore()
}

/** Draw one material node: name, meta line, folded text preview. */
function drawMaterial(ctx: PngContext2D, item: SceneItemLike, x: number, y: number, style: TextStyleLike): void {
  ctx.save()
  roundRectPath(ctx, x, y, item.w, item.h, 8)
  ctx.fillStyle = PAINT.materialFill
  ctx.fill()
  ctx.strokeStyle = PAINT.materialStroke
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.font = `600 ${style.fontSize}px ${style.fontFamily}`
  ctx.fillStyle = PAINT.title
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(item.name ?? '').slice(0, 60), x + 12, y + 20)

  ctx.font = `10px ${style.fontFamily}`
  ctx.fillStyle = PAINT.muted
  ctx.fillText(`${item.bytes} 字节`, x + 12, y + 38)

  ctx.font = `${style.fontSize}px ${style.fontFamily}`
  ctx.fillStyle = PAINT.body
  ctx.textBaseline = 'top'
  let lineY = y + 54
  for (const line of linesOf(item)) {
    if (lineY + style.lineHeight > y + item.h - 8) break
    ctx.fillText(line, x + 12, lineY)
    lineY += style.lineHeight
  }
  if (item.truncated === true) {
    ctx.fillStyle = PAINT.muted
    ctx.fillText('…（预览已截断）', x + 12, y + item.h - style.lineHeight - 6)
  }
  ctx.restore()
}

/** Draw one note; a note whose target vanished is drawn with a warning frame. */
function drawAnnotation(ctx: PngContext2D, item: SceneItemLike, x: number, y: number, style: TextStyleLike): void {
  ctx.save()
  roundRectPath(ctx, x, y, item.w, item.h, 6)
  ctx.fillStyle = item.missingSource === true ? PAINT.missingFill : PAINT.annotationFill
  ctx.fill()
  ctx.strokeStyle = item.missingSource === true ? PAINT.missing : PAINT.annotationStroke
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.font = `${style.fontSize}px ${style.fontFamily}`
  ctx.fillStyle = item.missingSource === true ? PAINT.missing : PAINT.note
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  let lineY = y + 8
  for (const line of linesOf(item)) {
    if (lineY + style.lineHeight > y + item.h - 4) break
    ctx.fillText(line, x + 8, lineY)
    lineY += style.lineHeight
  }
  ctx.restore()
}

/** Draw one region box (its label is only drawn when the box is tall enough). */
function drawRegion(ctx: PngContext2D, item: SceneItemLike, x: number, y: number, style: TextStyleLike): void {
  ctx.save()
  ctx.fillStyle = PAINT.regionFill
  ctx.fillRect(x, y, item.w, item.h)
  ctx.strokeStyle = PAINT.regionStroke
  ctx.lineWidth = 1
  ctx.strokeRect(x, y, item.w, item.h)
  if (typeof item.name === 'string' && item.name !== '' && item.h >= 24) {
    ctx.font = `600 11px ${style.fontFamily}`
    ctx.fillStyle = PAINT.badge
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(item.name.slice(0, 40), x + 8, y + 6)
  }
  ctx.restore()
}

/**
 * Draw one connector from its SAMPLED points.
 *
 * The samples, not the endpoints, are the geometry: a curve that bows outside
 * the straight line still renders where the bounds said it would.
 */
function drawConnector(ctx: PngContext2D, item: SceneItemLike): void {
  const points = Array.isArray(item.points) ? item.points : []
  if (points.length === 0) return
  // `noUncheckedIndexedAccess` cannot see the length guard above; the cast is
  // type-only, so the runtime indexing is exactly the old `points[index].x`.
  const first = points[0] as PointLike
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  for (let index = 1; index < points.length; index++) {
    const point = points[index] as PointLike
    ctx.lineTo(point.x, point.y)
  }
  ctx.strokeStyle = PAINT.connector
  ctx.lineWidth = 1.5
  if (typeof ctx.stroke === 'function') ctx.stroke()
  ctx.restore()
}

/** Draw order: region boxes behind, then connectors, then cards/materials, then notes. */
function paintOrder(items: readonly SceneItemLike[]): SceneItemLike[] {
  const rank = (item: SceneItemLike): number => {
    if (item.kind === 'region') return 0
    if (item.kind === 'connector') return 1
    if (item.kind === 'card' || item.kind === 'material') return 2
    if (item.kind === 'annotation') return 3
    return 4
  }
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => (rank(a.item) - rank(b.item)) || (a.index - b.index))
    .map(entry => entry.item)
}

/**
 * Render a scene into an abstract 2D context.
 *
 * The scene's own `bounds` is the coordinate origin, so a scene built from a
 * snapshot with negative coordinates renders with nothing clipped at 0,0 — the
 * translation carries the world origin into the padded image.
 *
 * Returns the drawing report `{ width, height, originX, originY, drawn }`, where
 * `drawn` counts the items actually painted per kind.
 */
export function renderScene(
  ctx: PngContext2D | null | undefined,
  scene: RenderSceneInput | null,
  options: RenderOptions = {},
): RenderReport {
  if (ctx === null || typeof ctx !== 'object') throw new TypeError('renderScene 需要一个 2D 上下文对象')
  if (scene === null || typeof scene !== 'object') throw new TypeError('renderScene 需要 scene 对象')
  // `options.scale` WINS over `scene.scale`. `exportPng` allocates the canvas at
  // the requested scale and then hands that same scale down here; reading only
  // `scene.scale` silently ignored it, so a caller asking for 2x got a 2x-sized
  // canvas with a 1x transform — the picture occupied the top-left quarter.
  const scale = options.scale !== undefined ? options.scale : (scene.scale === 2 ? 2 : 1)
  if (scale !== 1 && scale !== 2) throw new TypeError(`导出缩放只支持 1x 或 2x，收到 ${String(scale)}`)
  const bounds = scene.bounds ?? measureSceneBounds(scene)
  // A negative or absent dimension means "nothing measurable", which is 0 pixels
  // of canvas — not a negative allocation.
  const rawWidth = (scene.width ?? bounds.w) * scale
  const rawHeight = (scene.height ?? bounds.h) * scale
  const width = Math.ceil(rawWidth > 0 ? rawWidth : 0)
  const height = Math.ceil(rawHeight > 0 ? rawHeight : 0)
  const style: TextStyleLike = { fontFamily: options.fontFamily ?? FONT_STACK, fontSize: 12, lineHeight: 18 }
  const drawn: DrawnCounts = { card: 0, material: 0, region: 0, annotation: 0, connector: 0 }

  ctx.save()
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.fillStyle = options.background ?? CANVAS_BACKGROUND
  ctx.fillRect(0, 0, width / scale, height / scale)
  // World origin -> image origin (plus padding, already inside `bounds`).
  ctx.translate(-bounds.x, -bounds.y)

  for (const item of paintOrder(Array.isArray(scene.items) ? scene.items : [])) {
    const x = item.x
    const y = item.y
    if (item.kind === 'card') { drawCard(ctx, item, x, y, style); drawn.card += 1 }
    else if (item.kind === 'material') { drawMaterial(ctx, item, x, y, style); drawn.material += 1 }
    else if (item.kind === 'annotation') { drawAnnotation(ctx, item, x, y, style); drawn.annotation += 1 }
    else if (item.kind === 'region') { drawRegion(ctx, item, x, y, style); drawn.region += 1 }
    else if (item.kind === 'connector') { drawConnector(ctx, item); drawn.connector += 1 }
  }

  ctx.restore()
  return { width, height, originX: bounds.x, originY: bounds.y, drawn, itemCount: (scene.items ?? []).length }
}

/** Build the failing result shape once, so every refusal looks the same. */
function failure(
  kind: ExportFailureKind,
  reason: string,
  extra: { scene?: unknown; report?: RenderReport | null; attempts?: number } = {},
): ExportFailureBase {
  return { ok: false, failure: kind, reason, scene: extra.scene ?? null, blob: null, canvas: null, report: extra.report ?? null, attempts: extra.attempts ?? 0 }
}

/**
 * Whether a produced Blob is a real encode.
 *
 * Three separate lies are caught here: `null` (the encode reported failure),
 * a Blob whose `size` is 0 (a header-less empty buffer), and a value that is not
 * Blob-shaped at all (an adapter that returned the wrong thing).
 */
export function isNonEmptyBlob(value: unknown): value is BlobLike {
  if (value === null || typeof value !== 'object') return false
  const size = (value as { size?: unknown }).size
  if (typeof size !== 'number' || !Number.isFinite(size)) return false
  if (size <= 0) return false
  // `type` is NOT part of the verdict. A correct PNG encoder always sets
  // `image/png`, but treating an empty or absent `type` as failure would reject a
  // perfectly good Blob from an adapter that omits it — and `size > 0` is the only
  // property this check can actually stand on.
  return true
}

/**
 * `blob?.size ?? 0`, for an `unknown` value.
 *
 * The `number` return type is a compile-time stand-in, not a runtime promise:
 * this only runs on a value `isNonEmptyBlob` REJECTED, so `size` is either a
 * non-positive number or something that is not a number at all (`'100'`), and
 * the old JS printed whatever it was. Interpolating it keeps that behaviour,
 * including the throw on a symbol, which is exactly what `${...}` did before.
 */
function sizeOf(value: unknown): number {
  if (value === null || value === undefined) return 0
  return ((value as { size?: number }).size ?? 0) as number
}

/**
 * Wait for fonts, bounded.
 *
 * `adapter.waitFonts` is awaited with a timeout so a font promise that never
 * settles cannot hang the export; a rejection is treated as "fonts failed" and
 * reported as `font-timeout` (the same reader-facing outcome: the picture may
 * not have the CJK face).
 */
async function waitForFonts(adapter: PngCanvasAdapter | null | undefined, timeoutMs: number): Promise<FontWaitResult> {
  if (typeof adapter?.waitFonts !== 'function') return { ok: true, waited: false, timedOut: false }
  let timer: TimerHandle | null = null
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs))
    unrefTimer(timer)
  })
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => adapter.waitFonts?.()),
      timeout,
    ])
    if (outcome === 'timeout') return { ok: false, waited: true, timedOut: true }
    return { ok: true, waited: true, timedOut: false }
  } catch (error) {
    return { ok: false, waited: true, timedOut: false, error }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Exponential backoff between encode attempts, if a caller asks for retries. */
function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    unrefTimer(timer)
  })
}

/**
 * Resolve the 2D context out of whatever `createCanvas` returned.
 *
 * Mirrors the old inline expression exactly: `null`/`undefined` canvas → no
 * context; a canvas with `getContext` is asked for `'2d'`; otherwise `.ctx`.
 */
function resolveContext(canvas: unknown): unknown {
  if (canvas === null || canvas === undefined) return null
  const candidate = canvas as { getContext?: unknown; ctx?: unknown }
  if (typeof candidate.getContext === 'function') {
    return (candidate.getContext as (contextId: string) => unknown)('2d')
  }
  return candidate.ctx ?? null
}

/**
 * Export a scene as PNG through an injected adapter.
 *
 * Order is fixed and each step can refuse:
 *   1. limits (no silent downscale, no viewport fallback)
 *   2. empty scene (nothing to draw is not a success)
 *   3. fonts (`waitFonts` when the adapter provides one, including CJK)
 *   4. canvas allocation (`alloc-failed` on a throw or a canvas without a context)
 *   5. render
 *   6. `toBlob`, success callback, non-empty Blob verification
 *
 * Every failure keeps the scene and its preview intact — the caller can change
 * the selection and retry, which is why the failing result carries the scene.
 */
export async function exportPng(
  scene: ExportSceneInput | null,
  adapter: PngCanvasAdapter | null,
  options: ExportOptions = {},
): Promise<ExportResult> {
  if (scene === null || typeof scene !== 'object') throw new TypeError('exportPng 需要 scene 对象')
  if (adapter === null || typeof adapter !== 'object') throw new TypeError('exportPng 需要 adapter 对象')
  if (typeof adapter.createCanvas !== 'function') throw new TypeError('adapter.createCanvas 必须是函数')
  if (typeof adapter.toBlob !== 'function') throw new TypeError('adapter.toBlob 必须是函数')

  const scale = options.scale === undefined ? (scene.scale ?? 1) : options.scale
  const limits: SceneLimitsCheck = validateSceneLimits(scene, { ...(options.limits ?? {}), scale })
  if (!limits.ok) {
    return { ...failure(EXPORT_FAILURES.tooLarge, `${limits.message}。${limits.suggestion}`, { scene }), limits }
  }

  const isEmpty = !Array.isArray(scene.items) || scene.items.length === 0
  if (isEmpty) {
    return { ...failure(EXPORT_FAILURES.emptyScene, '场景里没有任何可绘制对象（未勾选卡片或勾选的卡片没有投影），未生成图片。', { scene }), limits }
  }

  const fonts = await waitForFonts(adapter, options.fontTimeoutMs ?? DEFAULT_FONT_TIMEOUT_MS)
  if (!fonts.ok) {
    return {
      ...failure(
        EXPORT_FAILURES.fontTimeout,
        fonts.timedOut
          ? `等待字体就绪超时（${options.fontTimeoutMs ?? DEFAULT_FONT_TIMEOUT_MS}ms），为避免缺字形的图片未执行导出。`
          : `等待字体就绪失败：${failureDetail(fonts.error)}，未执行导出。`,
        { scene },
      ),
      limits,
    }
  }

  const width = limits.actual.width
  const height = limits.actual.height

  let canvas: unknown = null
  try {
    canvas = adapter.createCanvas(width, height)
  } catch (error) {
    return { ...failure(EXPORT_FAILURES.allocFailed, `分配 ${width}×${height} 画布失败：${failureDetail(error)}`, { scene }), limits }
  }
  const rawCtx = resolveContext(canvas)
  if (rawCtx === null || rawCtx === undefined) {
    return { ...failure(EXPORT_FAILURES.allocFailed, `分配 ${width}×${height} 画布失败：拿不到 2D 上下文`, { scene }), limits }
  }
  // Same trust level as the old JS: the adapter is responsible for handing back
  // something context-shaped; a broken one surfaces as a render failure below.
  const ctx = rawCtx as PngContext2D

  let report: RenderReport | null = null
  try {
    report = renderScene(ctx, scene, { scale })
  } catch (error) {
    return { ...failure(EXPORT_FAILURES.allocFailed, `绘制失败：${failureDetail(error)}`, { scene }), limits }
  }

  // `Number.isSafeInteger` does not narrow `number | undefined`, so the guard is
  // spelled out. It is the same predicate: a non-number never passes it.
  const requestedAttempts = options.encodeAttempts
  const attempts = typeof requestedAttempts === 'number' && Number.isSafeInteger(requestedAttempts) && requestedAttempts > 0 ? requestedAttempts : 1
  let lastReason = '编码未返回 Blob'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let blob: unknown = null
    let threw: unknown = null
    try {
      blob = await adapter.toBlob(canvas)
    } catch (error) {
      threw = error
    }
    if (threw === null && isNonEmptyBlob(blob)) {
      return {
        ok: true,
        failure: null,
        reason: null,
        blob,
        canvas,
        scene,
        report,
        limits,
        width,
        height,
        scale,
        attempts: attempt,
        fonts: { waited: fonts.waited },
      }
    }
    lastReason = threw !== null
      ? `编码失败：${failureDetail(threw)}`
      : (blob === null ? '编码失败：toBlob 返回 null' : `编码失败：Blob 为空（size=${sizeOf(blob)}）`)
    if (attempt < attempts) await waitMs(60 * attempt)
  }

  return {
    ...failure(EXPORT_FAILURES.encodeFailed, `${lastReason}，未生成可下载的 PNG。选择与预览已保留，可重试。`, { scene, report, attempts }),
    limits,
  }
}

/**
 * Result shape for a preview that never rendered anything.
 *
 * Kept next to `exportPng` so the preview and the exporter cannot disagree on
 * what "nothing to export" looks like.
 */
export function describeEmptyScene(scene?: ExportSceneInput | null): EmptySceneDescription {
  const warnings: readonly SceneWarningLike[] = scene?.warnings ?? []
  const warning = warnings.find(item => item.code === SCENE_CODES.emptySelection)
  return {
    ok: false,
    failure: EXPORT_FAILURES.emptyScene,
    reason: warning?.message ?? '没有可导出的内容。',
    scene: scene ?? null,
  }
}

export default {
  EXPORT_FAILURES,
  DEFAULT_FONT_TIMEOUT_MS,
  PNG_MIME,
  CANVAS_BACKGROUND,
  PAINT,
  FONT_STACK,
  isNonEmptyBlob,
  renderScene,
  exportPng,
  describeEmptyScene,
}
