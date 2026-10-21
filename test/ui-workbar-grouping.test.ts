/**
 * 顶栏目录分组（UI-D10）。
 *
 * 用户反馈「所有会话都展示在顶栏」。实际列的是工作区，但每个工作区就是宿主里
 * 一个目录，平铺成一排后读起来像「一堆陌生名字」。修法是把顶栏语义改成
 * **目录选择器**：同 cwd 合并成一个按钮，按钮上带该目录的会话数。
 *
 * 这里复刻分组与命名逻辑。为什么要单独测：分组是按 `cwd` 归并的，
 * 而 `cwd` 在历史数据里可能为 null（未绑定宿主目录），null 的处理一旦写错，
 * 所有未绑定行会被合并成**一个**按钮，用户就只看得到「一个目录」。
 */

import { describe, it, expect } from 'vitest';

interface Impl {
  id: string;
  title?: string;
  cwd?: string | null;
  threadCount?: number;
}

/** 与 App.tsx 中 `WorkspaceBar` 的分组逻辑逐字一致。 */
function groupByDirectory(workspaces: Impl[]) {
  const groups = new Map<string, { cwd: string | null; items: Impl[] }>();
  for (const item of workspaces) {
    const key = item.cwd ?? item.id;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, { cwd: item.cwd ?? null, items: [item] });
    else bucket.items.push(item);
  }
  return groups;
}

/** 与 App.tsx 中 `directoryLabel` 逐字一致。 */
function directoryLabel(cwd: string | null, fallback: string): string {
  if (cwd === null || cwd === '') return fallback;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

const ws = (id: string, cwd: string | null, threadCount = 0, title = id): Impl => ({
  id,
  cwd,
  threadCount,
  title,
});

describe('按 cwd 分组', () => {
  it('不同目录各自成组', () => {
    const groups = groupByDirectory([
      ws('a', 'C:\\work\\alpha'),
      ws('b', 'C:\\work\\beta'),
    ]);
    expect(groups.size).toBe(2);
  });

  it('同 cwd 的多行合并成一组（S0-7 修复前的历史数据兜底）', () => {
    const groups = groupByDirectory([
      ws('a1', 'C:\\work\\alpha', 3),
      ws('a2', 'C:\\work\\alpha', 4),
    ]);
    expect(groups.size).toBe(1);
    const only = [...groups.values()][0]!;
    expect(only.items).toHaveLength(2);
    // 会话数是组内求和，不是取第一个
    const total = only.items.reduce((n, item) => n + (item.threadCount ?? 0), 0);
    expect(total).toBe(7);
  });

  it('cwd 为 null 时按 id 各自成组，绝不合并成一个', () => {
    // 这是最容易写错的一处：若把 null 当同一个 key，多个未绑定工作区
    // 会合并成「一个」按钮，用户会以为只存在一个目录。
    const groups = groupByDirectory([ws('x', null), ws('y', null)]);
    expect(groups.size).toBe(2);
  });

  it('cwd 缺失（undefined）与 null 行为一致', () => {
    const groups = groupByDirectory([{ id: 'p' }, { id: 'q' }]);
    expect(groups.size).toBe(2);
  });

  it('已绑定与未绑定目录不会互相吞并', () => {
    const groups = groupByDirectory([ws('a', 'C:\\work\\alpha'), ws('b', null)]);
    expect(groups.size).toBe(2);
  });
});

describe('目录标签', () => {
  it('取路径最后一段', () => {
    expect(directoryLabel('C:\\Users\\imyan\\Documents\\deepseek-harness\\EV Canvas', 'fb')).toBe('EV Canvas');
  });

  it('正斜杠路径同样处理', () => {
    expect(directoryLabel('/home/user/projects/evcanvas', 'fb')).toBe('evcanvas');
  });

  it('末尾带分隔符时仍取到目录名', () => {
    expect(directoryLabel('C:\\work\\alpha\\', 'fb')).toBe('alpha');
  });

  it('cwd 为 null 时回落到标题', () => {
    expect(directoryLabel(null, '未绑定工作区')).toBe('未绑定工作区');
  });

  it('cwd 为空串时回落到标题', () => {
    expect(directoryLabel('', '空路径')).toBe('空路径');
  });
});

describe('按钮选中态', () => {
  it('组内任一成员是 activeId 时该组为选中', () => {
    const groups = groupByDirectory([ws('a1', 'C:\\w\\a'), ws('a2', 'C:\\w\\a')]);
    const activeId = 'a2';
    const selected = [...groups.values()].filter(g => g.items.some(i => i.id === activeId));
    expect(selected).toHaveLength(1);
  });

  it('没有任何成员命中时无组选中', () => {
    const groups = groupByDirectory([ws('a1', 'C:\\w\\a')]);
    const selected = [...groups.values()].filter(g => g.items.some(i => i.id === 'zzz'));
    expect(selected).toHaveLength(0);
  });

  it('点击按钮跳转到组内主工作区（选中项优先）', () => {
    const items = [ws('a1', 'C:\\w\\a'), ws('a2', 'C:\\w\\a')];
    const activeId = 'a2';
    const primary = items.find(i => i.id === activeId) ?? items[0]!;
    expect(primary.id).toBe('a2');
  });
});
