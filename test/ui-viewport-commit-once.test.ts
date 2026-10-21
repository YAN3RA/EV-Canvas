/**
 * 视口提交的**单次性**（UI-D1 回归）。
 *
 * 故障背景：pan 松手时原先是
 *   `setTransform(current => { commitViewport(current); return current })`
 * ——把副作用写进了 state updater。两重后果：
 *
 *   1. StrictMode 下 updater 会被**调用两次**（`main.tsx` 确实开着 StrictMode），
 *      同一次松手提交两次 viewport。两次提交带同一 revision 进入写队列，后一次
 *      基于尚未 reload 的旧模型重算快照，把前一次的正确位置**覆盖回旧值**。
 *   2. updater 允许被 React 丢弃或重放，副作用不在它的契约里。
 *
 * 同一类错误还出现在缩放滑杆的 `onPointerUp`。两处都已改为读 `transformRef.current`
 * 在 updater **之外**提交一次。
 *
 * 这些断言分两层：
 *   - 行为层：用纯函数复刻「松手 → 提交」路径，证明单次松手只产生一次提交。
 *   - 源码层：静态断言 updater 里不再出现 `commitViewport`。行为测试无法覆盖
 *     React 的双调用，而回退成旧写法时行为测试仍会全绿——所以必须查源码。
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * 用**本文件位置**定位源码，不用 `process.cwd()`。
 *
 * 踩过的坑：一开始写 `join(process.cwd(), 'src', ...)`，直接用 `npx vitest run`
 * 时 cwd 是仓库根所以能过；换成 `npx --prefix <repo> vitest run --root <repo>`
 * 时 cwd 变成调用方目录，读取立刻失败——看起来像源码回退，其实是路径假设错了。
 * `server-entry.test.ts` 也吃同一个亏（同批次里一起失败）。新测试不重复这个问题。
 */
const testDir = dirname(fileURLToPath(import.meta.url));
const surfacePath = join(testDir, '..', 'src', 'ui', 'CanvasSurface.tsx');

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * 复刻「一次手势结束」的提交路径。
 *
 * `viaUpdater` 为 true 时模拟旧写法：每次 updater 执行都提交一次。
 * `updaterRuns` 模拟 StrictMode 的双调用（React 19 dev 下 updater 跑两次）。
 */
function endGestureCommits(
  settled: Viewport,
  { viaUpdater, updaterRuns = 1 }: { viaUpdater: boolean; updaterRuns?: number },
): Viewport[] {
  const commits: Viewport[] = [];
  const commit = (value: Viewport): void => {
    commits.push({ ...value });
  };
  if (viaUpdater) {
    for (let i = 0; i < updaterRuns; i += 1) commit(settled);
  } else {
    commit(settled);
  }
  return commits;
}

describe('pan 松手提交次数', () => {
  const settled: Viewport = { x: -300, y: -150, zoom: 1 };

  it('在 updater 之外提交：一次松手只提交一次', () => {
    expect(endGestureCommits(settled, { viaUpdater: false })).toHaveLength(1);
  });

  it('在 updater 里提交 + StrictMode 双调用：会提交两次（旧缺陷形态）', () => {
    // 保留这条断言是为了把缺陷「钉住」：将来有人改回 updater 写法，
    // 这里会立刻说明它为什么错，而不是等用户真机上看见跳帧。
    expect(endGestureCommits(settled, { viaUpdater: true, updaterRuns: 2 })).toHaveLength(2);
  });

  it('提交的值是松手时的最终位置，不是上一帧的位置', () => {
    const lastRendered: Viewport = { x: -280, y: -140, zoom: 1 };
    const commits = endGestureCommits(settled, { viaUpdater: false });
    expect(commits[0]).toEqual(settled);
    // 明确断言两者不同：闭包里的 transform 会比 ref 旧一帧。
    expect(commits[0]).not.toEqual(lastRendered);
  });
});

describe('源码层：updater 里不得有副作用', () => {
  it('CanvasSurface 里不存在 `setTransform(... => ... commitViewport ...)` 形态', async () => {
    const source = await readFile(surfacePath, 'utf8');
    // 扒掉注释再断言：修复说明里会引用旧写法，不能把说明文字当成缺陷。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/setTransform\s*\(\s*\w+\s*=>\s*\(?\s*commitViewport/);
    // 旧写法还有一种跨行形式：updater 块内单独一行调用 commitViewport。
    expect(code).not.toMatch(/setTransform\s*\(\s*\w+\s*=>\s*\{[\s\S]{0,120}?commitViewport/);
  });

  it('存在 applyTransform 统一写入口，ref 与 state 同步更新', async () => {
    const source = await readFile(surfacePath, 'utf8');
    expect(source).toMatch(/const\s+applyTransform\s*=\s*useCallback/);
    expect(source).toMatch(/transformRef\.current\s*=\s*value/);
  });

  it('pan 结束走 transformRef.current，不再读闭包里的 transform', async () => {
    const source = await readFile(surfacePath, 'utf8');
    expect(source).toMatch(/const\s+settled\s*=\s*transformRef\.current/);
    expect(source).toMatch(/commitViewport\(settled\)/);
  });
});
