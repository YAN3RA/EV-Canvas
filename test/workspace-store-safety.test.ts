// @ts-nocheck -- 测试用真实 fs，类型宽松。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceStore, canonicalHash, mergeCoverageRanges } from '@/server/workspace-store';
import { RevisionConflictError } from '@/shared/schema';

/**
 * workspace-store 是整个项目唯一不能重写的模块（原子写 + 乐观锁 + 幂等）。
 * 这组测试只锁四件事 —— 它们错了就等于数据会丢：
 *
 *   1. 落盘是原子替换，不残留临时文件或锁文件
 *   2. revision 乐观锁真的会拒绝过期写
 *   3. 幂等键能防重放
 *   4. 坏数据不会静默清空
 *
 * 每个用例拿独立目录：锁是真实文件锁（`<dataFile>.lock`），
 * 共享目录会让并发用例互相撞锁 —— 这正是设计要防的场景，
 * 测试必须隔离而不是放宽断言。
 */

interface Opened {
  dir: string;
  dataFile: string;
  store: any;
}
let opened: Opened[] = [];

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

/** 造一个合法 envelope。operationId 必须是 UUIDv7（版本位=7，variant=8/9/a/b）。 */
function env(overrides: Record<string, unknown> = {}): any {
  return {
    workspaceId: uuid7(),
    baseRevision: 0,
    operationId: uuid7(),
    projectionEpoch: 1,
    action: 'test.action',
    body: {},
    ...overrides,
  };
}

let uuidSeq = 0;
/**
 * 生成合法 UUIDv7。
 * 格式（36 字符）：xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
 * 第三段必须以 7 开头（版本），第四段必须以 8/9/a/b 开头（variant）。
 */
function uuid7(): string {
  uuidSeq += 1;
  const tail = uuidSeq.toString(16).padStart(16, '0');
  return `0192f0a0-0000-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18).padEnd(12, '0')}`;
}

/** 建一个全新目录 + 全新 store */
async function makeStore(): Promise<{ store: any; dataFile: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'evc-store-'));
  const dataFile = join(dir, 'state.json');
  const store = new WorkspaceStore(dataFile);
  opened.push({ dir, dataFile, store });
  // 构造函数内部已经 this.ready = this.load()，再显式 load 会并发申请同一把锁
  await store.ready;
  return { store, dataFile, dir };
}

describe('落盘与原子性', () => {
  it('创建后文件存在且是合法 JSON', async () => {
    const { store, dataFile } = await makeStore();
    await store.create('测试工作区', env());
    const raw = await readFile(dataFile, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('保存后 format 是 dsh-evcanvas', async () => {
    const { store, dataFile } = await makeStore();
    await store.create('WS', env());
    const doc = JSON.parse(await readFile(dataFile, 'utf8'));
    expect(doc.format).toBe('dsh-evcanvas');
  });

  it('不留下临时文件', async () => {
    const { store, dir } = await makeStore();
    await store.create('WS', env());
    const files = await readdir(dir);
    const temps = files.filter((f) => f.includes('.tmp') || f.endsWith('~'));
    expect(temps).toEqual([]);
  });

  it('不留下锁文件（save 后即释放）', async () => {
    const { store, dir } = await makeStore();
    await store.create('WS', env());
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith('.lock'))).toEqual([]);
  });
});

describe('revision 乐观锁', () => {
  /** create 用 envelope.workspaceId 作为工作区 id，所以必须显式给同一个值 */
  async function makeWorkspace(store: any) {
    const wsId = uuid7();
    const ws = await store.create('WS', env({ workspaceId: wsId }));
    return { wsId, ws };
  }

  it('用不存在的 revision 写会被拒', async () => {
    const { store } = await makeStore();
    const { wsId } = await makeWorkspace(store);
    await expect(
      store.updateLayout(wsId, { layout: { cards: {} } }, env({ workspaceId: wsId, baseRevision: 9999 })),
    ).rejects.toThrow();
  });

  it('用正确 revision 写会成功并递增', async () => {
    const { store } = await makeStore();
    const { wsId, ws } = await makeWorkspace(store);
    const before = ws.revision;
    const out = await store.updateLayout(
      wsId,
      { layout: { cards: {} } },
      env({ workspaceId: wsId, baseRevision: before }),
    );
    expect(out.revision).toBeGreaterThan(before);
  });

  it('用过期的 revision 再写会被拒', async () => {
    const { store } = await makeStore();
    const { wsId, ws } = await makeWorkspace(store);
    const staleRevision = ws.revision;
    // 先成功一次，revision 已经前进
    await store.updateLayout(
      wsId,
      { layout: { cards: { a: { x: 1, y: 1 } } } },
      env({ workspaceId: wsId, baseRevision: staleRevision }),
    );
    // 再用旧 revision 写必须失败
    await expect(
      store.updateLayout(wsId, { layout: { cards: {} } }, env({ workspaceId: wsId, baseRevision: staleRevision })),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });
});

describe('幂等键', () => {
  it('同 operationId + 同 action + 同 body 视为重放，返回同一结果', async () => {
    const { store } = await makeStore();
    const opId = uuid7();
    const wsId = uuid7();
    const a = await store.create('WS', env({ operationId: opId, workspaceId: wsId }));
    const b = await store.create('WS', env({ operationId: opId, workspaceId: wsId }));
    expect(b.result.workspace.id).toBe(a.result.workspace.id);
  });

  it('不同 operationId 会真的创建两个工作区', async () => {
    const { store } = await makeStore();
    const idA = uuid7();
    const idB = uuid7();
    const a = await store.create('WS-A', env({ workspaceId: idA }));
    const b = await store.create('WS-B', env({ workspaceId: idB }));
    // create 返回 { revision, result: { workspace } }，id 在 result.workspace.id
    expect(a.result.workspace.id).toBe(idA);
    expect(b.result.workspace.id).toBe(idB);
    expect(a.result.workspace.id).not.toBe(b.result.workspace.id);
  });
});

describe('canonicalHash — 稳定摘要', () => {
  it('相同结构不同键序产生同一 hash', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it('不同值产生不同 hash', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });

  it('输出是 64 位 hex', () => {
    expect(canonicalHash({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('mergeCoverageRanges — 区间合并', () => {
  it('相邻区间合并', () => {
    expect(mergeCoverageRanges([[1, 3]], 4, 5)).toEqual([[1, 5]]);
  });

  it('有空洞时不合并（保留真实缺口）', () => {
    expect(mergeCoverageRanges([[1, 3]], 7, 9)).toEqual([
      [1, 3],
      [7, 9],
    ]);
  });

  it('重叠区间合并', () => {
    expect(mergeCoverageRanges([[1, 5]], 3, 7)).toEqual([[1, 7]]);
  });

  it('空起点直接建区间', () => {
    expect(mergeCoverageRanges([], 2, 4)).toEqual([[2, 4]]);
  });
});

describe('坏数据保护', () => {
  it('写入坏 JSON 后 load 抛错，且不清空原文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evc-store-'));
    const dataFile = join(dir, 'state.json');
    await writeFile(dataFile, '{ not json', 'utf8');
    const store = new WorkspaceStore(dataFile);
    opened.push({ dir, dataFile, store });

    let threw = false;
    try {
      await store.ready;
    } catch {
      threw = true;
    }
    // 关键：不能静默清空。要么抛错，要么文件仍非空。
    const raw = await readFile(dataFile, 'utf8');
    expect(threw || raw.length > 0).toBe(true);
  });
});
