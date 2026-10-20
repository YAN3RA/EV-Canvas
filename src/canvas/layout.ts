// 来源: dsh-synapnova@3fd1d00 canvas/layout.js

/**
 * Canvas layout engines (T4) — pure geometry over a canvas model.
 *
 * Pure module: no DOM, no Store, no IO, no npm dependency. Input is the frozen
 * model produced by `buildCanvasModel` (or any duck-typed object with a `cards`
 * array); output is fresh plain objects. The input model is never mutated, and
 * nothing here reads `layout`/`regions`/`projection` behind the caller's back.
 *
 * Why this is separate from app.js: app.js currently derives positions inline in
 * `layoutConversationGraph` (a provisional fallback). T4 needs three selectable
 * engines whose output can be asserted by tests, so the geometry lives here and
 * the caller only decides WHEN to run it and how to commit the result.
 *
 * Lineage model (frozen by canvas/model.js):
 * - A card's `parentId` is the previous card of the same thread, so a thread is a
 *   horizontal chain. `threadParentId` links threads, and is deliberately NOT
 *   used as a card edge here: layout operates on cards only, one edge per card.
 * - `parentId === null` means "root of the chain". A `parentId` that names a card
 *   the model does not contain is a BROKEN LINK, not a root: it is placed
 *   independently (never dropped) and reported in `unresolved`.
 * - A cycle cannot be produced by `buildCanvasModel`, but this module is also
 *   fed synthetic models in tests and by future import paths, so every traversal
 *   is bounded by a visited set. A cycle terminates, every member still gets
 *   coordinates, and every member is reported in `unresolved`.
 *
 * Geometry constants mirror app.js (`CARD_WIDTH`/`CARD_HEIGHT`/`CARD_GAP_Y`) and
 * `model.js` (`NATURAL_ORIGIN`/`NATURAL_STEP_X`). They are provisional: T4 owns
 * real card metrics once the DOM measurement lands.
 */

import { NATURAL_ORIGIN, NATURAL_STEP_X } from '@/canvas/model'
import type { Position } from '@/canvas/model'

/** Card box, mirrored from app.js. Provisional until measured in the DOM. */
export const CARD_WIDTH = 310
export const CARD_HEIGHT = 276
export const CARD_GAP_X = 42
export const CARD_GAP_Y = 42
/** Column pitch of a horizontal chain: same value as model.js natural step. */
export const CARD_STEP_X = NATURAL_STEP_X
/** Row pitch of a vertical chain: one card plus the vertical gap. */
export const CARD_STEP_Y = CARD_HEIGHT + CARD_GAP_Y
/** Lane pitch of a vertical layout / branch row: one card plus the horizontal gap. */
export const CARD_STEP_LANE = CARD_WIDTH + CARD_GAP_X

/** Engine ids, safe to store in a setting; disjoint from COMMAND_KINDS values. */
export const LAYOUT_MODES = Object.freeze({
  horizontal: 'horizontal',
  vertical: 'vertical',
  branch: 'branch',
})

/**
 * Patch area of a layout intent.
 *
 * `commands.js` `writePatch` accepts `layoutCards` (the frozen document field),
 * so that is the default: an intent produced here can be committed through
 * `createCommandHistory().commit()` with no adapter-side translation. The literal
 * `'cards'` spelling is available through `layoutToCommandIntent(model, positions,
 * { area: 'cards' })` for callers that speak that name.
 */
export const LAYOUT_PATCH_AREA = 'layoutCards'

/**
 * Command kind of a layout intent.
 *
 * Deliberately not a member of COMMAND_KINDS: a layout is one batch command that
 * moves many cards, and it must stay distinguishable from a single-card drag in
 * the undo stack (`inspect().undo[i].kind`).
 */
export const LAYOUT_COMMAND_KIND = 'layout'

/**
 * 布局引擎接受的模型形状。
 *
 * 只声明本模块真正读取的字段，且全部按 `unknown` 收窄：引擎同样接受测试里
 * 手工拼出的 duck-typed 模型（没有 `cardsById` / `layoutCards` 也合法）。
 */
export interface LayoutModelInput {
  cards?: readonly unknown[]
  cardsById?: Readonly<Record<string, unknown>>
  layoutCards?: Readonly<Record<string, unknown>>
}

