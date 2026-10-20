// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceStore, mergeSplitWorkspaces } from '@/server/workspace-store';
import type { MutableWorkspace } from '@/server/workspace-store';

/**
 * S0-7 工作区隔离的边界测试。
 *
 * 这组测试守的是一条边界：**一个会话只属于一个宿主工作区，一个宿主工作区只对应一个画布**。
 * 破了会怎样，逐条写在每个用例里 —— 因为「隔离破了」在界面上不报错，
 * 只会表现为「卡片出现在错的画布上」或「同一个会话出现两次」，肉眼极难归因。
 *
 * 被测函数 `hostWorkspaceOwnership` / `sameDshSessionId` 是模块私有，不做导出改造；
 * 一律通过公开入口 `new WorkspaceStore(...)` + `syncSessions(sessions, removed, hostWorkspaces)`
 * 间接驱动，断言读 `store.state`（公开字段）与 `store.sessionOwnership`（公开字段）。
 * 唯一可直接调用的是已导出的 `mergeSplitWorkspaces`（加载期归并 + 前缀写回）。
 */

interface Opened {
  dir: string;
  store: WorkspaceStore;
}

let opened: Opened[] = [];

afterEach(async () => {
  for (const item of opened) {
    try {
      await item.store.releaseLock();
    } catch {
      /* 锁已释放或从未持有 */
    }
    await rm(item.dir, { recursive: true, force: true });
  }
  opened = [];
});

/**
 * 每个用例独立目录。
 *
 * 锁是真实文件锁（`<dataFile>.lock`），共享目录会让用例互相撞锁 ——
 * 那是设计要防的场景，测试必须隔离而不是放宽断言。
 */
async function makeStore(): Promise<WorkspaceStore> {
  const dir = await mkdtemp(join(tmpdir(), 'evc-isolation-'));
  const store = new WorkspaceStore(join(dir, 'state.json'));
  opened.push({ dir, store });
  // 构造函数内部已 `this.ready = this.load()`；显式再 load 会并发抢同一把锁。
  await store.ready;
  return store;
}

/** 只取 `kind === 'dsh'` 的行：manual 画布不参与宿主工作区归属。 */
function dshRows(store: WorkspaceStore): MutableWorkspace[] {
  return store.state.workspaces.filter((workspace) => workspace.kind === 'dsh');
}

/**
 * 按宿主工作区 id 取唯一那一行，取不到就抛。
 *
 * 用抛错而不是返回 undefined：本组测试的前提就是「这一行必须存在」，
 * 静默返回 undefined 会让后面的断言变成对 undefined 的空断言。
 */
function rowOf(store: WorkspaceStore, hostWorkspaceId: string | null): MutableWorkspace {
  const row = store.state.workspaces.find(
    (workspace) => workspace.kind === 'dsh' && (workspace.dshWorkspaceId ?? null) === hostWorkspaceId,
  );
  if (row === undefined) throw new Error(`未找到 dshWorkspaceId=${String(hostWorkspaceId)} 的 dsh 工作区`);
  return row;
}

/** 一行工作区里的会话 id 序列（用于断言「这个桶里到底装了谁」）。 */
function sessionIdsOf(workspace: MutableWorkspace): (string | null | undefined)[] {
  return workspace.projection.threads.map((thread) => thread.dshSessionId);
}

/** 测试用的合法 UUID（`session-` 前缀规则只认 uuid，不能用 `abc` 之类假 id）。 */
const UUID_A = '0192f0a0-0000-7000-8000-00000000000a';
const UUID_B = '0192f0a0-0000-7000-8000-00000000000b';
const UUID_C = '0192f0a0-0000-7000-8000-00000000000c';
const UUID_D = '0192f0a0-0000-7000-8000-00000000000d';
const UUID_E = '0192f0a0-0000-7000-8000-00000000000e';

