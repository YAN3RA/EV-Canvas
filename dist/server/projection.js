// 来源: dsh-synapnova@3fd1d00 server/projection.js
/**
 * Synapnova event projection rules.
 *
 * Turns one committed DSH session event into the canvas representation, and
 * derives the working-directory/workspace labels. Pure functions only: no
 * filesystem and no host access.
 *
 * Extracted verbatim from index.js by refactor-slice2.mjs.
 *
 * 类型说明：入参来自宿主事件流，形状由宿主决定且可能演进，所以对外用
 * `unknown` 收窄；内部只在确认字段类型后取值，不做无依据的断言。
 */
import { MAX_PROJECTION_LENGTH, PROJECTION_TRUNCATED_SUFFIX, eventMessages, isRuntimeContextText, messageSourceVerdict, } from '../shared/schema.js';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
export function admittedUserText(message) {
    const verdict = messageSourceVerdict(message);
    if (verdict === 'injected')
        return null;
    const content = isRecord(message) ? message['content'] : undefined;
    const text = contentText(content);
    if (verdict === 'unknown' && isRuntimeContextText(text))
        return null;
    return text;
}
/** Admitted user text carried by one message, across both durable carriers. */
export function projectableEvent(event) {
    if (!isRecord(event))
        return null;
    const type = event['type'];
    const data = isRecord(event['data']) ? event['data'] : undefined;
    switch (type) {
        case 'user/message': {
            // `eventMessages` is the carrier-agnostic reader: a `user/message` keeps
            // one message in `data`, an `agent/inbox/spliced` stages queued ones in
            // `data.inserted[]`. Admission is judged by `source.kind` on whichever
            // shape the host used, through the one shared predicate.
            const [message] = eventMessages(event);
            const text = admittedUserText(message);
            return text === null ? null : noteProjection('user', text);
        }
        case 'agent/inbox/spliced':
            // Queued messages are staged here and re-registered as `user/message`
            // with the same message id once admitted (~99% of staged rows in real
            // logs), so projecting the splice as well would render every queued
            // question twice. Staged rows the host retracts (`removedCount`) were
            // never admitted and must not leave a card behind. Their attribution is
            // still judged by the same rule, above, for anyone reading the splice.
            return null;
        case 'assistant/message': {
            const message = data !== undefined && isRecord(data['message']) ? data['message'] : undefined;
            return noteProjection('assistant', contentText(message?.['content']));
        }
        case 'todo/write': {
            const todos = data?.['todos'];
            return noteProjection('todo', Array.isArray(todos)
                ? todos
                    .map(todo => (isRecord(todo) ? `[${String(todo['status'])}] ${String(todo['content'])}` : ''))
                    .join('\n')
                : '');
        }
        case 'turn/end': {
            const reason = data !== undefined && isRecord(data['reason']) ? data['reason'] : undefined;
            if (reason?.['kind'] === 'error')
                return noteProjection('error', errorText(reason['error']) ?? '本轮执行失败');
            if (reason?.['kind'] === 'cancelled' || reason?.['kind'] === 'canceled' || reason?.['kind'] === 'aborted') {
                return noteProjection('error', '本轮已取消');
            }
            return null;
        }
        default:
            return typeof type === 'string' && /(?:error|failed|failure|cancel(?:led)?|abort)/i.test(type)
                ? noteProjection('error', errorText(data?.['error'] ?? data?.['reason'] ?? data) ?? 'Harness 运行失败')
                : null;
    }
}
/** 把任意错误形状压成一行可读文本；无可用信息时返回 null（不编造）。 */
export function errorText(value) {
    if (typeof value === 'string')
        return value.trim() || null;
    if (value === null || value === undefined || typeof value !== 'object')
        return null;
    const record = value;
    const name = typeof record['name'] === 'string' && record['name'].trim() !== '' ? record['name'].trim() : '';
    const code = typeof record['code'] === 'string' && record['code'].trim() !== '' ? record['code'].trim() : '';
    const message = typeof record['message'] === 'string' && record['message'].trim() !== '' ? record['message'].trim() : '';
    if (message !== '')
        return [name, code].filter(Boolean).concat(message).join(': ');
    return [name, code].filter(Boolean).join(': ') || null;
}
/** 归一化一条注记：空文本不产生注记，超长截断并附 `PROJECTION_TRUNCATED_SUFFIX`。 */
export function noteProjection(kind, text) {
    const normalized = text.trim();
    if (normalized === '')
        return null;
    if (normalized.length <= MAX_PROJECTION_LENGTH)
        return { kind, text: normalized };
    return { kind, text: `${normalized.slice(0, MAX_PROJECTION_LENGTH)}${PROJECTION_TRUNCATED_SUFFIX}` };
}
/** 拼接一条消息的内容块；工具调用贡献「名字 + 参数」两行，结果块递归展开。 */
export function contentText(content) {
    if (!Array.isArray(content))
        return '';
    return content
        .flatMap(block => {
        if (!isRecord(block))
            return [];
        if (block['type'] === 'text')
            return [block['text']];
        if (block['type'] === 'tool-call')
            return [block['name'], block['arguments']];
        if (block['type'] === 'tool-result')
            return contentText(block['content']);
        return [];
    })
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .join('\n');
}
/** 由首条用户文本生成会话标题（单行、42 字符上限）。 */
export function titleFromText(text) {
    const line = text.replaceAll(/\s+/g, ' ').trim();
    return (line.length > 42 ? `${line.slice(0, 42)}...` : line) || 'DSH 会话';
}
/** 会话的工作目录；缺失时给出显式的「未指定」而不是空串。 */
export function sessionCwd(session) {
    // The Session header defines `cwd` as its only working-directory carrier; the
    // old `header.meta.cwd` fallback never matched a real header field.
    if (!isRecord(session))
        return '未指定工作目录';
    const header = isRecord(session['header']) ? session['header'] : undefined;
    const cwd = header?.['cwd'];
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : '未指定工作目录';
}
/** 由 cwd 派生工作区标题：取末段目录名，取不到时回落到给定标题。 */
export function workspaceTitle(cwd, fallbackTitle) {
    if (cwd === '未指定工作目录')
        return fallbackTitle;
    const segment = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
    return segment !== undefined && segment.trim() !== '' ? segment : fallbackTitle;
}
//# sourceMappingURL=projection.js.map