/** 引擎选项。`origin` 缺省时回落到 `NATURAL_ORIGIN`。 */
export interface LayoutOptions {
  origin?: unknown
  /** `layoutToCommandIntent` 的补丁落点，缺省 `LAYOUT_PATCH_AREA`。 */
  area?: string
  /** `layoutToCommandIntent` 的意图 kind，缺省 `LAYOUT_COMMAND_KIND`。 */
  kind?: string
}

/** 一张参与布局的卡片（只读 `id` / `parentId` / `position` / `naturalPosition`）。 */
interface LayoutCard {
  id: string;
  [field: string]: unknown;
}

/** 一条布局补丁：`before` 为 null 表示「从未手工放置过」。 */
export interface LayoutPatch {
  area: string;
  id: string;
  before: Position | null;
  after: Position;
}

/** 一次布局的产物：新坐标、真正移动的张数、血缘不可信的卡片 id。 */
export interface LayoutResult {
  positions: Record<string, Position>;
  movedCount: number;
  unresolved: string[];
}

/** 批量布局发出的命令意图。 */
export interface LayoutIntent {
  kind: string;
  patches: LayoutPatch[];
}

/** `layoutIntent` 的产物：意图 + 引擎结果。 */
export interface LayoutIntentWithResult extends LayoutIntent {
  layout: LayoutResult;
}

/** 一个引擎。 */
export type LayoutEngine = (model: LayoutModelInput | null | undefined, options?: LayoutOptions) => LayoutResult;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readPosition(value: unknown): Position | null {
  if (!isPlainObject(value) || !finiteNumber(value.x) || !finiteNumber(value.y)) return null
  return { x: value.x, y: value.y }
}

/**
 * Cards of a model, de-duplicated by id and kept in `cardOrder`.
 *
 * The model's `cards` array is the only input: unknown layout entities
 * (`model.unmatchedCardIds`, e.g. material nodes) have no card and therefore get
 * no position here — they keep their coordinates untouched in `layoutCards`.
 */
function cardsOf(model: LayoutModelInput | null | undefined): { cards: LayoutCard[]; byId: Map<string, LayoutCard> } {
  const cards: LayoutCard[] = []
  const byId = new Map<string, LayoutCard>()
  if (!Array.isArray(model?.cards)) return { cards, byId }
  for (const card of model.cards) {
    if (!isPlainObject(card) || typeof card.id !== 'string' || card.id === '') continue
    if (byId.has(card.id)) continue
    const typed = card as unknown as LayoutCard
    cards.push(typed)
    byId.set(typed.id, typed)
  }
  return { cards, byId }
}

/** Parent card, or null for a root, a broken link, or a self-reference. */
function parentOf(card: LayoutCard, byId: Map<string, LayoutCard>): LayoutCard | null {
  const parentId = card?.parentId
  if (typeof parentId !== 'string' || parentId === '') return null
  if (parentId === card.id) return null
  return byId.get(parentId) ?? null
}

/** Position a card is currently DRAWN at: manual position first, natural else. */
function drawnPosition(card: LayoutCard): Position {
  return readPosition(card?.position) ?? readPosition(card?.naturalPosition) ?? { ...NATURAL_ORIGIN }
}

/**
 * Stored (manual) position only — the value a `layoutCards` patch overwrites.
 *
 * Never falls back to `naturalPosition`: a card that was never placed must be
 * patched with `before: null`, exactly like `commands.moveCard` does.
 */
function storedPosition(model: LayoutModelInput | null | undefined, cardId: string): Position | null {
  // 逐字保留 `model?.cardsById?.[cardId]?.position` 的可选访问链：形状不对时
  // `readPosition` 本来就会返回 null，这里只是让类型系统看到同一件事。
  const card = model?.cardsById?.[cardId]
  const fromCard = readPosition(isPlainObject(card) ? card.position : null)
  if (fromCard !== null) return fromCard
  return readPosition(model?.layoutCards?.[cardId])
}

/**
 * Depth (chain distance from a root) of every card, cycle-safe.
 *
 * Walks upward per card with a visited map. On a cycle the walk stops at the
 * first repeated node, every member of the loop is recorded in `cycle`, and the
 * loop is anchored at depth 0 so it still receives coordinates. Assignment runs
 * from the topmost collected node downward, so a shared ancestor is resolved
 * once and every descendant reuses it (O(n) for a tree).
 */