describe('宿主工作区归属：同一 cwd 不合并', () => {
  it('两个不同 id 的宿主工作区即使 cwd 完全相同，也保持两个独立画布', async () => {
    // 边界：宿主工作区 id 才是归属权威，cwd 只是显示标签。
    // 破了会怎样：同路径的两个工作区被折叠成一个画布，用户在 A 工作区里
    // 看到 B 工作区的会话卡片，且两边任何一方的删改都会影响另一方。
    const store = await makeStore();
    const cwd = 'C:\\work\\shared';

    await store.syncSessions(
      [
        { id: UUID_A, cwd, title: 'A 的会话' },
        { id: UUID_B, cwd, title: 'B 的会话' },
      ],
      [],
      [
        { id: 'ws-A', title: '工作区 A', sessionIds: [UUID_A] },
        { id: 'ws-B', title: '工作区 B', sessionIds: [UUID_B] },
      ],
    );

    const rows = dshRows(store);
    // 断言实际条数：合流会变成 1，分离必须是 2。
    expect(rows).toHaveLength(2);

    const rowA = rowOf(store, 'ws-A');
    const rowB = rowOf(store, 'ws-B');
    // 两行必须是两个不同的对象（id 不同），而不是同一行被查了两次。
    expect(rowA.id).not.toBe(rowB.id);
    // 两行共享同一个 cwd —— 证明「不合并」不是因为路径不同，而是因为 id 不同。
    expect(rowA.cwd).toBe(cwd);
    expect(rowB.cwd).toBe(cwd);
    // 归属没有串味：各自只装自己的会话。
    expect(sessionIdsOf(rowA)).toEqual([UUID_A]);
    expect(sessionIdsOf(rowB)).toEqual([UUID_B]);
    // 标题来自各自宿主工作区，不是从 cwd 派生（派生会得到同一个 'shared'）。
    expect(rowA.title).toBe('工作区 A');
    expect(rowB.title).toBe('工作区 B');
  });

  it('加载期归并也不得折叠两个绑定到不同宿主 id 的同路径行', async () => {
    // 边界：mergeSplitWorkspaces 只处理「没有宿主 id」的残留行；
    // 两行各自绑定了真实宿主 id，就是两个真实工作区。
    // 破了会怎样：重启一次，两个画布被静默合成一个，用户看到卡片搬家。
    const doc = frozenDoc([
      workspaceRow('row-a', 'ws-A', 'C:\\work\\shared', [threadRow('t-a', UUID_A)]),
      workspaceRow('row-b', 'ws-B', 'C:\\work\\shared', [threadRow('t-b', UUID_B)]),
    ]);

    const changed = mergeSplitWorkspaces(doc);

    // 没有可归并的东西，函数必须报「无变更」并且原样返回两行。
    expect(changed).toBe(false);
    expect((doc.workspaces as unknown[]).length).toBe(2);
    const rows = doc.workspaces as { dshWorkspaceId: string; projection: { threads: { dshSessionId: string }[] } }[];
    expect(rows.map((row) => row.dshWorkspaceId)).toEqual(['ws-A', 'ws-B']);
    expect(rows[0]!.projection.threads.map((thread) => thread.dshSessionId)).toEqual([UUID_A]);
    expect(rows[1]!.projection.threads.map((thread) => thread.dshSessionId)).toEqual([UUID_B]);
  });
});

