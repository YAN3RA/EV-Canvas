/** Refusal thresholds. PROVISIONAL: not load-tested, do not promise capacity. */
export declare const IMPORT_LIMITS: Readonly<{
    maxBytes: number;
    maxEvents: 50000;
    maxCards: 10000;
}>;
/** Token lifetime: a preview older than this must be re-taken. */
export declare const TOKEN_TTL_MS: number;
/** Stable refusal codes so the UI can localise instead of echoing prose. */
export declare const IMPORT_REJECT: Readonly<{
    tooLarge: "too-large";
    tooManyEvents: "too-many-events";
    tooManyCards: "too-many-cards";
    badFormat: "bad-format";
    badVersion: "bad-version";
    duplicateId: "duplicate-id";
    danglingReference: "dangling-reference";
    notAnObject: "not-an-object";
    workspaceMismatch: "workspace-mismatch";
    tokenExpired: "token-expired";
    tokenUsed: "token-used";
    tokenUnknown: "token-unknown";
    revisionStale: "revision-stale";
    dirtyToken: "content-changed";
    backupFailed: "backup-failed";
    restoreFailed: "restore-failed";
    interruptedTransaction: "interrupted-transaction";
}>;
/** JSON 值（`contentHash` / `structuredClone` 的输入口径）。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
/** 拒绝结果的统一形状。`code` 取自 `IMPORT_REJECT`。 */
export interface ImportRejection {
    ok: false;
    code: string;
    detail: unknown;
}
/** `inspectImport` 成功时的计数。 */
export interface ImportCounts {
    threads: number;
    events: number;
    cards: number;
    materials: number;
    regions: number;
    annotations: number;
}
/** 覆盖率告警：某个线程的投影历史并不完整。 */
export interface ImportCoverageWarning {
    threadId: unknown;
    ranges: unknown;
}
/** `inspectImport` 的成功结果。 */
export interface ImportInspection {
    ok: true;
    bytes: number;
    counts: ImportCounts;
    hash: string;
    coverageWarnings: ImportCoverageWarning[];
}
/** `inspectImport` 的选项。 */
export interface InspectImportOptions {
    limits?: {
        maxBytes: number;
        maxEvents: number;
        maxCards: number;
    };
}
/** 导入/还原的收据（只含备份路径与字节数，不含正文）。 */
export interface BackupReceipt {
    path: string;
    bytes: number;
    digest: string;
}
/** 预览 token 的登记项。 */
interface TokenEntry {
    workspaceId: string;
    baseRevision: number;
    hash: string;
    issuedAt: number;
    usedAt: number | null;
}
/** `createTokenRegistry` 的产物。 */
export interface TokenRegistry {
    issue: (input: {
        workspaceId: string;
        baseRevision: number;
        hash: string;
    }) => string;
    consume: (input: {
        token: string;
        workspaceId: string;
        baseRevision: number;
        hash: string;
    }) => ImportRejection | {
        ok: true;
        token: string;
    };
    pending: () => (TokenEntry & {
        token: string;
    })[];
    prune: () => void;
    clear: () => void;
    size: () => number;
}
/** 预览对象：调用方（通常是 IPC 层）在两次请求之间保存的那份。 */
export interface ImportPreview {
    raw: unknown;
    hash: string;
    baseRevision: number;
}
/**
 * `WorkspaceStore` 在本模块里的最小投影。
 *
 * 只声明实际调用的两个方法。真实 store 的方法签名比这里宽（可选参数、返回
 * Promise，`action` 收一个可变的工作区对象），因此真实实例可直接传入；而本模块
 * 也不需要反向 import store，避免与最高风险模块形成类型环。
 */
export interface ImportStorePort {
    workspace: (workspaceId: string) => Record<string, unknown>;
    commit: (envelope: Record<string, unknown>, action: (workspace: Record<string, unknown>) => unknown, options?: {
        beforeCommit?: () => Promise<void>;
    }) => Promise<unknown>;
}
/** 事务信封：转发给 Store，本模块不改写其中的 `baseRevision`。 */
export type CommitEnvelope = Record<string, unknown>;
/** Canonical hash of any JSON-able value: key order must not change the digest. */
export declare function contentHash(value: unknown): string;
/**
 * Validate one imported document against the frozen shape, WITHOUT writing.
 *
 * Returns the counts the preview screen shows plus a per-problem list. A single
 * bad reference rejects the whole batch: §4.1 step 4 says "任一引用映射失败拒绝
 * 整次导入，不部分覆盖", so this never repairs and never drops quietly.
 */
