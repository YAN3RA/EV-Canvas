/**
 * EV Canvas · 顶层文档结构与校验
 * 来源: dsh-synapnova@3fd1d00 shared/schema.js（494 行）
 * 变更：FROZEN_FORMAT 改 'dsh-evcanvas'（D23）；其余校验逻辑原样保留。
 *
 * 保留原因：这套守卫是旧版唯一经过 52 套测试验证的输入校验层，
 * 重写只会引入新漏洞。八类节点的新校验追加在节点层（见 node-schema.ts）。
 *
 * --- 以下为原文件说明（保留）---
 * Synapnova persistence schema.
 *
 *
 * Single owner of the on-disk document shape, its legacy version migrations,
 * and the field validators every write path must go through. Pure module: no
 * filesystem and no host access — `server/workspace-store.js` performs IO,
 * this file only decides whether a value is a legal Synapnova document and how
 * older versions normalise into the current one.
 *
 * This module is ALSO served to the browser: `app.js` imports it so the canvas
 * and the server share one attribute judgment. It therefore must not import any
 * `node:` specifier — a bare `node:crypto` import makes Chromium fail to resolve
 * the module graph, which took the whole canvas down as a white screen with
 * `node:crypto ... net::ERR_FAILED` in the console. Both runtimes expose
 * `globalThis.crypto.randomUUID` (Node >= 19, and every browser that can run ES
 * modules), so the helper reads the global instead of importing it.
 *
 * ---
 * 类型口径（本轮新增，零行为变更）：
 * 本文件是**不受信输入的边界**，因此每个导出的校验器都以 `unknown` 收窄，返回
 * 自己构造的精确形状。归一化过程本身是「逐步往字典里填字段」，中间态用
 * `Record<string, unknown>` 承载，只在入口/出口断言到具名接口——把每个中间态
 * 也建成独立类型不会提高安全性（每一步都已经过它自己的校验器），只会让校验
 * 逻辑与类型定义互相纠缠。**所有判定表达式、错误文案与执行顺序逐字保留。**
 */
export declare const LEGACY_SCHEMA_VERSION = 4;
export declare const SCHEMA_VERSION = 1;
export declare const FROZEN_FORMAT = "dsh-evcanvas";
export declare const FROZEN_SCHEMA_VERSION = 1;
export declare const MAX_TITLE_LENGTH = 120;
export declare const MAX_NOTE_LENGTH = 4000;
export declare const MAX_PROJECTION_LENGTH = 8000;
export declare const PROJECTION_TRUNCATED_SUFFIX = "\n\u2014\u2014\u2026\uFF08\u8BE6\u60C5\u67E5\u770B\u5168\u6587\uFF09";
export declare const TOPIC_COLORS: string[];
export { InputError, NotFoundError, RevisionConflictError, IdempotencyExpiredError } from './errors.js';
export declare const IDEMPOTENCY_LIMIT = 200;
export declare const UUID_V7: RegExp;
/** 二维坐标。 */
export interface SchemaPosition {
    x: number;
    y: number;
}
/** 一个已提交写入的幂等记录。 */
export interface IdempotencyEntry {
    hash: string;
    workspaceId: string;
    revision: number;
    at: string;
    response: Record<string, unknown>;
}
/** 一条投影消息（冻结文档里的形状；字段白名单见 MESSAGE_FIELDS）。 */
export interface FrozenMessage {
    id: string;
    text?: string;
    kind?: string;
    sourceSeq?: number;
    at?: string;
    turn?: number;
    step?: number;
    process?: Record<string, unknown>[];
}
/** 一条工具过程记录（PROCESS_FIELDS 白名单）。 */
export interface FrozenProcessEntry {
    callId?: string;
    turn?: number;
    step?: number;
    name?: string;
    arguments?: unknown;
    result?: unknown;
    error?: unknown;
}
/** 覆盖率声明。 */
export interface FrozenCoverage {
    ranges: number[][];
    historyComplete: boolean;
    textTruncated: boolean;
}
/** 一条投影线程。 */
export interface FrozenThread {
    id: string;
    title?: string;
    parentId?: string | null;
    sourceParentSessionId?: string | null;
    sourceSeedLength?: number;
    dshSessionId?: string | null;
    dshSessionTitle?: string | null;
    color?: string | null;
    createdAt?: string;
    updatedAt?: string;
    messages: FrozenMessage[];
    pendingProcess: FrozenProcessEntry[];
    coverage: FrozenCoverage;
}
/** 布局包。 */
export interface FrozenLayout {
    cards: Record<string, SchemaPosition>;
    collapsed: Record<string, boolean>;
    viewport: {
        x: number;
        y: number;
        zoom: number;
    };
}
/** 材料。 */
export interface FrozenMaterial {
    id: string;
    name: string;
    importedAt: string;
    bytes: number;
    text: string;
}
/** 分区。 */
export interface FrozenRegion extends SchemaPosition {
    id: string;
    name: string;
    w: number;
    h: number;
}
/** 批注。 */
export interface FrozenAnnotation extends SchemaPosition {
    id: string;
    text: string;
    targetCardId?: string;
    targetRegionId?: string;
}
/** 一个工作区。 */
export interface FrozenWorkspace {
    id: string;
    kind: 'dsh' | 'manual';
    dshWorkspaceId?: unknown;
    cwd?: unknown;
    title?: unknown;
    createdAt: string;
    updatedAt: string;
    revision: number;
    projectionEpoch: number;
    projection: {
        threads: FrozenThread[];
    };
    layout: FrozenLayout;
    materials: FrozenMaterial[];
    regions: FrozenRegion[];
    annotations: FrozenAnnotation[];
}
/** 冻结文档根（`normalizeFrozenState` 的产物）。 */
export interface FrozenState {
    format: string;
    schemaVersion: number;
    updatedAt: string;
    hiddenSessionIds: string[];
    idempotency: Record<string, IdempotencyEntry>;
    idempotencyFloor: string | null;
    workspaces: FrozenWorkspace[];
}
/** 归一化结果 + 是否发生了迁移。 */
export interface NormalizedFrozen {
    state: FrozenState;
    migrated: boolean;
}
/** 旧版（v1–v4）文档形状。 */
export interface LegacyState {
    version: number;
    hiddenSessionIds: string[];
    workspaces: Record<string, unknown>[];
    updatedAt?: string;
}
/** 旧版归一化结果。 */
export interface NormalizedLegacy {
    state: LegacyState;
    migrated: boolean;
}
/** `normalizeState` 的联合结果：冻结根或旧版根。 */
export interface NormalizedState {
    state: FrozenState | LegacyState;
    migrated: boolean;
}
export declare function createFrozenState(now?: string): FrozenState;
export declare function isoDate(value: unknown, field?: string): string;
export declare function normalizeFrozenState(value: unknown): NormalizedFrozen;
export declare function assertFrozenDocument(value: unknown): void;
/**
 * Reject a document that is internally inconsistent.
 *
 * Duplicate entity ids and duplicate event keys are refused rather than
 * silently de-duplicated: a duplicate means two writers disagreed, and picking
 * one of them at load time would hide the divergence.
 */