describe('宿主工作区归属：未归属会话自成一桶', () => {
  it('宿主没有分组的会话落在 dshWorkspaceId=null 的桶里，不进任何已选工作区', async () => {
    // 边界：归属来自宿主显式声明（workspace.sessionIds），不是从 cwd 推断。
    // 破了会怎样：用户打开工作区 A，里面凭空多出一个他从未放进来的会话，
    // 而且这个会话在 A 里被删掉时会被写进 hiddenSessionIds，从别处也一起消失。
    const store = await makeStore();
    const cwd = 'C:\\work\\shared';

    await store.syncSessions(
      [
        { id: UUID_A, cwd, title: '有归属的会话' },
        { id: UUID_B, cwd, title: '没有归属的会话' },
      ],
      [],
      [{ id: 'ws-A', title: '工作区 A', sessionIds: [UUID_A] }],
    );

    const rowA = rowOf(store, 'ws-A');
    // 已选工作区里只能有它自己的那一个会话。
    expect(sessionIdsOf(rowA)).toEqual([UUID_A]);

    const ungrouped = dshRows(store).filter((workspace) => (workspace.dshWorkspaceId ?? null) === null);
    // 未归属会话必须单独成桶，而且只有一个桶（不能被拆成多行）。
    expect(ungrouped).toHaveLength(1);
    expect(sessionIdsOf(ungrouped[0]!)).toEqual([UUID_B]);
    // 桶的标题由 cwd 末段派生（'shared'），不是 '工作区 A' —— 证明它没被 A 领走。
    expect(ungrouped[0]!.title).toBe('shared');
    expect(ungrouped[0]!.title).not.toBe('工作区 A');
  });

  /**
   * 已知缺陷（S0-7 边界真的破了，实现未改，此处用 `it.fails` 固定）。
   *
   * 根因：`dshWorkspace(hostWorkspaceId, ...)` 在「有宿主 id 但找不到绑定行」时会退到
   * `byCwd`，把 `dshWorkspaceId == null && cwd 相同` 的行**就地改绑**成这个宿主 id。
   * 这个 adoption 是给「旧版本按 cwd 匹配留下的残留行」设计的，但它无法区分
   * 「历史残留」与「本批次里仍然没有归属的会话」。
   *
   * 于是只要同一 cwd 下**未归属会话先于已归属会话**被处理，未归属会话所在的桶
   * 就会被整个送给随后出现的宿主工作区。上面那条用例之所以通过，只是因为它把
   * 已归属会话排在了前面 —— 归属结果依赖目录顺序，本身就是缺陷的一部分。
   *
   * 影响：未归属会话泄漏进已选工作区；用户在工作区 A 里看到不属于它的卡片；
   * 该卡片在 A 里被删除时会写进 `hiddenSessionIds`，从「未分组」里也一起消失。
   *
   * 修好之后这条会变成 unexpected pass（vitest 会报红），那正是提醒：
   * 把 `it.fails` 改回 `it`。不要为了让套件变绿而删除本用例。
   */
  it.fails('未归属会话排在已归属会话之前时，仍不得被同 cwd 的宿主工作区领走', async () => {
    // 边界：同一批目录里，处理顺序不能改变归属结果。
    // 破了会怎样：顺序依赖的越界 —— 宿主先列未分组会话、后列工作区时，
    // 未归属会话会被「按 cwd 领养」逻辑绑进后续宿主工作区，用户看到别人的会话出现在自己的画布里。
    // 注意：这不是「历史残留行 adoption」的合法场景，那一行是同一批刚建的。
    const store = await makeStore();
    const cwd = 'C:\\work\\shared';

    await store.syncSessions(
      [
        // 顺序故意反过来：未归属的在前。
        { id: UUID_B, cwd, title: '没有归属的会话' },
        { id: UUID_A, cwd, title: '有归属的会话' },
      ],
      [],
      [{ id: 'ws-A', title: '工作区 A', sessionIds: [UUID_A] }],
    );

    const rowA = rowOf(store, 'ws-A');
    // 已选工作区里只能有 UUID_A；若出现 UUID_B 就是越界。
    expect(sessionIdsOf(rowA)).toEqual([UUID_A]);

    const ungrouped = dshRows(store).filter((workspace) => (workspace.dshWorkspaceId ?? null) === null);
    expect(ungrouped).toHaveLength(1);
    expect(sessionIdsOf(ungrouped[0]!)).toEqual([UUID_B]);
  });

  /**
   * 已知缺陷的第二面（同一根因，单独一条用例是因为它跨了两次目录刷新，
   * 触发条件比上面更宽：**不需要同批次内的顺序巧合**）。
   *
   * 场景：第一轮宿主只报会话、还没报工作区 → 未归属会话落在 `dshWorkspaceId=null`
   * 的桶里。第二轮宿主报出工作区 A（同 cwd），而那个未归属会话仍然没有归属。
   * 实测结果：A 的行把整个未归属桶**吞掉**，`ws-A` 下同时出现 UUID_B 与 UUID_A。
   *
   * 这在真实使用中就是「先开会话、后建工作区」的常规顺序，不是极端构造。
   * 修好后同样要改回 `it`。
   */
  it.fails('跨轮刷新时，先落地的未归属桶也不得被后续同 cwd 的宿主工作区吞并', async () => {
    const store = await makeStore();
    const cwd = 'C:\\work\\cross';

    // 第一轮：只有会话，没有工作区声明 → 全部未归属。
    await store.syncSessions([{ id: UUID_B, cwd, title: '没有归属的会话' }], [], []);
    const before = dshRows(store);
    expect(before).toHaveLength(1);
    expect(before[0]!.dshWorkspaceId ?? null).toBeNull();

    // 第二轮：宿主报出工作区 A，UUID_B 依旧没有被任何工作区声明。
    await store.syncSessions(
      [
        { id: UUID_B, cwd, title: '没有归属的会话' },
        { id: UUID_A, cwd, title: '有归属的会话' },
      ],
      [],
      [{ id: 'ws-A', title: '工作区 A', sessionIds: [UUID_A] }],
    );

    const rowA = rowOf(store, 'ws-A');
    // 正确行为：A 里只有 UUID_A，UUID_B 留在未归属桶里。
    expect(sessionIdsOf(rowA)).toEqual([UUID_A]);
    const ungrouped = dshRows(store).filter((workspace) => (workspace.dshWorkspaceId ?? null) === null);
    expect(ungrouped).toHaveLength(1);
    expect(sessionIdsOf(ungrouped[0]!)).toEqual([UUID_B]);
  });
});

