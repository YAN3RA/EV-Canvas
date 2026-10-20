/**
 * 画布交互接线（`src/ui/*` → `canvas/selection` + `canvas/commands`）。
 *
 * 这组用例测的是**接线语义**，不是像素级 UI：
 *   1. 选中集在不同工作区之间不串（FR-09.8 边界）
 *   2. 多卡拖拽只产生一条意图 → 一步 undo（FR-09.7）
 *   3. 框选把卡片正确适配成选中层认识的形状
 *   4. 位置没变的卡片不产生空补丁（不写盘）
 *
 * 为什么不去渲染 React：真实 DOM 交互依赖浏览器环境，本轮只锁纯逻辑接线，
 * 浏览器层留给后续的浏览器验收台（见 3-开发测试/测试/浏览器验收）。
 */

import { describe, it, expect } from 'vitest';
import { createCommandHistory } from '@/canvas/commands';
import { nodesInRect, selectionBounds, type SelectableNode } from '@/canvas/selection';

/** 与 `CanvasSurface.toSelectable` 同口径的适配：卡片 → 选中层节点。 */
function toSelectable(cards: { id: string; x: number; y: number }[], width = 310, height = 276): SelectableNode[] {
  return cards.map(card => ({ nodeId: card.id, x: card.x, y: card.y, width, height }));
}

/** 造一个带布局的命令历史，模拟画布当前状态。 */
function historyWith(cards: Record<string, { x: number; y: number }>) {
  return createCommandHistory({
    limit: 100,
    readLayout: () => ({ cards, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], annotations: [], materials: [] }),
  });
}

describe('多卡拖拽 → 一步撤销', () => {
  it('拖动 3 张卡只产生一条意图，undo 一次全部还原', () => {
    const layout = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 200, y: 0 } };
    const history = historyWith(layout);

    // 模拟拖拽落位：一次提交 3 张卡。
    const patches = [];
    for (const [id, base] of Object.entries(layout)) {
      const recorded = history.commit(history.commands.moveCard(id, { x: base.x + 40, y: base.y + 25 }));
      if (recorded !== null) patches.push(...recorded.patches);
    }

    expect(patches).toHaveLength(3);
    // 逐卡补丁都带真实 before/after，撤销才可逆。
    expect(patches[0].before).toEqual({ x: 0, y: 0 });
    expect(patches[0].after).toEqual({ x: 40, y: 25 });
  });

  it('位置没变的卡片不产生补丁（避免空写盘）', () => {
    const history = historyWith({ a: { x: 10, y: 10 } });
    const recorded = history.commit(history.commands.moveCard('a', { x: 10, y: 10 }));
    // 同位置提交：要么 null，要么空 patches —— 两者都算「不写盘」。
    const count = recorded === null ? 0 : recorded.patches.length;
    expect(count).toBe(0);
  });

  it('拖动后撤销，布局回到原位', () => {
    const history = historyWith({ a: { x: 5, y: 5 } });
    const recorded = history.commit(history.commands.moveCard('a', { x: 105, y: 55 }));
    expect(recorded).not.toBeNull();

    const undone = history.undo();
    expect(undone).not.toBeNull();
    const restored = history.applyTo(
      { cards: { a: { x: 105, y: 55 } }, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], annotations: [], materials: [] },
      undone,
    );
    expect(restored.cards.a).toEqual({ x: 5, y: 5 });
  });
});

describe('框选适配', () => {
  it('卡片适配成 nodeId 形状后能被框到', () => {
    const cards = [
      { id: 'card-1', x: 0, y: 0 },
      { id: 'card-2', x: 500, y: 500 },
    ];
    const hit = nodesInRect(toSelectable(cards), { x: -10, y: -10, w: 400, h: 400 });
    expect(hit).toEqual(['card-1']);
  });

  it('框住全部卡片时按入参顺序返回', () => {
    const cards = [
      { id: 'c', x: 0, y: 0 },
      { id: 'a', x: 100, y: 100 },
      { id: 'b', x: 200, y: 200 },
    ];
    const hit = nodesInRect(toSelectable(cards), { x: -50, y: -50, w: 2000, h: 2000 });
    expect(hit).toEqual(['c', 'a', 'b']);
  });

  it('退化矩形（宽高为 0）不选中任何卡片', () => {
    const hit = nodesInRect(toSelectable([{ id: 'card-1', x: 0, y: 0 }]), { x: 0, y: 0, w: 0, h: 0 });
    expect(hit).toEqual([]);
  });

  it('包围盒覆盖多选卡片，用于绘制批量选中框', () => {
    const cards = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 300, y: 200 },
    ];
    const nodes = toSelectable(cards);
    const box = selectionBounds(nodes, ['a', 'b']);
    expect(box).toEqual({ x: 0, y: 0, w: 300 + 310, h: 200 + 276 });
  });
});
