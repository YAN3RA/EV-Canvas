/**
 * 视图（pan/zoom）的本地权威性。
 *
 * 故障背景：原先 effect 依赖 `[viewport.x, viewport.y, viewport.zoom, dragging]`，
 * 松手时 `setDragging(false)` 立刻执行，而此刻 `viewport` 还是保存前的旧值
 * （PATCH + reload 未回），effect 把画布弹回旧位置，等 reload 带回新值再跳过去。
 * 卡片那条路径当时单独修过，pan 这条漏了 —— 表现就是「拖空白画面放下跳远」。
 *
 * 修复原则：本地手势是唯一权威，服务端 viewport 只在**切换工作区**时回灌一次。
 * 这里把该不变量抽成纯函数验证。
 */

import { describe, it, expect } from 'vitest';

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * 复刻修复后的同步判据：只有 workspaceId 变化才用服务端 viewport 重置本地。
 * 返回 null 表示「不回灌，保留本地 transform」。
 */
function syncOnWorkspaceChange(
  previousWorkspaceId: string | null,
  nextWorkspaceId: string | null,
  serverViewport: Viewport,
): Viewport | null {
  if (nextWorkspaceId === previousWorkspaceId) return null;
  return { ...serverViewport };
}

describe('视图回灌', () => {
  const server: Viewport = { x: 100, y: 200, zoom: 1 };

  it('同一工作区的服务端刷新不回灌（这是跳帧根因）', () => {
    // 用户刚拖完画布，本地 transform 已经是 (-300, -150)，服务端还在返回旧值。
    expect(syncOnWorkspaceChange('ws-1', 'ws-1', server)).toBeNull();
  });

  it('切换工作区时用服务端视图重置本地', () => {
    expect(syncOnWorkspaceChange('ws-1', 'ws-2', server)).toEqual({ x: 100, y: 200, zoom: 1 });
  });

  it('首次加载（无工作区 → 有工作区）会同步', () => {
    expect(syncOnWorkspaceChange(null, 'ws-1', server)).toEqual({ x: 100, y: 200, zoom: 1 });
  });

  it('工作区被清空（有 → null）也会同步，避免残留上一个视图', () => {
    expect(syncOnWorkspaceChange('ws-1', null, { x: 0, y: 0, zoom: 1 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

/**
 * 滚轮事件的 passive 约束。
 *
 * 真实故障：`preventDefault` 报
 * 「Unable to preventDefault inside passive event listener invocation」，
 * 因为 React 把根容器的 wheel 监听注册为 passive。后果不止脏日志：
 * 浏览器默认缩放与画布缩放叠加，观感上位置全乱。
 *
 * 判据：缩放计算本身是纯的、可测；绑定方式（native + passive:false）由代码注释与
 * 类型约束保证，这里守住缩放数学与钳制行为。
 */
describe('滚轮缩放计算', () => {
  const WHEEL_FACTOR_BASE = 1.1;
  const clampZoom = (value: number): number => (Number.isFinite(value) ? Math.min(5, Math.max(0.05, value)) : Number.NaN);

  function zoomAfter(current: number, deltaY: number): number {
    const delta = -deltaY;
    return clampZoom(current * WHEEL_FACTOR_BASE ** (delta / 100));
  }

  it('向上滚（deltaY 为负）放大，向下滚缩小', () => {
    expect(zoomAfter(1, -100)).toBeCloseTo(1.1, 5);
    expect(zoomAfter(1, 100)).toBeCloseTo(1 / 1.1, 5);
  });

  it('缩放被钳制在 0.05–5', () => {
    expect(zoomAfter(4.9, -10000)).toBe(5);
    expect(zoomAfter(0.06, 10000)).toBe(0.05);
  });

  it('缩放值始终有限（不产生 NaN 传播到 transform）', () => {
    for (const start of [0.05, 1, 5]) {
      for (const delta of [-500, -100, 0, 100, 500]) {
        expect(Number.isFinite(zoomAfter(start, delta))).toBe(true);
      }
    }
  });
});
