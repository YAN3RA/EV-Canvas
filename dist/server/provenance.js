/**
 * EV Canvas · S3-8 只读 why：单张卡片的来源解释层
 *
 * 本层回答一个问题：**这张卡片是谁、在哪里产生的**。它只解释**一张卡片**，
 * 不构建完整 why 图（那是另一件事），也不提供 MCP 入口。
 *
 * 输入口径（**明确且严格**，不做任何猜测式兼容）：
 *   - 只接受「冻结完整文档」：`{ format: 'dsh-evcanvas', schemaVersion: 1, workspaces: [...] }`。
 *     这正是 `shared/schema.ts` 唯一的冻结写形态，因此严格校验直接复用
 *     `normalizeFrozenState`——权威判定只有一份，本模块不重写第二套校验器。
 *   - **不接受**旧版 v1–v4 文档（`format` 缺失 → `bad-format`）；
 *   - **不接受** `GET /api/workspaces/<id>` 的单工作区信封（没有顶层 `workspaces` 数组）；
 *   - **不接受** projection-only 片段（没有 `workspaces` 根）；
 *   - `workspaceId` 与 `cardId` 必须由调用方**显式指定**，本层没有任何默认值，
 *     因此不会「碰巧」解释别的会话里的卡片。
 *
 * 行为边界：
 *   - 纯模块：不读文件、不读 `DSH_HOME`、不发网络、不写文件、不调用模型。
 *   - 不触碰 `WorkspaceStore`，也不加载任何真实用户数据；输入字节由调用方（CLI）提供。
 *   - **绝不回显正文**：输出只含稳定的标识与标记（sessionId / seq / 父链 / coverage 标记），
 *     没有 `title` / `question` / `text` / `process`，也没有线程消息内容。
 *   - 错误一律是机器码（`PROVENANCE_REJECT`），不带原文片段。
 */
import { buildCanvasModel } from '../canvas/model.js';
import { normalizeSessionId } from '../shared/session-id.js';
import { FROZEN_FORMAT, FROZEN_SCHEMA_VERSION, InputError, normalizeFrozenState, } from '../shared/schema.js';
/** 输出判别标记：消费者据此确认拿到的是本特性而不是别的 JSON。 */
export const PROVENANCE_KIND = 'dsh-evcanvas/card-provenance';
export const PROVENANCE_VERSION = 1;
/** 稳定拒绝码（kebab-case；CLI 据此映射退出码，消费方据此本地化文案）。 */
export const PROVENANCE_REJECT = Object.freeze({
    notAnObject: 'not-an-object',
    badFormat: 'bad-format',
    badVersion: 'bad-version',
    duplicateId: 'duplicate-id',
    ambiguousCardId: 'ambiguous-card-id',
    invalidDocument: 'invalid-document',
    workspaceRequired: 'workspace-required',
    cardRequired: 'card-required',
    workspaceNotFound: 'workspace-not-found',
    cardNotFound: 'card-not-found',
});
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function reject(code, field) {
    return field === undefined ? { ok: false, code } : { ok: false, code, field };
}
/**
 * 把 `normalizeFrozenState` 的 `InputError` 归类成稳定拒绝码。
 *
 * 为什么用文案匹配做**分类**而不是自己再写一套校验器：冻结文档的权威判定只有
 * `shared/schema.ts` 一份，第二套校验器迟早与它分歧（那正是本项目最怕的
 * 「两个 owner」）。这里只分类，判定仍由 schema 做；匹配不到就退化为
 * `invalid-document`，绝不因为分类不到而放行。分类依据是 schema 里的固定文案，
 * 文案一旦改动，定向测试会当场失败——这正是它该有的行为。
 *
 * 注意：schema 抛出的 message 可能含**标识**（如重复的 thread id），但本函数
 * 只返回 code 与字段名，`message` 从不进入任何返回值，因此不会外泄内容。
 */
