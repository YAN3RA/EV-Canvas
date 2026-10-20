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
import { saveAsset, sniffMime } from './assets.js';
import { ALLOWED_ASSET_MIME } from '../shared/constants.js';
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
export const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
/** 允许的 MIME：直接复用共享白名单，**不另立一份**（两份必然漂移）。 */
const ALLOWED_MIME = ALLOWED_ASSET_MIME;
/** 415 响应里要展示的类型清单；由白名单生成，永不与校验脱节。 */
const ALLOWED_MIME_TEXT = ALLOWED_MIME.join('、');
/**
 * 把 `assets.ts` 的 `saveAsset` 适配成本模块需要的 `storeAsset` 形状。
 *
 * 存在理由：`saveAsset` 的签名是 `{ root, buffer, declaredMime }`，而路由层
 * 拿到的是 `{ data, mime, filename }`。这层薄适配让宿主只接线一次，
 * 也保证「校验 + 原子写 + 去重」永远走 `assets.ts`，路由里不会长出第二套实现。
 */
export function createAssetStore(root) {
    return async ({ data, mime }) => {
        const meta = await saveAsset({ root, buffer: data, declaredMime: mime });
        return { assetId: meta.assetId, bytes: meta.bytes, sha256: meta.sha256, mime: meta.mime };
    };
}
/**
 * 规范化声明的 Content-Type：`image/png; charset=binary` → `image/png`。
 *
 * 浏览器与客户端会带参数、大小写不一；直接字符串比对会把合法请求误判成 415。
 */
function normalizeContentType(value) {
    if (typeof value !== 'string')
        return '';
    return value.split(';')[0]?.trim().toLowerCase() ?? '';
}
/**
 * 检查文件名是否可以安全保留；返回 `null` 表示通过，否则返回给用户看的原因。
 *
 * 为什么不学 `path.basename` 把 `../../etc/passwd` 悄悄改成 `passwd`：
 * 静默改写会让用户以为存下了 A，实际存的是 B。**拒绝并说清楚**比替人做主安全。
 *
 * 真正防穿越的仍是 `assets.ts` 的 `assetPathFor`（路径由 sha256 计算，
 * 从不拼接用户输入）；这里拦住的是「文件名被当作路径使用」的语义错误。
 */
function filenameProblem(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string')
        return '文件名必须是字符串';
    const name = value.trim();
    if (name === '')
        return null;
    if (name.length > 255)
        return `文件名过长（上限 255 字符）：${name.slice(0, 32)}…`;
    if (/[\\/\0]/.test(name))
        return `文件名不能包含路径分隔符：${name}`;
    if (name.includes('..'))
        return `文件名不能包含 ".."：${name}`;
    if (/^[A-Za-z]:/.test(name))
        return `文件名不能是盘符路径：${name}`;
    if (/[:*?"<>|]/.test(name))
        return `文件名含非法字符：${name}`;
    return null;
}
/** 组装统一的错误响应；`extra` 用来补机器可读字段（上限、允许列表）。 */
function fail(status, error, extra) {
    return { status, body: extra === undefined ? { error } : { error, ...extra } };
}
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
export async function handleMediaUpload(deps, input) {
    if (deps === null || typeof deps !== 'object' || typeof deps.storeAsset !== 'function') {
        // 装配错误不是用户的错，但也不能把内部细节抛给浏览器。
        return fail(500, '媒体路由未正确装配');
    }
    const root = typeof deps.assetsRoot === 'string' ? deps.assetsRoot.trim() : '';
    if (root === '') {
        return fail(500, '资产根目录未配置，媒体上传不可用');
    }
    const nameProblem = filenameProblem(input?.filename);
    if (nameProblem !== null)
        return fail(400, nameProblem);
    const data = input?.data;
    if (!Buffer.isBuffer(data)) {
        return fail(400, '上传内容必须是二进制数据');
    }
    if (data.length === 0) {
        // 单独一条分支：空文件是最常见的「上传按钮点空了」，
        // 归到「格式不支持」里会让人去换文件类型，方向完全错。
        return fail(400, '文件为空：上传内容长度为 0 字节');
    }
    if (data.length > MAX_MEDIA_BYTES) {
        return fail(413, `文件过大：${data.length} 字节，上限 ${MAX_MEDIA_BYTES} 字节（${MAX_MEDIA_BYTES / 1024 / 1024} MiB）`, { maxBytes: MAX_MEDIA_BYTES });
    }
    const declared = normalizeContentType(input?.contentType);
    if (declared === '') {
        // 缺 Content-Type 同样无法双验，按「类型不被接受」处理，
        // 而不是默默按魔数猜一个——猜错时用户拿到的是一个类型不对的资产。
        return fail(415, `未提供 Content-Type；允许的类型：${ALLOWED_MIME_TEXT}`, {
            allowed: [...ALLOWED_MIME],
        });
    }
    if (!ALLOWED_MIME.includes(declared)) {
        // 必须列出允许类型：用户不知道系统支持什么，「不支持」三个字等于让人试错。
        // 允许列表由白名单常量生成，不会与校验逻辑漂移。
        return fail(415, `不支持的 MIME：${declared}；允许的类型：${ALLOWED_MIME_TEXT}`, {
            allowed: [...ALLOWED_MIME],
        });
    }
    /**
     * MIME 双验：声明的 `content-type` 不可信。
     *
     * 浏览器、curl、任何脚本都能随意写这个头，它只描述「发送方声称是什么」。
     * 真正的安全边界是字节本身：一个改名为 `.png` 的可执行文件，声明
     * `image/png` 也照样能过白名单。所以必须用魔数表比对真实内容，
     * 不一致就拒绝——否则下游拿到的是「按 png 处理的可执行文件」。
     */
    const actual = sniffMime(data);
    if (actual === null) {
        return fail(400, `无法识别文件的真实类型（声明为 ${declared}），已拒绝`);
    }
    if (actual !== declared) {
        return fail(400, `声明的 MIME（${declared}）与真实内容（${actual}）不符，已拒绝`);
    }
    const safeName = typeof input?.filename === 'string' ? input.filename.trim() : '';
    let stored;
    try {
        stored = await deps.storeAsset({
            data,
            mime: actual,
            ...(safeName === '' ? {} : { filename: safeName }),
        });
    }
    catch {
        /**
         * 走到这里说明入参已经全部过检，失败只可能是存储层故障（磁盘满、权限、
         * 写入后回读校验不通过）。**堆栈与原始 message 一律不进响应体**：
         * 那里面有绝对路径与内部实现细节，既帮不到用户，又会泄露目录结构。
         * 细节应由宿主 `logger.error` 记录，本模块不持有 logger。
         */
        return fail(500, '媒体保存失败，请稍后重试');
    }
    if (stored === null ||
        typeof stored !== 'object' ||
        typeof stored.assetId !== 'string' ||
        typeof stored.sha256 !== 'string' ||
        typeof stored.bytes !== 'number') {
        return fail(500, '媒体保存结果不完整');
    }
    /**
     * 长度交叉校验：响应里的 `bytes` 必须是**真实入参长度**。
     * 下游若回报了别的数字，说明存储层算错了（或适配层接错），
     * 此时宁可 500 也不要把一个假数字写进画布元数据——那个数字之后会被
     * 用来做配额与展示，错了很难反查。
     */
    if (stored.bytes !== data.length) {
        return fail(500, '媒体保存结果与入参长度不一致');
    }
    return {
        status: 200,
        body: {
            assetId: stored.assetId,
            bytes: data.length,
            sha256: stored.sha256,
            mime: actual,
        },
    };
}
//# sourceMappingURL=media-route.js.map