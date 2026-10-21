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

describe('HOME 是否要求选中项（源码层约束）', () => {
  it('HOME 的处理必须在「无选中即 return」之前', async () => {
    /**
     * 这条用源码顺序断言，因为行为测试无法覆盖：
     * 键盘处理是组件内的 effect 闭包，纯函数测不到它的早退顺序。
     *
     * 具体检查：`event.key === 'Home'` 的位置必须早于
     * `if (selectedCardIds.length === 0) return`。
     */
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(testDir, '..', 'src', 'ui', 'App.tsx'), 'utf8');

    /**
     * 剥掉注释再定位。
     *
     * 踩过的坑：第一版直接在原文里 indexOf，结果命中了我自己写在
     * 块注释里的一句 `selectedCardIds.length === 0` —— 那句比真正的
     * 守卫语句更靠前，测试因此误报「顺序颠倒」。锚点必须落在可执行代码上。
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const homeAt = code.indexOf("event.key === 'Home'");
    expect(homeAt).toBeGreaterThan(-1);

    /**
     * 守卫用「HOME 之后最近的那一个」定位，而不是全局第一个。
     *
     * 文件里有多处 `selectedCardIds.length === 0`（另一个函数里也有一个，
     * 位置更靠前）。用全局 indexOf 会拿错对象，断言看似成立实则测的不是
     * 同一段代码。这里必须锚定 HOME 之后的那一处。
     */
    const guardAt = code.indexOf('if (selectedCardIds.length === 0) return;', homeAt);
    expect(guardAt).toBeGreaterThan(-1);
    // HOME 必须在前，否则「没选中 → 按 HOME 没反应」这个缺陷会复活。
    expect(homeAt).toBeLessThan(guardAt);
  });

  it('HOME 走 layoutIntent，不自己算坐标', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(testDir, '..', 'src', 'ui', 'App.tsx'), 'utf8');
    expect(source).toMatch(/layoutIntent\(modelRef\.current, LAYOUT_MODES.branch\)/);
  });

  it('排版补丁复用 submitPatches（同一条撤销/乐观锁路径）', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(testDir, '..', 'src', 'ui', 'App.tsx'), 'utf8');
    expect(source).toMatch(/void submitPatches\(intent\.patches as Patch\[\]\)/);
  });
});

/** 类型守卫只是为了让 import 的 CanvasModel 不被 lint 判为未使用。 */
export type _ModelShape = CanvasModel | null;
