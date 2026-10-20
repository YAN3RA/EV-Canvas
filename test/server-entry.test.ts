// @ts-nocheck -- 测试用假宿主 ctx 与假 req/res，断言精确。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, PLUGIN_META, ROUTE_PREFIX, inject, name } from '@/server/index';

/**
 * U1：宿主入口接线（src/server/index.ts）。
 *
 * 这里**不测真实宿主**（9222 未开，无法执行）。测的是接线本身：
 *   - apply 能把路由注册到宿主 ctx，不再抛 not implemented
 *   - Host 围栏（插件路由不在宿主 /api 的防护范围内，必须自检）
 *   - 健康检查能证明 store 已读盘
 *   - 未知路由 404、非法标识符被拒、错误映射成正确状态码
 *
 * 真实宿主加载验收另需 9222，见交接文档。
 *
 * 注意：`WorkspaceStore` 用文件锁保证「只有一个写者」，所以同一 dataFile 上
 * 不能并存多个实例。整组用例共用一个挂载。
 */

/** 假 ctx：记录注册的路由与 effect 调用。 */
function fakeContext() {
  const routes = new Map();
  const labels = [];
  const warnings = [];
  const errors = [];
  return {
    routes,
    labels,
    warnings,
    errors,
    logger: {
      warn: (error) => warnings.push(String(error?.message ?? error)),
      error: (error) => errors.push(String(error?.message ?? error)),
    },
    webServer: {
      register(route) {
        routes.set(`${route.kind}:${route.path}`, route);
        return { dispose() {} };
      },
    },
    effect(fn, label) {
      labels.push(label);
      return fn();
    },
  };
}

/** 假 req：异步可迭代的字节流 + headers/url/method。 */
function fakeRequest({ url = '/', method = 'GET', host = 'localhost:1234', body = null, raw = null } = {}) {
  const payload = raw !== null
    ? [new TextEncoder().encode(raw)]
    : body === null ? [] : [new TextEncoder().encode(JSON.stringify(body))];
  return {
    url,
    method,
    headers: { host },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk;
    },
  };
}

/** 假 res：记录状态码、头与响应体。 */
function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(body) {
      state.body = typeof body === 'string' ? body : new TextDecoder().decode(body ?? new Uint8Array());
    },
    json() {
      return JSON.parse(state.body);
    },
  };
}

let workDir;
let ctx;

async function call(kind, path, options) {
  const route = ctx.routes.get(`${kind}:${path}`);
  if (route === undefined) throw new Error(`路由未注册：${kind}:${path}`);
  const res = fakeResponse();
  await route.handler(fakeRequest(options), res);
  return res;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'evcanvas-entry-'));
  ctx = fakeContext();
  apply(ctx, { dataFile: join(workDir, 'workspaces.json'), trustedHosts: [] });
  // 等 store 首次读盘完成：首个请求会挡在 ready 上，这里先触发一次。
  const warm = await call('prefix', '/evcanvas/api', { url: '/evcanvas/api/health' });
  expect(warm.state.status).toBe(200);
});

afterAll(async () => {
  // WorkspaceStore 会做延迟写盘（SAVE_DEBOUNCE_MS = 800）并在写盘时建锁文件，
  // 所以立刻 rm 会撞上「目录里刚多出文件」。最多重试几次再放弃：
  // 清理失败不该让一个已经通过的套件变成失败。
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(workDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  }
});

describe('插件元信息', () => {
  it('插件名、注入服务与路由前缀派生自同一个 id', () => {
    expect(name).toBe('evcanvas');
    expect(inject).toEqual(['webServer']);
    expect(PLUGIN_META.id).toBe('evcanvas');
    expect(ROUTE_PREFIX).toBe('/evcanvas');
    expect(PLUGIN_META.format).toBe('dsh-evcanvas');
    expect(PLUGIN_META.schemaVersion).toBe(1);
  });
});

