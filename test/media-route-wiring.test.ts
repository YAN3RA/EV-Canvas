/**
 * S0-3 上传路由的**接线测试**（不是模块测试）。
 *
 * 为什么这组测试必须存在：`media-route.test.ts` 已经 23 条全绿，但它测的是
 * 纯函数 `handleMediaUpload`。模块有测试 ≠ 路由被挂上——本项目已经出现过
 * 「1.1 万行有测试但零运行时调用方」的情况（HANDOFF §8 的口径说明）。
 * 这里从真实 `apply()` 出来的路由入口发请求，证明接线真的通了。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '@/server/index';

/** 极小的合法 PNG（1x1 透明），用于验证魔数校验真的走到。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function fakeContext() {
  const routes = new Map<string, { handler: (req: unknown, res: unknown) => unknown }>();
  return {
    routes,
    logger: { warn: () => undefined, error: () => undefined },
    webServer: {
      register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }) {
        routes.set(`${route.kind}:${route.path}`, route);
        return { dispose() {} };
      },
    },
    effect(fn: () => unknown) {
      return fn();
    },
  };
}

function fakeResponse() {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' };
  return {
    state,
    statusCode: 0,
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
    },
    // `sendJson` 用 writeHead(status, headers) 而不是 setHeader + statusCode，
    // 这里两个入口都要支持，否则测试桩和真实 ServerResponse 行为不一致。
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status;
      if (headers !== undefined) {
        for (const [name, value] of Object.entries(headers)) state.headers[name.toLowerCase()] = value;
      }
      return this;
    },
    end(body?: string) {
      state.body = body ?? '';
    },
  };
}

/** 构造一个上传请求：body 是**原始二进制**，类型与文件名走 header。 */
function uploadRequest(options: { data: Buffer; contentType?: string; filename?: string }) {
  const headers: Record<string, string> = { host: 'localhost:1234' };
  if (options.contentType !== undefined) headers['content-type'] = options.contentType;
  if (options.filename !== undefined) headers['x-evcanvas-filename'] = options.filename;
  return {
    url: '/evcanvas/api/media',
    method: 'POST',
    headers,
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(options.data);
    },
  };
}

describe('媒体上传路由接线（S0-3）', () => {
  let workDir = '';
  let ctx: ReturnType<typeof fakeContext>;

  const call = async (req: unknown) => {
    const route = ctx.routes.get('prefix:/evcanvas/api');
    expect(route).toBeDefined();
    const res = fakeResponse();
    await route!.handler(req, res);
    return res;
  };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'evcanvas-media-'));
    ctx = fakeContext();
    apply(ctx, {
      dataFile: join(workDir, 'workspaces.json'),
      autoProjection: false,
      projectionWorkspaceTitle: 'DSH 任务',
      trustedHosts: [],
    });
    // 首个请求会挡在首次读盘上，先热身一次。
    await call({ url: '/evcanvas/api/health', method: 'GET', headers: { host: 'localhost:1234' }, async *[Symbol.asyncIterator]() {} });
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('上传合法 PNG 返回 200 与 assetId', async () => {
    const res = await call(uploadRequest({ data: PNG_1PX, contentType: 'image/png', filename: 'dot.png' }));
    expect(res.state.status).toBe(200);
    const body = JSON.parse(res.state.body);
    expect(body.assetId).toMatch(/^[0-9a-f]{64}$/);
    expect(body.mime).toBe('image/png');
    expect(body.bytes).toBe(PNG_1PX.length);
  });

  it('资产真的落到磁盘（不是只返回一个 id）', async () => {
    const res = await call(uploadRequest({ data: PNG_1PX, contentType: 'image/png', filename: 'dot.png' }));
    expect(res.state.status).toBe(200);
    const assetsDir = join(workDir, 'assets');
    // assets.ts 按 sha256 前两位分桶；递归数一遍文件。
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else out.push(full);
      }
      return out;
    };
    const files = await walk(assetsDir);
    expect(files.length).toBeGreaterThan(0);
  });

  it('同一内容重复上传去重（内容寻址）', async () => {
    const first = JSON.parse((await call(uploadRequest({ data: PNG_1PX, contentType: 'image/png' }))).state.body);
    const second = JSON.parse((await call(uploadRequest({ data: PNG_1PX, contentType: 'image/png' }))).state.body);
    expect(second.assetId).toBe(first.assetId);
  });

  it('MIME 与魔数不符返回 400（声明 png 实为文本）', async () => {
    const res = await call(uploadRequest({ data: Buffer.from('这不是 PNG'), contentType: 'image/png', filename: 'fake.png' }));
    expect(res.state.status).toBe(400);
  });

  it('不支持的 MIME 返回 415', async () => {
    const res = await call(uploadRequest({ data: Buffer.from('hello'), contentType: 'application/x-executable' }));
    expect(res.state.status).toBe(415);
  });

  it('空文件返回 400（不是 415：这是「点空了」不是格式问题）', async () => {
    const res = await call(uploadRequest({ data: Buffer.alloc(0), contentType: 'image/png' }));
    expect(res.state.status).toBe(400);
    expect(res.state.body).toContain('空');
  });

  it('文件名路径穿越返回 400', async () => {
    const res = await call(uploadRequest({ data: PNG_1PX, contentType: 'image/png', filename: '../../evil.png' }));
    expect(res.state.status).toBe(400);
  });

  it('GET 同一路径返回 404（只支持 POST）', async () => {
    const res = await call({ url: '/evcanvas/api/media', method: 'GET', headers: { host: 'localhost:1234' }, async *[Symbol.asyncIterator]() {} });
    expect(res.state.status).toBe(404);
  });
});
