import type { SchemaPosition, IdempotencyEntry } from '../shared/schema.js';
/** 一条投影消息（可变视图；字段与 `shared/schema` 的 MESSAGE_FIELDS 一致）。 */
export interface MutableMessage {
    id: string;
    text?: string;
    kind?: string;
    sourceSeq?: number;
    at?: string;
    turn?: number;
    step?: number;
    process?: MutableProcessEntry[];
}
/** 一条工具过程记录。 */
export interface MutableProcessEntry {
    callId?: string;
    turn?: number;
    step?: number;
    name?: string;
    arguments?: unknown;
    result?: unknown;
    error?: unknown;
}
/** 覆盖率声明。 */
export interface MutableCoverage {
    ranges: number[][];
    historyComplete: boolean;
    textTruncated: boolean;
}
/** 一条投影线程（可变视图）。 */
export interface MutableThread {
    id: string;
    title?: string | null;
    parentId?: string | null;
    sourceParentSessionId?: string | null;
    sourceSeedLength?: number | null;
    dshSessionId?: string | null;
    dshSessionTitle?: string | null;
    color?: string | null;
    createdAt?: string;
    /** 所有写入路径都写 ISO 字符串；`dshThread` 建线程时也是 `now`。 */
    updatedAt?: string;
    messages: MutableMessage[];
    pendingProcess: MutableProcessEntry[];
    coverage?: MutableCoverage;
    /** 旧版过渡字段：由 `canonicalizeThreads` 搬到 `layout.cards` 后删除。 */
    position?: SchemaPosition;
}
/** 布局包（可变视图）。 */
export interface MutableLayout {
    cards: Record<string, SchemaPosition>;
    collapsed: Record<string, unknown>;
    viewport: {
        x: number;
        y: number;
        zoom: number;
    };
}
/** 一个工作区（可变视图）。 */
export interface MutableWorkspace {
    id: string;
    kind?: string;
    dshWorkspaceId?: string | null;
    cwd?: string | null;
    title?: string;
    revision: number;
    projectionEpoch: number;
    createdAt?: string;
    updatedAt?: string;
    projection: {
        threads: MutableThread[];
    };
    layout: MutableLayout;
    materials: Record<string, unknown>[];
    regions: Record<string, unknown>[];
    annotations: Record<string, unknown>[];
    /** 旧版只读别名，仅供 `workspaceView` 的兼容读视图回退。 */
    threads?: MutableThread[];
}
/** 顶层文档（可变视图）。 */
export interface MutableState {
    format?: string;
    schemaVersion?: number;
    updatedAt: string;
    hiddenSessionIds: string[];
    idempotency: Record<string, IdempotencyEntry>;
    idempotencyFloor: string | null;
    workspaces: MutableWorkspace[];
}
/** 一个分批目录快照（仅内存，永不落盘）。 */
interface DirectorySnapshot {
    snapshotId: string;
    nextCursor: number;
    lastCursor: number;
    completed?: boolean;
    ready?: boolean;
    sessionById: Map<string, HostSessionEntry>;
    workspaceById: Map<string, HostWorkspaceEntry>;
    removed: Set<string>;
}
/** 目录快照结算后的载荷。 */
interface SettledDirectory {
    sessions: HostSessionEntry[];
    removedSessionIds: string[];
    workspaces: HostWorkspaceEntry[];
    cleanup: boolean;
    pending: DirectorySnapshot;
}
/** 宿主目录里的一行会话。 */
interface HostSessionEntry {
    id: string;
    cwd?: unknown;
    blank?: unknown;
    title?: unknown;
    parentId?: unknown;
    [key: string]: unknown;
}
/** 宿主目录里的一行工作区。 */
interface HostWorkspaceEntry {
    id: string;
    title?: unknown;
    path?: unknown;
    cwd?: unknown;
    sessionIds?: unknown;
    [key: string]: unknown;
}
/** 一个冷历史窗口（仅内存）。 */
interface HistoryWindow {
    historyId: string;
    sessionId: string;
    nextCursor: number;
    lastCursor: number;
    completed?: boolean;
    events: HistoryEvent[];
    bytes?: number;
    title?: string;
    cwd?: string;
    lowWater?: number;
    hasMore?: boolean;
    claimsComplete?: boolean;
}
/** 结算后的历史窗口。 */
interface SettledHistoryWindow {
    historyId: string;
    sessionId: string;
    title: string | undefined;
    cwd: string | undefined;
    lowWater: number | undefined;
    hasMore: boolean | undefined;
    claimsComplete: boolean | undefined;
    events: HistoryEvent[];
}
/** 一条线上事件（已收窄到投影读取的字段）。 */
export interface HistoryEvent {
    seq: number;
    type: string;
    time: number;
    data?: unknown;
}
/** 被投影进画布的宿主会话（`projectSession` / `projectEvent` 的入参形状）。 */
export interface ProjectableSession {
    id: string;
    title?: unknown;
    header?: {
        cwd?: unknown;
        parentSession?: unknown;
        meta?: unknown;
    } | null;
    inheritedEventCount?: unknown;
    snapshotEvents?: () => Iterable<ProjectableEvent>;
}
/** 被投影的一条已提交事件。 */
export interface ProjectableEvent {
    seq: number;
    type: string;
    time: number;
    data?: unknown;
}
/** `mutateLocked` 的选项。 */
export interface MutateOptions {
    deferred?: boolean;
    envelope?: Record<string, unknown> | undefined;
    creating?: boolean;
    workspaceId?: string;
    targetThreadId?: string;
    beforeCommit?: (() => Promise<void>) | undefined;
}
/** `replaceFileWithRetry` 的注入点（测试用）。 */
interface ReplaceRetryOptions {
    replace?: (from: string, to: string) => Promise<void>;
    wait?: (ms: number) => Promise<unknown>;
    random?: () => number;
}
/** 构造选项。 */
export interface WorkspaceStoreOptions {
    onFlushError?: (error: unknown) => void;
}
/**
 * Union one seq interval into a coverage range list.
 *
 * `coverage.ranges` is a list of closed, sorted, non-touching intervals; a range
 * only ever grows, so merging is monotonic. Overlapping AND adjacent intervals
 * collapse ([1,3] + [4,5] -> [1,5]): a gap of zero seqs is not a gap, and
 * leaving it as two entries would make every later "is this seq covered?"
 * reader special-case adjacency.
 */
