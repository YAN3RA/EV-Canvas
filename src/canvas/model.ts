// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova@3fd1d00 canvas/model.js，行为完整、类型标注待补。
// 来源: dsh-synapnova@3fd1d00 canvas/model.js

/**
 * Canvas entity model — stable-ID view of one workspace revision.
 *
 * Pure module: no DOM, no host access, no IO. Input is a read-only snapshot
 * (the workspace document from the Store, or explicit field arguments), output
 * is a deeply frozen model. Inputs are never mutated.
 *
 * Why stable IDs: a canvas card is keyed by `<threadId>:<userQuestionSeq>`
 * (thread-level placeholder: `<threadId>`), never by an array index. Appending a
 * message, reordering `projection.threads`, or inserting a new thread therefore
 * cannot re-bind a saved position or collapsed flag to a different card. The
 * card ID shape is frozen by T0 §8.3; keep it in sync with the Store and with
 * app.js `conversationCards`.
 *
 * Field ownership: this file only READS `layout` / `regions` / `annotations`
 * and the projection threads it derives cards from. Writing is `commands.js`;
 * projection updates never touch layout fields.
 */

/** Separator of the frozen card-id form: `<threadId>:<userQuestionSeq>`. */
export const CARD_ID_SEPARATOR = ':'

/**
 * Provisional fallback geometry, mirrored from app.js (`layoutConversationGraph`
 * defaults) so a card without a saved position still renders somewhere sane.
 * T4 owns the real layout engines; this module must not grow layout policy.
 */
export const NATURAL_ORIGIN = Object.freeze({ x: 86, y: 82 })
export const NATURAL_STEP_X = 365
export const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 1 })

/** A card placeholder that stands for the whole thread (no user turns yet). */
export function threadCardId(threadId) {
  assertThreadId(threadId)
  return threadId
}

/** The canonical, index-free card id for one user turn. */
export function questionCardId(threadId, userQuestionSeq) {
  assertThreadId(threadId)
  if (!Number.isSafeInteger(userQuestionSeq) || userQuestionSeq < 0) throw new TypeError('userQuestionSeq 必须是 0 基安全整数')
  return `${threadId}${CARD_ID_SEPARATOR}${userQuestionSeq}`
}

/**
 * Split a card id back into its thread and turn. Thread ids may contain the
 * separator themselves (host session ids are opaque), so the numeric tail is
 * what identifies the turn; anything else is a thread-level card.
 */
export function parseCardId(cardId) {
  if (typeof cardId !== 'string' || cardId === '') return null
  const match = /^(.*):(\d+)$/.exec(cardId)
  if (match === null) return { threadId: cardId, userQuestionSeq: null }
  return { threadId: match[1], userQuestionSeq: Number(match[2]) }
}

function assertThreadId(threadId) {
  if (typeof threadId !== 'string' || threadId === '') throw new TypeError('threadId 必须是非空字符串')
}

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

function copyPosition(value) {
  if (!isPlainObject(value) || !finite(value.x) || !finite(value.y)) return null
  return { x: value.x, y: value.y }
}

function normalizeViewport(value) {
  if (!isPlainObject(value)) return { ...DEFAULT_VIEWPORT }
  const x = finite(value.x) ? value.x : 0
  const y = finite(value.y) ? value.y : 0
  const zoom = finite(value.zoom) && value.zoom > 0 ? value.zoom : 1
  return { x, y, zoom }
}

function messagesOf(thread) {
  return Array.isArray(thread?.messages) ? thread.messages : []
}

/**
 * Assign 0-based user-question ordinals inside one thread.
 *
 * Ordinals follow projection order (the same order app.js walks), so a card id
 * stays the same when a later message arrives or when the thread array moves.
 * Injected/non-user messages never consume an ordinal.
 */
function turnsOf(thread) {
  const turns = []
  for (const message of messagesOf(thread)) {
    if (message?.kind !== 'user') continue
    turns.push({ message, userQuestionSeq: turns.length })
  }
  return turns
}

