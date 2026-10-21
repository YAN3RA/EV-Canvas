/**
 * 剔除目录已不存在的 `dsh` 工作区（UI-D12）。
 *
 * ## 为什么必须有这个功能
 *
 * 用户顶栏里挂着 4 个早已删掉的目录（`aik_auto_memory_use` / `ds-opt` /
 * `dsh适配` / `dsh-synapnova`）。画布把它们当真实工作区展示，点进去是空的。
 *
 * ## 为什么手改数据文件没用（已实测）
 *
 * 2026-10-21 直接把 `workspaces.json` 从 7 行删到 3 行，重启后**又变回 7 行**：
 * store 在内存里持有整份文档，下一次保存原样写回。所以剔除必须是 store 的一条
 * 写路径，并在宿主刷新目录后重新执行。
 *
 * ## 判据为什么是「目录不存在」而不是「没有会话」
 *
 * 工作区 = 一个宿主目录。目录没了 ⇒ 该行永远不可能再有新会话，是死行。
 * 而「没有会话」是正常状态（新建的空工作区），不能据此删。
 *
 * ## 测试为什么要走 `applyDirectory`
 *
 * `create()` 硬编码 `kind:'manual', cwd:null`，造不出 `dsh` 行。
 * 真实的 `dsh` 行只由目录投影产生，所以夹具必须走同一条路。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { WorkspaceStore } from '@/server/workspace-store';

interface Opened {
  dir: string;
  store: any;
}
let opened: Opened[] = [];

/** 合法 UUIDv7：第三段以 7 开头、第四段以 8 开头（服务端会严格校验）。 */
let uuidSeq = 0;
function uuid7(): string {
  uuidSeq += 1;
  const n = String(uuidSeq).padStart(12, '0');
  return '0192f0b0-0003-7000-8000-' + n;
}

async function makeStore(): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), 'evc-prune-'));
  const store = new WorkspaceStore(join(dir, 'state.json')) as any;
  opened.push({ dir, store });
  await store.ready;
  return store;
}

/** 一个最小可用的宿主会话条目（字段与 listSessionLogs 产物对齐）。 */
function session(id: string, cwd: string, title = id) {
  return { id, cwd, title, parentId: null, blank: false };
}

/** 一个宿主工作区条目。 */
function hostWorkspace(id: string, path: string) {
  return { id, title: path, path };
}

/** 用目录投影造出真实的 dsh 工作区行。 */
async function projectDirectory(store: any, sessions: ReturnType<typeof session>[]) {
  const paths = [...new Set(sessions.map(item => item.cwd))];
  const hosts = paths.map((path, index) => hostWorkspace('host-' + String(index), path));
  await store.applyDirectory(sessions, [], hosts, true);
  return (await store.list()) as { title?: string }[];
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

describe('剔除失效目录', () => {
  it('目录不存在的 dsh 行被移除，存在的保留', async () => {
    const store = await makeStore();
    const alive = 'C:\\work\\alive';
    const gone = 'C:\\work\\gone';

    const before = await projectDirectory(store, [
      session('s1', alive, '活着'),
      session('s2', gone, '死掉'),
    ]);
    expect(before.length).toBe(2);

    // 只承认 alive 存在
    const removed = (await store.pruneMissingDirectories((dir: string) => dir === alive)) as string[];
    /**
     * 断结构而不是断名字：工作区行的 title 由宿主给出，未必等于会话 title。
     * 这里真正要证明的是「恰好删掉一行、且删的是 gone 那一行」，
     * 用计数 + 幸存者来断言，不依赖标题文案。
     */
    expect(removed).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);

    const titles = ((await store.list()) as { title?: string }[]).map(item => item.title);
    expect(titles).toEqual(['alive']);
    expect(titles).not.toContain('gone');
  });

  it('判据确实是「目录存在」：同一份数据换 exists 即可控制结果', async () => {
    const store = await makeStore();
    await projectDirectory(store, [session('s1', 'C:\\work\\a'), session('s2', 'C:\\work\\b')]);

    // 全部存在 → 一个都不删
    expect(await store.pruneMissingDirectories(() => true)).toEqual([]);
    // 全部不存在 → 两个都删
    const removed = (await store.pruneMissingDirectories(() => false)) as string[];
    expect(removed.length).toBe(2);
    expect(await store.list()).toEqual([]);
  });

  it('cwd 为 null 的行永不剔除（无法证明它失效）', async () => {
    const store = await makeStore();
    await projectDirectory(store, [session('s1', 'C:\\work\\a')]);
    // 再插一行没有 cwd 的：kind=manual 由 create 产生，恒无 cwd
    await store.create('手动行', {
      workspaceId: uuid7(),
      baseRevision: 0,
      operationId: uuid7(),
      projectionEpoch: 1,
    });

    const removed = (await store.pruneMissingDirectories(() => false)) as string[];
    // 只该删掉那条 dsh 行，手动行留下
    expect(removed).not.toContain('手动行');
    const titles = ((await store.list()) as { title?: string }[]).map(item => item.title);
    expect(titles).toContain('手动行');
  });

  it('没有可剔除项时返回空数组（不制造无谓的写盘）', async () => {
    const store = await makeStore();
    await projectDirectory(store, [session('s1', 'C:\\work\\a')]);
    expect(await store.pruneMissingDirectories(() => true)).toEqual([]);
  });

  it('重复剔除是幂等的（宿主每次刷新都会调）', async () => {
    const store = await makeStore();
    await projectDirectory(store, [session('s1', 'C:\\work\\a'), session('s2', 'C:\\work\\b')]);

    const first = (await store.pruneMissingDirectories((dir: string) => dir === 'C:\\work\\a')) as string[];
    expect(first.length).toBe(1);

    // 第二次没有可删的了：不能重复上报，也不能报错
    const second = await store.pruneMissingDirectories((dir: string) => dir === 'C:\\work\\a');
    expect(second).toEqual([]);
  });
});
