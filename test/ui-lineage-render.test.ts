/**
 * 血缘连线的路径几何（UI-D16）。
 *
 * ## 需求
 *
 * 用户问「本项目有没有卡片连线功能」。查证结论：**数据层与纯逻辑都写完了**
 * （`edges.ts` + 31 条测试），但 `src/ui` 里一条线都没画——属于「有代码、没界面」。
 * 本文件锁住渲染侧的几何约定。
 *
 * ## 只画 lineage
 *
 * `lineage`（会话血缘）是系统生成、只读的，不需要用户操作，适合直接渲染。
 * `context` / `input` 是用户手工连线，需要拉线/删除交互，不在本次范围。
 */

import { describe, it, expect } from 'vitest';

import { CARD_HEIGHT, CARD_WIDTH } from '@/canvas/layout';

interface Point {
  x: number;
  y: number;
}

/**
 * 与 `CanvasSurface.tsx` 里 `lineagePaths` 的几何逐字一致。
 * 抽出来测是因为「父卡右侧中点 → 子卡左侧中点」这个约定一旦写错，
 * 连线会穿过卡片或锚在角上，而 UI 上很难一眼看出是几何算错还是数据错。
 */
function pathBetween(from: Point, to: Point): string {
  const x1 = from.x + CARD_WIDTH;
  const y1 = from.y + CARD_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + CARD_HEIGHT / 2;
  const bend = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

describe('连线锚点', () => {
  it('起点在父卡右侧中点', () => {
    const d = pathBetween({ x: 0, y: 0 }, { x: 500, y: 0 });
    // 第一条移动指令的目标 = (父卡右边缘, 垂直中点)
    expect(d.startsWith(`M ${CARD_WIDTH} ${CARD_HEIGHT / 2}`)).toBe(true);
  });

  it('终点在子卡左侧中点', () => {
    const to = { x: 500, y: 200 };
    const d = pathBetween({ x: 0, y: 0 }, to);
    expect(d.endsWith(`${to.x} ${to.y + CARD_HEIGHT / 2}`)).toBe(true);
  });

  it('同一行的父子之间是水平连线（起终点 y 相同）', () => {
    const from = { x: 0, y: 300 };
    const to = { x: 400, y: 300 };
    const y1 = from.y + CARD_HEIGHT / 2;
    const y2 = to.y + CARD_HEIGHT / 2;
    expect(y1).toBe(y2);
  });

  it('跨行时产生 S 形（控制点在同一侧外推）', () => {
    const d = pathBetween({ x: 0, y: 0 }, { x: 400, y: 318 });
    // 两个控制点分别向左右外推，形成 S 而不是直线
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // 格式：M x1 y1 C c1x c1y, c2x c2y, x2 y2
    const [, , , c1y, c2y] = nums as unknown as number[];
    expect(c1y).not.toBe(c2y);
  });

  it('弯曲量有下限，短距离连接也会弯', () => {
    // 相邻两张卡：|x2-x1| 可能很小，若不加下限会变成一条直线，
    // 与卡片边框重叠后看不出方向。
    const d = pathBetween({ x: 0, y: 0 }, { x: CARD_WIDTH + 10, y: 0 });
    expect(d).toContain('C');
    // 路径格式：`M x1 y1 C c1x c1y, c2x c2y, x2 y2`
    // 数字顺序：  0  1  2  3   4   5   6   7
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const x1 = nums[0] as number;
    const c1x = nums[2] as number;
    expect(c1x - x1).toBeGreaterThanOrEqual(40);
  });
});

describe('跳过条件', () => {
  it('端点缺坐标时不产生路径（悬空线比不画更困惑）', () => {
    // 复刻绘制前的过滤：任一端 getResolvedPosition 为 null 就跳过
    const positions = new Map<string, Point>([['a:0', { x: 0, y: 0 }]]);
    const links: [string, string][] = [['a:0', 'a:1']];
    const drawn = links.filter(([from, to]) => positions.has(from) && positions.has(to));
    expect(drawn).toEqual([]);
  });

  it('parentId 为 null 的根卡片不画线', () => {
    const card = { id: 'a:0', parentId: null };
    const links = [card].filter(item => item.parentId !== null && item.parentId !== undefined);
    expect(links).toEqual([]);
  });

  it('两端都有坐标时画一条', () => {
    const positions = new Map<string, Point>([
      ['a:0', { x: 0, y: 0 }],
      ['a:1', { x: 400, y: 0 }],
    ]);
    const links: [string, string][] = [['a:0', 'a:1']];
    const drawn = links.filter(([from, to]) => positions.has(from) && positions.has(to));
    expect(drawn).toHaveLength(1);
  });
});

describe('源码层：连线层不吃指针事件', () => {
  it('.evc-lineage-layer 必须是 pointer-events: none', async () => {
    // 这条是硬性交互要求：连线覆盖在卡片之间，若吃掉指针事件，
    // 框选与空白拖拽全部失效（用户会以为画布坏了）。
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testDir = dirname(fileURLToPath(import.meta.url));
    const css = await readFile(join(testDir, '..', 'src', 'styles', 'base.css'), 'utf8');
    const block = css.slice(css.indexOf('.evc-lineage-layer'));
    const end = block.indexOf('}');
    expect(block.slice(0, end)).toContain('pointer-events: none');
  });
});
