// 来源: dsh-synapnova@3fd1d00 canvas/model.js
/** Separator of the frozen card-id form: `<threadId>:<userQuestionSeq>`. */
export const CARD_ID_SEPARATOR = ':';
/**
 * Provisional fallback geometry, mirrored from app.js (`layoutConversationGraph`
 * defaults) so a card without a saved position still renders somewhere sane.
 * T4 owns the real layout engines; this module must not grow layout policy.
 */
export const NATURAL_ORIGIN = Object.freeze({ x: 86, y: 82 });
export const NATURAL_STEP_X = 365;
/**
 * 会话之间的行距（world 坐标）。
 *
 * 数值必须等于 `layout.ts` 的 `CARD_HEIGHT + CARD_GAP_Y`（276 + 42），否则
 * 「natural 排布」与「自动排版」两种布局对同一批卡片会算出不同的行高，用户在
 * 按 HOME 前后会看到卡片行距突然变化。
 *
 * 为什么在这里重复定义而不 import `layout.ts`：`layout.ts` 已经 `import` 了本
 * 模块（拿 `NATURAL_ORIGIN`/`NATURAL_STEP_X`），反向引用会形成循环依赖。
 * 两边的一致性靠 `layout.ts` 里那行 `CARD_STEP_Y = CARD_HEIGHT + CARD_GAP_Y`
 * 与 `model-natural-rows.test.ts` 的等值断言共同守住。
 */
export const NATURAL_STEP_Y = 318;
export const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 1 });
/** A card placeholder that stands for the whole thread (no user turns yet). */
export function threadCardId(threadId) {
    assertThreadId(threadId);
    return threadId;
}
/** The canonical, index-free card id for one user turn. */
export function questionCardId(threadId, userQuestionSeq) {
    assertThreadId(threadId);
    if (!Number.isSafeInteger(userQuestionSeq) || userQuestionSeq < 0)
        throw new TypeError('userQuestionSeq 必须是 0 基安全整数');
    return `${threadId}${CARD_ID_SEPARATOR}${userQuestionSeq}`;
}
/**
 * Split a card id back into its thread and turn. Thread ids may contain the
 * separator themselves (host session ids are opaque), so the numeric tail is
 * what identifies the turn; anything else is a thread-level card.
 */
