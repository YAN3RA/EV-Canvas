/**
 * EV Canvas · 媒体资产存储（S0-3）
 *
 * 设计依据：Project Docs/2-设计/S0-1-统一节点schema设计.md §7
 *
 * 硬约束（来自 PRD 与旧版教训）：
 *   1. 媒体二进制**不入库** —— workspaces.json 只存 assetId 与元数据
 *   2. 路径由 sha256 计算，**永不拼接用户输入**（防目录穿越）
 *   3. MIME 必须双验：声明类型 + 文件魔数
 *   4. 写入原子：临时文件 → fsync → rename
 *   5. 同内容只存一份（内容寻址天然去重）
 *   6. 缺失文件必须明确报错，不得静默
 */
/** 判定字节的真实类型；返回 null 表示无法识别 */
export declare function sniffMime(buffer: Buffer): string | null;
/** 校验入参：白名单 + 大小 + 魔数与声明一致，返回真实 MIME。 */
export declare function validateAsset({ buffer, declaredMime }: {
    buffer: Buffer;
    declaredMime: string;
}): string;
/** sha256 摘要（十六进制小写） */
export declare function digestOf(buffer: Buffer): string;
/**
 * 内容寻址路径：`<root>/<sha256 前两位>/<sha256>.<ext>`
 *
 * 这是**唯一**生成资产路径的函数。任何调用方都不得自己拼路径，
 * 否则目录穿越的口子就打开了。
 */
export declare function assetPathFor(root: string, sha256: string, mime: string): string;
/** 资产元数据。`createdAt` 为 null 表示本次是去重命中（没有新写入）。 */
export interface AssetMeta {
    assetId: string;
    mime: string;
    bytes: number;
    sha256: string;
    createdAt: string | null;
    deduped: boolean;
}
/** 读取路径所需的元数据子集：只要 sha256 与 mime。 */
export interface AssetRef {
    assetId?: string;
    mime: string;
    sha256: string;
}
/**
 * 保存一个资产，返回其元数据。
 *
 * 幂等：同一份内容重复保存只会返回已有元数据，不重复写盘。
 */
export declare function saveAsset({ root, buffer, declaredMime, now, }: {
    root: string;
    buffer: Buffer;
    declaredMime: string;
    now?: () => string;
}): Promise<AssetMeta>;
/** 读取资产字节。缺失时抛 MissingAssetError，**绝不返回空**。 */
export declare function readAsset({ root, meta }: {
    root: string;
    meta: AssetRef;
}): Promise<Buffer>;
/** 资产是否存在（用于加载期降级判断，不抛错） */
export declare function assetExists({ root, meta }: {
    root: string;
    meta: AssetRef;
}): Promise<boolean>;