function copyRegion(region) {
  if (!isPlainObject(region) || typeof region.id !== 'string' || region.id === '') return null
  if (!finite(region.x) || !finite(region.y) || !finite(region.w) || !finite(region.h)) return null
  if (region.w <= 0 || region.h <= 0) return null
  return { id: region.id, name: typeof region.name === 'string' ? region.name : '', x: region.x, y: region.y, w: region.w, h: region.h }
}

function copyAnnotation(annotation) {
  if (!isPlainObject(annotation) || typeof annotation.id !== 'string' || annotation.id === '') return null
  if (!finite(annotation.x) || !finite(annotation.y) || typeof annotation.text !== 'string') return null
  const hasCard = typeof annotation.targetCardId === 'string' && annotation.targetCardId !== ''
  const hasRegion = typeof annotation.targetRegionId === 'string' && annotation.targetRegionId !== ''
  // The frozen document shape requires exactly one target; a snapshot that
  // violates it is dropped instead of being re-guessed here.
  if (hasCard === hasRegion) return null
  return {
    id: annotation.id,
    x: annotation.x,
    y: annotation.y,
    text: annotation.text,
    targetCardId: hasCard ? annotation.targetCardId : null,
    targetRegionId: hasRegion ? annotation.targetRegionId : null,
  }
}

function annotationsList(value) {
  const list = []
  if (!Array.isArray(value)) return list
  for (const item of value) {
    const annotation = copyAnnotation(item)
    if (annotation !== null) list.push(annotation)
  }
  return list
}

function regionsList(value) {
  const list = []
  if (!Array.isArray(value)) return list
  for (const item of value) {
    const region = copyRegion(item)
    if (region !== null) list.push(region)
  }
  return list
}

/**
 * Read the layout/region/annotation fields out of a snapshot.
 *
 * Accepts either the plain field bundle (`{ cards, collapsed, viewport, ... }`)
 * or a workspace document (`{ layout, regions, annotations }`). Returns plain
 * immutable copies so callers never alias Store objects.
 */
export function readLayout(snapshot = {}) {
  if (!isPlainObject(snapshot)) throw new TypeError('snapshot 必须是对象')
  const layout = isPlainObject(snapshot.layout) ? snapshot.layout : snapshot
  const cards = {}
  if (isPlainObject(layout.cards)) {
    for (const [cardId, position] of Object.entries(layout.cards)) {
      const copy = copyPosition(position)
      if (copy !== null) cards[cardId] = copy
    }
  }
  const collapsed = {}
  if (isPlainObject(layout.collapsed)) {
    for (const [cardId, value] of Object.entries(layout.collapsed)) if (value === true) collapsed[cardId] = true
  }
  const viewport = normalizeViewport(layout.viewport)
  const regions = regionsList(snapshot.regions)
  const annotations = annotationsList(snapshot.annotations)
  // Branch anchors are UI state (the exact card the user branched from), not a
  // persisted document field — so they arrive through the layout bundle and are
  // optional. Without them the lineage pass falls back to the seed boundary.
  const branchAnchors = {}
  const rawAnchors = layout.branchAnchors ?? snapshot.branchAnchors
  if (isPlainObject(rawAnchors)) {
    for (const [threadId, cardId] of Object.entries(rawAnchors)) {
      if (typeof threadId === 'string' && typeof cardId === 'string' && cardId !== '') branchAnchors[threadId] = cardId
    }
  }
  return {
    cards,
    collapsed,
    viewport,
    regions,
    annotations,
    branchAnchors,
  }
}

