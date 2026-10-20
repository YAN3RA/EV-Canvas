import * as schema from '../shared/schema.js';
import type { LayoutMigrationPlan } from '../shared/migration.js';
/**
 * 迁移服务与 `WorkspaceStore` 的耦合点。
 *
 * 只声明实际调用到的成员（队列、锁、状态发布、原子替换、脏标记、源摘要）。
 * 真实 store 的成员比这里更宽，因此真实实例可直接传入；反过来本文件也不
 * 反向 import store 类型，避免与最高风险模块形成类型环。
 */
export interface MigrationStorePort {
    ready: Promise<unknown>;
    dataFile: string;
    dirty: boolean;
    lastKnownDigest: string | null;
    lastKnownMtime: number | null;
    runExclusive: <T>(action: () => Promise<T> | T) => Promise<T>;
    acquireLock: () => Promise<unknown>;
    releaseLock: () => Promise<unknown> | unknown;
    workspace: (workspaceId: string) => {
        revision: number;
    };
    prepareState: (state: unknown) => {
        state: unknown;
    };
    publishState: (state: unknown) => void;
    replaceFileWithRetry: (temporaryFile: string) => Promise<void>;
    commit: (envelope: Record<string, unknown>, action: (workspace: Record<string, unknown>) => unknown, options?: {
        beforeCommit?: () => Promise<void>;
    }) => Promise<unknown>;
}
/** 读写最小接口，便于测试注入内存实现。 */
export interface MigrationIO {
    readFile: (path: string) => Promise<Buffer>;
    writeFile: (path: string, data: Buffer | string, options?: {
        flag?: string;
    }) => Promise<unknown>;
}
/** `backupSources` 的产物：备份路径 + 读回校验过的摘要。 */
interface BackupArtifacts {
    backupPath: string;
    backupHash: string;
    browserBackupPath: string | undefined;
    browserBackupHash: string | null;
}
/** 一次预览在服务端保留的不可变快照。 */
interface LayoutPreviewRecord extends BackupArtifacts {
    mode: 'layout';
    sourceHash: string;
    plan: LayoutMigrationPlan;
}
/** 整文档迁移预览记录。 */
interface DocumentPreviewRecord {
    sourceHash: string;
    backupPath: string;
    browserBackupPath: string | undefined;
    browserBackupHash: string | null;
    backupHash: string;
    candidate: unknown;
}
/** 预览记录的联合。 */
type PreviewRecord = LayoutPreviewRecord | DocumentPreviewRecord;
export declare class MigrationService {
    store: MigrationStorePort;
    io: MigrationIO;
    now: () => string;
    previews: Map<string, PreviewRecord>;
    constructor(store: MigrationStorePort, { io, now }?: {
        io?: MigrationIO;
        now?: () => string;
    });
    exclusive<T>(action: () => Promise<T>): Promise<T>;
    assertQuiescent(): void;
    validateFrozen(value: unknown): schema.FrozenState;
    backupSources(bytes: Buffer, browserLayout: unknown): Promise<BackupArtifacts>;
    previewLayout({ workspaceId, browserLayout }?: {
        workspaceId: string;
        browserLayout?: unknown;
    }): Promise<Record<string, unknown>>;
    commitLayout(envelope?: Record<string, unknown>): Promise<unknown>;
    /** Only an explicit user request calls preview. Backups retain exact source bytes. */
    preview({ browserLayout, hostWorkspaces }?: {
        browserLayout?: unknown;
        hostWorkspaces?: unknown;
    }): Promise<Record<string, unknown>>;
    /** A token authorizes exactly the immutable candidate that was previewed. */
    commit({ previewToken }?: {
        previewToken?: string;
    }): Promise<Record<string, unknown>>;
}
export {};
