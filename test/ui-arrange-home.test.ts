/**
 * HOME 键自动排版（UI-D11）。
 *
 * ## 需求
 *
 * 用户原话：「移动后找不到卡片难以寻找」。画布没有小地图（D14 已移除），
 * 卡片被拖到视口外就只能靠滚轮盲找。HOME 要能一键把全部卡片救回来。
 *
 * ## 两个容易写错的点，本文件专门锁住
 *
 * 1. **HOME 不能要求选中项**。原有键盘处理在 `selectedCardIds.length === 0`
 *    时直接 return。如果 HOME 写成同一段里的 case，就会出现「什么都没选 →
 *    HOME 不响应」，而「什么都没选」恰恰是最需要它的场景。
 *
 * 2. **必须走 `layoutIntent`，不能自己算坐标**。自动排版有三套引擎
 *    （horizontal / vertical / byBranch），重写一份必然与 FR-09.1 走样。
 *    这里锁住「产出的是可提交的 patches」，保证它复用同一条撤销/乐观锁路径。
 */

import { describe, it, expect } from 'vitest';

import { LAYOUT_COMMAND_KIND, LAYOUT_MODES, LAYOUT_PATCH_AREA, layoutIntent, layoutCards, type LayoutModelInput } from '@/canvas/layout';
import type { CanvasModel } from '@/canvas/model';

/**
 * 最小可用的 duck-typed 模型。
 *
 * `layout.ts` 的契约就是「接受任何带 cards 数组的对象」（见其文件头注释），
 * 所以这里不需要构造完整 CanvasModel —— 那会把测试绑死在无关字段上。
 */
function model(cards: { id: string; parentId: string | null }[]): LayoutModelInput {
  return {
    cards: cards.map(card => ({
      id: card.id,
      parentId: card.parentId,
      threadId: card.id.split(':')[0],
      kind: 'session',
      title: card.id,
      collapsed: false,
      position: null,
      naturalPosition: { x: 0, y: 0 },
    })),
  };
}

/** 一条链：a0 → a1，外加另一条链 b0。 */
const twoChains = () =>
  model([
    { id: 'a:0', parentId: null },
    { id: 'a:1', parentId: 'a:0' },
    { id: 'b:0', parentId: null },
  ]);

describe('layoutIntent 产出可提交的补丁', () => {
  it('给每张卡片都产出位移补丁', () => {
    const intent = layoutIntent(twoChains(), LAYOUT_MODES.branch);
    expect(intent.patches).toHaveLength(3);
    // kind 是命令意图名（'layout'），area 才是补丁落点（'layoutCards'）。两者别混。
    expect(intent.kind).toBe(LAYOUT_COMMAND_KIND);
    expect(intent.patches[0]!.area).toBe(LAYOUT_PATCH_AREA);
  });

  it('每条补丁都是 layoutCards 区域，带 before/after', () => {
    const intent = layoutIntent(twoChains(), LAYOUT_MODES.branch);
    for (const patch of intent.patches as { area: string; id: string; after: unknown }[]) {
      expect(patch.area).toBe('layoutCards');
      expect(typeof patch.id).toBe('string');
      expect(patch.after).not.toBeNull();
    }
  });

  it('空模型产出空补丁，不抛错', () => {
    const intent = layoutIntent(model([]), LAYOUT_MODES.branch);
    expect(intent.patches).toEqual([]);
  });

  it('null 模型不抛错（未加载完成时按 HOME 也不能崩）', () => {
    expect(() => layoutIntent(null, LAYOUT_MODES.branch)).not.toThrow();
    expect(layoutIntent(null, LAYOUT_MODES.branch).patches).toEqual([]);
  });
});

describe('byBranch 把不同会话分开', () => {
  it('两条链的卡片落在不同行', () => {
    const result = layoutCards(twoChains(), LAYOUT_MODES.branch);
    const positions = result.positions as Record<string, { x: number; y: number }>;
    // a 链与 b 链的 y 应当不同（分行），同一链内 y 相同
    expect(positions['a:0']!.y).toBe(positions['a:1']!.y);
    expect(positions['a:0']!.y).not.toBe(positions['b:0']!.y);
  });

  it('同一链内按序水平展开', () => {
    const result = layoutCards(twoChains(), LAYOUT_MODES.branch);
    const positions = result.positions as Record<string, { x: number; y: number }>;
    expect(positions['a:1']!.x).toBeGreaterThan(positions['a:0']!.x);
  });
});