function buildCards(threads, layout) {
  const cards = []
  const cardsById = {}
  const threadsSummary = []
  // Per-thread card list, needed to resolve a fork's inherited parent card.
  const cardsByThread = new Map()
  for (const thread of threads) {
    if (!isPlainObject(thread) || typeof thread.id !== 'string' || thread.id === '') continue
    const turns = turnsOf(thread)
    threadsSummary.push({
      id: thread.id,
      title: thread.dshSessionTitle ?? thread.title ?? '',
      parentId: typeof thread.parentId === 'string' ? thread.parentId : null,
      dshSessionId: typeof thread.dshSessionId === 'string' ? thread.dshSessionId : null,
      color: typeof thread.color === 'string' ? thread.color : null,
    })
    const firstId = turns.length === 0 ? threadCardId(thread.id) : questionCardId(thread.id, 0)
    let previousNatural = { ...NATURAL_ORIGIN }
    let previousId = null
    const threadCards = []
    for (let index = 0; index < Math.max(turns.length, 1); index++) {
      const turn = turns[index]
      const id = turns.length === 0 ? firstId : questionCardId(thread.id, turn.userQuestionSeq)
      const stored = layout.cards[id]
      const naturalPosition = index === 0 ? { ...NATURAL_ORIGIN } : { x: previousNatural.x + NATURAL_STEP_X, y: previousNatural.y }
      const position = stored === undefined ? null : { x: stored.x, y: stored.y }
      const card = {
        id,
        threadId: thread.id,
        userQuestionSeq: turns.length === 0 ? null : turn.userQuestionSeq,
        // Intra-thread predecessor. A fork's FIRST card gets its cross-thread
        // parent assigned in the lineage pass below.
        parentId: previousId,
        threadParentId: typeof thread.parentId === 'string' ? thread.parentId : null,
        previousCardId: previousId,
        sourceSeq: turns.length === 0 ? undefined : turn.message.sourceSeq,
        title: thread.dshSessionTitle ?? thread.title ?? '',
        question: turns.length === 0 ? '' : (turn.message.text ?? ''),
        naturalPosition,
        position,
        positionLocked: position !== null,
        collapsed: layout.collapsed[id] === true,
      }
      cards.push(card)
      cardsById[id] = card
      threadCards.push(card)
      previousNatural = naturalPosition
      previousId = id
    }
    cardsByThread.set(thread.id, threadCards)
  }

  // ── Lineage: wire the cross-thread branch parent onto the child's FIRST card ──
  //
  // Without this pass `card.parentId` only ever expressed the INTRA-thread
  // predecessor, so a fork's first card had no parent. The canvas hid that (it
  // recomputes lineage itself in app.js) but every consumer of this model — the
  // PNG export in particular — drew a fork with no edge at all.
  //
  // The rule is deliberately the SAME one app.js uses, or the picture and the
  // screen would disagree about which Turn a branch was born from:
  //   1. `branchAnchors` (when the caller supplies them) wins: it records the
  //      exact card the user branched from, which no persisted field can express.
  //   2. otherwise the inherited Turn: a fork inherits every parent event before
  //      DSH's durable seed boundary, so the latest parent question strictly
  //      below `sourceSeedLength` is the Turn the child was created at.
  //   3. otherwise no parent at all — never guess from coordinates.
  for (const thread of threadsByIterationOrder(threads)) {
    const cardsOfThread = cardsByThread.get(thread.id)
    const firstChild = cardsOfThread?.[0]
    if (firstChild === undefined) continue
    // `firstChild` is by construction the thread's FIRST card, so its parentId is
    // always null here (only `previousId` — which is null at index 0 — feeds it).
    // An `if (firstChild.parentId !== null) continue` guard would therefore be
    // unreachable code that no test could exercise; the lineage pass instead only
    // ever assigns to this one card, leaving later cards' intra-thread chain alone.
    const parentThreadId = typeof thread.parentId === 'string' && thread.parentId !== '' ? thread.parentId : null
    if (parentThreadId === null) continue
    const anchor = layout.branchAnchors?.[thread.id]
    if (typeof anchor === 'string' && anchor !== '' && cardsById[anchor] !== undefined) {
      firstChild.parentId = anchor
      continue
    }
    const parentCards = cardsByThread.get(parentThreadId)
    if (parentCards === undefined || parentCards.length === 0) continue
    // ONLY the persisted boundary is usable here. Substituting the child's own
    // first `sourceSeq` looks like a boundary but is not one: it is a position in
    // the CHILD's event stream, so treating it as "how much of the parent was
    // inherited" silently picks an arbitrary parent card and reports it as
    // proven. Without a real `sourceSeedLength` the link is honestly inferred.
    const seedLength = Number.isSafeInteger(thread.sourceSeedLength) ? thread.sourceSeedLength : undefined
    if (Number.isSafeInteger(seedLength)) {
      // Strictly below the seed boundary: the child inherited those parent events,
      // so the last one before the boundary is the Turn it forked from.
      const inherited = parentCards.filter(candidate => Number.isInteger(candidate.sourceSeq) && candidate.sourceSeq < seedLength).at(-1)
      if (inherited !== undefined) {
        firstChild.parentId = inherited.id
        continue
      }
    }
    // No anchor and no usable seed boundary: fall back to the parent thread's last
    // card so the branch is at least visibly connected, and RECORD that the link
    // was inferred rather than proven — a consumer that needs certainty (or a
    // preview that must not overstate) can check this flag.
    firstChild.parentId = parentCards.at(-1).id
    firstChild.parentIdInferred = true
  }

  return { cards, cardsById, threads: threadsSummary }
}