function resolveDepths(cards: readonly LayoutCard[], byId: Map<string, LayoutCard>): { depth: Map<string, number>; cycle: Set<string> } {
  const depth = new Map<string, number>()
  const cycle = new Set<string>()
  for (const card of cards) {
    if (depth.has(card.id)) continue
    const path: LayoutCard[] = []
    const seen = new Map<string, number>()
    let cursor: LayoutCard | null = card
    let base = 0
    while (cursor !== null) {
      if (depth.has(cursor.id)) {
        // `has()` 已保证存在；断言只补类型，判定的仍是同一个值。
        base = (depth.get(cursor.id) as number) + 1
        break
      }
      if (seen.has(cursor.id)) {
        // 同上：`has()` 为真，因此 `get()` 必为 number。
        const start = seen.get(cursor.id) as number
        for (let index = start; index < path.length; index++) cycle.add((path[index] as LayoutCard).id)
        base = 0
        break
      }
      seen.set(cursor.id, path.length)
      path.push(cursor)
      cursor = parentOf(cursor, byId)
    }
    for (let index = path.length - 1, step = 0; index >= 0; index--, step++) {
      // 循环条件保证 index 在 [0, path.length) 内。
      depth.set((path[index] as LayoutCard).id, base + step)
    }
  }
  return { depth, cycle }
}

/**
 * Lane index per card, where a lane is one connected lineage component.
 *
 * Union-find over parent edges (a cycle simply unions already-joined nodes), then
 * lanes are numbered by first appearance in `cardOrder` so the result is
 * deterministic regardless of map iteration. Lanes are what keeps two unrelated
 * branches from being drawn on top of each other.
 */
function resolveLanes(cards: readonly LayoutCard[], byId: Map<string, LayoutCard>): { laneOf: Map<string, number>; laneCount: number } {
  const parent = new Map<string, string>()
  for (const card of cards) parent.set(card.id, card.id)
  // `parent` 预先为每张卡填入自指，`union` 只改写已存在的键，所以每次 `get`
  // 都命中；断言只补类型，不插入任何兜底值（兜底会掩盖真正的断链）。
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
    let cursor = id
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootB, rootA)
  }
  for (const card of cards) {
    const node = parentOf(card, byId)
    if (node !== null) union(card.id, node.id)
  }
  const laneByRoot = new Map<string, number>()
  const laneOf = new Map<string, number>()
  for (const card of cards) {
    const root = find(card.id)
    let lane = laneByRoot.get(root)
    if (lane === undefined) {
      lane = laneByRoot.size
      laneByRoot.set(root, lane)
    }
    laneOf.set(card.id, lane)
  }
  return { laneOf, laneCount: laneByRoot.size }
}

/** 一次布局分析的结果。 */
interface LayoutAnalysis {
  cards: LayoutCard[];
  byId: Map<string, LayoutCard>;
  depth: Map<string, number>;
  laneOf: Map<string, number>;
  laneCount: number;
  unresolved: string[];
}

/** Shared analysis: depths, lanes, and the cards whose lineage is untrustworthy. */
function analyze(model: LayoutModelInput | null | undefined): LayoutAnalysis {
  const { cards, byId } = cardsOf(model)
  const { depth, cycle } = resolveDepths(cards, byId)
  const { laneOf, laneCount } = resolveLanes(cards, byId)
  const broken = new Set<string>()
  for (const card of cards) {
    const parentId = card.parentId
    if (typeof parentId !== 'string' || parentId === '') continue
    if (parentId === card.id || !byId.has(parentId)) broken.add(card.id)
  }
  const unresolved: string[] = []
  for (const card of cards) if (broken.has(card.id) || cycle.has(card.id)) unresolved.push(card.id)
  return { cards, byId, depth, laneOf, laneCount, unresolved }
}

function readOrigin(origin: unknown): Position {
  const value = readPosition(origin)
  return value === null ? { x: NATURAL_ORIGIN.x, y: NATURAL_ORIGIN.y } : value
}

/**
 * Build the result bundle, counting only cards whose DRAWN position changes.
 *
 * `movedCount` is not "cards in the result": a layout that reproduces the current
 * picture reports 0, which is what lets the caller skip an empty undo step.
 */