function classifyFrozenError(error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('format 必须是'))
        return reject(PROVENANCE_REJECT.badFormat, 'format');
    if (message.includes('schemaVersion'))
        return reject(PROVENANCE_REJECT.badVersion, 'schemaVersion');
    if (message.includes('重复的'))
        return reject(PROVENANCE_REJECT.duplicateId);
    return reject(PROVENANCE_REJECT.invalidDocument);
}
/**
 * 把 `model.cards` 收成**已确认**卡片的索引，并单独记下 id 歧义。
 *
 * 为什么不用 `model.cardsById`：那是普通对象，`cardsById['constructor']`、
 * `cardsById['toString']`、`cardsById['__proto__']` 这类键会顺着原型链命中
 * `Object.prototype`，于是「快照里根本没有这张卡」看起来存在——正是本层最怕的
 * 假成功（失败被解释成一条来源）。`Map` 只认自己写入的键，继承属性不可能命中。
 *
 * 为什么还要记歧义：卡片 id 由 `<threadId>:<seq>` 派生，所以线程 `t` 的第 0 问
 * 与名为 `t:0` 的占位线程会派生出**同一个** id。此时按 id 回答「这张卡是谁」
 * 一定会把结论钉错一张；取「最后写入的对象」更是由遍历顺序决定的答案，换个
 * 快照顺序就换一张卡。因此同名即判歧义、拒绝解释，并且**不把歧义 id 留在索引里**
 * （父链上溯也只能走已确认的卡片）。
 */
function indexCards(model) {
    const cards = new Map();
    const ambiguous = new Set();
    for (const card of model.cards) {
        if (ambiguous.has(card.id))
            continue;
        if (cards.has(card.id)) {
            // 第二次见到同一个 id：撤掉已登记的那张，永久标记为歧义。
            cards.delete(card.id);
            ambiguous.add(card.id);
            continue;
        }
        cards.set(card.id, card);
    }
    return { cards, ambiguous };
}
/**
 * 沿 `parentId` 上溯，遇环即停（不猜、不无限循环）。
 *
 * `cards` 必须是 `indexCards` 产出的**已确认**索引：父链绝不能在原型链或歧义 id
 * 上「找到」一张卡，否则一次解释会同时报告一张查询卡和一条编造的祖先链。
 */
function ancestorsOf(cards, card) {
    const ancestors = [];
    const visited = new Set([card.id]);
    let nextId = card.parentId;
    let edgeInferred = card.parentIdInferred === true;
    let cycle = false;
    while (nextId !== null) {
        if (visited.has(nextId)) {
            // 快照内部不自洽（父链成环）。到此为止并**显式报告**，而不是悄悄截断成一条
            // 看似正常的父链。
            cycle = true;
            break;
        }
        const node = cards.get(nextId);
        // 父卡片不在**已确认**索引里说明父链悬空或该 id 有歧义。这里不拿别的卡片顶上：
        // 来源解释宁缺勿猜。
        if (node === undefined)
            break;
        visited.add(nextId);
        ancestors.push({ cardId: node.id, parentId: node.parentId, parentIdInferred: edgeInferred });
        edgeInferred = node.parentIdInferred === true;
        nextId = node.parentId;
    }
    return { ancestors, cycle };
}
/**
 * 读 coverage：**区分「快照写了」与「快照没写」**。
 *
 * 归一化会把缺失的 coverage 补成 `{ ranges: [], historyComplete: false, textTruncated: false }`，
 * 于是「没声明」与「声明了不完整」在归一化产物里长得一模一样——把默认值当声明
 * 报出去，等于替快照编造一个它没做过的断言。因此这里回到**原始输入**判断字段
 * 是否存在，没写就报 `unknown`（布尔全为 null）。
 */
function readCoverage(document, workspaceId, threadId, normalizedThread) {
    const unknown = {
        status: 'unknown',
        ranges: [],
        historyComplete: null,
        textTruncated: null,
        nativeLogComplete: 'unknown',
    };
    const rawWorkspaces = Array.isArray(document['workspaces']) ? document['workspaces'] : [];
    const rawWorkspace = rawWorkspaces.find(candidate => isPlainObject(candidate) && candidate['id'] === workspaceId);
    if (!isPlainObject(rawWorkspace))
        return unknown;
    const rawProjection = rawWorkspace['projection'];
    if (!isPlainObject(rawProjection))
        return unknown;
    const rawThreads = Array.isArray(rawProjection['threads']) ? rawProjection['threads'] : [];
    const rawThread = rawThreads.find(candidate => isPlainObject(candidate) && candidate['id'] === threadId);
    if (!isPlainObject(rawThread) || rawThread['coverage'] === undefined || rawThread['coverage'] === null)
        return unknown;
    const ranges = normalizedThread.coverage.ranges.map(range => [...range]);
    return {
        status: 'declared',
        ranges,
        historyComplete: normalizedThread.coverage.historyComplete,
        textTruncated: normalizedThread.coverage.textTruncated,
        nativeLogComplete: 'unknown',
    };
}
/**
 * 读一份快照里某张卡片的来源。
 *
 * 入参按 `unknown` 收窄（这是不受信输入的边界）：`{ document, workspaceId, cardId }`。
 * 返回判别联合，调用方先看 `ok` 再取字段。
 */