/**
 * Threads in the order they were declared.
 *
 * The lineage pass must not depend on iteration order for its RESULT (each child
 * only reads its parent's card list, which is already complete), but keeping the
 * declaration order makes the output stable for a given snapshot.
 */
function threadsByIterationOrder(threads) {
  return threads.filter(thread => isPlainObject(thread) && typeof thread.id === 'string' && thread.id !== '')
}

/**
 * Build the immutable canvas model for one workspace snapshot.
 *
 * `snapshot` may be a workspace document (`projection.threads`, `layout`,
 * `regions`, `annotations`) or explicit fields (`threads`, `layout`, ...).
 * Unknown layout keys are preserved in `layoutCards` and reported in
 * `unmatchedCardIds` (material nodes keep their positions this way); they are
 * never dropped just because this module does not know their type.
 */
export function buildCanvasModel(snapshot = {}) {
  if (!isPlainObject(snapshot)) throw new TypeError('snapshot 必须是对象')
  const threads = Array.isArray(snapshot.projection?.threads)
    ? snapshot.projection.threads
    : Array.isArray(snapshot.threads) ? snapshot.threads : []
  const layout = readLayout(snapshot)
  const { cards, cardsById, threads: threadsSummary } = buildCards(threads, layout)
  const knownIds = new Set(cards.map(card => card.id))
  const unmatchedCardIds = Object.keys(layout.cards).filter(cardId => !knownIds.has(cardId))
  const collapsedCardIds = Object.keys(layout.collapsed).filter(cardId => knownIds.has(cardId))
  const unmatchedCollapsedIds = Object.keys(layout.collapsed).filter(cardId => !knownIds.has(cardId))
  const regionsById = {}
  for (const region of layout.regions) regionsById[region.id] = region
  const skipped = []
  // Availability is computed, never stored: a card or region can disappear from
  // the projection while its note must survive with an explicit marker.
  const annotations = layout.annotations.map(annotation => {
    const availability = annotation.targetCardId !== null
      ? (knownIds.has(annotation.targetCardId) ? 'ok' : 'missing-source')
      : (regionsById[annotation.targetRegionId] === undefined ? 'missing-source' : 'ok')
    return { ...annotation, availability }
  })
  const annotationsById = {}
  for (const annotation of annotations) annotationsById[annotation.id] = annotation
  if (Array.isArray(snapshot.regions) && snapshot.regions.length !== layout.regions.length) skipped.push({ area: 'regions', reason: 'invalid' })
  if (Array.isArray(snapshot.annotations) && snapshot.annotations.length !== layout.annotations.length) skipped.push({ area: 'annotations', reason: 'invalid' })
  return deepFreeze({
    workspaceId: typeof snapshot.id === 'string' ? snapshot.id : (typeof snapshot.workspaceId === 'string' ? snapshot.workspaceId : null),
    revision: Number.isSafeInteger(snapshot.revision) ? snapshot.revision : null,
    projectionEpoch: Number.isSafeInteger(snapshot.projectionEpoch) ? snapshot.projectionEpoch : null,
    viewport: layout.viewport,
    cards,
    cardsById,
    cardOrder: cards.map(card => card.id),
    collapsedCardIds,
    threads: threadsSummary,
    regions: layout.regions,
    regionsById,
    annotations,
    annotationsById,
    layoutCards: layout.cards,
    unmatchedCardIds,
    unmatchedCollapsedIds,
    skipped,
  })
}

