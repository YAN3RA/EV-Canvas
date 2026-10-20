/** 投影出来的一条注记（`text` 已去首尾空白，超长则截断并附标记）。 */
export interface ProjectionNote {
    kind: string;
    text: string;
}
/**
 * Decide one event-carried message: the text to project, or null when the
 * message is not a real user turn.
 *
 * Attribution is decided by `source.kind`, not by text: the runtime-context
 * prefix matched only 1 of the 7 injected kinds in the sampled session, and 1 of
 * the 18 kinds observed across the local session corpus — `agent-instructions`,
 * `skill-catalog`, `plugin:*` and `time-context` carry no prefix at all. The
 * text heuristic survives only as the fallback for legacy rows that carry no
 * attribution at all, so old projections stay readable.
 */
export declare function admittedUserText(message: unknown): string | null;
/** Admitted user text carried by one message, across both durable carriers. */
export declare function projectableEvent(event: unknown): ProjectionNote | null;
/** 把任意错误形状压成一行可读文本；无可用信息时返回 null（不编造）。 */
export declare function errorText(value: unknown): string | null;
/** 归一化一条注记：空文本不产生注记，超长截断并附 `PROJECTION_TRUNCATED_SUFFIX`。 */
export declare function noteProjection(kind: string, text: string): ProjectionNote | null;
/** 拼接一条消息的内容块；工具调用贡献「名字 + 参数」两行，结果块递归展开。 */
export declare function contentText(content: unknown): string;
/** 由首条用户文本生成会话标题（单行、42 字符上限）。 */
export declare function titleFromText(text: string): string;
/** 会话的工作目录；缺失时给出显式的「未指定」而不是空串。 */
export declare function sessionCwd(session: unknown): string;
/** 由 cwd 派生工作区标题：取末段目录名，取不到时回落到给定标题。 */
export declare function workspaceTitle(cwd: string, fallbackTitle: string): string;