describe('宿主工作区归属：重复 session id 不转移归属', () => {
  it('两个工作区声明同一个会话时，先声明者赢，后声明者拿不到', async () => {
    // 边界：归属表 first-wins。宿主可能因为竞态把同一个会话同时列进两个工作区。
    // 破了会怎样：后声明的条目覆盖前者，会话在两次目录刷新之间来回跳工作区，
    // 画布上表现为卡片在两个工作区之间闪动、布局坐标丢失。
    const store = await makeStore();
    const cwd = 'C:\\work\\dup';

    await store.syncSessions(
      [{ id: UUID_C, cwd, title: '被重复声明的会话' }],
      [],
      [
        { id: 'ws-first', title: '先声明', sessionIds: [UUID_C] },
        { id: 'ws-second', title: '后声明', sessionIds: [UUID_C] },
      ],
    );

    // 归属表里只能记先声明的那一个。
    expect(store.sessionOwnership.get(UUID_C)?.id).toBe('ws-first');
    expect(store.sessionOwnership.get(UUID_C)?.title).toBe('先声明');

    // 后声明的工作区不该被创建出来 —— 它一个会话都没拿到。
    const rows = dshRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dshWorkspaceId).toBe('ws-first');
    expect(rows[0]!.title).toBe('先声明');
    expect(sessionIdsOf(rows[0]!)).toEqual([UUID_C]);
  });
});

