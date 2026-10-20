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
import { MAX_TITLE_LENGTH } from '../shared/constants.js';
import { InputError, NotFoundError, RevisionConflictError } from '../shared/errors.js';
import { PLUGIN_META, ROUTE_PREFIX } from '../shared/meta.js';
import { WorkspaceStore, type ProjectableEvent, type ProjectableSession } from './workspace-store.js';

/** 插件配置（来自 cordis.patch.yml） */
export interface PluginConfig {
  dataFile: string;
  autoProjection: boolean;
  projectionWorkspaceTitle: string;
  trustedHosts: string[];
}

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

/**
 * 注入的宿主服务。
 *
 * `sessions` 是会话投影（S0-5）的**唯一**内容来源：DSH 拥有会话日志，插件只做
 * 投影副本。不注入它就没有任何合法途径读到会话事件——旧版同一位置也是这两个
 * （`dsh-synapnova@3fd1d00` `index.js:24`），属于已在真实宿主跑通的契约。
 */
export const inject = ['webServer', 'sessions'] as const;

/** 请求体上限：普通业务写 32KiB（与旧版共享解析器一致）。 */
const MAX_BODY_BYTES = 32 * 1024;

/** 布局更新与导入是整份工作区文档，单独放宽；这是**唯一**的例外。 */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/**
 * 可被浏览器请求的静态模块白名单。
 *
 * **没有任何路由把 URL 映射到任意文件路径。** 浏览器能拿到的只有白名单里的
 * 固定条目；表外请求一律 404。这是旧版 `MODULES` 白名单的直接沿用，
 * 也是 FR-13「拒绝目录穿越」在路由层的落点。
 *
 * vNext 前端是 Vite 产物（`dist/ui`），构建后其文件集合是**已知且封闭**的：
 * `index.html` + `app.js` + `assets/<name>-<hash>.<ext>`。因此这里不再硬编码
 * 具体文件名，而是按「前缀 + 安全文件名」的规则放行——仍然不接受任何 `..`、
 * 分隔符或非白名单扩展名。
 */
const MODULES = new Map<string, string>([]);

/** Vite 产物根（相对本模块：`dist/server/` → `../ui/`）。 */
const UI_ROOT = new URL('../ui/', import.meta.url);

/** 允许从 `dist/ui/assets/` 提供的扩展名。 */
const ASSET_EXTENSIONS = new Set(['.css', '.js', '.woff2', '.woff', '.ttf', '.svg', '.png', '.map']);

/** 资产文件名只允许 `[A-Za-z0-9._-]`，杜绝任何路径语义。 */
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
});

/** 一个已解码的路径段：拒绝任何能逃出单段的字符。 */
function decodeIdSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new InputError('标识符不是合法的 URL 编码');
  }
  if (decoded === '' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
    throw new InputError('标识符非法');
  }
  return decoded;
}

interface ResLike {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string | Uint8Array): void;
}

function sendJson(res: ResLike, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(res: ResLike, contentType: string, body: string | Uint8Array): void {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req: AsyncIterable<Uint8Array>, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new InputError('请求内容过大');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InputError('请求不是有效 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InputError('请求必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/** 信封解包：旧版契约是 `{ body, ...envelope }` 的扁平形状。 */
function unwrapEnvelope(body: Record<string, unknown>): unknown {
  return body['body'] ?? body;
}

/**
 * 宿主 `ctx` 的最小形状（不 import cordis 类型，宿主侧零依赖）。
 *
 * `on` / `sessions` 是可选的：缺 `sessions` 时插件仍要能挂载并提供只读快照，
 * 只是没有投影数据来源。**不因为缺一个能力就整体拒载**——那会让「插件坏了」
 * 和「宿主没给这个服务」两种情况看起来一样。
 */
interface PluginContext {
  logger: { warn(error: Error): void; error(error: Error): void };
  webServer: { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: never, res: never) => void | Promise<void> }, label?: string): unknown };
  effect(fn: () => unknown, label?: string): unknown;
  on?(event: string, listener: (...args: never[]) => void): unknown;
  sessions?: { list(): Iterable<unknown> };
}

/** 判断 `ctx` 是否具备我们需要的宿主能力。 */
function asContext(ctx: unknown): PluginContext | null {
  if (ctx === null || typeof ctx !== 'object') return null;
  const candidate = ctx as Partial<PluginContext>;
  if (candidate.webServer === undefined || typeof candidate.effect !== 'function') return null;
  return candidate as PluginContext;
}