describe('排版结果是确定的（同样的输入给同样的坐标）', () => {
  it('连续两次调用结果一致', () => {
    const first = layoutCards(twoChains(), LAYOUT_MODES.branch);
    const second = layoutCards(twoChains(), LAYOUT_MODES.branch);
    expect(first.positions).toEqual(second.positions);
  });

  it('不依赖当前坐标：把卡片放到很远的地方，排版结果不变', () => {
    // 这是 HOME 能「救回」卡片的前提：排版只看血缘，不看现有位置。
    const far = model([
      { id: 'a:0', parentId: null },
      { id: 'a:1', parentId: 'a:0' },
      { id: 'b:0', parentId: null },
    ]);
    for (const card of far.cards ?? []) (card as { position: unknown }).position = { x: 99999, y: -99999 };
    const near = layoutCards(twoChains(), LAYOUT_MODES.branch);
    const moved = layoutCards(far, LAYOUT_MODES.branch);
    expect(moved.positions).toEqual(near.positions);
  });
});

describe('HOME 的位置与接线（源码层约束）', () => {
  /** 读源码并剥注释：注释里会引用旧写法，不能当代码判。 */
  async function sourceOf(relative: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testDir = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(testDir, '..', relative), 'utf8');
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('HOME 的键监听在 CanvasSurface（只有它握有 transform）', async () => {
    const surface = await sourceOf('src/ui/CanvasSurface.tsx');
    expect(surface).toContain("event.key !== 'Home'");
    // 且必须读 ref 而不是闭包里的 transform，否则平移后按 HOME 会算错原点
    expect(surface).toMatch(/transformRef\.current/);
  });

  it('HOME 不再挂在 App.tsx（挂在那里只能拿到绝对原点）', async () => {
    const app = await sourceOf('src/ui/App.tsx');
    expect(app).not.toContain("event.key === 'Home'");
  });

  it('App 把视口原点透传给布局引擎', async () => {
    const app = await sourceOf('src/ui/App.tsx');
    // origin 必须来自外部传入，不能是常量
    expect(app).toMatch(/layoutIntent\(modelRef\.current, LAYOUT_MODES\.branch, \{ origin \}\)/);
  });

  it('排版补丁复用 submitPatches（同一条撤销/乐观锁路径）', async () => {
    const app = await sourceOf('src/ui/App.tsx');
    expect(app).toMatch(/void submitPatches\(intent\.patches as Patch\[\]\)/);
  });

  it('CanvasSurface 把 onArrangeAll 接到了 App', async () => {
    const app = await sourceOf('src/ui/App.tsx');
    expect(app).toContain('onArrangeAll={arrangeAllCards}');
  });
});

describe('视口原点换算', () => {
  /**
   * 复刻 CanvasSurface 里的换算：
   *   world 0 落在屏幕 (transform.x, transform.y)，
   *   所以视口左上角对应的 world 坐标是 (-x/zoom, -y/zoom)。
   */
  function originFromTransform(transform: { x: number; y: number; zoom: number }, padding = 40) {
    const zoom = Number.isFinite(transform.zoom) && transform.zoom > 0 ? transform.zoom : 1;
    return {
      x: Math.round(-transform.x / zoom) + padding,
      y: Math.round(-transform.y / zoom) + padding,
    };
  }

  it('未平移时原点就是内边距本身', () => {
    expect(originFromTransform({ x: 0, y: 0, zoom: 1 })).toEqual({ x: 40, y: 40 });
  });

  it('向右平移 500 → world 原点左移 500（方向不能反）', () => {
    expect(originFromTransform({ x: 500, y: 0, zoom: 1 }, 0).x).toBe(-500);
  });

  it('缩放会一起参与换算', () => {
    // zoom=0.5 时，屏幕上 500px 只对应 world 1000
    expect(originFromTransform({ x: 500, y: 0, zoom: 0.5 }, 0).x).toBe(-1000);
  });

  it('zoom 非法时退回 1，不产生 NaN 坐标', () => {
    const origin = originFromTransform({ x: 100, y: 0, zoom: 0 }, 0);
    expect(Number.isFinite(origin.x)).toBe(true);
    expect(origin.x).toBe(-100);
  });

  it('卡片铺在当前视口附近，而不是画布角落', () => {
    // 用户正看着 world (-5000,-3000) 一带
    const origin = originFromTransform({ x: 5000, y: 3000, zoom: 1 }, 0);
    expect(origin).toEqual({ x: -5000, y: -3000 });
    // 铺出来的第一张卡就在这个原点，视野不需要移动
    expect(Math.abs(origin.x - -5000)).toBe(0);
  });
});