export function parseCardId(cardId) {
    if (typeof cardId !== 'string' || cardId === '')
        return null;
    const match = /^(.*):(\d+)$/.exec(cardId);
    if (match === null)
        return { threadId: cardId, userQuestionSeq: null };
    const threadId = match[1] ?? '';
    return { threadId, userQuestionSeq: Number(match[2]) };
}
function assertThreadId(threadId) {
    if (typeof threadId !== 'string' || threadId === '')
        throw new TypeError('threadId 必须是非空字符串');
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/**
 * 投影文本字段的窄化读取。
 *
 * 冻结 schema 只校验 `message.id` / `message.sourceSeq`，没有强制 `text` /
 * `title` 是字符串；旧实现把这些值**原样**写进模型。这里保持原样透传，
 * 只在类型层面按既有契约记为 `string`——绝不插入 `String()` 或兜底转换，
 * 那会让导出结果与旧版不一致。
 */
function projectedText(value) {
    return value;
}
/** `Number.isSafeInteger` 的类型守卫形式（守卫本身不改变判定结果）。 */
function isEventSeq(value) {
    return Number.isSafeInteger(value);
}
/** `Number.isInteger` 的类型守卫形式（判定结果与直接调用完全一致）。 */
function isInteger(value) {
    return Number.isInteger(value);
}
/** 取字段里的安全整数，非安全整数/非数字一律 `undefined`（与原三元表达式等价）。 */
function safeIntegerField(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}
function deepFreeze(value) {
    if (Array.isArray(value)) {
        for (const item of value)
            deepFreeze(item);
        return Object.freeze(value);
    }
    if (isPlainObject(value)) {
        for (const key of Object.keys(value))
            deepFreeze(value[key]);
        return Object.freeze(value);
    }
    return value;
}
function copyPosition(value) {
    if (!isPlainObject(value) || !finite(value.x) || !finite(value.y))
        return null;
    return { x: value.x, y: value.y };
}
function normalizeViewport(value) {
    if (!isPlainObject(value))
        return { ...DEFAULT_VIEWPORT };
    const x = finite(value.x) ? value.x : 0;
    const y = finite(value.y) ? value.y : 0;
    const zoom = finite(value.zoom) && value.zoom > 0 ? value.zoom : 1;
    return { x, y, zoom };
}
function messagesOf(thread) {
    return Array.isArray(thread['messages']) ? thread['messages'] : [];
}
/**
 * Assign 0-based user-question ordinals inside one thread.
 *
 * Ordinals follow projection order (the same order app.js walks), so a card id
 * stays the same when a later message arrives or when the thread array moves.
 * Injected/non-user messages never consume an ordinal.
 */
function turnsOf(thread) {
    const turns = [];
    for (const message of messagesOf(thread)) {
        if (!isPlainObject(message) || message['kind'] !== 'user')
            continue;
        turns.push({ message, userQuestionSeq: turns.length });
    }
    return turns;
}
function copyRegion(region) {
    if (!isPlainObject(region) || typeof region.id !== 'string' || region.id === '')
        return null;
    if (!finite(region.x) || !finite(region.y) || !finite(region.w) || !finite(region.h))
        return null;
    if (region.w <= 0 || region.h <= 0)
        return null;
    return { id: region.id, name: typeof region.name === 'string' ? region.name : '', x: region.x, y: region.y, w: region.w, h: region.h };
}
function copyAnnotation(annotation) {
    if (!isPlainObject(annotation) || typeof annotation.id !== 'string' || annotation.id === '')
        return null;
    if (!finite(annotation.x) || !finite(annotation.y) || typeof annotation.text !== 'string')
        return null;
    const hasCard = typeof annotation.targetCardId === 'string' && annotation.targetCardId !== '';
    const hasRegion = typeof annotation.targetRegionId === 'string' && annotation.targetRegionId !== '';
    // The frozen document shape requires exactly one target; a snapshot that
    // violates it is dropped instead of being re-guessed here.
    if (hasCard === hasRegion)
        return null;
    return {
        id: annotation.id,
        x: annotation.x,
        y: annotation.y,
        text: annotation.text,
        targetCardId: hasCard ? annotation.targetCardId : null,
        targetRegionId: hasRegion ? annotation.targetRegionId : null,
    };
}
function annotationsList(value) {
    const list = [];
    if (!Array.isArray(value))
        return list;
    for (const item of value) {
        const annotation = copyAnnotation(item);
        if (annotation !== null)
            list.push(annotation);
    }
    return list;
}
function regionsList(value) {
    const list = [];
    if (!Array.isArray(value))
        return list;
    for (const item of value) {
        const region = copyRegion(item);
        if (region !== null)
            list.push(region);
    }
    return list;
}
/**
 * Read the layout/region/annotation fields out of a snapshot.
 *
 * Accepts either the plain field bundle (`{ cards, collapsed, viewport, ... }`)
 * or a workspace document (`{ layout, regions, annotations }`). Returns plain
 * immutable copies so callers never alias Store objects.
 */
export function readLayout(snapshot = {}) {
    if (!isPlainObject(snapshot))
        throw new TypeError('snapshot 必须是对象');
    const layout = isPlainObject(snapshot['layout']) ? snapshot['layout'] : snapshot;
    const cards = {};
    if (isPlainObject(layout['cards'])) {
        for (const [cardId, position] of Object.entries(layout['cards'])) {
            const copy = copyPosition(position);
            if (copy !== null)
                cards[cardId] = copy;
        }
    }
    const collapsed = {};
    if (isPlainObject(layout['collapsed'])) {
        for (const [cardId, value] of Object.entries(layout['collapsed']))
            if (value === true)
                collapsed[cardId] = true;
    }
    const viewport = normalizeViewport(layout['viewport']);
    const regions = regionsList(snapshot['regions']);
    const annotations = annotationsList(snapshot['annotations']);
    // Branch anchors are UI state (the exact card the user branched from), not a
    // persisted document field — so they arrive through the layout bundle and are
    // optional. Without them the lineage pass falls back to the seed boundary.
    const branchAnchors = {};
    const rawAnchors = layout['branchAnchors'] ?? snapshot['branchAnchors'];
    if (isPlainObject(rawAnchors)) {
        for (const [threadId, cardId] of Object.entries(rawAnchors)) {
            if (typeof threadId === 'string' && typeof cardId === 'string' && cardId !== '')
                branchAnchors[threadId] = cardId;
        }
    }
    return {
        cards,
        collapsed,
        viewport,
        regions,
        annotations,
        branchAnchors,
    };
}
function buildCards(threads, layout) {
    const cards = [];
    const cardsById = {};
    const threadsSummary = [];
    // Per-thread card list, needed to resolve a fork's inherited parent card.
    const cardsByThread = new Map();
    /**
     * 已排版会话的序号，用于把每个会话的未落位卡片**错开成一行**（UI-D13）。
     *
     * 为什么必须有它：下面每个线程的 `naturalPosition` 都从 `NATURAL_ORIGIN` 起算，
     * 于是**所有会话的首张卡都落在同一个 (86, 82)**。29 个会话就是 29 张卡完全重叠
     * ——用户看到的是「切目录后卡片堆在一起」，实际是一堆卡片坐标相同。
     *
     * 用会话序号做行偏移（y），会话内仍按提问顺序水平展开（x），正是用户要的
     * 「按会话内顺序排列」。行高取 `CARD_STEP_Y`（卡片高 + 间隙），保证不重叠。
     */
    let threadRow = 0;
    for (const thread of threads) {
        if (!isPlainObject(thread) || typeof thread.id !== 'string' || thread.id === '')
            continue;
        const threadId = thread.id;
        const turns = turnsOf(thread);
        const rowOffset = threadRow * NATURAL_STEP_Y;
        threadRow += 1;
        threadsSummary.push({
            id: threadId,
            title: projectedText(thread.dshSessionTitle ?? thread.title ?? ''),
            parentId: typeof thread.parentId === 'string' ? thread.parentId : null,
            dshSessionId: typeof thread.dshSessionId === 'string' ? thread.dshSessionId : null,
            color: typeof thread.color === 'string' ? thread.color : null,
        });
        const firstId = turns.length === 0 ? threadCardId(threadId) : questionCardId(threadId, 0);
        let previousNatural = { x: NATURAL_ORIGIN.x, y: NATURAL_ORIGIN.y + rowOffset };
        let previousId = null;
        const threadCards = [];
        for (let index = 0; index < Math.max(turns.length, 1); index++) {
            const turn = turns[index];
            // 循环上界保证：turns 为空时 `turn` 必为 undefined，非空时必存在。
            // 两种写法在该循环内等价，只是把「线程无用户提问」这一事实挂在 turn 上。
            const id = turn === undefined ? firstId : questionCardId(threadId, turn.userQuestionSeq);
            const stored = layout.cards[id];
            const naturalPosition = index === 0
                ? { x: NATURAL_ORIGIN.x, y: NATURAL_ORIGIN.y + rowOffset }
                : { x: previousNatural.x + NATURAL_STEP_X, y: previousNatural.y };
            const position = stored === undefined ? null : { x: stored.x, y: stored.y };
            const card = {
                id,
                threadId,
                userQuestionSeq: turn === undefined ? null : turn.userQuestionSeq,
                // Intra-thread predecessor. A fork's FIRST card gets its cross-thread
                // parent assigned in the lineage pass below.
                parentId: previousId,
                threadParentId: typeof thread.parentId === 'string' ? thread.parentId : null,
                previousCardId: previousId,
                sourceSeq: turn === undefined ? undefined : turn.message['sourceSeq'],
                title: projectedText(thread.dshSessionTitle ?? thread.title ?? ''),
                question: projectedText(turn === undefined ? '' : (turn.message['text'] ?? '')),
                naturalPosition,
                position,
                positionLocked: position !== null,
                collapsed: layout.collapsed[id] === true,
            };
            cards.push(card);
            cardsById[id] = card;
            threadCards.push(card);
            previousNatural = naturalPosition;
            previousId = id;
        }
        cardsByThread.set(threadId, threadCards);
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
        const cardsOfThread = cardsByThread.get(thread.id);
        const firstChild = cardsOfThread?.[0];
        if (firstChild === undefined)
            continue;
        // `firstChild` is by construction the thread's FIRST card, so its parentId is
        // always null here (only `previousId` — which is null at index 0 — feeds it).
        // An `if (firstChild.parentId !== null) continue` guard would therefore be
        // unreachable code that no test could exercise; the lineage pass instead only
        // ever assigns to this one card, leaving later cards' intra-thread chain alone.
        const parentThreadId = typeof thread.parentId === 'string' && thread.parentId !== '' ? thread.parentId : null;
        if (parentThreadId === null)
            continue;
        const anchor = layout.branchAnchors[thread.id];
        if (typeof anchor === 'string' && anchor !== '' && cardsById[anchor] !== undefined) {
            firstChild.parentId = anchor;
            continue;
        }
        const parentCards = cardsByThread.get(parentThreadId);
        if (parentCards === undefined || parentCards.length === 0)
            continue;
        // ONLY the persisted boundary is usable here. Substituting the child's own
        // first `sourceSeq` looks like a boundary but is not one: it is a position in
        // the CHILD's event stream, so treating it as "how much of the parent was
        // inherited" silently picks an arbitrary parent card and reports it as
        // proven. Without a real `sourceSeedLength` the link is honestly inferred.
        const seedLength = safeIntegerField(thread['sourceSeedLength']);
        if (seedLength !== undefined) {
            // Strictly below the seed boundary: the child inherited those parent events,
            // so the last one before the boundary is the Turn it forked from.
            const inherited = parentCards.filter(candidate => isInteger(candidate.sourceSeq) && candidate.sourceSeq < seedLength).at(-1);
            if (inherited !== undefined) {
                firstChild.parentId = inherited.id;
                continue;
            }
        }
        // No anchor and no usable seed boundary: fall back to the parent thread's last
        // card so the branch is at least visibly connected, and RECORD that the link
        // was inferred rather than proven — a consumer that needs certainty (or a
        // preview that must not overstate) can check this flag.
        const lastParent = parentCards.at(-1);
        // 上一行的 `length === 0` 已排除空数组，这里只是把同一个事实告诉类型系统。
        if (lastParent === undefined)
            continue;
        firstChild.parentId = lastParent.id;
        firstChild.parentIdInferred = true;
    }
    return { cards, cardsById, threads: threadsSummary };
}
/**
 * Threads in the order they were declared.
 *
 * The lineage pass must not depend on iteration order for its RESULT (each child
 * only reads its parent's card list, which is already complete), but keeping the
 * declaration order makes the output stable for a given snapshot.
 */
function threadsByIterationOrder(threads) {
    const kept = [];
    for (const thread of threads) {
        if (!isPlainObject(thread) || typeof thread.id !== 'string' || thread.id === '')
            continue;
        kept.push(thread);
    }
    return kept;
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
    if (!isPlainObject(snapshot))
        throw new TypeError('snapshot 必须是对象');
    /**
     * 宿主快照有两种形状，这里统一收口：
     *   - 工作区文档本体：`{ projection, layout, ... }`（列表项 / 导出物）
     *   - 单工作区接口的**信封**：`{ format, schemaVersion, workspace: { ... } }`
     *
     * 为什么要在这里兼容而不是只在前端剥一层：`GET /api/workspaces/<id>` 返回的是
     * 信封，而 `buildCanvasModel` 的调用方不止前端一处（导出、测试夹具都用它）。
     * 只在前端剥，别处照样会把信封当文档、得到一个空画布；而且这种错是**静默**的
     * ——不报错，只是没有卡片，正是本项目最怕的「假成功」。
     *
     * 信封识别只看 `workspace` 是否为对象且**不是**数组：`workspace` 是工作区文档
     * 的专属字段，别的形状不会碰巧带它。
     */
    const inner = isPlainObject(snapshot['workspace']) ? snapshot['workspace'] : null;
    const document = inner ?? snapshot;
    const projection = isPlainObject(document['projection']) ? document['projection'] : null;
    const threads = projection !== null && Array.isArray(projection['threads'])
        ? projection['threads']
        : Array.isArray(document['threads']) ? document['threads'] : [];
    const layout = readLayout(document);
    const { cards, cardsById, threads: threadsSummary } = buildCards(threads, layout);
    const knownIds = new Set(cards.map(card => card.id));
    const unmatchedCardIds = Object.keys(layout.cards).filter(cardId => !knownIds.has(cardId));
    const collapsedCardIds = Object.keys(layout.collapsed).filter(cardId => knownIds.has(cardId));
    const unmatchedCollapsedIds = Object.keys(layout.collapsed).filter(cardId => !knownIds.has(cardId));
    const regionsById = {};
    for (const region of layout.regions)
        regionsById[region.id] = region;
    const skipped = [];
    // Availability is computed, never stored: a card or region can disappear from
    // the projection while its note must survive with an explicit marker.
    const annotations = layout.annotations.map(annotation => {
        // `targetRegionId` 走到这里时按冻结形状必为字符串；原实现对 `null` 也是同一次
        // JS 属性查找（`regionsById[null]` → `regionsById["null"]`），断言不改运行时语义。
        const availability = annotation.targetCardId !== null
            ? (knownIds.has(annotation.targetCardId) ? 'ok' : 'missing-source')
            : (regionsById[annotation.targetRegionId] === undefined ? 'missing-source' : 'ok');
        return { ...annotation, availability };
    });
    const annotationsById = {};
    for (const annotation of annotations)
        annotationsById[annotation.id] = annotation;
    if (Array.isArray(document['regions']) && document['regions'].length !== layout.regions.length)
        skipped.push({ area: 'regions', reason: 'invalid' });
    if (Array.isArray(document['annotations']) && document['annotations'].length !== layout.annotations.length)
        skipped.push({ area: 'annotations', reason: 'invalid' });
    return deepFreeze({
        workspaceId: typeof document['id'] === 'string' ? document['id'] : (typeof document['workspaceId'] === 'string' ? document['workspaceId'] : null),
        revision: isEventSeq(document['revision']) ? document['revision'] : null,
        projectionEpoch: isEventSeq(document['projectionEpoch']) ? document['projectionEpoch'] : null,
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
    });
}
/** One card, or null. */
export function getCard(model, cardId) {
    return model?.cardsById?.[cardId] ?? null;
}
/** Stored (manual) position, or null when the card was never placed manually. */
export function getCardPosition(model, cardId) {
    const position = model?.layoutCards?.[cardId];
    return position === undefined ? null : { x: position.x, y: position.y };
}
/** Position to draw at: manual position when present, else natural fallback. */
export function getResolvedPosition(model, cardId) {
    const card = getCard(model, cardId);
    if (card === null)
        return null;
    return card.position === null ? { ...card.naturalPosition } : { x: card.position.x, y: card.position.y };
}
export function isCardCollapsed(model, cardId) {
    return model?.cardsById?.[cardId]?.collapsed === true;
}
export function getRegion(model, regionId) {
    return model?.regionsById?.[regionId] ?? null;
}
export function getAnnotation(model, annotationId) {
    return model?.annotationsById?.[annotationId] ?? null;
}
/**
 * 视口副本。
 *
 * 入参保持 `unknown`：`canvas/navigation` 等调用方把任意模型形状传进来，旧实现
 * 用 `model?.viewport ?? DEFAULT_VIEWPORT` 天然接受任何值。这里逐字保留那条
 * 可选访问 + 空值合并，只补类型断言——不做额外的形状校验，否则会改变
 * 「模型缺 viewport 时回落到默认视口」以外的行为。
 */
export function getViewport(model) {
    const source = model;
    return { ...(source?.viewport ?? DEFAULT_VIEWPORT) };
}
/** Annotations attached to a card, including ones whose card vanished. */
export function annotationsForCard(model, cardId) {
    if (typeof cardId !== 'string' || cardId === '')
        return [];
    return (model?.annotations ?? []).filter(annotation => annotation.targetCardId === cardId);
}
export function annotationsForRegion(model, regionId) {
    if (typeof regionId !== 'string' || regionId === '')
        return [];
    return (model?.annotations ?? []).filter(annotation => annotation.targetRegionId === regionId);
}
/** Annotations whose target is gone; they stay, marked `missing-source`. */
export function missingSourceAnnotations(model) {
    return (model?.annotations ?? []).filter(annotation => annotation.availability === 'missing-source');
}
/**
 * Cards whose resolved position falls inside a region box.
 *
 * Used for region highlighting and for proving that deleting a region only
 * detaches association — membership is computed, never stored, so no card can
 * be removed by deleting a box.
 */
export function cardsInsideRegion(model, regionId) {
    const region = getRegion(model, regionId);
    if (region === null)
        return [];
    const inside = [];
    for (const card of model?.cards ?? []) {
        const position = card.position === null ? card.naturalPosition : card.position;
        if (position.x >= region.x && position.x <= region.x + region.w && position.y >= region.y && position.y <= region.y + region.h)
            inside.push(card.id);
    }
    return inside;
}
/**
 * Project a model back to the plain layout bundle commands operate on.
 *
 * `layoutCards` is copied wholesale (not only known card ids) so unknown
 * entities such as material nodes keep their coordinates.
 */
export function layoutBundle(model) {
    const cards = {};
    for (const [cardId, position] of Object.entries(model?.layoutCards ?? {}))
        cards[cardId] = { x: position.x, y: position.y };
    const collapsed = {};
    for (const cardId of model?.collapsedCardIds ?? [])
        collapsed[cardId] = true;
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
    };
}
//# sourceMappingURL=model.js.map