// @ts-nocheck
/**
 * 前端数据层测试。
 *
 * 测的是**接入逻辑**，不是 React 渲染：`useCanvasData` 的核心风险在于
 * 「服务端返回什么形状 → 怎么判定成功/失败 → 空数据怎么降级」，
 * 这些都能脱离 DOM 验证。真正的像素/交互留给浏览器验收。
 *
 * 用假 fetch 而不是真 http server：这里要覆盖的是错误分支（404/500/坏 JSON），
 * 起真服务反而更难造。
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { patchLayout, readLayoutBundle, uuidv7 } from '@/ui/data';
import { buildCanvasModel } from '@/canvas/model';

/**
 * 造一个最小的合法快照；模型层会校验并补默认值。
 *
 * `layout` 做**浅合并**而不是整体替换：否则调用方只传 `layout.cards` 时，
 * 基础快照里的 `layout.viewport` 会被整个丢掉——这条坑本人在写测试时踩过一次。
 */
function minimalDocument(overrides = {}) {
  const base = {
    format: 'dsh-evcanvas',
    schemaVersion: 1,
    revision: 3,
    layout: { viewport: { x: 10, y: 20, zoom: 1.5 } },
    regions: [],
    annotations: [],
  };
  const merged = { ...base, ...overrides };
  if (overrides.layout !== undefined) {
    merged.layout = { ...base.layout, ...overrides.layout };
  }
  return merged;
}