/** 由 cwd/标题截断成的投影工作区标题，与配置项同口径。 */
function projectionTitleOf(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_TITLE_LENGTH) : 'DSH 任务';
}

/**
 * 会话投影订阅（S0-5）。
 *
 * 数据权威边界（AGENTS §5.2）：会话内容权威在 DSH，这里只做**投影副本**，
 * 任何路径都不写宿主会话日志。因此本函数只读事件、只写自己的工作区文档。
 *
 * 三处刻意的设计，都来自旧版已踩过的坑：
 *
 * 1. **重启后补历史**（`ctx.sessions.list()` 回放）。只订阅 `session/created`
 *    的话，插件装好之前就存在的会话永远不出现在画布上——用户会以为投影坏了。
 * 2. **回放起点取 `inheritedEventCount`**。fork 出来的会话继承父会话的事件前缀，
 *    从 0 重放会把整段父历史再投影一遍，卡片直接重复。
 * 3. **微任务合并批**。一轮对话会连续产生多个事件；逐事件写盘会让一轮对话变成
 *    N 次原子写。合并成一次后，`projectEvents` 的「一次写」语义才真正生效。
 *
 * `generation` 与 `projectionEpoch` 是**并发守卫**，不是可选优化：数据文件被外部
 * 重写或工作区重建后，旧世代的事件必须被丢弃，否则会用陈旧快照覆盖新投影。
 */
function startSessionProjection(
  host: PluginContext,
  store: WorkspaceStore,
  workspaceTitle: string,
  autoProjection: boolean,
): void {
  if (!autoProjection) return;

  const sessions = host.sessions;
  if (sessions === undefined || typeof sessions.list !== 'function' || typeof host.on !== 'function') {
    // 缺依赖时**明说**，不做静默空转：画布会一直是空的，用户需要知道原因在宿主侧。
    host.logger.warn(
      new Error('evcanvas: 宿主未提供 sessions 服务或 on()，会话投影未启动（画布将保持为空）'),
    );
    return;
  }

  const fail = (error: unknown): void => {
    host.logger.error(error instanceof Error ? error : new Error(String(error)));
  };

  const replaySession = (session: unknown): void => {
    const target = session as ProjectableSession;
    const replayFrom = typeof target.inheritedEventCount === 'number' ? target.inheritedEventCount : 0;
    const generation = store.projectionGeneration;
    const projectionEpoch = store.projectionEpochFor(target);
    void store.projectSession(target, replayFrom, workspaceTitle, projectionEpoch, generation).catch(fail);
  };

  /** 按 `session + 纪元 + 世代` 分组合并，一次写盘覆盖一批事件。 */
  const pending: { session: ProjectableSession; event: ProjectableEvent; generation: number; projectionEpoch: number }[] = [];
  let scheduled = false;
  const enqueue = (session: unknown, event: unknown): void => {
    const target = session as ProjectableSession;
    pending.push({
      session: target,
      event: event as ProjectableEvent,
      generation: store.projectionGeneration,
      projectionEpoch: store.projectionEpochFor(target),
    });
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const batch = pending.splice(0);
      const grouped = new Map<string, { session: ProjectableSession; events: ProjectableEvent[]; generation: number; projectionEpoch: number }>();
      for (const item of batch) {
        // 世代与纪元进 key：同一会话在重写前后的事件不能被并到同一批里。
        const key = `${item.generation}:${item.projectionEpoch}:${item.session.id}`;
        const entry = grouped.get(key);
        if (entry === undefined) {
          grouped.set(key, { session: item.session, events: [item.event], generation: item.generation, projectionEpoch: item.projectionEpoch });
        } else {
          entry.events.push(item.event);
        }
      }
      for (const entry of grouped.values()) {
        void store.projectEvents(entry.session, entry.events, workspaceTitle, entry.projectionEpoch, entry.generation).catch(fail);
      }
    });
  };

  // 订阅本身也要进 effect：宿主卸载插件时必须能释放监听，否则换装后旧监听还在跑。
  host.effect(() => {
    host.on?.('session/created', replaySession as never);
    host.on?.('session/event', enqueue as never);
    return () => {
      // cordis 的 on() 返回 disposer 时由 effect 统一回收；这里只清内存缓冲，
      // 避免卸载后 microtask 仍去写已关闭的 store。
      pending.length = 0;
      scheduled = false;
    };
  }, 'evcanvas: session projection');

  // 冷启动补历史：插件装好之前就存在的会话也要出现在画布上。
  for (const session of sessions.list()) replaySession(session);
}

