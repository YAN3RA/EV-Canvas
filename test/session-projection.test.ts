// @ts-nocheck -- 测试用假宿主 ctx 与会话对象，断言精确。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '@/server/index';

/**
 * S0-5 会话投影接线（`src/server/index.ts` → `startSessionProjection`）。
 *
 * 这组用例锁的是**接线本身**，不是真实宿主行为：
 *
 *   1. `inject` 里必须有 `sessions` —— 少了它就没有任何合法途径读到会话事件
 *   2. 宿主已有的会话在加载时被回放（否则装插件之前的会话永远不出现）
 *   3. fork 的会话从 `inheritedEventCount` 起算，不重复投影父历史
 *   4. 一轮对话的多个事件合并成**一次写盘**，不是 N 次
 *   5. `autoProjection: false` 真的关掉订阅
 *   6. 宿主没给 `sessions` 时**明确告警**，不静默空转
 *
 * 真实宿主组合验收（发一轮对话看画布出卡片）另需真实 GUI，见交接文档。
 */

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'evcanvas-proj-'));
});

afterEach(async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
});

/** 造一个宿主会话：`events` 是它自己的快照，`inheritedEventCount` 是 fork 切口。 */
function fakeSession({ id, title = null, cwd = '/work/proj', parentSession = null, events = [], inheritedEventCount = undefined }) {
  return {
    id,
    title,
    header: { cwd, parentSession: parentSession === null ? undefined : parentSession },
    ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }),
    snapshotEvents: () => events,
  };
}

/** 一条用户消息事件。 */
function userEvent(seq, text) {
  return { seq, type: 'user/message', time: 1_700_000_000_000 + seq, data: { content: [{ type: 'text', text }] } };
}

