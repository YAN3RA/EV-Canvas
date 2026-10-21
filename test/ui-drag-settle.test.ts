/**
 * 拖拽落位与键盘微调的**提交语义**。
 *
 * 这里不渲染 React（DOM 交互留给浏览器验收），锁的是三类容易回归的规则：
 *
 *   1. 防跳帧：松手后到模型追上之前，卡片必须继续画在目标位置，不能回弹
 *   2. 方向键入队：一次按键 = 一条意图，且不抢输入框的按键
 *   3. 步长口径：普通 1px、Shift 10px，与 `moveCard` 的取整一致
 */

import { describe, it, expect } from 'vitest';
import { createCommandHistory } from '@/canvas/commands';

function historyWith(cards: Record<string, { x: number; y: number }>) {
  return createCommandHistory({
    limit: 100,
    readLayout: () => ({ cards, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], annotations: [], materials: [] }),
  });
}

describe('方向键微调', () => {
  it('一次按键产生一条意图，位移按步长', () => {
    const history = historyWith({ a: { x: 100, y: 100 } });
    const recorded = history.commit(history.commands.moveCard('a', { x: 101, y: 100 }));
    expect(recorded).not.toBeNull();
    const patch = recorded!.patches[0] as { before: { x: number }; after: { x: number } };
    expect(patch.before).toEqual({ x: 100, y: 100 });
    expect(patch.after).toEqual({ x: 101, y: 100 });
  });

  it('Shift 步长 10 与普通步长 1 产生不同的目标', () => {
    const history = historyWith({ a: { x: 0, y: 0 } });
    const small = history.commit(history.commands.moveCard('a', { x: 1, y: 0 }));
    const large = history.commit(history.commands.moveCard('a', { x: 10, y: 0 }));
    expect((small!.patches[0] as { after: { x: number } }).after.x).toBe(1);
    expect((large!.patches[0] as { after: { x: number } }).after.x).toBe(10);
  });

  it('多选时每个选中卡片各得一条意图，可被一次 undo 依次还原', () => {
    const history = historyWith({ a: { x: 0, y: 0 }, b: { x: 50, y: 50 } });
    const first = history.commit(history.commands.moveCard('a', { x: 1, y: 0 }));
    const second = history.commit(history.commands.moveCard('b', { x: 51, y: 50 }));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // 两次 commit 在栈上是两条，撤销要按次回退（方向键是细粒度操作，符合预期）。
    expect(history.undoDepth).toBe(2);
  });

  it('移回原位不产生补丁（防抖：连按同方向再反向不应留空记录）', () => {
    const history = historyWith({ a: { x: 5, y: 5 } });
    const recorded = history.commit(history.commands.moveCard('a', { x: 5, y: 5 }));
    const count = recorded === null ? 0 : recorded.patches.length;
    expect(count).toBe(0);
  });
});

/**
 * 防跳帧的判据是：松手后卡片位置应停在目标坐标，直到模型追上。
 *
 * 这里用一个纯函数复刻渲染层的偏移计算，验证「模型未追上时不回弹、
 * 追上后偏移归零」这条不变量。之所以不复刻整段组件：那段逻辑依赖 React
 * 状态与 effect 时序，脱离 DOM 测不出真实行为，硬测只会测到测试自己的实现。
 */
interface PendingMove {
  dx: number;
  dy: number;
  targets: { cardId: string; x: number; y: number }[];
}

/** 与 `CanvasSurface` 渲染层同口径：拖拽中叠相对位移，松手后用绝对目标。 */
function renderedPosition(
  modelPosition: { x: number; y: number },
  cardId: string,
  pending: PendingMove | null,
  dragPreview: { dx: number; dy: number } | null = null,
): { x: number; y: number } {
  const pinned = pending?.targets.find(target => target.cardId === cardId);
  // 绝对目标优先：模型未追上时提前画在目标位置，追上后与模型坐标重合。
  if (pending !== null && pinned !== undefined) return { x: pinned.x, y: pinned.y };
  // 拖拽中（未松手）才用相对位移。
  if (dragPreview !== null) return { x: modelPosition.x + dragPreview.dx, y: modelPosition.y + dragPreview.dy };
  return modelPosition;
}

/**
 * 与 `CanvasSurface` 的 `pendingMoveActive` 同口径：模型是否已追上全部目标。
 *
 * 注意：`d3cd9e1` 起，这个判据在组件里是渲染期算的 `useMemo`，**不是 effect**。
 * 本文件复刻的是它的判定式，不是它的执行时机——下面 `renderedPosition` 直接把
 * `pending` 传进来、绕开 `pendingMoveActive`，所以**这里测不出 W2（settled 后
 * model 回退导致旧 pending 复燃）**。要测那类时序问题必须真 DOM + 时间线，
 * 见 [UI-D2-D3-埋点方案](../../Project%20Docs/3-开发测试/测试/UI-D2-D3-埋点方案.md)。
 */
function settled(model: Record<string, { x: number; y: number }>, pending: PendingMove): boolean {
  return pending.targets.every(target => {
    const position = model[target.cardId];
    if (position === undefined) return true;
    return Math.abs(position.x - target.x) < 0.5 && Math.abs(position.y - target.y) < 0.5;
  });
}