/** One card, or null. */
export function getCard(model, cardId) {
  return model?.cardsById?.[cardId] ?? null
}

/** Stored (manual) position, or null when the card was never placed manually. */
export function getCardPosition(model, cardId) {
  const position = model?.layoutCards?.[cardId]
  return position === undefined ? null : { x: position.x, y: position.y }
}

/** Position to draw at: manual position when present, else natural fallback. */
export function getResolvedPosition(model, cardId) {
  const card = getCard(model, cardId)
  if (card === null) return null
  return card.position === null ? { ...card.naturalPosition } : { x: card.position.x, y: card.position.y }
}

export function isCardCollapsed(model, cardId) {
  return model?.cardsById?.[cardId]?.collapsed === true
}

export function getRegion(model, regionId) {
  return model?.regionsById?.[regionId] ?? null
}

export function getAnnotation(model, annotationId) {
  return model?.annotationsById?.[annotationId] ?? null
}

export function getViewport(model) {
  return { ...(model?.viewport ?? DEFAULT_VIEWPORT) }
}

/** Annotations attached to a card, including ones whose card vanished. */
export function annotationsForCard(model, cardId) {
  if (typeof cardId !== 'string' || cardId === '') return []
  return (model?.annotations ?? []).filter(annotation => annotation.targetCardId === cardId)
}

export function annotationsForRegion(model, regionId) {
  if (typeof regionId !== 'string' || regionId === '') return []
  return (model?.annotations ?? []).filter(annotation => annotation.targetRegionId === regionId)
}

/** Annotations whose target is gone; they stay, marked `missing-source`. */
export function missingSourceAnnotations(model) {
  return (model?.annotations ?? []).filter(annotation => annotation.availability === 'missing-source')
}

/**
 * Cards whose resolved position falls inside a region box.
 *
 * Used for region highlighting and for proving that deleting a region only
 * detaches association — membership is computed, never stored, so no card can
 * be removed by deleting a box.
 */
export function cardsInsideRegion(model, regionId) {
  const region = getRegion(model, regionId)
  if (region === null) return []
  const inside = []
  for (const card of model.cards) {
    const position = card.position === null ? card.naturalPosition : card.position
    if (position.x >= region.x && position.x <= region.x + region.w && position.y >= region.y && position.y <= region.y + region.h) inside.push(card.id)
  }
  return inside
}

/**
 * Project a model back to the plain layout bundle commands operate on.
 *
 * `layoutCards` is copied wholesale (not only known card ids) so unknown
 * entities such as material nodes keep their coordinates.
 */
export function layoutBundle(model) {
  const cards = {}
  for (const [cardId, position] of Object.entries(model?.layoutCards ?? {})) cards[cardId] = { x: position.x, y: position.y }
  const collapsed = {}
  for (const cardId of model?.collapsedCardIds ?? []) collapsed[cardId] = true
  return {
    cards,
    collapsed,
    viewport: { ...(model?.viewport ?? DEFAULT_VIEWPORT) },
    regions: (model?.regions ?? []).map(region => ({ ...region })),
    annotations: (model?.annotations ?? []).map(annotation => ({
      id: annotation.id,
      x: annotation.x,
      y: annotation.y,
      text: annotation.text,
      targetCardId: annotation.targetCardId,
      targetRegionId: annotation.targetRegionId,
    })),
  }
}