describe('会话 id 归一化：session- 前缀', () => {
  it('session-<uuid> 与 <uuid> 是同一会话，第二次投影不新增 thread', async () => {
    // 边界：宿主历史上把 id 报成 `session-<uuid>`，现在报裸 `<uuid>`。
    // 破了会怎样：同一个会话被投影成两条 thread，消息被切成两半，
    // 用户在画布上看到两张卡，删掉一张另一张还在（这正是旧版 0.2.2 的真实缺陷）。
    const store = await makeStore();
    const cwd = 'C:\\work\\prefix';

    // 第一轮：旧形式带前缀。
    await store.syncSessions(
      [{ id: `session-${UUID_D}`, cwd, title: '同一会话' }],
      [],
      [{ id: 'ws-1', title: '工作区 1', sessionIds: [`session-${UUID_D}`] }],
    );
    expect(sessionIdsOf(rowOf(store, 'ws-1'))).toEqual([`session-${UUID_D}`]);

    // 第二轮：宿主升级后报裸 uuid。必须命中已有 thread，而不是新建。
    await store.syncSessions(
      [{ id: UUID_D, cwd, title: '同一会话' }],
      [],
      [{ id: 'ws-1', title: '工作区 1', sessionIds: [UUID_D] }],
    );

    const row = rowOf(store, 'ws-1');
    // 关键断言：仍然只有一条 thread。
    expect(row.projection.threads).toHaveLength(1);
    // 磁盘上的 id 保持原样（命中路径不改写 id），但比较期必须认作同一会话。
    expect(row.projection.threads[0]!.dshSessionId).toBe(`session-${UUID_D}`);
  });

  it('加载期把 session-<uuid> 写回裸 <uuid>，消除后续直接比对的隐患', async () => {
    // 边界：比较期归一化只保护「记得用 sameDshSessionId 的地方」，
    // 任何新增的直接 === 比对都会把同一会话判成两个。
    // 破了会怎样：新增一处直接比对就复发重复投影，且很难在测试里发现。
    const doc = frozenDoc([workspaceRow('row-1', 'ws-1', 'C:\\work\\p', [threadRow('t-1', `session-${UUID_D}`)])]);

    const changed = mergeSplitWorkspaces(doc);

    // 写回本身是变更，必须报 true（否则 load 会因「无变更」丢弃改写）。
    expect(changed).toBe(true);
    const rows = doc.workspaces as { projection: { threads: { dshSessionId: string }[] } }[];
    expect(rows[0]!.projection.threads[0]!.dshSessionId).toBe(UUID_D);
  });

  it('非 uuid 的 session-1 不被误剥（前缀规则必须连 uuid 一起校验）', async () => {
    // 边界：只剥 `session-` 前缀会把 `session-1` 变成 `1`、`session-foo` 变成 `foo`，
    // 从而把两个本来不同的会话判成同一个。
    // 破了会怎样：不同会话被合并，消息串台。
    const doc = frozenDoc([workspaceRow('row-1', 'ws-1', 'C:\\work\\p', [threadRow('t-1', 'session-1')])]);

    const changed = mergeSplitWorkspaces(doc);

    expect(changed).toBe(false);
    const rows = doc.workspaces as { projection: { threads: { dshSessionId: string }[] } }[];
    expect(rows[0]!.projection.threads[0]!.dshSessionId).toBe('session-1');
  });

  it('同一工作区内前缀形式与裸形式并存时整行回退，绝不制造重复 thread', async () => {
    // 边界：写回前的撞车保护。归一化后若同 workspace 内出现重复 id，
    // 宁可留着前缀（比较期仍能正确归一化），也不能写回成两条一模一样的 id。
    // 破了会怎样：两条 thread 的 dshSessionId 完全相同，后续按 id 查找只会命中第一条，
    // 第二条成为永远更新不到、也删不干净的僵尸。
    const doc = frozenDoc([
      workspaceRow('row-1', 'ws-1', 'C:\\work\\p', [
        threadRow('t-prefixed', `session-${UUID_E}`),
        threadRow('t-bare', UUID_E),
      ]),
    ]);

    const changed = mergeSplitWorkspaces(doc);

    // 撞车 → 整行回退 → 不产生任何改写，因此无变更。
    expect(changed).toBe(false);
    const rows = doc.workspaces as { projection: { threads: { dshSessionId: string }[] } }[];
    expect(rows[0]!.projection.threads.map((thread) => thread.dshSessionId)).toEqual([`session-${UUID_E}`, UUID_E]);
  });
});

