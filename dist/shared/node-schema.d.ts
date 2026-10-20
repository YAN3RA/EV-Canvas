/**
 * EV Canvas · 节点与边校验（S0-1 §6 十条不变量）
 *
 * 与 schema.ts 的分工：
 *   - schema.ts 管**顶层文档**（format / schemaVersion / workspace / thread），迁移自旧版
 *   - 本文件管**八类节点 + 三类边**，是 vNext 新增部分
 *
 * 为什么手写守卫而不用 zod：宿主侧要求零 runtime 依赖，且旧版已验证手写守卫模式可行。
 */
import type { CanvasEdge, CanvasNode } from './types.js';
/**
 * 校验单个节点（不变量 1 的基础，引用完整性由 validateWorkspace 负责）。
 */
export declare function validateNode(input: unknown, index: number): CanvasNode;
/**
 * 校验边（不变量 2/3/4 由 validateWorkspace 汇总检查）。
 */
export declare function validateEdge(input: unknown, index: number): CanvasEdge;
/** 校验结果：合法则返回，非法抛 InputError */
export interface WorkspaceInput {
    nodes: unknown;
    edges: unknown;
    viewport?: unknown;
}
/**
 * 校验整个 workspace 的节点与边（不变量 1–5、7）。
 * 资产存在性（不变量 7）由调用方传入已知 assetId 集合检查。
 */
export declare function validateWorkspace(input: WorkspaceInput, knownAssetIds?: ReadonlySet<string>): void;
/** 校验 MIME 是否在白名单内（FR-13） */
export declare function isAllowedAssetMime(mime: string): boolean;
/** 校验资产大小（FR-13） */
export declare function assertAssetSize(bytes: number): void;
