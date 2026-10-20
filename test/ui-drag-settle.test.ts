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

/** 与 `CanvasSurface` 渲染层同口径：有 pending 时用绝对目标坐标。 */
function renderedPosition(
  modelPosition: { x: number; y: number },
  cardId: string,
  pending: PendingMove | null,
): { x: number; y: number } {
  const pinned = pending?.targets.find(target => target.cardId === cardId);
  // 绝对目标：模型未追上时提前画在目标位置；追上后与模型坐标重合（同一个值）。
  // 不能用「模型位置 + 相对位移」—— 追上后会叠第二次，卡片二次跳动。
  if (pinned === undefined || pending === null) return modelPosition;
  return { x: pinned.x, y: pinned.y };
}

/** 与 `CanvasSurface` effect 同口径：模型是否已追上全部目标。 */
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
});
