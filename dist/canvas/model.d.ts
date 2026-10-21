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
 *
 * 类型口径：入参是**不受信的快照**，因此一律以 `unknown` 进、经守卫收窄；
 * 输出是本模块自己构造的形状，用下面的具名接口精确描述。投影来源的文本字段
 * （`title` / `question` / `sourceSeq`）在冻结 schema 里并未强制类型，这里按
 * 既有契约断言而不做任何转换——转换会改变导出行为。
 */
/** 二维坐标。 */
export interface Position {
    x: number;
    y: number;
}
/** 视口（相机）位置与缩放。 */
export interface Viewport {
    x: number;
    y: number;
    zoom: number;
}
/** 分区框。 */
export interface CanvasRegion {
    id: string;
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
}
/** 批注：恰好挂在卡片或分区之一。 */
export interface CanvasAnnotation {
    id: string;
    x: number;
    y: number;
    text: string;
    targetCardId: string | null;
    targetRegionId: string | null;
}
/** 批注来源是否还在画布上（计算得到，从不持久化）。 */
export type AnnotationAvailability = 'ok' | 'missing-source';
/** 带可用性判定的批注。 */
export interface CanvasAnnotationView extends CanvasAnnotation {
    availability: AnnotationAvailability;
}
/** 一张卡片。 */
export interface CanvasCard {
    id: string;
    threadId: string;
    /** 线程级占位卡片（线程还没有用户提问）时为 null。 */
    userQuestionSeq: number | null;
    /** 线程内的前驱卡片；分叉的第一张卡由谱系步骤改为跨线程父卡片。 */
    parentId: string | null;
    /** 仅当父链是**推断**出来（无 anchor 也无种子边界）时出现。 */
    parentIdInferred?: true;
    threadParentId: string | null;
    previousCardId: string | null;
    /** 投影事件序号；线程级占位卡片没有（`undefined`）。 */
    sourceSeq: number | undefined;
    title: string;
    question: string;
    naturalPosition: Position;
    /** 手工保存的位置；未手工放置过为 null。 */
    position: Position | null;
    positionLocked: boolean;
    collapsed: boolean;
}
/** 线程摘要。 */
export interface CanvasThreadSummary {
    id: string;
    title: string;
    parentId: string | null;
    dshSessionId: string | null;
    color: string | null;
}
/** 被丢弃的输入分支（供调用方提示，不抛错）。 */
export interface SkippedBranch {
    area: string;
    reason: string;
}
/** 一个工作区修订的完整画布模型（返回时已深冻结）。 */
export interface CanvasModel {
    workspaceId: string | null;
    revision: number | null;
    projectionEpoch: number | null;
    viewport: Viewport;
    cards: CanvasCard[];
    cardsById: Record<string, CanvasCard>;
    cardOrder: string[];
    collapsedCardIds: string[];
    threads: CanvasThreadSummary[];
    regions: CanvasRegion[];
    regionsById: Record<string, CanvasRegion>;
    annotations: CanvasAnnotationView[];
    annotationsById: Record<string, CanvasAnnotationView>;
    layoutCards: Record<string, Position>;
    unmatchedCardIds: string[];
    unmatchedCollapsedIds: string[];
    skipped: SkippedBranch[];
}
/** `readLayout` 的结果：冻结文档里的布局字段 + 可选的 UI 分支锚点。 */
export interface LayoutView {
    cards: Record<string, Position>;
    collapsed: Record<string, true>;
    viewport: Viewport;
    regions: CanvasRegion[];
    annotations: CanvasAnnotation[];
    branchAnchors: Record<string, string>;
}
/** `layoutBundle` 的结果：命令层操作的那份布局包（不含 materials）。 */
export interface CanvasLayoutBundle {
    cards: Record<string, Position>;
    collapsed: Record<string, true>;
    viewport: Viewport;
    regions: CanvasRegion[];
    annotations: CanvasAnnotation[];
}
/** 分离卡片 id 的结果。 */
export interface ParsedCardId {
    threadId: string;
    userQuestionSeq: number | null;
}
/** Separator of the frozen card-id form: `<threadId>:<userQuestionSeq>`. */
export declare const CARD_ID_SEPARATOR = ":";
/**
 * Provisional fallback geometry, mirrored from app.js (`layoutConversationGraph`
 * defaults) so a card without a saved position still renders somewhere sane.
 * T4 owns the real layout engines; this module must not grow layout policy.
 */
