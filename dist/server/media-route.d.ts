/**
 * EV Canvas · 媒体上传路由（S0-3 配套）
 *
 * 职责边界：本模块**只处理已经解析好的入参**，不碰 `req` / `res`。
 * 读 body、写响应、限流、鉴权都属于宿主层（`src/server/index.ts`）；
 * 这里只回答一个问题：**这份字节能不能落盘，落盘结果该用哪个状态码回**。
 *
 * 为什么拆成不依赖宿主 ctx 的纯函数：上传的失败分支（空文件、超限、MIME
 * 欺骗、路径穿越）恰恰是最容易写错、也最不该靠手工点页面验证的部分。
 * 把它们和 HTTP 管道解耦后，7 条拒绝路径可以逐条单测，不用起服务器。
 *
 * 校验**不在这里重写**：魔数表与白名单来自 `assets.ts` / `shared/constants.ts`，
 * 真正的写入、原子替换、内容去重也由 `assets.ts` 的 `saveAsset` 完成
 * （宿主通过 `deps.storeAsset` 注入，见 `createAssetStore`）。
 * 本模块只做**前置分类**——因为 `saveAsset` 抛的 `InputError` 一律是 400，
 * 而客户端需要区分 400 / 413 / 415，否则「文件太大」和「格式不对」看起来一样。
 */
/**
 * 单次上传的字节上限：32 MiB。
 *
 * 为什么不用 `assets.ts` 的 50 MiB：`MAX_DOCUMENT_BYTES`（布局更新 / 导入）
 * 也是 32 MiB，前端上传走的是同一条 HTTP 通道，两个上限对齐后不会出现
 * 「导入能过、传图被拒」的割裂。路由层比存储层更严是**刻意**的——存储层
 * 上限是最后一道兜底，路由层要留拒绝余量。
 *
 * 为什么这个检查必须在读 body 之前：宿主必须按本常量**流式累加**并在超限时
 * 立刻中断（同 `readJson` 的 `maxBytes` 做法），绝不能先把整个 body 收进内存
 * 再交给这里判断。32 MiB 的请求若先落地再拒绝，并发几个就能把进程内存打爆；
 * 本模块里的长度判断是**兜底**，不是第一道闸。
 */
export declare const MAX_MEDIA_BYTES: number;
export interface MediaRouteDeps {
    /** assets.ts 提供的资产存储函数，测试时可替换。 */
    storeAsset: (input: {
        data: Buffer;
        mime: string;
        filename?: string;
    }) => Promise<{
        assetId: string;
        bytes: number;
        sha256: string;
        mime: string;
    }>;
    /** 资产根目录（测试用临时目录）。 */
    assetsRoot: string;
}
export interface MediaUploadResult {
    status: number;
    body: Record<string, unknown>;
}
/**
 * 把 `assets.ts` 的 `saveAsset` 适配成本模块需要的 `storeAsset` 形状。
 *
 * 存在理由：`saveAsset` 的签名是 `{ root, buffer, declaredMime }`，而路由层
 * 拿到的是 `{ data, mime, filename }`。这层薄适配让宿主只接线一次，
 * 也保证「校验 + 原子写 + 去重」永远走 `assets.ts`，路由里不会长出第二套实现。
 */
export declare function createAssetStore(root: string): MediaRouteDeps['storeAsset'];
/**
 * 处理一次上传。入参是已解析好的内容，不碰 req/res，
 * 由宿主层负责读 body 与写响应。
 *
 * 判定顺序是有讲究的（先便宜、先安全，再碰数据）：
 *   1. 依赖装配 / 根目录 —— 配错时不能假装是用户输入问题
 *   2. 文件名 —— 任何路径语义在进入后续逻辑前就掐掉
 *   3. 空 / 超限 —— 不把明显不合格的载荷往下传
 *   4. MIME 白名单 —— 未知类型不给魔数解析机会
 *   5. 魔数双验 —— 声明类型不可信，必须看真实字节
 *   6. 交给 storeAsset —— 校验、原子写、去重都在那里
 */
export declare function handleMediaUpload(deps: MediaRouteDeps, input: {
    filename?: string;
    contentType?: string;
    data: Buffer;
}): Promise<MediaUploadResult>;