export function readProvenance(request) {
    const source = (isPlainObject(request) ? request : {});
    const document = source.document;
    const workspaceId = source.workspaceId;
    const cardId = source.cardId;
    if (!isPlainObject(document))
        return reject(PROVENANCE_REJECT.notAnObject, 'document');
    if (typeof workspaceId !== 'string' || workspaceId === '')
        return reject(PROVENANCE_REJECT.workspaceRequired, 'workspaceId');
    if (typeof cardId !== 'string' || cardId === '')
        return reject(PROVENANCE_REJECT.cardRequired, 'cardId');
    // 前置分类：只支持当前冻结形态，让「旧格式 / 信封 / 片段」得到**明确**的拒绝码，
    // 而不是笼统的 invalid-document。
    if (document['format'] !== FROZEN_FORMAT)
        return reject(PROVENANCE_REJECT.badFormat, 'format');
    if (document['schemaVersion'] !== FROZEN_SCHEMA_VERSION)
        return reject(PROVENANCE_REJECT.badVersion, 'schemaVersion');
    let state;
    try {
        // 唯一的权威判定：与真实加载路径共用同一个校验器。
        state = normalizeFrozenState(document).state;
    }
    catch (error) {
        // 非 InputError 的失败（内部的意外错误）同样拒绝：宁可拒绝，也不把一份
        // 没通过校验的快照当依据。
        return classifyFrozenError(error);
    }
    const workspace = state.workspaces.find(candidate => candidate.id === workspaceId);
    if (workspace === undefined)
        return reject(PROVENANCE_REJECT.workspaceNotFound, 'workspaceId');
    const model = buildCanvasModel(workspace);
    const { cards, ambiguous } = indexCards(model);
    if (ambiguous.size > 0)
        return reject(PROVENANCE_REJECT.ambiguousCardId, 'cardId');
    const card = cards.get(cardId);
    if (card === undefined)
        return reject(PROVENANCE_REJECT.cardNotFound, 'cardId');
    const thread = model.threads.find(candidate => candidate.id === card.threadId);
    // `card.threadId` 来自本模型构造，线程摘要必然存在；防御性用 null 分支而非断言。
    const normalizedThread = workspace.projection.threads.find(candidate => candidate.id === card.threadId);
    const { ancestors, cycle } = ancestorsOf(cards, card);
    const coverage = normalizedThread === undefined
        ? { status: 'unknown', ranges: [], historyComplete: null, textTruncated: null, nativeLogComplete: 'unknown' }
        : readCoverage(document, workspace.id, card.threadId, normalizedThread);
    const sessionId = thread?.dshSessionId ?? null;
    const data = {
        kind: PROVENANCE_KIND,
        version: PROVENANCE_VERSION,
        workspaceId: workspace.id,
        snapshot: {
            updatedAt: state.updatedAt ?? null,
            revision: model.revision,
            projectionEpoch: model.projectionEpoch,
        },
        card: {
            cardId: card.id,
            threadId: card.threadId,
            userQuestionSeq: card.userQuestionSeq,
            kind: card.userQuestionSeq === null ? 'thread-placeholder' : 'question',
        },
        source: {
            sessionId,
            sessionIdNormalized: sessionId === null ? null : normalizeSessionId(sessionId),
            // `?? null` 保留 0：0 是合法的事件序号，绝不能当「没有来源」。
            sourceSeq: card.sourceSeq ?? null,
        },
        lineage: {
            parentId: card.parentId,
            parentIdInferred: card.parentIdInferred === true,
            threadParentId: card.threadParentId,
            threadParentInWorkspace: card.threadParentId === null
                ? null
                : model.threads.some(candidate => candidate.id === card.threadParentId),
            previousCardId: card.previousCardId,
            ancestors,
            cycle,
        },
        coverage,
    };
    return { ok: true, data };
}
//# sourceMappingURL=provenance.js.map