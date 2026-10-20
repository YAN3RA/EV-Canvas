/** 一条未知字段警告。 */
export interface MigrationWarning {
    code: string;
    path: string;
    message: string;
}
/** 一条阻断性歧义（存在即 `canCommit === false`）。 */
export interface MigrationAmbiguity {
    code: string;
    path: string;
    message: string;
}
/** 旧卡片键 → 新卡片的映射项。 */
export interface MigrationMapping {
    workspaceId: string;
    threadId: string;
    sourceSeq: number;
    userQuestionSeq: number;
    cardId: string;
}
/** 迁移计数。 */
export interface MigrationCounts {
    workspaces: number;
    sessions: number;
    cards: number;
    messages?: number;
    materials: number;
    positions: number;
    collapsed: number;
    skipped?: number;
}
/** 计数字段的语义说明（避免把「身份数」误读成「渲染卡数」）。 */
export interface MigrationCountsMeaning {
    cards: string;
}
/** `buildMigrationPlan` 的产物。 */
export interface MigrationPlan {
    document: Record<string, unknown>;
    counts: MigrationCounts;
    countsMeaning: MigrationCountsMeaning;
    ambiguities: MigrationAmbiguity[];
    warnings: MigrationWarning[];
    mapping: MigrationMapping[];
    canCommit: boolean;
}
/** `buildLayoutMigrationPlan` 的产物。 */
export interface LayoutMigrationPlan {
    workspaceId: string;
    baseRevision: number;
    projectionEpoch: number;
    layout: {
        cards: Record<string, {
            x: number;
            y: number;
        }>;
        collapsed: Record<string, unknown>;
        viewport: {
            x: number;
            y: number;
            zoom: number;
        };
    };
    counts: MigrationCounts;
    countsMeaning: MigrationCountsMeaning;
    ambiguities: MigrationAmbiguity[];
    warnings: MigrationWarning[];
    mapping: MigrationMapping[];
    canCommit: boolean;
}
/** 浏览器布局快照（`positions` / `collapsed` / `branchAnchors` / `raw`）。 */
export interface BrowserLayout {
    positions?: unknown;
    collapsed?: unknown;
    branchAnchors?: unknown;
    raw?: unknown;
    [key: string]: unknown;
}
/**
 * browserLayout: { positions: [[legacyCardId,{x,y}]], collapsed: [legacyCardId],
 *                  branchAnchors?: [[sessionId,legacyCardId]] }.
 * Supply an explicit snapshot, never a storage object. Unknown/stale keys block
 * commit rather than guessing by array index. Both aliases may map to one card
 * only when their stored positions agree.
 */
export declare function buildMigrationPlan({ legacyState, browserLayout, hostWorkspaces, now }?: {
    legacyState?: unknown;
    browserLayout?: BrowserLayout;
    hostWorkspaces?: unknown;
    now?: string;
}): MigrationPlan;
/** Merge explicitly supplied legacy entries into one existing canonical layout. */
export declare function buildLayoutMigrationPlan({ document: inputDocument, workspaceId, browserLayout }?: {
    document?: unknown;
    workspaceId?: string;
    browserLayout?: BrowserLayout;
}): LayoutMigrationPlan;