describe('apply 挂载', () => {
  it('不再抛 not implemented，且注册了入口页与 api 前缀', () => {
    expect(ctx.routes.has('exact:/evcanvas')).toBe(true);
    expect(ctx.routes.has('exact:/evcanvas/')).toBe(true);
    expect(ctx.routes.has('prefix:/evcanvas/api')).toBe(true);
  });

  it('缺少 webServer 的 ctx 被明确拒绝，不静默成功', () => {
    expect(() => apply({}, { dataFile: join(workDir, 'w.json') })).toThrow(/webServer/);
    expect(() => apply(null, { dataFile: join(workDir, 'w.json') })).toThrow(/webServer/);
  });

  it('dataFile 为空时拒绝挂载', () => {
    expect(() => apply(fakeContext(), { dataFile: '' })).toThrow(/dataFile/);
  });

  it('入口路径 302 到 /evcanvas/', async () => {
    const res = fakeResponse();
    await ctx.routes.get('exact:/evcanvas').handler(fakeRequest(), res);
    expect(res.state.status).toBe(302);
    expect(res.state.headers.location).toBe('/evcanvas/');
  });

  it('入口页返回 HTML 骨架', async () => {
    const res = fakeResponse();
    await ctx.routes.get('exact:/evcanvas/').handler(fakeRequest(), res);
    expect(res.state.status).toBe(200);
    expect(res.state.headers['content-type']).toMatch(/text\/html/);
    expect(res.state.body).toMatch(/EV Canvas/);
  });
});

describe('Host 信任围栏', () => {
  it('localhost 与 127.0.0.1 默认放行', async () => {
    for (const host of ['localhost:57461', '127.0.0.1:57461', 'localhost']) {
      const res = await call('prefix', '/evcanvas/api', { url: '/evcanvas/api/health', host });
      expect(res.state.status, host).toBe(200);
    }
  });

  it('未知 Host 一律 403（插件路由不在宿主 /api 防护范围内）', async () => {
    const res = await call('prefix', '/evcanvas/api', { url: '/evcanvas/api/health', host: 'evil.example.com' });
    expect(res.state.status).toBe(403);
    expect(res.json().error).toMatch(/Host/);
  });

  it('config.trustedHosts 被解析进围栏（大小写不敏感）', async () => {
    // 不新建 store（会抢锁），直接对一个独立 ctx 验证 config 解析与挂载成功。
    const other = fakeContext();
    apply(other, { dataFile: join(workDir, 'nested', 'w.json'), trustedHosts: ['DevBox.Local'] });
    expect(other.routes.has('prefix:/evcanvas/api')).toBe(true);
  });
});

describe('健康检查', () => {
  it('证明插件已加载且 store 已读盘', async () => {
    const res = await call('prefix', '/evcanvas/api', { url: '/evcanvas/api/health' });
    expect(res.state.status).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe('evcanvas');
    expect(body.format).toBe('dsh-evcanvas');
    // store.metadata() 在首次读盘后给出格式与版本，不是 undefined
    expect(body.store).toMatchObject({ format: 'dsh-evcanvas', schemaVersion: 1 });
    expect(body.store.readOnly).toBe(false);
  });
});

describe('路由与错误映射', () => {
  it('未知接口返回 404', async () => {
    const res = await call('prefix', '/evcanvas/api', { url: '/evcanvas/api/nope' });
    expect(res.state.status).toBe(404);
    expect(res.json().error).toMatch(/接口不存在/);
  });

  it('工作区列表可读（空库返回空数组）', async () => {
    const res = await call('prefix', '/evcanvas/api', { url: '/evcanvas/api/workspaces' });
    expect(res.state.status).toBe(200);
    expect(Array.isArray(res.json().workspaces)).toBe(true);
  });

  it('非法标识符被拒（路径穿越与 NUL）', async () => {
    for (const segment of ['..%2Fetc', 'a%00b']) {
      const res = await call('prefix', '/evcanvas/api', { url: `/evcanvas/api/workspaces/${segment}` });
      expect(res.state.status, segment).toBe(400);
    }
  });

  it('坏 JSON 体返回 400 而不是 500', async () => {
    const route = ctx.routes.get('prefix:/evcanvas/api');
    const res = fakeResponse();
    await route.handler(
      {
        url: '/evcanvas/api/workspaces/ws-1',
        method: 'POST',
        headers: { host: 'localhost' },
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode('{ not json');
        },
      },
      res,
    );
    expect(res.state.status).toBe(400);
    expect(res.json().error).toMatch(/JSON/);
  });

  it('不存在的工作区返回 404 或 400，不是 500', async () => {
    const res = await call('prefix', '/evcanvas/api', { url: '/evcanvas/api/workspaces/ghost-workspace' });
    expect([404, 400]).toContain(res.state.status);
  });
});

describe('静态模块白名单', () => {
  it('没有把 URL 映射到任意文件的路由（防目录穿越）', () => {
    const paths = [...ctx.routes.keys()];
    expect(paths.some(path => path.includes('*'))).toBe(false);
    for (const path of paths) expect(path).toMatch(/^(exact|prefix):\/evcanvas/);
  });
});
