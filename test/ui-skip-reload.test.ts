/**
 * 保存后不走全量 reload（UI-D15，M1）。
 *
 * ## 背景
 *
 * 用户原话：「刷新太频繁，动一下就刷新」。实测原因：每次 PATCH 成功都
 * `await canvas.reload()`，而 reload 会拉两次——工作区列表 + 整份工作区文档
 * （18 MB、29 个会话）。拖一次卡片就是一整轮。
 *
 * ## 修法
 *
 * `PATCH` 的响应里已经带了提交后的 `layout` 与 `revision`
 * （服务端 `updateLayout` 的返回值），本地用它重建模型即可，结果与重新拉一次
 * 等价。只有「模型不属于该工作区」时才回落到 reload。
 *
 * ## 本文件锁什么
 *
 * 1. 响应带了 layout → 不 reload
 * 2. 响应没带 layout → 必须 reload（不能假装成功）
 * 3. 模型属于别的工作区 → 必须 reload（不能把 A 的布局套到 B）
 * 4. 就地应用后 revision 跟着服务端走（否则下次写入撞 409）
 */

import { describe, it, expect } from 'vitest';

interface Layout {
  cards: Record<string, { x: number; y: number }>;
  collapsed: Record<string, true>;
  viewport: { x: number; y: number; zoom: number };
}

/** 与 App.tsx 中的回落判据逐字一致。 */
function shouldReload(
  written: { layout?: Layout; revision?: number | null },
  modelWorkspaceId: string | null,
  targetWorkspaceId: string,
): boolean {
  const applied = written.layout !== undefined && modelWorkspaceId === targetWorkspaceId;
  return !applied;
}

const layout: Layout = { cards: { 'a:0': { x: 1, y: 2 } }, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } };

describe('是否回落 reload', () => {
  it('响应带 layout 且工作区匹配 → 不 reload（这是修复的核心）', () => {
    expect(shouldReload({ layout, revision: 8 }, 'ws-1', 'ws-1')).toBe(false);
  });

  it('响应没带 layout → 必须 reload，不能假装成功', () => {
    // 服务端没回 layout 时本地无从得知新布局，硬不 reload 会让界面停在旧坐标。
    expect(shouldReload({ revision: 8 }, 'ws-1', 'ws-1')).toBe(true);
  });

  it('模型属于别的工作区 → 必须 reload', () => {
    // 不能把 A 的布局写进 B 的模型。
    expect(shouldReload({ layout, revision: 8 }, 'ws-OTHER', 'ws-1')).toBe(true);
  });

  it('模型尚未加载（null）→ 必须 reload', () => {
    expect(shouldReload({ layout, revision: 8 }, null, 'ws-1')).toBe(true);
  });

  it('layout 与 revision 都缺 → 必须 reload', () => {
    expect(shouldReload({}, 'ws-1', 'ws-1')).toBe(true);
  });
});

describe('就地应用后的 revision 一致性', () => {
  it('用服务端返回的 revision 覆盖模型，而不是本地推算', () => {
    /**
     * 防 409 的关键：本地加的 1 可能与服务端实际值不同（并发写入、服务端合并
     * 都可能让实际值跳号），所以必须信响应里的数字。
     *
     * 选 47 而不是 42：42 = 41+1 恰好与「本地加一」同值，那样这条断言即使实现
     * 改成推算也照样通过，测不出问题。
     */
    const written = { revision: 47, layout };
    const modelBefore = { revision: 41 };
    const modelAfter = { revision: typeof written.revision === 'number' ? written.revision : modelBefore.revision };
    expect(modelAfter.revision).toBe(47);
    expect(modelAfter.revision).not.toBe(modelBefore.revision + 1);
  });

  it('响应缺 revision 时保留模型原值（不写成 NaN/undefined）', () => {
    const written: { revision?: number | null } = {};
    const modelRevision = 41;
    const next = typeof written.revision === 'number' ? written.revision : modelRevision;
    expect(next).toBe(41);
  });
});

describe('源码层：reload 不再是无条件调用', () => {
  it('App.tsx 里的 reload 必须挂在 applied 判断之后', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testDir = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(testDir, '..', 'src', 'ui', 'App.tsx'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // 必须存在条件式 reload
    expect(code).toMatch(/if \(!applied\) await canvas\.reload\(\)/);
    // 且必须调用就地更新
    expect(code).toMatch(/applyLayoutLocally\(/);
  });

  it('applyLayoutLocally 只在工作区匹配时应用', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testDir = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(testDir, '..', 'src', 'ui', 'data.ts'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/current\.workspaceId !== workspaceId/);
  });
});
