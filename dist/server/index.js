/**
 * EV Canvas · 宿主侧入口（Cordis 插件注册）
 *
 * 来源参考：dsh-synapnova@3fd1d00 index.js（路由模式与 `MODULES` 白名单防穿越）
 *
 * 本文件只做一件事：把已经迁移完成的 `WorkspaceStore`（原子写 + digest + 锁 +
 * 幂等窗口）挂到宿主已有的 Web Server 上，让插件**能被真实加载**。
 * 它不实现任何画布功能——那在 `src/canvas/*`、`src/export/*` 与后续的 UI 层。
 *
 * 硬约束：
 *   - 宿主侧零 runtime 依赖（react 只进前端产物）
 *   - 不建第二监听端口，复用宿主 `webServer`
 *   - 路由 path 永不直接映射到文件系统（防目录穿越，沿用旧版 `MODULES` 白名单模式）
 *   - 不新增模型/凭证权威，不建第二调度器（D16）
 *
 * 数据权威边界（AGENTS §5.2）：DSH 拥有原生日志/目录/标题/归档/执行；
 * 本插件只拥有投影副本与画布元数据。任何路由都不写宿主会话日志。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { InputError, NotFoundError, RevisionConflictError } from '../shared/errors.js';
import { PLUGIN_META, ROUTE_PREFIX } from '../shared/meta.js';
import { WorkspaceStore } from './workspace-store.js';
// 元信息与路由前缀的唯一来源是 `shared/meta.ts`（前端也 import 它，
// 不能让前端顺着这里把 node:fs / workspace-store 拖进浏览器构建）。
export { PLUGIN_META, ROUTE_PREFIX };
/**
 * Cordis 插件名。
 *
 * 必须与**包名**一致（`dsh-evcanvas`），而不是 `PLUGIN_META.id`（`evcanvas`）。
 * Loader 行按 `name:` 解析到包，名字对不上时既加载不到、也不会给出明显报错。
 * `PLUGIN_META.id` 是插件在自身数据/路由里用的短标识，两者不是一回事。
 */
export const name = PLUGIN_META.name;
/** 注入的宿主服务：只要 Web Server，不额外开端口/服务。 */
export const inject = ['webServer'];
/** 请求体上限：普通业务写 32KiB（与旧版共享解析器一致）。 */
const MAX_BODY_BYTES = 32 * 1024;
/** 布局更新与导入是整份工作区文档，单独放宽；这是**唯一**的例外。 */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
/**
 * 可被浏览器请求的静态模块白名单。
 *
 * **没有任何路由把 URL 映射到任意文件路径。** 浏览器能拿到的只有这张表里的
 * 固定条目；表外的请求一律 404。这是旧版 `MODULES` 白名单的直接沿用，
 * 也是 FR-13「拒绝目录穿越」在路由层的落点。
 *
 * vNext 前端是 Vite 产物，开发期由 Vite 自己的 dev server 提供，
 * 生产期由 `dist/ui` 交给宿主静态资源。这张表只负责「共享模块也能被
 * 浏览器按需取到」这件事，目前为空表示没有单独暴露的源码模块。
 */
