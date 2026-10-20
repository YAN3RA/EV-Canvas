/**
 * S0-7 修复的**正面担保**：`byCwd` 收编（adoption）不能因此失效。
 *
 * 为什么单独一个套件：`allowCwdAdoption` 把默认行为改成了「不猜」，这解决了
 * 未归属会话被吞并的泄漏，但也带来相反的风险 —— **旧版本遗留行再也不会被
 * 认领**，用户升级后看到画布突然多出一堆「未分组」。那是比原缺陷更难解释的
 * 症状，因为它会出现在所有老用户身上。
 *
 * 所以这里守两条底线：
 *   1. 本批次该 cwd **没有**任何宿主工作区时，历史残留行必须照旧被按 cwd 归并；
 *   2. 本批次该 cwd **有**宿主工作区、但那个残留行确实属于它（同 cwd 且原本
 *      就没有绑定）时，仍然允许收编 —— 否则老数据会永久失联。
 *
 * 第 2 条是这次修复最微妙的地方：必须区分「残留」与「本批次未归属」。
 * 判据是本批次全貌（`boundCwd`），不是行本身的形状。
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '@/server/workspace-store';

const opened: { dir: string; store: WorkspaceStore }[] = [];

afterAll(async () => {
  for (const item of opened) {
    await item.store.flush().catch(() => undefined);
    await rm(item.dir, { recursive: true, force: true });
  }
});

async function makeStore(): Promise<WorkspaceStore> {
  const dir = await mkdtemp(join(tmpdir(), 'evc-adoption-'));
  const store = new WorkspaceStore(join(dir, 'state.json'));
  opened.push({ dir, store });
  await store.ready;
  return store;
}

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function rows(store: WorkspaceStore) {
  return store.state.workspaces.filter(workspace => workspace.kind === 'dsh');
}

describe('byCwd 收编仍在工作', () => {
  it('宿主完全不报工作区时，同一 cwd 的会话归入同一个「未分组」桶', async () => {
    // 这条守的是老路径：`hostWorkspaceId === null` 时仍按 cwd 归并，
    // 否则没有工作区概念的宿主会把每个会话都变成一张独立画布。
    const store = await makeStore();
    const cwd = 'C:\\work\\nogroups';
    await store.syncSessions(
      [
        { id: UUID_A, cwd, title: '会话 A' },
        { id: UUID_B, cwd, title: '会话 B' },
      ],
      [],
      [],
    );
    const dsh = rows(store);
    expect(dsh).toHaveLength(1);
    expect(dsh[0]!.dshWorkspaceId ?? null).toBeNull();
    expect(dsh[0]!.projection.threads).toHaveLength(2);
  });

  it('历史残留行（无绑定、同 cwd）在本批次有宿主工作区时仍被收编', async () => {
    // 模拟升级：旧版本写下的行 `dshWorkspaceId = null`，本轮宿主才第一次
    // 报出工作区 A。若不允许收编，用户会看到「未分组」和「工作区 A」两份，
    // 画布内容凭空分裂。
    const store = await makeStore();
    const cwd = 'C:\\work\\legacy';

    // 第一轮：老版本行为，只有会话没工作区 → 留下未绑定行。
    await store.syncSessions([{ id: UUID_A, cwd, title: '老会话' }], [], []);
    const legacy = rows(store);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.dshWorkspaceId ?? null).toBeNull();

    // 第二轮：宿主报出工作区 A，并明确把这个会话划给 A。
    // 该 cwd 在本批次里**有**绑定，且这个会话自己就属于 A —— 收编是对的，
    // 因为命中的残留行正是它为这个会话留下的。
    await store.syncSessions(
      [{ id: UUID_A, cwd, title: '老会话' }],
      [],
      [{ id: 'ws-A', title: '工作区 A', sessionIds: [UUID_A] }],
    );

    const after = rows(store);
    // 关键断言：不能变成两行。残留行被收编后应当只剩 A 这一行。
    expect(after).toHaveLength(1);
    expect(after[0]!.dshWorkspaceId).toBe('ws-A');
    expect(after[0]!.projection.threads.map(thread => thread.dshSessionId)).toContain(UUID_A);
  });

  it('未归属会话与已归属会话同 cwd 时，收编只发生在该会话自己的归属上', async () => {
    // 混合场景：A 有归属、B 没有，二者同 cwd。修复后必须是两行，
    // 且 B 不在 A 里。这条与 workspace-isolation 的泄漏用例互补：
    // 那边断言「不许吞」，这边断言「该收的仍然收了」。
    const store = await makeStore();
    const cwd = 'C:\\work\\mixed';
    await store.syncSessions(
      [
        { id: UUID_A, cwd, title: '有归属' },
        { id: UUID_B, cwd, title: '没归属' },
      ],
      [],
      [{ id: 'ws-A', title: '工作区 A', sessionIds: [UUID_A] }],
    );

    const dsh = rows(store);
    expect(dsh).toHaveLength(2);
    const bound = dsh.find(row => row.dshWorkspaceId === 'ws-A');
    const unbound = dsh.find(row => (row.dshWorkspaceId ?? null) === null);
    expect(bound).toBeDefined();
    expect(unbound).toBeDefined();
    // B 绝不能出现在 A 里 —— 这就是原缺陷的直接表现。
    expect(bound!.projection.threads.map(thread => thread.dshSessionId)).not.toContain(UUID_B);
    expect(unbound!.projection.threads.map(thread => thread.dshSessionId)).toContain(UUID_B);
  });
});