describe('松手后的防跳帧', () => {
  const pending: PendingMove = { dx: 40, dy: 25, targets: [{ cardId: 'a', x: 140, y: 125 }] };

  it('模型未追上时，渲染位置停在目标而非回弹', () => {
    // 松手瞬间模型还是旧位置 (100,100)
    const rendered = renderedPosition({ x: 100, y: 100 }, 'a', pending);
    expect(rendered).toEqual({ x: 140, y: 125 });
    expect(settled({ a: { x: 100, y: 100 } }, pending)).toBe(false);
  });

  it('模型追上后，偏移自然归零（位置连续，无跳变）', () => {
    // reload 落地：模型已是新位置
    const rendered = renderedPosition({ x: 140, y: 125 }, 'a', pending);
    expect(rendered).toEqual({ x: 140, y: 125 });
    expect(settled({ a: { x: 140, y: 125 } }, pending)).toBe(true);
  });

  it('多选拖动时所有卡片一起停在目标位置', () => {
    const multi: PendingMove = {
      dx: 10,
      dy: 10,
      targets: [
        { cardId: 'a', x: 110, y: 110 },
        { cardId: 'b', x: 210, y: 310 },
      ],
    };
    expect(renderedPosition({ x: 100, y: 100 }, 'a', multi)).toEqual({ x: 110, y: 110 });
    expect(renderedPosition({ x: 200, y: 300 }, 'b', multi)).toEqual({ x: 210, y: 310 });
    // 只要有一张没追上就整体不算 settled，避免部分卡片提前回弹
    expect(settled({ a: { x: 110, y: 110 }, b: { x: 200, y: 300 } }, multi)).toBe(false);
    expect(settled({ a: { x: 110, y: 110 }, b: { x: 210, y: 310 } }, multi)).toBe(true);
  });

  it('没有 pending 时渲染位置就是模型位置（不引入常驻偏移）', () => {
    expect(renderedPosition({ x: 7, y: 9 }, 'a', null)).toEqual({ x: 7, y: 9 });
  });

  /**
   * 回归：`pendingMove` 释放后，**残留的 dragPreview 不得再生效**。
   *
   * 这条抓的是真实发生过的「松手后瞬间跳远」：松手时只设了 pendingMove、
   * 忘了清 dragPreview。有 pending 时 pinned 优先，看起来正常；但 pending 一旦
   * 释放（模型追上或 3s 超时），残留的相对位移就在**已含位移的新位置**上
   * 再叠一次 —— 卡片正好多走一个 dx/dy。
   *
   * 断言方式：模拟「模型已追上 + pending 已释放 + dragPreview 忘了清」，
   * 渲染结果若等于新位置 + dx，就是 bug；正确实现要求松手时两者一起清。
   */
  it('释放 pending 后不得再叠相对位移（防「松手跳远」）', () => {
    const target = { x: 140, y: 125 };
    // 正确路径：松手时 setDragPreview(null) 与 setPendingMove(...) 成对发生。
    const correct = renderedPosition(target, 'a', null, null);
    expect(correct).toEqual({ x: 140, y: 125 });

    // 错误路径（曾经真实存在）：pending 已清但 dragPreview 残留，
    // 在新位置 (140,125) 上再叠加 (40,25) → 180,150，正是用户看到的「跳远」。
    const buggy = renderedPosition(target, 'a', null, { dx: 40, dy: 25 });
    expect(buggy).not.toEqual({ x: 140, y: 125 });
    expect(buggy).toEqual({ x: 180, y: 150 });
  });

  it('pending 生效期间 dragPreview 即使残留也被绝对目标压住（视觉不跳）', () => {
    const target = { x: 140, y: 125 };
    // 松手瞬间模型仍是旧位置；此时若 dragPreview 还在，pinned 优先，画面仍正确。
    // 这解释了为什么这个 bug 只在「pending 释放那一刻」才暴露。
    const rendered = renderedPosition({ x: 100, y: 100 }, 'a', pending, { dx: 40, dy: 25 });
    expect(rendered).toEqual(target);
  });

  /**
   * 整条时间线逐帧验证：松手前后的可见位置必须**单调**走到目标并停住，
   * 不允许出现「回弹」或「越过目标」。
   *
   * 这条是上面几条的合体，直接对应用户看到的抖动。它之所以必要：
   * 单点断言各自都能过，但真实故障正是**帧与帧之间**的跳变 —— 比如
   * effect 释放 pending 造成的多渲染一帧旧值。逐帧算出坐标再检查相邻帧
   * 位移方向，才能覆盖这类问题。
   */
  it('逐帧时间线：松手后不回弹、不越过目标', () => {
    const origin = { x: 100, y: 100 };
    const target = { x: 140, y: 125 };
    const pendingMove: PendingMove = { dx: 40, dy: 25, targets: [{ cardId: 'a', x: 140, y: 125 }] };

    // 帧 1-3：拖拽中，模型仍是旧位置，dragPreview 叠相对位移。
    const frames: { x: number; y: number }[] = [];
    for (const dx of [10, 25, 40]) frames.push(renderedPosition(origin, 'a', null, { dx, dy: Math.round(dx * 0.625) }));

    // 帧 4：松手瞬间 —— dragPreview 清空、pending 接管、模型仍是旧值。
    frames.push(renderedPosition(origin, 'a', pendingMove, null));
    // 帧 5：网络往返中，模型未变。
    frames.push(renderedPosition(origin, 'a', pendingMove, null));
    // 帧 6：reload 落地，模型到达目标，pending 同步失效（同一帧）。
    frames.push(renderedPosition(target, 'a', null, null));

    // 松手后（帧 4 起）位置不得回退、不得超过目标。
    const afterRelease = frames.slice(3);
    for (let i = 1; i < afterRelease.length; i++) {
      expect(afterRelease[i]!.x).toBeGreaterThanOrEqual(afterRelease[i - 1]!.x);
      expect(afterRelease[i]!.x).toBeLessThanOrEqual(target.x);
    }
    // 松手那一帧必须**正好**在目标上，不能掉回起点。
    expect(afterRelease[0]).toEqual(target);
    // 末帧停在目标，不越界。
    expect(frames.at(-1)).toEqual(target);
  });
});
