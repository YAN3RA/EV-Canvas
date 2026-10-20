// @ts-nocheck -- 测试里用鸭子类型节点，断言精确。
import { describe, it, expect } from 'vitest';
import {
  EMPTY_SELECTION,
  addToSelection,
  createSelection,
  deletableSelection,
  movePatchesFor,
  nodeBounds,
  nodesInRect,
  pruneSelection,
  rectsIntersect,
  removeFromSelection,
  selectAll,
  selectionBounds,
  toggleSelection,
} from '@/canvas/selection';

/**
 * 多选与批量操作（FR-09.8 / S1-5）的本地验证。
 * 锁四件事：
 *   1. 框选只命中可见且有坐标的节点，隐藏/待布局的节点不会被误选
 *   2. 选择集去重、保序、可增删切
 *   3. 批量位移产出逐节点字段补丁，取整只发生在总量上
 *   4. session 节点不可删（D5：会话权威在 DSH）
 */

const node = (nodeId, x, y, extra = {}) => ({ nodeId, x, y, width: 310, height: 276, visibility: 'visible', ...extra });

describe('矩形几何', () => {
  it('相交判定含部分重叠与完全包含', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    expect(rectsIntersect(a, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 10, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 200, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsIntersect(a, { x: -100, y: 0, w: 100, h: 100 })).toBe(false); // 仅贴边
  });

  it('退化矩形不选中任何东西（零宽框选不是全选）', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    expect(rectsIntersect(a, { x: 0, y: 0, w: 0, h: 100 })).toBe(false);
    expect(rectsIntersect(a, { x: 0, y: 0, w: 100, h: 0 })).toBe(false);
  });

  it('畸形矩形返回 false，不抛错', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    expect(rectsIntersect(a, null)).toBe(false);
    expect(rectsIntersect(a, { x: Number.NaN, y: 0, w: 10, h: 10 })).toBe(false);
  });
});

describe('节点包围盒', () => {
  it('用节点自带尺寸，缺省时用卡片兜底尺寸', () => {
    expect(nodeBounds(node('a', 10, 20))).toEqual({ x: 10, y: 20, w: 310, h: 276 });
    expect(nodeBounds(node('b', 10, 20, { width: 100, height: 50 }))).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });

  it('坐标为 null（待自动布局）时没有包围盒', () => {
    expect(nodeBounds({ nodeId: 'a', x: null, y: null })).toBeNull();
    expect(nodeBounds({ nodeId: 'a', x: 0, y: Number.NaN })).toBeNull();
    expect(nodeBounds(null)).toBeNull();
  });

  it('非正尺寸回落到兜底尺寸（不产生零面积盒子）', () => {
    expect(nodeBounds(node('a', 0, 0, { width: 0, height: -5 }))).toEqual({ x: 0, y: 0, w: 310, h: 276 });
  });
});