describe('会话 id 归一化：不同 uuid 永不相等', () => {
  it('两个不同 uuid 各自投影成一条 thread，不被归一化判成同一个', async () => {
    // 边界：归一化只能消除格式差异，不能模糊匹配。
    // 破了会怎样：两个不同会话被折叠成一条 thread，第二个会话的消息全丢。
    const store = await makeStore();
    const cwd = 'C:\\work\\distinct';

    await store.syncSessions(
      [
        { id: UUID_A, cwd, title: '会话 A' },
        { id: UUID_B, cwd, title: '会话 B' },
      ],
      [],
      [{ id: 'ws-1', title: '工作区 1', sessionIds: [UUID_A, UUID_B] }],
    );

    const row = rowOf(store, 'ws-1');
    expect(row.projection.threads).toHaveLength(2);
    expect(sessionIdsOf(row)).toEqual([UUID_A, UUID_B]);
  });

  it('仅前缀相同、uuid 不同的两个 id 不得判等', async () => {
    // 边界：剥前缀之后必须逐字比较 uuid。
    // 破了会怎样：`session-<A>` 与 `session-<B>` 被当成同一个会话。
    const store = await makeStore();
    const cwd = 'C:\\work\\distinct2';

    await store.syncSessions(
      [
        { id: `session-${UUID_A}`, cwd, title: '会话 A' },
        { id: `session-${UUID_B}`, cwd, title: '会话 B' },
      ],
      [],
      [{ id: 'ws-1', title: '工作区 1', sessionIds: [`session-${UUID_A}`, `session-${UUID_B}`] }],
    );

    const row = rowOf(store, 'ws-1');
    expect(row.projection.threads).toHaveLength(2);
    expect(sessionIdsOf(row)).toEqual([`session-${UUID_A}`, `session-${UUID_B}`]);
  });
});

describe('空 / 畸形 id：跳过而不是造幽灵', () => {
  it('空字符串与非字符串 id 被跳过，不崩溃、不产生幽灵工作区', async () => {
    // 边界：宿主目录里可能出现空 id、null、数字、非数组的 sessionIds。
    // 破了会怎样：产生一个 id 为空或为 `undefined` 的工作区 —— 界面上打不开、
    // 也删不掉，且每刷新一次就多一个，最终把用户真正的画布挤出列表。
    const store = await makeStore();
    const cwd = 'C:\\work\\junk';

    await expect(
      store.syncSessions(
        [
          { id: '', cwd },
          { id: 123, cwd },
          { id: null, cwd },
          { id: UUID_A, cwd, title: '唯一合法会话' },
          null,
          'not-a-session',
        ],
        [],
        [
          // 空 id 的工作区整行跳过（连它的 sessionIds 也不参与归属）。
          { id: '', sessionIds: [UUID_A] },
          { id: null, sessionIds: [UUID_A] },
          // 合法 id，但 sessionIds 里混着各种垃圾；重复项只记第一次。
          { id: 'ws-ok', title: '有效工作区', sessionIds: ['', null, 42, {}, [], UUID_A, UUID_A] },
          null,
          { id: 'ws-broken', sessionIds: 'not-an-array' },
          { id: 'ws-null-list', sessionIds: null },
        ],
      ),
    ).resolves.toHaveLength(1);

    // 归属表里只能有那一个合法会话。
    expect([...store.sessionOwnership.keys()]).toEqual([UUID_A]);
    expect(store.sessionOwnership.get(UUID_A)?.id).toBe('ws-ok');

    // 只有一行 dsh 工作区，且 id 不是空串 / undefined。
    const rows = dshRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dshWorkspaceId).toBe('ws-ok');
    expect(rows[0]!.id).not.toBe('');
    expect(typeof rows[0]!.id).toBe('string');
    expect(sessionIdsOf(rows[0]!)).toEqual([UUID_A]);
  });

  it('workspaces 不是数组时返回空结果而不是抛错，也不留下半截状态', async () => {
    // 边界：加载期归并拿到的可能是坏数据（手改过的文件、截断的写入）。
    // 破了会怎样：一个坏字段让整次加载抛错，用户的所有画布都打不开。
    expect(mergeSplitWorkspaces({ workspaces: 'not-an-array' })).toBe(false);
    expect(mergeSplitWorkspaces(null)).toBe(false);
    expect(mergeSplitWorkspaces({})).toBe(false);
  });
});