/**
 * 宿主注册入口。
 *
 * 与旧版骨架的差别：这里**不再抛 `not implemented`**。它实例化 `WorkspaceStore`
 * 并挂载路由；store 自身的原子写、锁、digest、幂等窗口全部沿用迁移实现。
 *
 * 已接：路由、静态产物、会话投影订阅（S0-5，`session/created` + `session/event`）。
 * 尚未接的部分（如实标注，不冒充已实现）：
 *   - S0-3 媒体资产上传路由（`assets.ts` 已实现且有测试，缺 HTTP 层）
 *   - S0-6 历史回填的 HTTP 入口（store 侧 `syncHistory` 已就绪）
 */
export function apply(ctx: unknown, config: PluginConfig): void {
  const host = asContext(ctx);
  if (host === null) {
    throw new Error(`evcanvas: 宿主 ctx 缺少 webServer/effect，插件无法挂载（收到 ${typeof ctx}）`);
  }
  const dataFile = typeof config?.dataFile === 'string' && config.dataFile !== '' ? config.dataFile : '';
  if (dataFile === '') throw new Error('evcanvas: config.dataFile 必须是非空路径');

  const reportFlushFailure = (error: Error): void => {
    host.logger.warn(error instanceof Error ? error : new Error(String(error)));
  };
  const store = new WorkspaceStore(dataFile, { onFlushError: reportFlushFailure } as never);

  /**
   * 等 store 完成首次读盘。
   *
   * `WorkspaceStore` 构造函数里已经启动了 `this.ready = this.load()`，但那是
   * **异步**的：宿主挂载完路由后，第一个请求很可能在 `load()` 落地之前到达。
   * 那时 `store.metadata()` 读到的还是 `undefined`，健康检查会报「格式未知」，
   * 更像是插件坏了。所有请求先挡在同一把 ready 上——不重复调用 `load()`
   * （并发抢同一把文件锁，见交接 ins_34a234a6）。
   */
  const ready = Promise.resolve((store as unknown as { ready: Promise<void> }).ready).catch(error => {
    reportFlushFailure(error instanceof Error ? error : new Error(String(error)));
  });

  /**
   * 会话投影订阅（S0-5）。
   *
   * `autoProjection` 此前只出现在 `cordis.patch.yml` 与类型声明里，**从未被读过**——
   * 配置写着 `true` 却什么也不发生，属于最容易被误读成「已实现」的那种空壳。
   * 这里按旧版同义（`config.autoProjection !== false`）接上：缺省开，显式 false 才关。
   *
   * 放在路由注册之前：宿主加载后到达的第一个会话事件不应该因为路由还没挂而丢失。
   * `startSessionProjection` 内部的写入全部经 `mutate` → `runExclusive`，
   * 而 `runExclusive` 先 `await this.ready`，所以这里不需要再等 `ready`。
   */
  startSessionProjection(host, store, projectionTitleOf(config?.projectionWorkspaceTitle), config?.autoProjection !== false);

  /** 浏览器信任围栏：宿主 `/api` 的同款防护不覆盖插件路由，这里自检 Host。 */
  const trustedHosts = new Set<string>([
    'localhost',
    '127.0.0.1',
    ...(Array.isArray(config?.trustedHosts) ? config.trustedHosts : []).map(item => String(item).trim().toLowerCase()).filter(Boolean),
  ]);

  const workspaceRoute = new RegExp(`^${ROUTE_PREFIX}/api/workspaces/([^/]+)$`);
  const workspaceLayoutRoute = new RegExp(`^${ROUTE_PREFIX}/api/workspaces/([^/]+)/layout$`);

  const api = async (req: never, res: never): Promise<void> => {
    const raw = req as unknown as { headers: Record<string, string | undefined>; url?: string; method?: string };
    const response = res as unknown as ResLike;
    try {
      const hostname = (typeof raw.headers.host === 'string' ? raw.headers.host : '').replace(/:\d+$/, '').toLowerCase();
      if (!trustedHosts.has(hostname)) {
        sendJson(response, 403, { error: '不被信任的 Host' });
        return;
      }
      const path = new URL(raw.url ?? '/', 'http://dsh.local').pathname;
      const method = raw.method ?? 'GET';
      const readable = req as unknown as AsyncIterable<Uint8Array>;

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
        sendJson(response, 200, await (store.snapshot as (workspaceId?: string) => Promise<unknown>)(undefined));
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
          sendJson(response, 200, await store.createThread(workspaceId, unwrapEnvelope(body) as Record<string, unknown>, body));
          return;
        }
      }

      const layout = workspaceLayoutRoute.exec(path);
      if (layout !== null && method === 'PATCH') {
        const workspaceId = decodeIdSegment(layout[1] ?? '');
        const body = await readJson(readable, MAX_DOCUMENT_BYTES);
        sendJson(response, 200, await store.updateLayout(workspaceId, unwrapEnvelope(body) as Record<string, unknown>, body));
        return;
      }

      sendJson(response, 404, { error: '接口不存在' });
    } catch (error) {
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

  /**
   * 读取 `dist/ui` 里的真实前端产物。
   *
   * 为什么不再返回硬编码骨架页：宿主看到的必须就是用户真正会跑的那份 UI。
   * 之前这里返回一句「骨架已加载」，于是「路由 200」掩盖了「前端根本没被提供」
   * 这一事实——属于最容易被误读成「已实现」的那类假成功。
   *
   * 产物缺失时**明确报错**，不做静默降级：宁可让页面显示「未构建」，
   * 也不要让人以为功能已经可用。
   */
  const readUiFile = async (relativePath: string): Promise<{ body: Uint8Array; contentType: string }> => {
    const url = new URL(relativePath, UI_ROOT);
    const body = new Uint8Array(await readFile(url));
    const extension = relativePath.slice(relativePath.lastIndexOf('.'));
    return { body, contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream' };
  };

  const uiMissingPage = (): string =>
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>EV Canvas</title></head>` +
    `<body style="font:13px system-ui;padding:16px">` +
    `<p><strong>前端产物未就位。</strong></p>` +
    `<p>请先运行 <code>npm run build</code>，再重装插件。</p>` +
    `</body></html>`;

  host.effect(() => host.webServer.register({ kind: 'exact', path: ROUTE_PREFIX, handler: (_req: never, res: never) => {
    const response = res as unknown as ResLike;
    response.writeHead(302, { location: `${ROUTE_PREFIX}/` });
    response.end();
  } }), 'evcanvas: redirect');

  host.effect(() => host.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/`, handler: async (_req: never, res: never) => {
    const response = res as unknown as ResLike;
    try {
      const html = await readUiFile('index.html');
      sendFile(response, html.contentType, html.body);
    } catch {
      sendFile(response, 'text/html; charset=utf-8', uiMissingPage());
    }
  } }), 'evcanvas: page');

  /** `/evcanvas/assets/<name>` — 只放行单段、白名单扩展名的文件名。 */
  host.effect(() => host.webServer.register({ kind: 'prefix', path: `${ROUTE_PREFIX}/assets`, handler: async (req: never, res: never) => {
    const response = res as unknown as ResLike;
    const rawUrl = String((req as { url?: string })?.url ?? '');
    const name = rawUrl.slice(`${ROUTE_PREFIX}/assets/`.length).split('?')[0] ?? '';
    const dot = name.lastIndexOf('.');
    const extension = dot >= 0 ? name.slice(dot) : '';
    if (!ASSET_NAME_RE.test(name) || !ASSET_EXTENSIONS.has(extension)) {
      sendJson(response, 404, { error: '资源不存在' });
      return;
    }
    try {
      const asset = await readUiFile(`assets/${name}`);
      sendFile(response, asset.contentType, asset.body);
    } catch {
      sendJson(response, 404, { error: '资源不存在' });
    }
  } }), 'evcanvas: assets');

  /** 前端入口脚本。名字由 Vite 配置固定为 `app.js`。 */
  host.effect(() => host.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/app.js`, handler: async (_req: never, res: never) => {
    const response = res as unknown as ResLike;
    try {
      const script = await readUiFile('app.js');
      sendFile(response, script.contentType, script.body);
    } catch {
      sendJson(response, 404, { error: '前端入口脚本不存在，请先构建' });
    }
  } }), 'evcanvas: app.js');

  for (const [path, file] of MODULES) {
    host.effect(() => host.webServer.register({ kind: 'exact', path, handler: async (_req: never, res: never) => {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      sendFile(res as unknown as ResLike, 'text/javascript; charset=utf-8', source);
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