/** 假宿主 ctx：记录路由、effect、告警，并可选地提供 sessions/on。 */
function fakeContext({ sessions, withOn = true } = {}) {
  const routes = new Map();
  const warnings = [];
  const errors = [];
  const listeners = new Map();
  const labels = [];
  const ctx = {
    routes,
    warnings,
    errors,
    listeners,
    labels,
    logger: {
      warn: error => warnings.push(String(error?.message ?? error)),
      error: error => errors.push(String(error?.message ?? error)),
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
  if (withOn) {
    ctx.on = (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return { dispose() {} };
    };
  }
  if (sessions !== undefined) ctx.sessions = sessions;
  return ctx;
}

/** 等 microtask 合并批落地，再等延迟写盘。 */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** 读回某会话的投影消息文本（`MutableMessage` 是 `{ text, kind, sourceSeq }`，不是 content 块）。 */
async function projectedTexts(ctx, sessionId) {
  const read = async path => {
    const res = { state: { status: 0, body: '' }, writeHead(s, h) { this.state.status = s; this.state.headers = h; }, end(b) { this.state.body = typeof b === 'string' ? b : new TextDecoder().decode(b ?? new Uint8Array()); } };
    await ctx.routes.get('prefix:/evcanvas/api').handler({ url: path, method: 'GET', headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() {} }, res);
    return JSON.parse(res.state.body);
  };
  const list = await read('/evcanvas/api/workspaces');
  for (const summary of list.workspaces ?? []) {
    const doc = await read(`/evcanvas/api/workspaces/${summary.id}`);
    const thread = (doc.workspace?.projection?.threads ?? []).find(item => item.dshSessionId === sessionId);
    if (thread !== undefined) return (thread.messages ?? []).map(message => String(message.text ?? ''));
  }
  return null;
}

/** 读回当前存储里所有 dsh 线程的会话 id。 */
async function projectedSessionIds(ctx) {
  const res = { state: { status: 0, body: '' }, writeHead(s, h) { this.state.status = s; this.state.headers = h; }, end(b) { this.state.body = typeof b === 'string' ? b : new TextDecoder().decode(b ?? new Uint8Array()); } };
  await ctx.routes.get('prefix:/evcanvas/api').handler({ url: '/evcanvas/api/workspaces', method: 'GET', headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() {} }, res);
  const body = JSON.parse(res.state.body);
  const ids = [];
  for (const summary of body.workspaces ?? []) {
    const wres = { state: { status: 0, body: '' }, writeHead(s, h) { this.state.status = s; this.state.headers = h; }, end(b) { this.state.body = typeof b === 'string' ? b : new TextDecoder().decode(b ?? new Uint8Array()); } };
    await ctx.routes.get('prefix:/evcanvas/api').handler({ url: `/evcanvas/api/workspaces/${summary.id}`, method: 'GET', headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() {} }, wres);
    const doc = JSON.parse(wres.state.body);
    for (const thread of doc.workspace?.projection?.threads ?? []) {
      if (thread.dshSessionId) ids.push(thread.dshSessionId);
    }
  }
  return ids;
}

describe('inject 声明', () => {
  it('声明了 sessions：没有它就没有合法途径读会话事件', async () => {
    const mod = await import('@/server/index');
    expect(mod.inject).toContain('sessions');
  });
});

describe('冷启动回放', () => {
  it('宿主已存在的会话在加载时被投影出来', async () => {
    const session = fakeSession({ id: 'sess-existing', events: [userEvent(0, '装插件之前就有的对话')] });
    const ctx = fakeContext({ sessions: { list: () => [session] } });
    apply(ctx, { dataFile: join(dir, 'w.json') });
    await settle();

    expect(await projectedSessionIds(ctx)).toContain('sess-existing');
  });

  it('fork 会话从 inheritedEventCount 起算，不重复投影父历史', async () => {
    const events = [userEvent(0, '父会话第一轮'), userEvent(1, 'fork 之后的新一轮')];
    // 切口在 seq=1：只有 seq>=1 的事件属于本会话。
    const session = fakeSession({ id: 'sess-fork', events, inheritedEventCount: 1 });
    const ctx = fakeContext({ sessions: { list: () => [session] } });
    apply(ctx, { dataFile: join(dir, 'w.json') });
    await settle();

    const ids = await projectedSessionIds(ctx);
    expect(ids).toContain('sess-fork');
    // 父历史（seq=0）不应出现在投影里：这条断言锁的是「别把 fork 变成复制」。
    const texts = await projectedTexts(ctx, 'sess-fork');
    expect(texts).toContain('fork 之后的新一轮');
    expect(texts).not.toContain('父会话第一轮');
  });
});

describe('实时订阅', () => {
  it('session/created 触发回放，新会话出现在画布上', async () => {
    const sessions = { list: () => [] };
    const ctx = fakeContext({ sessions });
    apply(ctx, { dataFile: join(dir, 'w.json') });
    await settle();

    expect(await projectedSessionIds(ctx)).toEqual([]);

    const created = fakeSession({ id: 'sess-live', events: [userEvent(0, '实时到达的一轮')] });
    for (const listener of ctx.listeners.get('session/created') ?? []) listener(created);
    await settle();

    expect(await projectedSessionIds(ctx)).toContain('sess-live');
  });

  it('一轮对话的多个事件合并成一次写盘，不是 N 次', async () => {
    const sessions = { list: () => [] };
    const ctx = fakeContext({ sessions });
    apply(ctx, { dataFile: join(dir, 'w.json') });
    await settle();

    const live = fakeSession({ id: 'sess-batch', events: [] });
    // 同一微任务窗口内连发 4 个事件：合并批后应只写一次。
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      listener(live, userEvent(0, '一句'));
      listener(live, userEvent(1, '两句'));
      listener(live, userEvent(2, '三句'));
      listener(live, userEvent(3, '四句'));
    }
    await settle();

    expect(await projectedSessionIds(ctx)).toContain('sess-batch');
    // 四条消息都落地了（合并的是写盘次数，不是内容）。
    expect(await projectedTexts(ctx, 'sess-batch')).toEqual(['一句', '两句', '三句', '四句']);
  });

  it('autoProjection: false 真的关掉订阅（不是写了不生效的空壳）', async () => {
    const session = fakeSession({ id: 'sess-off', events: [userEvent(0, '不该出现')] });
    const ctx = fakeContext({ sessions: { list: () => [session] } });
    apply(ctx, { dataFile: join(dir, 'w.json'), autoProjection: false });
    await settle();

    expect(await projectedSessionIds(ctx)).toEqual([]);
    expect(ctx.listeners.size).toBe(0);
  });
});

describe('依赖缺失时的行为', () => {
  it('宿主没给 sessions 时明确告警，不静默空转', async () => {
    const ctx = fakeContext({ sessions: undefined });
    apply(ctx, { dataFile: join(dir, 'w.json') });
    await settle();

    expect(ctx.warnings.join('\n')).toMatch(/sessions/);
    expect(ctx.warnings.join('\n')).toMatch(/画布/);
  });

  it('缺 sessions 不影响插件挂载（路由仍然全部注册）', async () => {
    const ctx = fakeContext({ sessions: undefined });
    apply(ctx, { dataFile: join(dir, 'w.json') });

    expect(ctx.routes.has('exact:/evcanvas')).toBe(true);
    expect(ctx.routes.has('exact:/evcanvas/')).toBe(true);
    expect(ctx.routes.has('prefix:/evcanvas/api')).toBe(true);
  });
});