export declare function assertDocumentIntegrity(state: unknown): void;
export declare function normalizeState(value: unknown): NormalizedState;
export declare function normalizeLegacyState(value: unknown): NormalizedLegacy;
/**
 * Fold v3-era standalone tool cards (kinds `tool` / `tool-result`) into the
 * preceding assistant message's `process` list, pairing each call with the
 * result that follows it in order, so every tool invocation lives in one
 * home: the assistant turn card.
 */
export declare function foldLegacyToolCards(workspaces: readonly unknown[]): boolean;
export declare function positionOf(value: unknown): SchemaPosition;
export declare function requiredText(value: unknown, maxLength: number, field: string): string;
/**
 * The one `source.kind` value that means "a human wrote this".
 *
 * DSH v4 admission (`assertV4MessageSources` -> `source()`) only requires a
 * non-empty string that is not the retired literal `plugin`, so `kind` is an
 * OPEN set, not a closed enum. Real local logs already carry `user`,
 * `agent-instructions`, `runtime-context`, `skill-catalog`, `time-context`,
 * `plugin:dsh-project-memory`, `plugin:aegis`, `agent-message`,
 * `subagent-settled`, `schedule`, `model-selection`, `user-approval`,
 * `dsh-rewind` and `compact-checkpoint`. Attribution therefore has to be
 * decided by "is this the human kind", never by enumerating injected kinds: a
 * new injection source must be rejected without a code change.
 */
export declare const USER_MESSAGE_SOURCE_KIND = "user";
/** `message.source.kind` when it is a usable attribution, otherwise null. */
export declare function messageSourceKind(message: unknown): string | null;
/**
 * Three-way source verdict for one DSH message.
 *
 * - `user`     — attributed to the human (`source.kind === 'user'`)
 * - `injected` — attributed to any other producer
 * - `unknown`  — no attribution at all (legacy rows); the caller must fall back
 *                to text heuristics rather than guess an attribution
 *
 * Returning `unknown` instead of defaulting to either side is what keeps old
 * projections readable: dropping every unattributed row would silently erase
 * history, and accepting every unattributed row would readmit injections.
 */
export declare function messageSourceVerdict(message: unknown): 'user' | 'injected' | 'unknown';
/**
 * The messages one committed event carries, across both durable carriers.
 *
 * `user/message` keeps a single message in `data`; `agent/inbox/spliced` stages
 * queued messages in `data.inserted[]`. Both carry the same `source`
 * attribution shape, so both must be judged by the same rule.
 */
export declare function eventMessages(event: unknown): unknown[];
/**
 * Plain-text runtime-context detector. Kept as a pure text tool for the
 * unattributed fallback path (`messageSourceVerdict(...) === 'unknown'`); it is
 * deliberately no longer the only criterion for admitting a `user/message`.
 */
export declare function isRuntimeContextText(text: unknown): boolean;
/**
 * Legacy fallback for messages already persisted in the frozen document.
 *
 * `MESSAGE_FIELDS` deliberately does not carry `source` (the field table is
 * frozen), so a persisted message can never be attributed — it is exactly the
 * `unknown` case above, and the text heuristic is the only criterion available
 * for it. This is not the admission rule for incoming events.
 */
export declare function isRuntimeContextMessage(message: unknown): boolean;