function finish(model: LayoutModelInput | null | undefined, positions: Record<string, Position>, unresolved: string[]): LayoutResult {
  const { cards } = cardsOf(model)
  let movedCount = 0
  for (const card of cards) {
    const next = positions[card.id]
    if (next === undefined) continue
    const current = drawnPosition(card)
    if (Math.round(current.x) !== next.x || Math.round(current.y) !== next.y) movedCount += 1
  }
  return { positions, movedCount, unresolved }
}

/**
 * Grid packing shared by the horizontal and vertical engines.
 *
 * Cells are `(lane, depth)`. Cards that land in the same cell stack in card
 * order; each lane's cross-axis size is its tallest cell, so lanes never
 * overlap and no card is dropped. `horizontal` puts depth on X and the stack on
 * Y; `vertical` swaps the two axes.
 */
function gridPositions(analysis: LayoutAnalysis, orientation: 'horizontal' | 'vertical', origin: Position): Record<string, Position> {
  const { cards, depth, laneOf, laneCount } = analysis
  const cellCount = new Map<string, number>()
  const cellOf = new Map<string, { lane: number; level: number; stack: number }>()
  const laneSize = new Array<number>(laneCount).fill(1)
  for (const card of cards) {
    const lane = laneOf.get(card.id) ?? 0
    const level = depth.get(card.id) ?? 0
    const key = `${lane}|${level}`
    const stack = cellCount.get(key) ?? 0
    cellCount.set(key, stack + 1)
    cellOf.set(card.id, { lane, level, stack })
    // `lane` 由 `resolveLanes` 生成，必然落在 [0, laneCount) 内。
    if (stack + 1 > (laneSize[lane] as number)) laneSize[lane] = stack + 1
  }
  const laneBase: number[] = []
  let cursor = 0
  for (let lane = 0; lane < laneCount; lane++) {
    laneBase.push(cursor)
    // 上面刚 push 过，同一下标必有值。
    cursor += laneSize[lane] as number
  }
  const positions: Record<string, Position> = {}
  for (const card of cards) {
    const cell = cellOf.get(card.id)
    if (cell === undefined) continue
    // `laneBase` 与 `laneSize` 长度同为 `laneCount`，`cell.lane` 必在其中。
    const slot = (laneBase[cell.lane] as number) + cell.stack
    positions[card.id] = orientation === 'horizontal'
      ? { x: Math.round(origin.x + cell.level * CARD_STEP_X), y: Math.round(origin.y + slot * CARD_STEP_Y) }
      : { x: Math.round(origin.x + slot * CARD_STEP_LANE), y: Math.round(origin.y + cell.level * CARD_STEP_Y) }
  }
  return positions
}

/**
 * Horizontal layout: lineage grows to the RIGHT from each root.
 *
 * Depth is a column (`+CARD_STEP_X` per generation); each lineage component gets
 * its own row band. Cards that branch at the same depth stack downward inside
 * their band instead of overlapping.
 */
export function layoutHorizontal(model: LayoutModelInput | null | undefined, options: LayoutOptions = {}): LayoutResult {
  const analysis = analyze(model)
  const origin = readOrigin(options.origin)
  return finish(model, gridPositions(analysis, 'horizontal', origin), analysis.unresolved)
}

/**
 * Vertical layout: lineage grows DOWNWARD from each root.
 *
 * Depth is a row (`+CARD_STEP_Y` per generation); each lineage component gets its
 * own column band, and same-depth branches stack to the right inside that band.
 */
export function layoutVertical(model: LayoutModelInput | null | undefined, options: LayoutOptions = {}): LayoutResult {
  const analysis = analyze(model)
  const origin = readOrigin(options.origin)
  return finish(model, gridPositions(analysis, 'vertical', origin), analysis.unresolved)
}

/**
 * Branch layout: one lane (row) per lineage component, cards in reading order.
 *
 * Inside a lane cards are ordered by depth, then by `cardOrder`, and each card
 * takes its own column slot — so a lane is a single left-to-right sequence and
 * two branches are always visually separated by a full row pitch. Cycles and
 * broken links stay in their own lane and are reported in `unresolved`.
 */
