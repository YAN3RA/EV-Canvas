// @ts-nocheck -- 测试里用鸭子类型 model，断言精确。
import { describe, it, expect } from 'vitest';
import {
  CARD_WIDTH,
  CARD_HEIGHT,
  CARD_GAP_X,
  CARD_GAP_Y,
  CARD_STEP_X,
  CARD_STEP_Y,
  CARD_STEP_LANE,
  LAYOUT_MODES,
  LAYOUT_ENGINES,
  LAYOUT_PATCH_AREA,
  LAYOUT_COMMAND_KIND,
  layoutHorizontal,
  layoutVertical,
  layoutByBranch,
  layoutCards,
} from '@/canvas/layout';
import { NATURAL_ORIGIN, NATURAL_STEP_X } from '@/canvas/model';

/**
 * layout 是纯几何：输入 cards，输出 positions。
 * 重点锁三件事：
 *   1. 三种布局都产出全部卡片的坐标（不丢卡）
 *   2. 断链/环 不被静默吞掉，进 unresolved
 *   3. 输入 model 不被修改（纯函数）
 */

/** 用边表造一个鸭子类型 model。edges: [childId, parentId][] */
function modelFromEdges(edges: [string, string | null][]) {
  const cards = edges.map(([id, parentId], index) => ({
    id,
    parentId,
    cardOrder: index,
    x: 0,
    y: 0,
  }));
  return { cards, regions: [], annotations: [] };
}

describe('几何常量', () => {
  it('卡片有正尺寸', () => {
    expect(CARD_WIDTH).toBeGreaterThan(0);
    expect(CARD_HEIGHT).toBeGreaterThan(0);
  });

  it('步长 = 尺寸 + 间隔', () => {
    expect(CARD_STEP_Y).toBe(CARD_HEIGHT + CARD_GAP_Y);
    expect(CARD_STEP_LANE).toBe(CARD_WIDTH + CARD_GAP_X);
  });

  it('横向步长与 model 的自然步长一致', () => {
    expect(CARD_STEP_X).toBe(NATURAL_STEP_X);
  });

  it('三种布局模式都有登记', () => {
    expect(Object.keys(LAYOUT_MODES).length).toBeGreaterThanOrEqual(3);
  });

  it('每个模式都有对应引擎', () => {
    for (const key of Object.keys(LAYOUT_MODES)) {
      expect(LAYOUT_ENGINES).toHaveProperty(LAYOUT_MODES[key]);
    }
  });

  it('补丁区域与命令 kind 已声明', () => {
    expect(typeof LAYOUT_PATCH_AREA).toBe('string');
    expect(typeof LAYOUT_COMMAND_KIND).toBe('string');
  });
});

describe('layoutHorizontal — 链式横向', () => {
  it('单链每张卡拿到坐标', () => {
    const model = modelFromEdges([
      ['a', null],
      ['b', 'a'],
      ['c', 'b'],
    ]);
    const out = layoutHorizontal(model);
    expect(Object.keys(out.positions).sort()).toEqual(['a', 'b', 'c']);
  });

  it('子卡在父卡右侧一个步长', () => {
    const model = modelFromEdges([
      ['a', null],
      ['b', 'a'],
    ]);
    const out = layoutHorizontal(model);
    expect(out.positions.b.x - out.positions.a.x).toBe(CARD_STEP_X);
  });

  it('起点可用 options.origin 覆盖', () => {
    const model = modelFromEdges([['a', null]]);
    const out = layoutHorizontal(model, { origin: { x: 500, y: 600 } });
    expect(out.positions.a.x).toBe(500);
    expect(out.positions.a.y).toBe(600);
  });

  it('不给 origin 时用自然原点', () => {
    const model = modelFromEdges([['a', null]]);
    const out = layoutHorizontal(model);
    expect(out.positions.a.x).toBe(NATURAL_ORIGIN.x);
    expect(out.positions.a.y).toBe(NATURAL_ORIGIN.y);
  });

  it('没有卡片时返回空结果，不崩', () => {
    const out = layoutHorizontal(modelFromEdges([]));
    expect(out.positions).toEqual({});
    expect(out.movedCount).toBe(0);
  });
});

describe('layoutVertical — 链式纵向', () => {
  it('子卡在父卡下方一个步长', () => {
    const model = modelFromEdges([
      ['a', null],
      ['b', 'a'],
    ]);
    const out = layoutVertical(model);
    expect(out.positions.b.y - out.positions.a.y).toBe(CARD_STEP_Y);
  });

  it('所有卡都有坐标', () => {
    const model = modelFromEdges([
      ['a', null],
      ['b', 'a'],
      ['c', 'a'],
    ]);
    const out = layoutVertical(model);
    expect(Object.keys(out.positions).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('layoutByBranch — 分支分道', () => {
  it('两条独立分支都拿到坐标', () => {
    const model = modelFromEdges([
      ['a', null],
      ['b', 'a'],
      ['c', null],
      ['d', 'c'],
    ]);
    const out = layoutByBranch(model);
    expect(Object.keys(out.positions).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('不同分支在不同 lane（y 不同）', () => {
    const model = modelFromEdges([
      ['a', null],
      ['c', null],
    ]);
    const out = layoutByBranch(model);
    expect(out.positions.a.y).not.toBe(out.positions.c.y);
  });
});

describe('断链与环 — 不丢卡、进 unresolved', () => {
  it('parentId 指向不存在的卡 → 该卡仍得到坐标', () => {
    const model = modelFromEdges([['a', 'ghost']]);
    const out = layoutHorizontal(model);
    expect(out.positions.a).toBeDefined();
  });

  it('断链卡被记入 unresolved', () => {
    const model = modelFromEdges([['a', 'ghost']]);
    const out = layoutHorizontal(model);
    expect(out.unresolved).toContain('a');
  });

  it('自引用算断链，不无限递归', () => {
    const model = modelFromEdges([['a', 'a']]);
    const out = layoutHorizontal(model);
    expect(out.positions.a).toBeDefined();
    expect(out.unresolved).toContain('a');
  });

  it('环能终止且每个成员都有坐标', () => {
    // a→b→a 的环（手工构造，buildCanvasModel 不会产出）
    const model = modelFromEdges([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    const out = layoutHorizontal(model);
    expect(out.positions.a).toBeDefined();
    expect(out.positions.b).toBeDefined();
    expect(out.unresolved.length).toBeGreaterThan(0);
  });

  it('正常链不产生 unresolved', () => {
    const model = modelFromEdges([
      ['a', null],
      ['b', 'a'],
    ]);
    expect(layoutHorizontal(model).unresolved).toEqual([]);
  });
});

describe('纯函数性 — 不修改输入', () => {
  it('layout 后原 model 的坐标不变', () => {
    const model = modelFromEdges([
      ['a', null],
      ['b', 'a'],
    ]);
    const before = JSON.stringify(model);
    layoutHorizontal(model);
    layoutVertical(model);
    layoutByBranch(model);
    expect(JSON.stringify(model)).toBe(before);
  });
});

describe('layoutCards 分派', () => {
  it('三种模式都返回同样形状', () => {
    const model = modelFromEdges([
      ['a', null],
      ['b', 'a'],
    ]);
    for (const mode of Object.values(LAYOUT_MODES)) {
      const out = layoutCards(model, mode);
      expect(out).toHaveProperty('positions');
      expect(out).toHaveProperty('movedCount');
      expect(out).toHaveProperty('unresolved');
    }
  });
});