describe('加载期归并：只收残留行，不动绑定行', () => {
  it('同 cwd 的无归属残留行并入已绑定行，被并走的那行从文档里移除', async () => {
    // 边界：归并的对象只能是「没有宿主 id」的残留行（旧版本按 cwd 匹配留下的）。
    // 破了会怎样：如果连绑定行也参与归并，两个真实工作区会被折叠；
    // 如果残留行不归并，用户会看到两个同名画布，其中一个永远是空的。
    const doc = frozenDoc([
      workspaceRow('row-bound', 'ws-1', 'C:\\work\\m', [threadRow('t-bound', UUID_A, 2)]),
      workspaceRow('row-leftover', null, 'C:\\work\\m', [threadRow('t-leftover', UUID_B, 0)]),
    ]);

    const changed = mergeSplitWorkspaces(doc);

    expect(changed).toBe(true);
    const rows = doc.workspaces as {
      id: string;
      dshWorkspaceId: string | null;
      projection: { threads: { dshSessionId: string }[] };
    }[];
    // 只剩绑定行，且它现在同时装了两个会话。
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('row-bound');
    expect(rows[0]!.dshWorkspaceId).toBe('ws-1');
    expect(rows[0]!.projection.threads.map((thread) => thread.dshSessionId)).toEqual([UUID_A, UUID_B]);
  });

  it('两个无归属行同 cwd 时合并成一行，不留两个同名空画布', async () => {
    // 边界：残留行之间也要收，否则旧数据会一直带着两个「shared」画布。
    // 破了会怎样：用户看到两个同名画布，其中一个点开是空的，另一个才有卡片。
    const doc = frozenDoc([
      workspaceRow('row-1', null, 'C:\\work\\m2', [threadRow('t-1', UUID_A, 0)]),
      workspaceRow('row-2', null, 'C:\\work\\m2', [threadRow('t-2', UUID_B, 3)]),
    ]);

    const changed = mergeSplitWorkspaces(doc);

    expect(changed).toBe(true);
    const rows = doc.workspaces as { id: string; projection: { threads: { dshSessionId: string }[] } }[];
    expect(rows).toHaveLength(1);
    // 更重的那行当靶子（row-2 有 3 条消息），两边的会话都保住。
    expect(rows[0]!.id).toBe('row-2');
    expect(rows[0]!.projection.threads.map((thread) => thread.dshSessionId)).toEqual([UUID_B, UUID_A]);
  });
});

// ---------------------------------------------------------------------------
// 夹具：mergeSplitWorkspaces 只读这几个字段，不需要造完整合法文档。
// 之所以仍然写全 envelope 字段，是为了让夹具与真实磁盘形状一致 ——
// 只喂最小字段的夹具会在实现新增读取点时静默失效。
// ---------------------------------------------------------------------------

function frozenDoc(workspaces: unknown[]): Record<string, unknown> {
  return {
    format: 'dsh-evcanvas',
    schemaVersion: 1,
    updatedAt: '2026-10-21T00:00:00.000Z',
    hiddenSessionIds: [],
    idempotency: {},
    idempotencyFloor: null,
    workspaces,
  };
}

function workspaceRow(
  id: string,
  dshWorkspaceId: string | null,
  cwd: string | null,
  threads: unknown[],
): Record<string, unknown> {
  return {
    id,
    kind: 'dsh',
    dshWorkspaceId,
    cwd,
    title: id,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    revision: 1,
    projectionEpoch: 1,
    projection: { threads },
    layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    materials: [],
    regions: [],
    annotations: [],
  };
}

function threadRow(id: string, dshSessionId: string | null, messageCount = 0): Record<string, unknown> {
  const messages = Array.from({ length: messageCount }, (_unused, index) => ({
    id: `${id}-m${index}`,
    text: `消息 ${index}`,
    kind: 'user',
    at: '2026-10-21T00:00:00.000Z',
  }));
  return {
    id,
    title: id,
    parentId: null,
    dshSessionId,
    messages,
    pendingProcess: [],
    coverage: { ranges: [], historyComplete: false, textTruncated: false },
  };
}