const MODULES = new Map([]);
/** 一个已解码的路径段：拒绝任何能逃出单段的字符。 */
function decodeIdSegment(segment) {
    let decoded;
    try {
        decoded = decodeURIComponent(segment);
    }
    catch {
        throw new InputError('标识符不是合法的 URL 编码');
    }
    if (decoded === '' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
        throw new InputError('标识符非法');
    }
    return decoded;
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}
function sendFile(res, contentType, body) {
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    res.end(body);
}
async function readJson(req, maxBytes = MAX_BODY_BYTES) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
        length += chunk.length;
        if (length > maxBytes)
            throw new InputError('请求内容过大');
        chunks.push(chunk);
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new InputError('请求不是有效 JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new InputError('请求必须是 JSON 对象');
    }
    return parsed;
}
/** 信封解包：旧版契约是 `{ body, ...envelope }` 的扁平形状。 */
function unwrapEnvelope(body) {
    return body['body'] ?? body;
}
/** 判断 `ctx` 是否具备我们需要的宿主能力。 */
function asContext(ctx) {
    if (ctx === null || typeof ctx !== 'object')
        return null;
    const candidate = ctx;
    if (candidate.webServer === undefined || typeof candidate.effect !== 'function')
        return null;
    return candidate;
}
/**
 * 宿主注册入口。
 *
 * 与旧版骨架的差别：这里**不再抛 `not implemented`**。它实例化 `WorkspaceStore`
 * 并挂载路由；store 自身的原子写、锁、digest、幂等窗口全部沿用迁移实现。
 *
 * 尚未接的部分（如实标注，不冒充已实现）：
 *   - S0-5 会话投影订阅（`session/created`、`session/event`）—— 需要 `sessions` 服务，
 *     vNext 尚未决定订阅契约（`ready` 握手，ADR-0003 待写）
 *   - S0-3 媒体资产上传路由
 *   - 前端 UI：仍是骨架页
 */