describe('readLayoutBundle', () => {
  it('模型为 null 时给出完整空布局，而不是抛错', () => {
    const bundle = readLayoutBundle(null);
    expect(bundle.cards).toEqual({});
    expect(bundle.collapsed).toEqual({});
    expect(bundle.regions).toEqual([]);
    expect(bundle.annotations).toEqual([]);
    expect(bundle.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('把模型的布局字段原样搬过去', () => {
    // 快照里的布局在 `layout` 下；`layoutCards` 是模型的**输出**字段，不是输入。
    // 用一个模型不认识的卡片 id，验证「未知 key 也保留位置」的既有语义。
    const model = buildCanvasModel(
      minimalDocument({
        layout: {
          cards: { 'material:m1': { x: 100, y: 50 } },
          collapsed: { 'material:m1': true },
        },
      }),
    );
    const bundle = readLayoutBundle(model);
    expect(bundle.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
    expect(bundle.cards['material:m1']).toEqual({ x: 100, y: 50 });
    // `collapsedCardIds` 只保留**匹配到真实卡片**的 id；`material:*` 不在投影里，
    // 因此落到 `unmatchedCollapsedIds`——这是模型的既有语义，不是丢数据。
    expect(model.collapsedCardIds).toEqual([]);
    expect(model.unmatchedCollapsedIds).toEqual(['material:m1']);
  });
});

describe('buildCanvasModel 的信封解包', () => {
  /**
   * 回归：`GET /api/workspaces/<id>` 返回的是**信封**
   * `{ format, schemaVersion, readOnly, migrationRequired, workspace: {...} }`，
   * 而模型要的是 `workspace` 里面那份文档。
   *
   * 这个 bug 真实发生过：前端把信封直接喂给模型，模型在外层找不到 `projection`，
   * 于是 `threads` 为空 → 画布空白，**且不报错**。属于最隐蔽的一类故障——
   * 「接口 200、数据在、界面空」。
   */
  const thread = {
    id: 'thread-1',
    dshSessionId: 'f0b42e0b-8771-4ed6-9bba-d90b76ba468f',
    dshSessionTitle: '测试会话',
    messages: [{ id: 'm1', text: '第一轮提问', kind: 'user', sourceSeq: 1 }],
  };

  it('信封形状能解出卡片（前端真实调用形状）', () => {
    const envelope = {
      format: 'dsh-evcanvas',
      schemaVersion: 1,
      readOnly: false,
      migrationRequired: false,
      workspace: {
        id: 'ws-1',
        revision: 42,
        projectionEpoch: 1,
        projection: { threads: [thread] },
        layout: { viewport: { x: 0, y: 0, zoom: 1 } },
        regions: [],
        annotations: [],
      },
    };
    const model = buildCanvasModel(envelope);
    expect(model.workspaceId).toBe('ws-1');
    expect(model.revision).toBe(42);
    expect(model.threads).toHaveLength(1);
    expect(model.cards.length).toBeGreaterThan(0);
  });

  it('文档本体形状仍照常工作（不能为了信封破坏原路径）', () => {
    const model = buildCanvasModel({
      id: 'ws-2',
      revision: 7,
      projection: { threads: [thread] },
      layout: { viewport: { x: 1, y: 2, zoom: 1.25 } },
      regions: [],
      annotations: [],
    });
    expect(model.workspaceId).toBe('ws-2');
    expect(model.revision).toBe(7);
    expect(model.threads).toHaveLength(1);
    expect(model.viewport).toEqual({ x: 1, y: 2, zoom: 1.25 });
  });

  it('空信封不报错，给出空画布', () => {
    const model = buildCanvasModel({ workspace: { id: 'ws-3', projection: { threads: [] } } });
    expect(model.workspaceId).toBe('ws-3');
    expect(model.cards).toEqual([]);
  });
});

describe('patchLayout', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** 造一份最小合法布局快照。 */
  function snapshot() {
    return {
      cards: { 'card-1': { x: 10, y: 20 } },
      collapsed: {},
      viewport: { x: 0, y: 0, zoom: 1 },
    };
  }

  it('baseRevision 非法时不发请求（不允许无版本号写入）', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    for (const bad of [Number.NaN, 0, -1, 1.5]) {
      await expect(patchLayout('w1', bad, { projectionEpoch: 1, layout: snapshot() })).rejects.toThrow(/baseRevision/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('projectionEpoch 非法时不发请求（服务端会 400，但先本地拒掉）', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      await expect(patchLayout('w1', 3, { projectionEpoch: bad, layout: snapshot() })).rejects.toThrow(/projectionEpoch/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * 契约回归：请求体必须是服务端 `validateEnvelope` 认的完整信封。
   *
   * 这条锁的是**形状**，不是行为。早先发 `{ expectedRevision, patches }`，
   * 服务端直接 400「layout 写入必须携带 projectionEpoch」，拖拽与撤销一起失效。
   * 光测「发出了 PATCH」是抓不到这类错的。
   */
  it('请求体是完整信封：workspaceId/baseRevision/operationId/projectionEpoch/action/body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ revision: 4 }) });
    globalThis.fetch = fetchMock;
    const result = await patchLayout('w1', 3, { projectionEpoch: 2, layout: snapshot() });
    expect(result).toEqual({ revision: 4 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/evcanvas/api/workspaces/w1/layout');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body);
    expect(body.workspaceId).toBe('w1');
    expect(body.baseRevision).toBe(3);
    expect(body.projectionEpoch).toBe(2);
    expect(body.action).toBe('workspace.layout');
    expect(body.body.layout).toEqual(snapshot());
    // operationId 必须是标准小写 UUIDv7（服务端用正则强制）
    expect(body.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // 旧形状不能复活
    expect(body).not.toHaveProperty('expectedRevision');
    expect(body).not.toHaveProperty('patches');
  });

  it('regions / annotations 只在显式传入时才发（不传等于不清空）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock;
    await patchLayout('w1', 3, { projectionEpoch: 1, layout: snapshot() });
    let body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.body).not.toHaveProperty('regions');
    expect(body.body).not.toHaveProperty('annotations');

    await patchLayout('w1', 3, { projectionEpoch: 1, layout: snapshot(), regions: [], annotations: [] });
    body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.body.regions).toEqual([]);
    expect(body.body.annotations).toEqual([]);
  });

  it('operationId 可注入（重试同一操作必须复用同一个值）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock;
    const fixed = '0192f0a0-0000-7000-8000-000000000001';
    await patchLayout('w1', 3, { projectionEpoch: 1, layout: snapshot(), operationId: fixed });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).operationId).toBe(fixed);
  });

  it('工作区 id 会被 URL 编码，避免路径注入', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock;
    await patchLayout('a/../b', 1, { projectionEpoch: 1, layout: snapshot() });
    expect(fetchMock.mock.calls[0][0]).toBe('/evcanvas/api/workspaces/a%2F..%2Fb/layout');
  });

  it('非 2xx 抛错并带上响应正文摘要（不静默吞掉）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () => 'expected 3 got 4',
    });
    await expect(patchLayout('w1', 3, { projectionEpoch: 1, layout: snapshot() })).rejects.toThrow(/409.*expected 3 got 4/s);
  });
});

describe('uuidv7', () => {
  it('形状合法：小写、版本位 7、变体位 8/9/a/b', () => {
    for (let i = 0; i < 50; i++) {
      expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('单调：后生成的按字典序不小于先生成的（幂等窗口依赖这个）', async () => {
    const first = uuidv7();
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = uuidv7();
    expect(second >= first).toBe(true);
  });
});
