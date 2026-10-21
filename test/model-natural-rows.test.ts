/**
 * 会话之间必须错开成行（UI-D13）。
 *
 * ## 故障
 *
 * 用户反馈两条：「切目录后卡片堆叠在一起」「卡片要按会话内顺序排列」。
 *
 * 根因不在 `layoutByBranch`（那个引擎是对的，测试里能看到 t1 占 y=82、t2 占
 * y=400）。真正的原因是 `buildCanvasModel` 给每个线程的**第一张**卡都用
 * `NATURAL_ORIGIN` 当起点：
 *
 *     const naturalPosition = index === 0 ? { ...NATURAL_ORIGIN } : ...
 *
 * 而画布默认走的是 `naturalPosition`（`getResolvedPosition` 在 `position === null`
 * 时回落到它），并不调用布局引擎。于是一个目录下 29 个会话 → 29 张卡全部落在
 * (86, 82)，视觉上完全重叠。
 *
 * ## 修法
 *
 * 每个会话分配一行：`y = NATURAL_ORIGIN.y + threadIndex * NATURAL_STEP_Y`，
 * 会话内部仍按提问顺序水平展开（`x += NATURAL_STEP_X`）。这同时满足
 * 「按会话内顺序排列」。
 */

import { describe, it, expect } from 'vitest';

import { buildCanvasModel, getResolvedPosition, NATURAL_ORIGIN, NATURAL_STEP_X, NATURAL_STEP_Y } from '@/canvas/model';
import { CARD_STEP_Y, layoutCards, LAYOUT_MODES } from '@/canvas/layout';

/** 造一个带若干会话的冻结态快照；每个会话有 `turns` 个用户提问。 */
function snapshot(threads: { id: string; turns: number }[]): unknown {
  return {
    format: 'dsh-evcanvas',
    schemaVersion: 1,
    revision: 1,
    projectionEpoch: 1,
    layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    materials: [],
    regions: [],
    annotations: [],
    projection: {
      threads: threads.map(thread => ({
        id: thread.id,
        title: thread.id,
        parentId: null,
        dshSessionId: 'sess-' + thread.id,
        dshSessionTitle: thread.id,
        color: null,
        messages: Array.from({ length: thread.turns }, (_, index) => ({
          id: thread.id + '-m' + String(index),
          text: 'q' + String(index),
          kind: 'user',
          sourceSeq: index,
          at: '2026-10-21T00:00:00.000Z',
        })),
      })),
    },
  };
}

describe('会话之间错开成行', () => {
  it('三个会话的首张卡 y 各不相同（这正是修复前全相同的点）', () => {
    const model = buildCanvasModel(snapshot([
      { id: 't1', turns: 1 },
      { id: 't2', turns: 1 },
      { id: 't3', turns: 1 },
    ]));
    const y1 = getResolvedPosition(model, 't1:0')!.y;
    const y2 = getResolvedPosition(model, 't2:0')!.y;
    const y3 = getResolvedPosition(model, 't3:0')!.y;

    expect(new Set([y1, y2, y3]).size).toBe(3);
    expect(y2).toBe(y1 + NATURAL_STEP_Y);
    expect(y3).toBe(y1 + 2 * NATURAL_STEP_Y);
  });

  it('第一行仍从 NATURAL_ORIGIN.y 开始，不整体下移', () => {
    const model = buildCanvasModel(snapshot([{ id: 't1', turns: 1 }, { id: 't2', turns: 1 }]));
    expect(getResolvedPosition(model, 't1:0')!.y).toBe(NATURAL_ORIGIN.y);
  });

  it('会话内部按提问顺序水平展开', () => {
    const model = buildCanvasModel(snapshot([{ id: 't1', turns: 3 }]));
    const xs = [0, 1, 2].map(index => getResolvedPosition(model, 't1:' + String(index))!.x);
    expect(xs[1]).toBe(xs[0]! + NATURAL_STEP_X);
    expect(xs[2]).toBe(xs[1]! + NATURAL_STEP_X);
  });

  it('同一会话内所有卡片 y 相同（不被行偏移打散）', () => {
    const model = buildCanvasModel(snapshot([{ id: 't1', turns: 3 }, { id: 't2', turns: 2 }]));
    const ys = [0, 1, 2].map(index => getResolvedPosition(model, 't1:' + String(index))!.y);
    expect(new Set(ys).size).toBe(1);
  });

  it('手工落位的卡片不被行偏移覆盖（用户的摆放优先）', () => {
    const withLayout = snapshot([{ id: 't1', turns: 1 }]) as {
      layout: { cards: Record<string, { x: number; y: number }> };
    };
    withLayout.layout.cards['t1:0'] = { x: -999, y: 12345 };
    const model = buildCanvasModel(withLayout);
    expect(getResolvedPosition(model, 't1:0')).toEqual({ x: -999, y: 12345 });
  });
});

describe('行距常量与自动排版一致', () => {
  it('NATURAL_STEP_Y 等于 layout 的 CARD_STEP_Y（两套布局不能给出不同行距）', () => {
    // 这条是防漂移守卫：两个模块各自定义行高，但数值必须相同，
    // 否则用户按 HOME 前后会看到行距突然变化。
    expect(NATURAL_STEP_Y).toBe(CARD_STEP_Y);
  });

  it('把同一批卡片交给 byBranch 引擎，行数与会话数一致且不重叠', () => {
    const model = buildCanvasModel(snapshot([
      { id: 't1', turns: 2 },
      { id: 't2', turns: 2 },
    ]));
    const result = layoutCards(model, LAYOUT_MODES.branch);
    const positions = result.positions as Record<string, { x: number; y: number }>;
    const ys = [...new Set(Object.values(positions).map(pos => pos.y))];
    expect(ys.length).toBe(2);
  });
});