export declare const NATURAL_ORIGIN: Readonly<{
    x: 86;
    y: 82;
}>;
export declare const NATURAL_STEP_X = 365;
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
export declare const NATURAL_STEP_Y = 318;
export declare const DEFAULT_VIEWPORT: Readonly<Viewport>;
/** A card placeholder that stands for the whole thread (no user turns yet). */
export declare function threadCardId(threadId: string): string;
/** The canonical, index-free card id for one user turn. */
export declare function questionCardId(threadId: string, userQuestionSeq: number): string;
/**
 * Split a card id back into its thread and turn. Thread ids may contain the
 * separator themselves (host session ids are opaque), so the numeric tail is
 * what identifies the turn; anything else is a thread-level card.
 */
export declare function parseCardId(cardId: unknown): ParsedCardId | null;
/**
 * Read the layout/region/annotation fields out of a snapshot.
 *
 * Accepts either the plain field bundle (`{ cards, collapsed, viewport, ... }`)
 * or a workspace document (`{ layout, regions, annotations }`). Returns plain
 * immutable copies so callers never alias Store objects.
 */
export declare function readLayout(snapshot?: unknown): LayoutView;
/**
 * Build the immutable canvas model for one workspace snapshot.
 *
 * `snapshot` may be a workspace document (`projection.threads`, `layout`,
 * `regions`, `annotations`) or explicit fields (`threads`, `layout`, ...).
 * Unknown layout keys are preserved in `layoutCards` and reported in
 * `unmatchedCardIds` (material nodes keep their positions this way); they are
 * never dropped just because this module does not know their type.
 */
export declare function buildCanvasModel(snapshot?: unknown): CanvasModel;
/** One card, or null. */
export declare function getCard(model: CanvasModel | null | undefined, cardId: string): CanvasCard | null;
/** Stored (manual) position, or null when the card was never placed manually. */
export declare function getCardPosition(model: CanvasModel | null | undefined, cardId: string): Position | null;
/** Position to draw at: manual position when present, else natural fallback. */
export declare function getResolvedPosition(model: CanvasModel | null | undefined, cardId: string): Position | null;
export declare function isCardCollapsed(model: CanvasModel | null | undefined, cardId: string): boolean;
export declare function getRegion(model: CanvasModel | null | undefined, regionId: string): CanvasRegion | null;
export declare function getAnnotation(model: CanvasModel | null | undefined, annotationId: string): CanvasAnnotationView | null;
/**
 * 视口副本。
 *
 * 入参保持 `unknown`：`canvas/navigation` 等调用方把任意模型形状传进来，旧实现
 * 用 `model?.viewport ?? DEFAULT_VIEWPORT` 天然接受任何值。这里逐字保留那条
 * 可选访问 + 空值合并，只补类型断言——不做额外的形状校验，否则会改变
 * 「模型缺 viewport 时回落到默认视口」以外的行为。
 */
export declare function getViewport(model: unknown): Viewport;
/** Annotations attached to a card, including ones whose card vanished. */
export declare function annotationsForCard(model: CanvasModel | null | undefined, cardId: string): CanvasAnnotationView[];
export declare function annotationsForRegion(model: CanvasModel | null | undefined, regionId: string): CanvasAnnotationView[];
/** Annotations whose target is gone; they stay, marked `missing-source`. */
export declare function missingSourceAnnotations(model: CanvasModel | null | undefined): CanvasAnnotationView[];
/**
 * Cards whose resolved position falls inside a region box.
 *
 * Used for region highlighting and for proving that deleting a region only
 * detaches association — membership is computed, never stored, so no card can
 * be removed by deleting a box.
 */
export declare function cardsInsideRegion(model: CanvasModel | null | undefined, regionId: string): string[];
/**
 * Project a model back to the plain layout bundle commands operate on.
 *
 * `layoutCards` is copied wholesale (not only known card ids) so unknown
 * entities such as material nodes keep their coordinates.
 */
export declare function layoutBundle(model: CanvasModel | null | undefined): CanvasLayoutBundle;
