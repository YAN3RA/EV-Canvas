/**
 * 卡片与连线共用同一套「画在哪」（UI-D17 / UI-D18）。
 *
 * ## 两个故障，一个根因
 *
 * 1. **连线不跟随拖拽**：卡片渲染时在 `position` 之上叠了 `dragPreview` /
 *    `pendingMove`，而连线直接用静止的 `position`。手指一拖，卡片动了、线钉在
 *    原地，松手刷新后线才追上。
 *
 * 2. **框选后拖不动**：渲染时的优先级是 `pinned`（pendingMove 的绝对目标）
 *    **高于** `draggingThis`（本次拖拽相对位移）。而框选拖一次之后会留下
 *    pendingMove 等模型追上；这个窗口里再拖同一批卡片，新位移被旧的 pinned
 *    整个盖住 —— 表现为「拖不动，得等几秒」。
 *
 * ## 修法
 *
 * 抽一个 `resolveDrawnPosition`，卡片与连线都调它。优先级改成：
 *   1. `dragPreview`（手指还按着：正在进行的拖拽是唯一权威）
 *   2. `pendingMove`（松手后接力，等模型追上）
 *   3. 静止 `position`
 *
 * 本文件锁住这三条优先级与几何一致性。
 */

import { describe, it, expect } from 'vitest';

interface Point {
  x: number;
  y: number;
}

/** 与 CanvasSurface.tsx 的 `resolveDrawnPosition` 逐字一致。 */
function resolveDrawnPosition(
  cardId: string,
  base: Point,
  preview: { dx: number; dy: number } | null,
  pending: { targets: { cardId: string; x: number; y: number }[] } | null,
): Point {
  if (preview !== null) return { x: base.x + preview.dx, y: base.y + preview.dy };
  const pinned = pending?.targets.find(target => target.cardId === cardId);
  if (pinned !== undefined) return { x: pinned.x, y: pinned.y };
  return base;
}

describe('画在哪：优先级', () => {
  const base: Point = { x: 100, y: 200 };

  it('常态：用静止坐标', () => {
    expect(resolveDrawnPosition('c1', base, null, null)).toEqual(base);
  });

  it('拖拽中：静止坐标 + 相对位移', () => {
    expect(resolveDrawnPosition('c1', base, { dx: 30, dy: -10 }, null)).toEqual({ x: 130, y: 190 });
  });

  it('松手后：用 pendingMove 的绝对目标', () => {
    const pending = { targets: [{ cardId: 'c1', x: 500, y: 600 }] };
    expect(resolveDrawnPosition('c1', base, null, pending)).toEqual({ x: 500, y: 600 });
  });

  it('**拖拽中优先级高于 pendingMove**（这是「框选后拖不动」的修法）', () => {
    // 场景：上一次框选拖拽留下 pendingMove，用户立刻再拖同一批卡片。
    // 旧实现让 pinned 胜出 → 新位移被吞掉 → 看起来拖不动。
    const pending = { targets: [{ cardId: 'c1', x: 500, y: 600 }] };
    const preview = { dx: 30, dy: -10 };
    // 必须跟着这次拖拽走，而不是回到旧目标
    expect(resolveDrawnPosition('c1', base, preview, pending)).toEqual({ x: 130, y: 190 });
  });

  it('pendingMove 只影响它列出的卡片', () => {
    const pending = { targets: [{ cardId: 'OTHER', x: 500, y: 600 }] };
    expect(resolveDrawnPosition('c1', base, null, pending)).toEqual(base);
  });

  it('pendingMove 存在但预览为空时不会误用别人的目标', () => {
    const pending = { targets: [{ cardId: 'c2', x: 9, y: 9 }] };
    const got = resolveDrawnPosition('c1', base, null, pending);
    expect(got).not.toEqual({ x: 9, y: 9 });
  });
});

describe('连线与卡片位置一致', () => {
  /** 复刻连线几何：父卡右中 → 子卡左中。 */
  function anchor(from: Point, to: Point, cardWidth: number, cardHeight: number) {
    return {
      x1: from.x + cardWidth,
      y1: from.y + cardHeight / 2,
      x2: to.x,
      y2: to.y + cardHeight / 2,
    };
  }

  it('两端都用「画在哪」而不是静止坐标（否则拖拽时线会脱离卡片）', () => {
    const baseFrom = { x: 0, y: 0 };
    const baseTo = { x: 400, y: 0 };
    const preview = { dx: 50, dy: 0 };

    // 卡片实际画的位置
    const drawnFrom = resolveDrawnPosition('p', baseFrom, preview, null);
    const drawnTo = resolveDrawnPosition('c', baseTo, preview, null);

    // 连线也必须用这两个位置
    const a = anchor(drawnFrom, drawnTo, 300, 276);
    // 起点应等于「父卡画的位置 + 卡宽」
    expect(a.x1).toBe(drawnFrom.x + 300);
    // 若误用静止坐标，起点会差出 50px
    expect(a.x1).not.toBe(baseFrom.x + 300);
  });

  it('拖拽时父子一起移动，连线长度不变（相对位置守恒）', () => {
    const baseFrom = { x: 0, y: 0 };
    const baseTo = { x: 400, y: 0 };
    const preview = { dx: 50, dy: 20 };
    const before = anchor(baseFrom, baseTo, 300, 276);
    const during = anchor(
      resolveDrawnPosition('p', baseFrom, preview, null),
      resolveDrawnPosition('c', baseTo, preview, null),
      300,
      276,
    );
    expect(during.x1 - before.x1).toBe(50);
    expect(during.y1 - before.y1).toBe(20);
    expect(during.x2 - during.x1).toBe(before.x2 - before.x1);
  });
});

describe('源码层：卡片与连线共用同一函数', () => {
  it('CanvasSurface 里存在 resolveDrawnPosition 且卡片与连线都调用它', async () => {
    // 这条是防「以后有人又给卡片单独写一套偏移」：只要有一处按静止坐标画，
    // 连线与卡片就会重新分离。
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testDir = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(testDir, '..', 'src', 'ui', 'CanvasSurface.tsx'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).toMatch(/const resolveDrawnPosition = useCallback/);
    // 调用点至少两处（连线循环 + 卡片渲染）
    // 统计「函数体调用」：排除定义处（前面跟 `const` 的那一行）
    const callLines = code
      .split('\n')
      .filter(line => line.includes('resolveDrawnPosition(') && !line.includes('const resolveDrawnPosition'));
    expect(callLines.length).toBeGreaterThanOrEqual(2);
  });

  it('拖拽预览在实现里优先于 pendingMove', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testDir = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(testDir, '..', 'src', 'ui', 'CanvasSurface.tsx'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const previewAt = code.indexOf('if (preview !== null) return');
    const pinnedAt = code.indexOf('.targets.find');
    expect(previewAt).toBeGreaterThan(-1);
    expect(pinnedAt).toBeGreaterThan(-1);
    // preview 分支必须写在 pending 分支之前
    expect(previewAt).toBeLessThan(pinnedAt);
  });
});
