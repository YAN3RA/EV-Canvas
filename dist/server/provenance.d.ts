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
/** 输出判别标记：消费者据此确认拿到的是本特性而不是别的 JSON。 */
export declare const PROVENANCE_KIND = "dsh-evcanvas/card-provenance";
export declare const PROVENANCE_VERSION = 1;
/** 稳定拒绝码（kebab-case；CLI 据此映射退出码，消费方据此本地化文案）。 */
export declare const PROVENANCE_REJECT: Readonly<{
    notAnObject: "not-an-object";
    badFormat: "bad-format";
    badVersion: "bad-version";
    duplicateId: "duplicate-id";
    ambiguousCardId: "ambiguous-card-id";
    invalidDocument: "invalid-document";
    workspaceRequired: "workspace-required";
    cardRequired: "card-required";
    workspaceNotFound: "workspace-not-found";
    cardNotFound: "card-not-found";
}>;
/** 卡片在所属线程里的身份。 */
export type ProvenanceCardKind = 'question' | 'thread-placeholder';
/** 父链上的一级祖先。 */
export interface ProvenanceAncestor {
    /** 祖先卡片 id。 */
    cardId: string;
    /** 该祖先自己的父卡片 id。 */
    parentId: string | null;
    /**
     * **进入该祖先的那条边**是否为推断（无 anchor 也无种子边界时由 `canvas/model.ts` 标记）。
     * 名字沿用卡片模型的 `parentIdInferred`，语义是「这条父子关系未被证明」。
     */
    parentIdInferred: boolean;
}
/** 覆盖率声明的读法。 */
export interface ProvenanceCoverage {
    /** `declared` = 快照里确实写了 coverage；`unknown` = 快照里没有 coverage 字段。 */
    status: 'declared' | 'unknown';
    /** 原标记的区间；未知时为空数组——**不编造**。 */
    ranges: number[][];
    /** 快照声明的投影历史完整性；未知时为 null。 */
    historyComplete: boolean | null;
    /** 快照声明的正文截断标记；未知时为 null。 */
    textTruncated: boolean | null;
    /**
     * 原生日志完整性。本 CLI **不读**原生会话日志，所以这里恒为 `'unknown'`。
     *
     * 为什么单独给一个字段：`historyComplete` 是**投影写入时**的自我声明，它不等于
     * DSH 原生日志完整。消费方若把它读成「原生日志已完整」，就会在缺历史的会话上
     * 报出一个它证明不了的结论。这个字段的存在就是为了让那种误读不可能悄悄发生。
     */
    nativeLogComplete: 'unknown';
}
/** 一份快照的标识，便于把结论钉到具体那一份输入。 */
export interface ProvenanceSnapshot {
    updatedAt: string | null;
    revision: number | null;
    projectionEpoch: number | null;
}
/** 一张卡片的来源元数据（本特性的全部输出）。 */
export interface ProvenanceData {
    kind: string;
    version: number;
    workspaceId: string;
    snapshot: ProvenanceSnapshot;
    card: {
        cardId: string;
        threadId: string;
        /** 线程内 0 基提问序；线程级占位卡片为 null。 */
        userQuestionSeq: number | null;
        kind: ProvenanceCardKind;
    };
    source: {
        /** 线程记录的 DSH 会话 id（原文）；没有原生会话时为 null。 */
        sessionId: string | null;
        /** 归一化后的会话标识；`sessionId` 为 null 时同为 null。 */
        sessionIdNormalized: string | null;
        /** 投影事件序号；**含 0**（0 是合法值，绝不能当「没有」）；占位卡片为 null。 */
        sourceSeq: number | null;
    };
    lineage: {
        parentId: string | null;
        /** `parentId` 是否为推断（未被证明）。 */
        parentIdInferred: boolean;
        /** 卡片所属线程声明的父线程 id（原样，可能是本工作区之外的线程）。 */
        threadParentId: string | null;
        /** 父线程是否也在本工作区内；无父线程时为 null（不适用）。 */
        threadParentInWorkspace: boolean | null;
        previousCardId: string | null;
        /** 由近到远的父链；成环时在闭环节点前停止。 */
        ancestors: ProvenanceAncestor[];
        /** 父链是否成环（快照本身不一致，结论不可全信）。 */
        cycle: boolean;
    };
    coverage: ProvenanceCoverage;
}
/** 拒绝结果。`field` 只给字段名，**不回显字段值**。 */
export interface ProvenanceRejection {
    ok: false;
    code: string;
    field?: string;
}
/** 成功结果。 */
export interface ProvenanceSuccess {
    ok: true;
    data: ProvenanceData;
}
export type ProvenanceResult = ProvenanceSuccess | ProvenanceRejection;
/**
 * 读一份快照里某张卡片的来源。
 *
 * 入参按 `unknown` 收窄（这是不受信输入的边界）：`{ document, workspaceId, cardId }`。
 * 返回判别联合，调用方先看 `ok` 再取字段。
 */
export declare function readProvenance(request: unknown): ProvenanceResult;