export function apply(ctx, config) {
    const host = asContext(ctx);
    if (host === null) {
        throw new Error(`evcanvas: 宿主 ctx 缺少 webServer/effect，插件无法挂载（收到 ${typeof ctx}）`);
    }
    const dataFile = typeof config?.dataFile === 'string' && config.dataFile !== '' ? config.dataFile : '';
    if (dataFile === '')
        throw new Error('evcanvas: config.dataFile 必须是非空路径');
    const reportFlushFailure = (error) => {
        host.logger.warn(error instanceof Error ? error : new Error(String(error)));
    };
    const store = new WorkspaceStore(dataFile, { onFlushError: reportFlushFailure });
    /**
     * 等 store 完成首次读盘。
     *
     * `WorkspaceStore` 构造函数里已经启动了 `this.ready = this.load()`，但那是
     * **异步**的：宿主挂载完路由后，第一个请求很可能在 `load()` 落地之前到达。
     * 那时 `store.metadata()` 读到的还是 `undefined`，健康检查会报「格式未知」，
     * 更像是插件坏了。所有请求先挡在同一把 ready 上——不重复调用 `load()`
     * （并发抢同一把文件锁，见交接 ins_34a234a6）。
     */
    const ready = Promise.resolve(store.ready).catch(error => {
        reportFlushFailure(error instanceof Error ? error : new Error(String(error)));
    });
    /** 浏览器信任围栏：宿主 `/api` 的同款防护不覆盖插件路由，这里自检 Host。 */
    const trustedHosts = new Set([
        'localhost',
        '127.0.0.1',
        ...(Array.isArray(config?.trustedHosts) ? config.trustedHosts : []).map(item => String(item).trim().toLowerCase()).filter(Boolean),
    ]);
    const workspaceRoute = new RegExp(`^${ROUTE_PREFIX}/api/workspaces/([^/]+)$`);
    const workspaceLayoutRoute = new RegExp(`^${ROUTE_PREFIX}/api/workspaces/([^/]+)/layout$`);
    const api = async (req, res) => {
        const raw = req;
        const response = res;
        try {
            const hostname = (typeof raw.headers.host === 'string' ? raw.headers.host : '').replace(/:\d+$/, '').toLowerCase();
            if (!trustedHosts.has(hostname)) {
                sendJson(response, 403, { error: '不被信任的 Host' });
                return;
            }
            const path = new URL(raw.url ?? '/', 'http://dsh.local').pathname;
            const method = raw.method ?? 'GET';
            const readable = req;
            // 静态入口页不依赖 store，先放行，免得读盘慢时连骨架页都打不开。
            if (!path.startsWith(`${ROUTE_PREFIX}/api`)) {
                sendJson(response, 404, { error: '接口不存在' });
                return;
            }
            // 其余全部等首次读盘落地，避免 metadata 为 undefined 被误报成插件损坏。
            await ready;
            // ── 健康检查：证明插件被真实加载，且 store 已读盘 ─────────────────
            if (path === `${ROUTE_PREFIX}/api/health` && method === 'GET') {
                sendJson(response, 200, { ok: true, ...PLUGIN_META, store: store.metadata() });
                return;
            }
            // ── 只读快照 ────────────────────────────────────────────────────
            if (path === `${ROUTE_PREFIX}/api/workspaces` && method === 'GET') {
                sendJson(response, 200, await store.snapshot(undefined));
                return;
            }
            const workspace = workspaceRoute.exec(path);
            if (workspace !== null) {
                const workspaceId = decodeIdSegment(workspace[1] ?? '');
                if (method === 'GET') {
                    sendJson(response, 200, await store.snapshot(workspaceId));
                    return;
                }
                if (method === 'POST') {
                    const body = await readJson(readable);
                    sendJson(response, 200, await store.createThread(workspaceId, unwrapEnvelope(body), body));
                    return;
                }
            }
            const layout = workspaceLayoutRoute.exec(path);
            if (layout !== null && method === 'PATCH') {
                const workspaceId = decodeIdSegment(layout[1] ?? '');
                const body = await readJson(readable, MAX_DOCUMENT_BYTES);
                sendJson(response, 200, await store.updateLayout(workspaceId, unwrapEnvelope(body), body));
                return;
            }
            sendJson(response, 404, { error: '接口不存在' });
        }
        catch (error) {
            if (error instanceof RevisionConflictError) {
                sendJson(response, 409, { error: error.message, currentRevision: error.expected });
                return;
            }
            if (error instanceof InputError) {
                sendJson(response, 400, { error: error.message });
                return;
            }
            if (error instanceof NotFoundError) {
                sendJson(response, 404, { error: error.message });
                return;
            }
            host.logger.error(error instanceof Error ? error : new Error(String(error)));
            sendJson(response, 500, { error: 'EV Canvas 数据暂时不可用' });
        }
    };
    // 入口页：目前只有骨架页，真实 UI 由 Vite 产物提供（S1）。
    const page = () => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EV Canvas</title></head>` +
        `<body><div id="app"></div><p style="font:13px system-ui;padding:16px">EV Canvas 骨架已加载。功能实现按 S0 → S3 推进。</p></body></html>`;
    host.effect(() => host.webServer.register({ kind: 'exact', path: ROUTE_PREFIX, handler: (_req, res) => {
            const response = res;
            response.writeHead(302, { location: `${ROUTE_PREFIX}/` });
            response.end();
        } }), 'evcanvas: redirect');
    host.effect(() => host.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/`, handler: (_req, res) => {
            sendFile(res, 'text/html; charset=utf-8', page());
        } }), 'evcanvas: page');
    for (const [path, file] of MODULES) {
        host.effect(() => host.webServer.register({ kind: 'exact', path, handler: async (_req, res) => {
                const source = await readFile(new URL(file, import.meta.url), 'utf8');
                sendFile(res, 'text/javascript; charset=utf-8', source);
            } }), `evcanvas: module ${path}`);
    }
    host.effect(() => host.webServer.register({ kind: 'prefix', path: `${ROUTE_PREFIX}/api`, handler: api }), 'evcanvas: api');
    // 数据文件旁路信息只暴露给宿主日志，不进任何响应。
    host.logger.warn(new Error(`evcanvas: store ready at ${join(dirname(dataFile), '.')}`));
}
/**
 * 测试与后续 S0-5 会用到的重导出。
 *
 * **不要在这里加 `export { apply as default }`**：Cordis 的 Loader 行按
 * *具名导出* 找插件（`apply` + `name` + `inject`），与已装插件一致的做法是
 * 只有具名导出。多一个 `default` 会让模块同时具备两种插件形态，加载器取哪个
 * 取决于内部判断，属于不必要的歧义。已装插件（`dsh-share` 等）实测都只有
 * `apply` / `name`，没有 `default`。
 */
export { WorkspaceStore };
//# sourceMappingURL=index.js.map