export declare function mergeCoverageRanges(ranges: unknown, from: unknown, to: unknown): number[][];
/** JSON persistence for the Synapnova workspace graph. */
export declare class WorkspaceStore {
    dataFile: string;
    onFlushError: (error: unknown) => void;
    sessionOwnership: Map<string, {
        id: string;
        title: string;
    }>;
    directorySnapshot: DirectorySnapshot | null;
    historyWindows: Map<string, HistoryWindow>;
    /**
     * 文档本身。
     *
     * 构造时字面赋值 `undefined`（旧实现如此），首个 `publishState` 之前不可读。
     * 所有公开方法都先 `await this.ready`（`load()` 已完成发布），所以运行期恒有值；
     * 这里用 definite-assignment 表达该不变量，不插入任何运行时兜底。
     */
    state: MutableState;
    serial: Promise<unknown>;
    projectionGeneration: number;
    ready: Promise<void>;
    lastKnownMtime: number | null;
    lastKnownDigest: string | null;
    lockToken: string | null;
    dirty: boolean;
    flushTimer: ReturnType<typeof setTimeout> | null;
    /** 旧格式（无 `format` 字段）时为只读；`publishState` 会置回 false。 */
    legacyReadOnly?: boolean;
    constructor(dataFile: unknown, { onFlushError }?: WorkspaceStoreOptions);
    runExclusive<T>(action: () => T | Promise<T>): Promise<T>;
    /**
     * 归一化 + 加载期修复。返回 `{ state, repaired }`：
     * `repaired` 表示这次是否真的发生了归并/前缀写回，`load()` 用它决定要不要回写磁盘。
     *
     * 不靠对象引用判断：`normalizeFrozenState` 总会造新对象。
     * 也不靠 `updatedAt`：别处也会改它，且 `load()` 读到的值本身就是旧的。
     */
    prepareState(state: unknown): {
        state: MutableState;
        repaired: boolean;
    };
    publishState(state: unknown): void;
    projectionEpochFor(session: ProjectableSession): number;
    metadata(): {
        format: string | null;
        schemaVersion: number | null;
        readOnly: boolean;
        migrationRequired: boolean;
    };
    snapshot(workspaceId?: string): Promise<Record<string, unknown>>;
    list(): Promise<Record<string, unknown>[]>;
    get(workspaceId: string): Promise<Record<string, unknown>>;
    create(title: unknown, envelope?: Record<string, unknown>): Promise<Record<string, unknown>>;
    createThread(workspaceId: string, input: Record<string, unknown> | null | undefined, envelope?: Record<string, unknown>): Promise<MutableThread>;
    branch(threadId: string, input: Record<string, unknown> | null | undefined, envelope?: Record<string, unknown>): Promise<MutableThread>;
    /**
     * Keep only the canvas graph in Synapnova; DSH remains the source of session
     * truth.
     *
     * A directory that does not fit one request arrives as a paged snapshot
     * (`snapshotId` / `cursor` / `complete`). The completeness gate lives here and
     * is deliberately unavoidable:
     *
     * - A batch that is not the last one is only staged in memory; the projection
     *   is not touched at all, so a half-arrived directory can neither add nor
     *   remove a single node.
     * - Node creation/updates and **all** removal (`removedSessionIds` and the
     *   blank-session sweep) happen only when the closing batch arrives. Anything
     *   else would treat "has not arrived yet" as "was deleted", which is exactly
     *   how a paging bug silently deletes user-visible cards.
     * - Removal additionally requires the host directory to have reported
     *   `phase: 'ready'`. A pending directory is an incomplete listing, so a
     *   session missing from it is unknown, not gone. Unknown phase is treated as
     *   not-ready (fail closed).
     * - A partial snapshot is never persisted: it lives in `this.directorySnapshot`
     *   next to `this.sessionOwnership`, because the frozen document field list is
     *   closed and must not grow a protocol-only key.
     *
     * The legacy three-argument call (no envelope) is still one complete listing,
     * which is what every non-paged caller and the direct-call fixtures use.
     */
    syncSessions(sessions: unknown, removedSessionIds?: unknown, hostWorkspaces?: unknown, envelope?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
    /**
     * Accumulate one paged directory batch and report whether the snapshot closed.
     *
     * Returns `null` while the snapshot is still incomplete (or when a repeat of
     * an already-settled batch arrives, which is a no-op), otherwise the complete
     * accumulated listing plus whether removal is allowed.
     */
    acceptDirectoryBatch(sessions: HostSessionEntry[], removedSessionIds: string[], hostWorkspaces: HostWorkspaceEntry[], envelope: Record<string, unknown> | undefined): SettledDirectory | null;
    /**
     * Apply one complete listing while the caller already holds the write queue.
     *
     * `mutate` would deadlock here (it takes `runExclusive` itself), so this is the
     * unlocked body. Only `syncSessions` may call it, from inside `runExclusive`.
     */
    applyDirectoryLocked(sessions: HostSessionEntry[], removedSessionIds: string[], hostWorkspaces: HostWorkspaceEntry[], cleanup: boolean): Promise<Record<string, unknown>[]>;
    /** Apply one complete listing to the projection. Removal is gated by `cleanup`. */
    applyDirectory(sessions: HostSessionEntry[], removedSessionIds: string[], hostWorkspaces: HostWorkspaceEntry[], cleanup: boolean): Promise<Record<string, unknown>[]>;
    /**
     * 判断一个未绑定行（`dshWorkspaceId == null`）是否**可以**被 `hostWorkspaceId` 收编。
     *
     * ## 问题本质
     *
     * `byCwd` 回退把「这一行没有宿主绑定」当成了「这一行属于那个宿主工作区」的
     * 证据，但它分不清两种来源：
     *
     *   - **遗留行**：升级前写下的，或 S0-6 从磁盘回填的。里面装的是宿主管不到的
     *     历史会话 —— 收编是对的，否则老数据永久失联。
     *   - **本批次未归属桶**：宿主当前确实没给这些会话分配工作区。收编就是越界：
     *     用户在 A 里看到不属于它的卡片，删掉还会从「未分组」一起消失。
     *
     * ## 判据：行内有没有「宿主列出了、却没给它归属」的会话
     *
     * 这是唯一同时满足两个场景的判据：
     *
     *   - **有** → 这一行就是本批次的未归属桶，收编会把那些会话带进别人的工作区。
     *   - **没有** → 行内的会话要么宿主压根管不到（回填的旧会话），要么已经明确
     *     归了这个工作区。两种情况收编都只是补上绑定，不搬运别人的数据。
     *
     * ## 试过但不成立的三版（都是真实教训）
     *
     *   1. 「行内所有会话都归属同一宿主工作区」→ 拒绝收编回填行（回填会话没有
     *      归属声明），画布分裂成「未分组」+「工作区」两份。
     *   2. 「只否决明确归了别人的会话」→ 泄漏重现（未归属会话同样没有声明）。
     *   3. 「按行是否本轮之前存在」→ 跨轮场景下未归属行同样早就在了，被误判成
     *      遗留行，泄漏照旧。
     *
     * 前三版都在猜「这个会话属于谁」；正解是换个问法：「这个会话，宿主现在
     * 到底有没有给它安排位置」。
     */
    private legacyRowBelongsTo;
    /** The locked/unlocked shared body: one complete listing written to the projection. */
    directoryAction(sessions: HostSessionEntry[], removedSessionIds: string[], hostWorkspaces: HostWorkspaceEntry[], cleanup: boolean): () => Record<string, unknown>[];
    addMessage(threadId: string, text: unknown, envelope?: Record<string, unknown>): Promise<MutableThread>;
    updateThread(threadId: string, input: Record<string, unknown> | null | undefined, envelope?: Record<string, unknown>): Promise<MutableThread>;
    removeThread(threadId: string, envelope?: Record<string, unknown>): Promise<{
        removed: number;
    }>;
    clearLegacy(sessions: {
        id: string;
    }[]): Promise<{
        cleared: true;
    }>;
    /**
     * Drop `dsh` workspaces whose host directory no longer exists (UI-D12).
     *
     * ## Why this has to live in the server, not in the data file
     *
     * Hand-editing `workspaces.json` to remove stale rows does not stick: the
     * running store holds the whole document in memory and rewrites it wholesale
     * on the next save, so the rows come straight back. The prune has to be a code
     * path that runs **inside** the store, and it has to run again whenever the
     * host's directory listing is refreshed.
     *
     * ## Why "directory missing" is the right signal
     *
     * A workspace is one host directory. Its sessions survive in DSH's own logs
     * (`$DSH_HOME/sessions/…`) long after the directory is gone, so removing the
     * canvas row loses only the projection and layout — never the conversation.
     * Rows with a null `cwd` are left alone: nothing proves they are stale, and
     * silently deleting unowned data is worse than showing an empty row.
     *
     * @param exists - injectable so tests need no real directories.
     * @returns the titles that were dropped, for logging.
     */
    pruneMissingDirectories(exists?: (dir: string) => boolean): Promise<string[]>;
    /** Replay one live DSH session into the dedicated projection workspace. */
    projectSession(session: ProjectableSession, replayFrom?: number, workspaceTitle?: string, projectionEpoch?: number, generation?: number): Promise<MutableThread | null>;
    /** Project one committed DSH session event. Repeated sequence numbers are ignored. */
    projectEvent(session: ProjectableSession, event: ProjectableEvent, workspaceTitle?: string, projectionEpoch?: number): Promise<MutableThread | null>;
    /** Project a batch of committed events for one session in a single write. */
    projectEvents(session: ProjectableSession, events: ProjectableEvent[], workspaceTitle?: string, projectionEpoch?: number, generation?: number): Promise<MutableThread | null>;
    /**
     * Accept one cold-history backfill window.
     *
     * This is a **deferred, envelope-free background write**, exactly like
     * `projectEvents`: reading old history is not a user edit, so it carries no
     * `baseRevision`, cannot conflict, and returns no revision. Its return value
     * is a report, never a revision promise.
     *
     * Two invariants are enforced here rather than trusted from the client:
     *
     * - A window is one logical unit however many requests it takes. Only the
     *   closing batch is applied, so a half-arrived window can neither widen
     *   `coverage.ranges` nor claim `historyComplete`.
     * - `historyComplete` is a claim about the WHOLE log. It is honoured only when
     *   the reported low water mark is seq 0 and the loader says no older page
     *   remains; any other combination is stored as "not complete". `loadThrough`
     *   resolves without loading in several cases (a concurrent page, a
     *   non-open session), so a client that mistakes that for success must not be
     *   able to turn it into a persisted claim.
     */
    syncHistory(payload: unknown): Promise<{
        accepted: false;
    } | {
        sessionId: string;
        ranges: number[][];
        historyComplete: boolean;
    }>;
    /** Stage one history batch; return the settled window when it closes. */
    acceptHistoryBatch(payload: unknown): SettledHistoryWindow | null;
    /**
     * Drop the oldest SETTLED windows so a misbehaving client cannot grow the map.
     *
     * Only settled windows are eligible. An in-flight window (one that has taken
     * `cursor: 0` but not yet its closing batch) must survive: deleting it turns
     * the next batch into a 400 "历史窗口缺少起始批次", and because the client
     * posts one window per Session the failure hits every session competing for
     * the last slot. The previous implementation ignored `completed` and simply
     * dropped the oldest key, which silently killed whichever backfill happened
     * to be oldest — the map's own docstring already promised otherwise.
     *
     * If nothing has settled yet we let the map exceed the ceiling rather than
     * abort live transfers. That is bounded in practice (one window per session)
     * and still finite, unlike the stream of 400s it replaces.
     */
    pruneHistoryWindows(): void;
    /** Validate one wire event down to the fields the projection reads. */
    historyEventOf(event: unknown): HistoryEvent;
    /**
     * Project one settled window and widen `thread.coverage` accordingly.
     *
     * Deferred (no envelope, no revision contract) for the same reason as
     * `projectEvents`: a background history read is not a user edit.
     */
    applyHistoryWindow(window: SettledHistoryWindow): Promise<{
        sessionId: string;
        ranges: number[][];
        historyComplete: boolean;
    }>;
    load(): Promise<void>;
    /**
     * Run one committed change against the document.
     *
     * Two publication rules, split by how the write lands:
     *
     * - Deferred (event projection) writes coalesce into one later save, so the
     *   change has to be visible before that write happens; a failed flush keeps
     *   `dirty` set and stays reportable.
     * - Everything else stages on a candidate copy and publishes it only after
     *   the file is on disk. A rejected write — bad input, a held lock, an
     *   external rewrite — therefore leaves memory exactly as it was, instead of
     *   applying a half-finished change to the live document.
     */
    commit(envelope: Record<string, unknown>, action: (workspace: MutableWorkspace) => unknown, { beforeCommit }?: {
        beforeCommit?: () => Promise<void>;
    }): Promise<unknown>;
    /**
     * Write one complete layout snapshot.
     *
     * **Returns the committed `revision`** (and `viewport`, which the caller may
     * have just clamped). The revision is what makes an optimistic-lock client
     * work: without it the caller has no way to learn the new version number
     * except by re-reading the whole workspace, and re-reading is asynchronous
     * relative to a local write queue.
     *
     * Why this matters enough to widen the return type: the canvas write queue
     * serialises PATCHes, but React re-renders only after the microtask queue
     * drains. A client that waits for a reload to learn the revision therefore
     * sends its next queued write with the previous revision and gets 409. Hand
     * the revision back in the response and the queue can track it synchronously.
     */
    updateLayout(workspaceId: string, input: Record<string, unknown> | null | undefined, envelope: Record<string, unknown>): Promise<{
        layout: MutableLayout;
        regions: Record<string, unknown>[];
        annotations: Record<string, unknown>[];
        revision: number | null;
    }>;
    mutate<T>(action: () => T, options?: MutateOptions): Promise<T>;
    /**
     * The body of `mutate`, for callers that already hold the write queue.
     *
     * Only `syncSessions` uses this: its paged path must stage the batch, apply the
     * closing listing, and be able to reopen the snapshot if the apply fails — one
     * atomic step that a nested `runExclusive` would deadlock on.
     */
    mutateLocked<T>(action: () => T, { deferred, envelope, creating, workspaceId, targetThreadId, beforeCommit }?: MutateOptions): Promise<T | null>;
    /** Mark the state dirty and schedule one trailing flush for the window. */
    markDirty(): void;
    /** Persist the current state when dirty, ordered after in-flight mutations. */
    flush(): Promise<unknown>;
    save(): Promise<void>;
    /**
     * Atomically publish the temporary file.
     *
     * On Windows `rename` fails with EPERM/EACCES/EBUSY when another handle has
     * the target open — a concurrent reader (the regression suite polling the
     * data file, an indexer, a second store) collides with roughly 3% of writes.
     * A single attempt silently loses that projection, so retry a bounded number
     * of times with short backoff. `flush()` itself still does not auto-retry: a
     * genuinely persistent failure keeps `dirty` set and stays reportable.
     */
    replaceFileWithRetry(temporaryFile: string, { replace, wait, random }?: ReplaceRetryOptions): Promise<void>;
    fileDigest(): Promise<string | null>;
    /**
     * Take an exclusive cross-process lock, breaking only a provably stale one.
     *
     * A live holder now makes the write fail outright. The previous behaviour was
     * to warn on stderr and then write anyway, which is precisely how two
     * instances clobbered each other's canvas.
     */
    acquireLock(): Promise<void>;
    tryAcquire(lockFile: string): Promise<boolean>;
    /** A lock is stale when its owner PID is gone or the lock file is older than the stale window. */
    lockIsStale(lockFile: string): Promise<boolean>;
    /** Remove the lock only if this store still owns it. */
    releaseLock(): Promise<void>;
    workspace(workspaceId: string): MutableWorkspace;
    locateThread(threadId: string): {
        workspace: MutableWorkspace;
        thread: MutableThread;
    };
    /**
     * Resolve the projected workspace for one DSH workspace.
     *
     * The host workspace id is the authority. `cwd` is only a display label plus
     * a one-time adoption key for rows written before the binding existed, so two
     * host workspaces that happen to share a path no longer merge into one canvas
     * node. When this path has no host attribution at all (direct replay, tests
     * that drive the store without a host directory), keep the historical
     * per-cwd grouping instead of collapsing every session into one bucket.
     *
     * ## `allowCwdAdoption` 为什么必须由调用方显式传
     *
     * `byCwd` 回退本意只收「旧版本按 cwd 匹配留下的、没有 host 绑定的历史行」。
     * 但 `dshWorkspaceId == null && cwd 相同` 这个条件**同时匹配**另一种情况：
     * 本批次里确实还没有归属的会话（宿主还没把它分到任何工作区）。
     *
     * 两者形状一样，只看行本身无法区分，于是出过两个真实故障：
     *   - **同批次顺序敏感**：未归属会话排在已归属会话之前时，整个未归属桶
     *     被随后出现的宿主工作区吞掉；调换顺序就正常。
     *   - **跨轮必现**：第一轮宿主只报会话、第二轮才报工作区，那个会话被收编。
     * 后果是用户在 A 里看到不属于它的卡片，删掉还会连带从「未分组」消失。
     *
     * 所以把判断交给**知道本批次全貌**的调用方：`directoryAction` 能算出
     * 「本批次里这个 cwd 是否已有真正绑定该 host id 的工作区」。若有，说明
     * `byCwd` 命中的只可能是历史残留而不是本批次的未归属桶，才允许收编。
     * 默认 `false` —— 默认不猜，猜错的代价是数据串味。
     */
    dshWorkspace(hostWorkspaceId: string | null, fallbackTitle: string, cwd?: string | null, allowCwdAdoption?: boolean): MutableWorkspace;
    /** Which projected workspace does one live/committed session belong to? */
    dshWorkspaceForSession(session: ProjectableSession, fallbackTitle?: string): MutableWorkspace;
    dshThread(workspace: MutableWorkspace, session: ProjectableSession): MutableThread;
    projectEventInto(workspace: MutableWorkspace, thread: MutableThread, event: ProjectableEvent): void;
    /**
     * Fold one tool call or result into the assistant message of its own
     * turn/step, keyed by `callId`, so a tool invocation never becomes a
     * separate canvas card. If a tool result arrives before its associated
     * assistant/error message, retain it on the thread until that turn appears.
     */
    foldToolProcess(thread: MutableThread, event: ProjectableEvent): void;
    attachPendingProcess(thread: MutableThread, message: MutableMessage): void;
    thread({ title, parentId, dshSessionId, dshSessionTitle, position, color, now, order }: {
        title?: unknown;
        parentId?: unknown;
        dshSessionId?: unknown;
        dshSessionTitle?: unknown;
        position?: unknown;
        color?: unknown;
        now: string;
        order: number;
    }): MutableThread;
    summary(workspace: MutableWorkspace): Record<string, unknown>;
}
export declare function canonicalHash(value: unknown): string;
/**
 * Collapse workspaces that describe the same canvas but were split apart by an
 * earlier version of the adoption rule.
 *
 * Before the host workspace id became the lookup key, rows were matched by
 * `cwd` alone. A row written while no host attribution was available (`null`)
 * therefore stayed behind as its own canvas once the host id appeared, and the
 * canvas then opened on whichever duplicate the list happened to put first —
 * typically the empty one — so already-projected sessions looked missing.
 *
 * Merge rule, applied per `cwd` group of `kind === 'dsh'` rows:
 *  - only rows that carry **no host id** (`null`, `''`, or absent) are merge
 *    candidates. Two rows bound to *different* host ids are two real host
 *    workspaces that happen to share a path; the host id stays authoritative and
 *    they must never be collapsed;
 *  - an unbound row folds into the heaviest *bound* row of the same `cwd` when
 *    one exists — that is exactly the leftover the adoption rule stranded;
 *  - when several unbound rows share a `cwd`, they collapse into one, keeping
 *    the skeleton of a thread that has no messages as history;
 *  - a `dsh-ungrouped` row never absorbs rows that carry messages, and is only
 *    itself absorbed when it is empty: it holds sessions the host has not
 *    grouped, and dropping that content would lose sessions the user still
 *    expects to see.
 *
 * The function is pure on its input and idempotent: already-canonical documents
 * come back untouched, so a load that changes nothing still rewrites nothing.
 */
export declare function mergeSplitWorkspaces(state: unknown): boolean;
export {};
