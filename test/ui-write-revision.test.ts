/**
 * 写入队列必须自己推进 revision（UI-D7 回归）。
 *
 * ## 故障
 *
 * 用户控制台刷屏 `PATCH .../layout 409 (Conflict)`，并伴随「动一下就刷新」
 * 「框选拖拽后卡片丢了」。它们是一个根因的三种表现。
 *
 * ## 曾经的（错误）假设
 *
 * 旧代码注释写着：「`await canvas.reload()` 之后 `modelRef.current` 就是新
 * revision」。**这不成立**：`reload()` 只 `setState`，React 重渲染排在下一个
 * 任务；而写入队列里的下一个 `run()` 在同一个微任务链上立即执行。它读到的
 * 仍是旧模型，于是带着过期 revision 发出去，被服务端乐观锁拒绝。
 *
 * ## 修法
 *
 * 不信 React 状态，直接信服务端返回值：`PATCH` 响应带 `revision`，
 * 队列把它记进 ref 供下一次使用。ref 是同步的，不受渲染时机影响。
 *
 * 本文件用纯逻辑复刻这条规则，锁定三条不变量：
 *   1. 写入成功后 revision **前进**
 *   2. 写入失败后缓存**失效**（回落到模型值，而不是继续用一个没被确认的号）
 *   3. 跨工作区的缓存**永不复用**
 */

import { describe, it, expect } from 'vitest';

interface RevisionCache {
  revision: number | null;
  workspaceId: string | null;
}

/**
 * 与 App.tsx 中 `submitPatches` 内的取值规则逐字一致。
 * `modelRevision` 对应 `modelRef.current.revision`。
 */
function resolveRevision(
  cache: RevisionCache,
  workspaceId: string,
  modelRevision: number | null,
): number | null {
  const queued = cache.workspaceId === workspaceId ? cache.revision : null;
  return queued ?? modelRevision;
}

/** 写入成功后的缓存更新（对应 `written.revision` 存在 / 缺失两个分支）。 */
function afterSuccess(cache: RevisionCache, workspaceId: string, written: number | null | undefined): void {
  if (typeof written === 'number') {
    cache.revision = written;
    cache.workspaceId = workspaceId;
  } else {
    cache.revision = null;
    cache.workspaceId = null;
  }
}

/** 写入失败后的缓存更新。 */
function afterFailure(cache: RevisionCache): void {
  cache.revision = null;
  cache.workspaceId = null;
}

const empty = (): RevisionCache => ({ revision: null, workspaceId: null });

describe('revision 取值优先级', () => {
  it('队列缓存优先于模型（这是修复的核心）', () => {
    const cache: RevisionCache = { revision: 5, workspaceId: 'ws-1' };
    // 模型还停在旧值 4（reload 尚未触发重渲染）
    expect(resolveRevision(cache, 'ws-1', 4)).toBe(5);
  });

  it('缓存为空时回落到模型', () => {
    expect(resolveRevision(empty(), 'ws-1', 7)).toBe(7);
  });

  it('缓存属于别的工作区时一律不复用', () => {
    const cache: RevisionCache = { revision: 99, workspaceId: 'ws-OTHER' };
    expect(resolveRevision(cache, 'ws-1', 7)).toBe(7);
  });

  it('模型也没有时返回 null（调用方据此拒绝写入并提示）', () => {
    expect(resolveRevision(empty(), 'ws-1', null)).toBeNull();
  });
});

describe('写入成功后的推进', () => {
  it('服务端回了 revision 就记住它', () => {
    const cache = empty();
    afterSuccess(cache, 'ws-1', 8);
    expect(cache.revision).toBe(8);
    expect(cache.workspaceId).toBe('ws-1');
  });

  it('服务端没回 revision 时清空缓存，不用猜的值', () => {
    const cache: RevisionCache = { revision: 5, workspaceId: 'ws-1' };
    afterSuccess(cache, 'ws-1', undefined);
    expect(cache.revision).toBeNull();
    expect(cache.workspaceId).toBeNull();
  });

  it('服务端回 null 时同样清空', () => {
    const cache: RevisionCache = { revision: 5, workspaceId: 'ws-1' };
    afterSuccess(cache, 'ws-1', null);
    expect(cache.revision).toBeNull();
  });

  it('连续两次写入各拿到自己的新号', () => {
    const cache = empty();
    afterSuccess(cache, 'ws-1', 3);
    expect(resolveRevision(cache, 'ws-1', 2)).toBe(3);
    afterSuccess(cache, 'ws-1', 4);
    expect(resolveRevision(cache, 'ws-1', 2)).toBe(4);
  });
});

describe('写入失败后的失效', () => {
  it('失败会清空缓存，下一次回落到模型', () => {
    const cache: RevisionCache = { revision: 5, workspaceId: 'ws-1' };
    afterFailure(cache);
    expect(resolveRevision(cache, 'ws-1', 2)).toBe(2);
  });

  it('失败后不会一直用一个「服务端从未确认」的号去撞 409', () => {
    // 这是失败路径最关键的性质：宁可回落到一个真实存在过的版本，
    // 也不要反复提交一个凭空的号。
    const cache = empty();
    afterSuccess(cache, 'ws-1', 10);
    afterFailure(cache);
    expect(cache.revision).toBeNull();
  });
});

describe('旧实现的缺陷形态（保留断言以防回退）', () => {
  it('只读模型的旧做法在「reload 未重渲染」时会拿到旧号', () => {
    // 复刻旧逻辑：直接返回 modelRevision，不看缓存。
    const oldResolve = (modelRevision: number | null) => modelRevision;
    const cache: RevisionCache = { revision: 5, workspaceId: 'ws-1' };
    // 新逻辑给 5，旧逻辑给 4 —— 差的就是那一次 409。
    expect(resolveRevision(cache, 'ws-1', 4)).toBe(5);
    expect(oldResolve(4)).toBe(4);
    expect(resolveRevision(cache, 'ws-1', 4)).not.toBe(oldResolve(4));
  });
});