export function layoutByBranch(model: LayoutModelInput | null | undefined, options: LayoutOptions = {}): LayoutResult {
  const analysis = analyze(model)
  const origin = readOrigin(options.origin)
  const { cards, depth, laneOf, laneCount } = analysis
  const laneMembers = new Map<number, LayoutCard[]>()
  for (let lane = 0; lane < laneCount; lane++) laneMembers.set(lane, [])
  for (const card of cards) {
    const lane = laneOf.get(card.id) ?? 0
    const members = laneMembers.get(lane)
    if (members !== undefined) members.push(card)
  }
  const slotOf = new Map<string, number>()
  for (const members of laneMembers.values()) {
    const ordered = members
      .map((card, index) => ({ card, index }))
      .sort((a, b) => ((depth.get(a.card.id) ?? 0) - (depth.get(b.card.id) ?? 0)) || (a.index - b.index))
    for (let slot = 0; slot < ordered.length; slot++) {
      // 循环条件保证 ordered[slot] 存在。
      slotOf.set((ordered[slot] as { card: LayoutCard }).card.id, slot)
    }
  }
  const positions: Record<string, Position> = {}
  for (const card of cards) {
    const lane = laneOf.get(card.id) ?? 0
    const slot = slotOf.get(card.id) ?? 0
    positions[card.id] = {
      x: Math.round(origin.x + slot * CARD_STEP_X),
      y: Math.round(origin.y + lane * CARD_STEP_Y),
    }
  }
  return finish(model, positions, analysis.unresolved)
}

/** Engine table, so a setting can name an engine without a switch in app.js. */
export const LAYOUT_ENGINES: Readonly<Record<string, LayoutEngine>> = Object.freeze({
  [LAYOUT_MODES.horizontal]: layoutHorizontal,
  [LAYOUT_MODES.vertical]: layoutVertical,
  [LAYOUT_MODES.branch]: layoutByBranch,
})

/** Run one engine by id; unknown ids throw instead of silently doing nothing. */
export function layoutCards(model: LayoutModelInput | null | undefined, mode: unknown, options: LayoutOptions = {}): LayoutResult {
  const engines: Record<string, LayoutEngine | undefined> = LAYOUT_ENGINES
  // `mode` 保持 `unknown`：非法值必须走到下面那条 TypeError，而不是在类型层被拦。
  const engine = engines[mode as string]
  if (typeof engine !== 'function') throw new TypeError(`未知的布局模式: ${String(mode)}`)
  return engine(model, options)
}

/**
 * Turn a layout result into ONE batch command intent.
 *
 * Shape: `{ kind, patches: [{ area, id, before, after }] }` — exactly what
 * `createCommandHistory().commit()` records as a single undo entry, so "重新排版"
 * is one step to undo, not one step per card.
 *
 * - `before` is the stored manual position, or `null` when the card was never
 *   placed (same convention as `commands.moveCard`).
 * - Cards already at their target position are omitted, so a no-op re-layout
 *   yields `patches: []` and commits nothing.
 * - Only cards present in the model are patched; unknown layout entities keep
 *   their coordinates.
 */
export function layoutToCommandIntent(model: LayoutModelInput | null | undefined, positions: unknown, options: LayoutOptions = {}): LayoutIntent {
  if (!isPlainObject(positions)) throw new TypeError('positions 必须是对象')
  const area = typeof options.area === 'string' && options.area !== '' ? options.area : LAYOUT_PATCH_AREA
  const kind = typeof options.kind === 'string' && options.kind !== '' ? options.kind : LAYOUT_COMMAND_KIND
  const { cards } = cardsOf(model)
  const patches: LayoutPatch[] = []
  for (const card of cards) {
    const next = positions[card.id]
    if (next === undefined || next === null) continue
    if (!isPlainObject(next) || !finiteNumber(next.x) || !finiteNumber(next.y)) {
      throw new TypeError(`positions.${card.id} 必须是 { x, y } 有限数字`)
    }
    const after = { x: Math.round(next.x), y: Math.round(next.y) }
    const before = storedPosition(model, card.id)
    if (before !== null && before.x === after.x && before.y === after.y) continue
    patches.push({ area, id: card.id, before, after })
  }
  return { kind, patches }
}

/**
 * Convenience for the wiring stage: run an engine and build its intent.
 *
 * `layout` carries the engine result (movedCount / unresolved) for status text;
 * the top-level `kind`/`patches` stay commit-compatible.
 */
export function layoutIntent(model: LayoutModelInput | null | undefined, mode: unknown, options: LayoutOptions = {}): LayoutIntentWithResult {
  const result = layoutCards(model, mode, options)
  const intent = layoutToCommandIntent(model, result.positions, options)
  return { ...intent, layout: result }
}

export default layoutCards
