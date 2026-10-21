/**
 * S0-1 · 用户写入路径的既有强制校验（enforce）边界。
 *
 * 为什么单开一组：HANDOFF §8.1 的 C 项写的是「S0-1 选第一个 enforce 点」，
 * 而 `schema-guard.ts`（25 条测试）至今零调用方。在接线前必须先回答一个事实问题：
 * **用户真正能写进去的字段，现在到底有没有被拦？**
 *
 * 结论（本文件即证据）：
 *   - 「用户创建节点」这条路径**还不存在**——`CanvasSurface.tsx` 头部注释明写
 *     「未实现复制粘贴（需要八类节点层，当前 CanvasModel 只有会话卡片）」，
 *     `src/server/*` 里没有任何一处在写 `nodes` / `edges`。
 *   - 用户当前唯一的写入入口是 `updateLayout`，它写的是 layout / regions / annotations。
 *     这条路径**已经**经过 `normalizeFrozenState` 的强校验（抛 `InputError`），
 *     也就是「enforce 已经存在」，只是规则在 `shared/schema.ts` 而不在 `schema-guard.ts`。
 *
 * 所以把 `guardWorkspace` 挂到 `updateLayout` 是错的：它校验的是
 * `{nodes, edges, viewport}` 形状，而 updateLayout 的 body 是
 * `{layout:{cards,collapsed,viewport}, regions, annotations}`。硬挂上去会让
 * `validateWorkspace` 的 `requireArray(input.nodes)` 抛错 → **每一次拖卡片保存都被拒**。
 *
 * 这些用例把「哪些能拦、哪些拦不住」钉死，避免接下来再有人误接线。
 */
// @ts-nocheck -- 测试用真实 fs，类型宽松。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceStore } from '@/server/workspace-store';
import { guardWorkspace } from '@/server/schema-guard';

interface Opened {
  dir: string;
  store: any;
}
let opened: Opened[] = [];

let uuidSeq = 0;
function uuid7(): string {
  uuidSeq += 1;
  const tail = uuidSeq.toString(16).padStart(16, '0');
  return `0192f0a0-0001-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18).padEnd(12, '0')}`;
}

function env(overrides: Record<string, unknown> = {}): any {
  return {
    workspaceId: uuid7(),
    baseRevision: 0,
    operationId: uuid7(),
    projectionEpoch: 1,
    action: 'workspace.layout',
    body: {},
    ...overrides,
  };
}

async function makeStore(): Promise<{ store: any }> {
  const dir = await mkdtemp(join(tmpdir(), 'evc-layout-guard-'));
  const store = new WorkspaceStore(join(dir, 'state.json'));
  opened.push({ dir, store });
  await store.ready;
  return { store };
}

async function makeWorkspace(store: any): Promise<{ wsId: string; revision: number }> {
  const wsId = uuid7();
  const ws = await store.create('WS', env({ workspaceId: wsId }));
  return { wsId, revision: ws.revision };
}

beforeEach(() => {
  opened = [];
});

afterEach(async () => {
  for (const item of opened) {
    try {
      await item.store.releaseLock();
    } catch {
      /* 已释放 */
    }
    await rm(item.dir, { recursive: true, force: true });
  }
});

describe('updateLayout 已有强制校验（不是缺口）', () => {
  it('viewport.zoom = 0 被拒（不变量 9 已生效）', async () => {
    const { store } = await makeStore();
    const { wsId, revision } = await makeWorkspace(store);
    await expect(
      store.updateLayout(
        wsId,
        { layout: { viewport: { x: 0, y: 0, zoom: 0 } } },
        env({ workspaceId: wsId, baseRevision: revision }),
      ),
    ).rejects.toThrow(/zoom/i);
  });

  it('viewport.zoom 为负被拒', async () => {
    const { store } = await makeStore();
    const { wsId, revision } = await makeWorkspace(store);
    await expect(
      store.updateLayout(
        wsId,
        { layout: { viewport: { x: 0, y: 0, zoom: -2 } } },
        env({ workspaceId: wsId, baseRevision: revision }),
      ),
    ).rejects.toThrow(/zoom/i);
  });

  it('cards 坐标不是有限数被拒', async () => {
    const { store } = await makeStore();
    const { wsId, revision } = await makeWorkspace(store);
    await expect(
      store.updateLayout(
        wsId,
        { layout: { cards: { 'c:1': { x: 'NaN', y: 0 } } } },
        env({ workspaceId: wsId, baseRevision: revision }),
      ),
    ).rejects.toThrow();
  });

  it('regions 不是数组被拒', async () => {
    const { store } = await makeStore();
    const { wsId, revision } = await makeWorkspace(store);
    await expect(
      store.updateLayout(
        wsId,
        { regions: 'not-an-array' },
        env({ workspaceId: wsId, baseRevision: revision }),
      ),
    ).rejects.toThrow();
  });

  it('被拒的写入不改变内存里的布局（候选态不回灌）', async () => {
    const { store } = await makeStore();
    const { wsId, revision } = await makeWorkspace(store);
    const before = JSON.stringify((await store.get(wsId)).layout.cards);
    await expect(
      store.updateLayout(
        wsId,
        { layout: { viewport: { x: 0, y: 0, zoom: 0 } } },
        env({ workspaceId: wsId, baseRevision: revision }),
      ),
    ).rejects.toThrow();
    const after = JSON.stringify((await store.get(wsId)).layout.cards);
    expect(after).toBe(before);
  });
});

describe('guardWorkspace 与 updateLayout 的形状不匹配（为何不能直接接）', () => {
  it('guardWorkspace 在 updateLayout 的 body 上会报错——它要 nodes/edges', () => {
    // 这是 updateLayout 真实收到的 body 形状。
    const updateLayoutBody = {
      layout: { cards: { 'c:1': { x: 1, y: 2 } }, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      regions: [],
      annotations: [],
    };
    const decision = guardWorkspace(updateLayoutBody, 'user');
    // user 默认 enforce，所以会 ok=false —— 一旦真挂上去，每次保存布局都被拒。
    expect(decision.ok).toBe(false);
    expect(decision.problems.join('\n')).toMatch(/nodes/);
  });

  it('补上 nodes/edges 后同一次调用才放行（说明它校验的是节点层，不是布局层）', () => {
    const nodeLayerBody = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    expect(guardWorkspace(nodeLayerBody, 'user').ok).toBe(true);
  });
});
