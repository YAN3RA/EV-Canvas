/**
 * 写入串行化：同一时刻只允许一次 PATCH 在途。
 *
 * 故障背景：每次写入都用当前 `revision` 做乐观锁。若上一次还在途就发下一次，
 * 两次带同一个 revision，第二次必 409。单选拖拽之间通常有间隔，撞上的概率低；
 * 框选后连续拖拽会把这个窗口放大，表现成「多选拖拽松手后位置乱跳再回弹」。
 *
 * 这里测的是**队列语义**本身，不依赖 React 或真实网络。
 */

import { describe, it, expect } from 'vitest';

/** 复刻 `submitPatches` 的队列：接在队尾，失败不阻塞后续。 */
function createWriter<T>(run: (task: T) => Promise<void>) {
  let chain: Promise<void> = Promise.resolve();
  const order: T[] = [];
  const push = async (task: T): Promise<void> => {
    const start = async (): Promise<void> => {
      order.push(task);
      await run(task);
    };
    chain = chain.then(start, start);
    await chain;
  };
  return { push, order, settled: () => chain };
}

describe('写入串行化', () => {
  it('连续提交按顺序执行，不并发', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const writer = createWriter<string>(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    await Promise.all([writer.push('a'), writer.push('b'), writer.push('c')]);
    // 关键：任何时刻只有 1 个在途 —— 并发会让 maxInFlight > 1，进而产生 409。
    expect(maxInFlight).toBe(1);
    expect(writer.order).toEqual(['a', 'b', 'c']);
  });

  it('前一次失败不阻塞后续（失败也要继续排队）', async () => {
    const done: string[] = [];
    const writer = createWriter<string>(async task => {
      if (task === 'boom') throw new Error('模拟保存失败');
      done.push(task);
    });

    await writer.push('first');
    // 失败的调用会 reject 到调用方；这里显式吞掉，验证后续仍能执行。
    await writer.push('boom').catch(() => undefined);
    await writer.push('after');

    expect(done).toEqual(['first', 'after']);
  });

  it('后续提交能拿到更新后的 revision（串行化的目的）', async () => {
    // 用一个可变 revision 模拟 reload 后拿到新值。
    const state = { revision: 10 };
    const seen: number[] = [];
    const writer = createWriter<void>(async () => {
      // 读取时刻的 revision 才是这次请求带的版本
      seen.push(state.revision);
      await new Promise(resolve => setTimeout(resolve, 3));
      // 服务端接受后 revision +1，reload 把它同步回来
      state.revision += 1;
    });

    await Promise.all([writer.push(), writer.push(), writer.push()]);
    // 若并发，三次都会读到 10 → 后两次 409；串行则依次 10 / 11 / 12。
    expect(seen).toEqual([10, 11, 12]);
  });
});