export declare function inspectImport(input: unknown, { limits }?: InspectImportOptions): ImportRejection | ImportInspection;
/**
 * Rebind an imported document onto `targetWorkspaceId`.
 *
 * Reuses the SAME thread ids (they are the file's own identity and the card ids
 * derive from them), rewrites the workspace id, and keeps only fields the frozen
 * document legally carries.
 *
 * NOTE on `origin`: §4.1 step 6 says the imported copy is marked
 * `origin=import`. `shared/schema.js` pins the workspace to exactly
 * `WORKSPACE_FIELDS = ['id','kind','dshWorkspaceId','cwd','title','createdAt','updatedAt']`
 * and `pickFields` DROPS everything else — so a persisted `origin` would vanish on
 * the next normalisation and silently look like it never worked. The marker is
 * therefore returned as transaction METADATA (`origin: 'import'` in the commit
 * result) rather than stored in the document. Storing it would require widening
 * the frozen schema, which is a data-format change outside this task's remit.
 */
export declare function buildCandidate(raw: unknown, { targetWorkspaceId, baseRevision }: {
    targetWorkspaceId: string;
    baseRevision: number;
}): Record<string, unknown>;
/**
 * Write a read-back-verified backup of the CURRENT workspace document.
 *
 * §4.1 step 3: "写可读回校验的完整旧工作区备份，备份失败则不替换". So this either
 * returns a path that really contains the bytes it claims, or it throws — there
 * is no "probably wrote it" outcome.
 */
export declare function writeBackup({ backupDir, workspaceId, revision, document, label }: {
    backupDir: string;
    workspaceId: string;
    revision: number;
    document: unknown;
    label?: string;
}): Promise<BackupReceipt>;
/**
 * One-shot preview tokens.
 *
 * A token binds (workspaceId, baseRevision, contentHash) so a stale preview can
 * never be replayed onto a newer document. It is consumed on first successful
 * commit; a second use is a distinct refusal, not a silent re-import.
 */
export declare function createTokenRegistry({ ttlMs, now }?: {
    ttlMs?: number;
    now?: () => number;
}): TokenRegistry;
/** `commitImport` 的成功结果。`origin` 是事务元数据，不写进文档。 */
export interface CommitImportSuccess {
    ok: true;
    response: unknown;
    backup: BackupReceipt | string | null;
}
/** `commitImport` 的入参。 */
export interface CommitImportInput {
    store: ImportStorePort;
    workspaceId: string;
    token: string;
    tokenRegistry: TokenRegistry;
    preview: ImportPreview;
    backupDir: string;
    operationId: string;
    envelope: CommitEnvelope;
}
/**
 * The transaction itself.
 *
 * Runs ENTIRELY inside the Store's serial queue, so a Host event that arrives
 * during the import is enqueued behind it and appended afterwards — that is how
 * §4.1 step 5 ("导入期间到达的 Host 事件…之后按来源去重追加") is satisfied without a
 * second queue.
 *
 * `beforeCommit` writes the backup. Because `mutate` publishes only after the
 * file lands, a backup failure leaves memory untouched.
 */
export declare function commitImport({ store, workspaceId, token, tokenRegistry, preview, backupDir, operationId, envelope }: CommitImportInput): Promise<ImportRejection | CommitImportSuccess>;
/** `restoreFromBackup` 的入参。 */
export interface RestoreFromBackupInput {
    store: ImportStorePort;
    workspaceId: string;
    backupPath: string;
    operationId: string;
    envelope: CommitEnvelope;
}
/**
 * Restore one workspace from a backup file.
 *
 * A restore is a NEW revision, never a version rollback (§4.1 last line). The
 * backup itself is read and validated before anything is replaced.
 */
export declare function restoreFromBackup({ store, workspaceId, backupPath, operationId, envelope }: RestoreFromBackupInput): Promise<ImportRejection | CommitImportSuccess>;
/** `readInterruptedMarker` 的产物。 */
export type InterruptedMarker = {
    interrupted: true;
    marker: string;
    [key: string]: unknown;
} | {
    interrupted: false;
    marker: null;
};
/**
 * Find a transaction that never finished.
 *
 * §4.1 step 7: "重启检测未完成导入事务并优先恢复". The marker is written before the
 * commit and removed after it, so a leftover marker means the process died in
 * between — the caller must restore before accepting writes for that workspace.
 */
export declare function readInterruptedMarker({ backupDir, workspaceId }: {
    backupDir: string;
    workspaceId: string;
}): Promise<InterruptedMarker>;
/** 写入「导入进行中」标记，返回标记文件路径。 */
export declare function writeInterruptedMarker({ backupDir, workspaceId, backupPath, preview }: {
    backupDir: string;
    workspaceId: string;
    backupPath: string;
    preview?: {
        hash?: unknown;
    } | null;
}): Promise<string>;
/** 清除「导入进行中」标记（已不存在时静默忽略），返回标记文件路径。 */
export declare function clearInterruptedMarker({ backupDir, workspaceId }: {
    backupDir: string;
    workspaceId: string;
}): Promise<string>;
export {};