describe('框选', () => {
  it('命中重叠节点，按入参顺序返回', () => {
    const nodes = [node('a', 0, 0), node('b', 500, 0), node('c', 50, 50)];
    expect(nodesInRect(nodes, { x: 0, y: 0, w: 200, h: 200 })).toEqual(['a', 'c']);
  });

  it('隐藏节点不被框到', () => {
    const nodes = [node('a', 0, 0), node('hidden', 0, 0, { visibility: 'hidden' })];
    expect(nodesInRect(nodes, { x: 0, y: 0, w: 400, h: 400 })).toEqual(['a']);
  });

  it('坐标未定的节点不被框到', () => {
    const nodes = [node('a', 0, 0), { nodeId: 'float', x: null, y: null }];
    expect(nodesInRect(nodes, { x: 0, y: 0, w: 400, h: 400 })).toEqual(['a']);
  });

  it('空节点数组与畸形节点返回空数组', () => {
    expect(nodesInRect([], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
    expect(nodesInRect([null, 1, { nodeId: '' }], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
  });
});

describe('选择集操作', () => {
  it('追加去重且保序，重复调 add 不产生重复项', () => {
    let selection = ['a'];
    selection = addToSelection(selection, 'b');
    selection = addToSelection(selection, 'a');
    expect(selection).toEqual(['a', 'b']);
  });

  it('移除、切换、全选', () => {
    expect(removeFromSelection(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleSelection(['a'], 'a')).toEqual([]);
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
    // 全选跳过隐藏节点并去重
    expect(selectAll([node('a', 0, 0), node('b', 0, 0), node('b', 0, 0), node('h', 0, 0, { visibility: 'hidden' })])).toEqual(['a', 'b']);
  });

  it('清理幽灵选中项', () => {
    expect(pruneSelection(['a', 'gone', 'b'], new Set(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('空选择与畸形输入被规范化成空数组', () => {
    expect(addToSelection(null, 'a')).toEqual(['a']);
    expect(removeFromSelection(undefined, 'a')).toEqual([]);
    expect(pruneSelection(null, new Set(['a']))).toEqual([]);
  });

  it('空 id 被拒绝', () => {
    expect(() => addToSelection(['a'], '')).toThrow(/非空字符串/);
    expect(() => toggleSelection(['a'], '')).toThrow(/非空字符串/);
  });
});

describe('选区包围盒', () => {
  it('覆盖所有选中节点', () => {
    const nodes = [node('a', 0, 0), node('b', 500, 300, { width: 100, height: 100 })];
    expect(selectionBounds(nodes, ['a', 'b'])).toEqual({ x: 0, y: 0, w: 600, h: 400 });
  });

  it('只算选中项，忽略未选中节点', () => {
    const nodes = [node('a', 0, 0), node('b', 999, 999)];
    expect(selectionBounds(nodes, ['a'])).toEqual({ x: 0, y: 0, w: 310, h: 276 });
  });

  it('空选区或全部无坐标时返回 null', () => {
    const nodes = [node('a', 0, 0), { nodeId: 'float', x: null, y: null }];
    expect(selectionBounds(nodes, [])).toBeNull();
    expect(selectionBounds(nodes, ['float'])).toBeNull();
    expect(selectionBounds(nodes, ['ghost'])).toBeNull();
  });
});

describe('批量位移', () => {
  it('产出逐节点字段补丁，before/after 都是整数坐标', () => {
    const nodes = [node('a', 0, 0), node('b', 100, 100), node('c', 500, 500)];
    const patches = movePatchesFor(nodes, ['a', 'b'], 30, -20);
    expect(patches).toEqual([
      { area: 'layoutCards', id: 'a', before: { x: 0, y: 0 }, after: { x: 30, y: -20 } },
      { area: 'layoutCards', id: 'b', before: { x: 100, y: 100 }, after: { x: 130, y: 80 } },
    ]);
  });

  it('取整只发生在总量上，节点相对距离不漂移', () => {
    const nodes = [node('a', 0, 0), node('b', 10, 0)];
    const patches = movePatchesFor(nodes, ['a', 'b'], 0.6, 0);
    // 0.6 → 1，两个节点都 +1，间距保持 10
    expect(patches[0].after.x - patches[0].before.x).toBe(1);
    expect(patches[1].after.x - patches[1].before.x).toBe(1);
    expect(patches[1].after.x - patches[0].after.x).toBe(10);
  });

  it('零位移与空选区不产生补丁（不制造空的 undo 步）', () => {
    const nodes = [node('a', 0, 0)];
    expect(movePatchesFor(nodes, ['a'], 0, 0)).toEqual([]);
    expect(movePatchesFor(nodes, ['a'], 0.4, 0.4)).toEqual([]);
    expect(movePatchesFor(nodes, [], 10, 10)).toEqual([]);
  });

  it('命中集里没有坐标的节点被跳过', () => {
    const nodes = [node('a', 0, 0), { nodeId: 'float', x: null, y: null }];
    expect(movePatchesFor(nodes, ['a', 'float'], 5, 5).map(patch => patch.id)).toEqual(['a']);
  });

  it('非有限位移被拒', () => {
    expect(() => movePatchesFor([node('a', 0, 0)], ['a'], Number.NaN, 0)).toThrow(/有限数字/);
  });
});

describe('批量删除的边界', () => {
  it('session 节点默认受保护，其余可删', () => {
    const nodes = [
      { nodeId: 's1', x: 0, y: 0, kind: 'session' },
      { nodeId: 't1', x: 0, y: 0, kind: 'thought' },
      { nodeId: 'x1', x: 0, y: 0, kind: 'text' },
    ];
    expect(deletableSelection(nodes, ['s1', 't1', 'x1'])).toEqual(['t1', 'x1']);
  });

  it('自定义保护集合生效', () => {
    const nodes = [{ nodeId: 'g1', x: 0, y: 0, kind: 'group' }];
    expect(deletableSelection(nodes, ['g1'], ['group'])).toEqual([]);
    expect(deletableSelection(nodes, ['g1'], [])).toEqual(['g1']);
  });

  it('未选中项不出现在结果里', () => {
    const nodes = [{ nodeId: 'a', x: 0, y: 0, kind: 'text' }];
    expect(deletableSelection(nodes, [])).toEqual([]);
  });
});

describe('选择状态', () => {
  it('anchor 缺省取最后一个；不在集合里则回落', () => {
    expect(createSelection(['a', 'b']).anchorId).toBe('b');
    expect(createSelection(['a'], 'ghost').anchorId).toBe('a');
    expect(createSelection([], 'ghost').anchorId).toBeNull();
  });

  it('空选择是冻结且只读的', () => {
    expect(EMPTY_SELECTION.ids).toEqual([]);
    expect(EMPTY_SELECTION.anchorId).toBeNull();
    expect(Object.isFrozen(EMPTY_SELECTION)).toBe(true);
  });

  it('构造时去重', () => {
    expect(createSelection(['a', 'a', 'b']).ids).toEqual(['a', 'b']);
  });
});
