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
import { patchLayout, readLayoutBundle } from '@/ui/data';
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

describe('patchLayout', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('拒绝不合法的 expectedRevision，不发请求（不允许无版本号写入）', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    await expect(patchLayout('w1', Number.NaN, [{ area: 'layoutViewport', id: 'viewport', before: null, after: null }])).rejects.toThrow(
      /expectedRevision/,
    );
    await expect(patchLayout('w1', -1, [{ area: 'layoutViewport', id: 'viewport', before: null, after: null }])).rejects.toThrow(
      /expectedRevision/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('空 patch 直接返回，不发请求', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    await expect(patchLayout('w1', 3, [])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('带上 expectedRevision 与 patches 发 PATCH', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ revision: 4 }),
    });
    globalThis.fetch = fetchMock;
    const patches = [{ area: 'layoutViewport', id: 'viewport', before: { x: 0, y: 0, zoom: 1 }, after: { x: 5, y: 5, zoom: 2 } }];
    const result = await patchLayout('w1', 3, patches);
    expect(result).toEqual({ revision: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/evcanvas/api/workspaces/w1/layout');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ expectedRevision: 3, patches });
  });

  it('工作区 id 会被 URL 编码，避免路径注入', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock;
    await patchLayout('a/../b', 1, [{ area: 'layoutViewport', id: 'viewport', before: null, after: null }]);
    expect(fetchMock.mock.calls[0][0]).toBe('/evcanvas/api/workspaces/a%2F..%2Fb/layout');
  });

  it('非 2xx 抛错并带上响应正文摘要（不静默吞掉）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () => 'expected 3 got 4',
    });
    await expect(
      patchLayout('w1', 3, [{ area: 'layoutViewport', id: 'viewport', before: null, after: null }]),
    ).rejects.toThrow(/409.*expected 3 got 4/s);
  });
});
