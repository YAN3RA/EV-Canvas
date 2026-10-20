/**
 * 校验「提交进仓库的 dist/」与「当前源码」一致。
 *
 * 为什么需要：`dist/` 一旦进版本控制，它就成了**安装方直接使用的产物**。
 * 源码改了却忘记重新构建，会得到一个「仓库里的产物比源码旧」的状态——
 * GitHub 直装的人拿到的是旧行为，而本地测试全绿，问题极难发现。
 *
 * 做法：重新构建到临时目录，与仓库里的 dist/ 逐文件比对（忽略 sourcemap，
 * 因为 sourcemap 不提交）。不一致就报出具体文件名并失败。
 *
 * 用法：`npm run check:dist`（CI / 提交前）
 */

import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(process.cwd());
const SHIPPED = join(ROOT, 'dist');

/** 只比对会被提交的文件：跳过 sourcemap。 */
const SKIP = /\.map$/;

async function walk(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, rel)));
    else if (!SKIP.test(entry.name)) out.push(rel);
  }
  return out.sort();
}

function hashOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 1) 在当前工作目录重建（产物写进 dist/，与提交内容同一位置）。 */
// `--no-build` 只跳到比对阶段，用来验证产物内部的静态约束（如资源路径前缀）
// 而不会先被重建覆盖。默认必须重建：不重建就是在比一份旧产物，等于没检查。
const skipBuild = process.argv.includes('--no-build');
console.log(skipBuild ? 'check-dist: 跳过重建，直接比对现有 dist/' : 'check-dist: 重新构建…');
if (!skipBuild) {
  for (const [label, args] of [
    ['tsc -p tsconfig.server.json', [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.server.json']],
    ['rewrite-alias', [join('scripts', 'rewrite-alias.mjs')]],
    ['vite build', [join('node_modules', 'vite', 'bin', 'vite.js'), 'build']],
  ]) {
    const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(`check-dist: ${label} 失败`);
      console.error(result.stdout?.slice(-2000) ?? '');
      console.error(result.stderr?.slice(-2000) ?? '');
      process.exit(1);
    }
  }
}

// 2) 与 git 里已提交的版本比对（用 git show，避免依赖工作区状态）
const gitFiles = spawnSync('git', ['ls-files', 'dist'], { cwd: ROOT, encoding: 'utf8' });
if (gitFiles.status !== 0) {
  console.error('check-dist: 无法列出已提交的 dist 文件（是否在 git 仓库内？）');
  process.exit(1);
}
const tracked = gitFiles.stdout.split('\n').map(line => line.trim()).filter(Boolean).filter(path => !SKIP.test(path));
const built = (await walk(SHIPPED)).map(rel => `dist/${rel}`);

const builtSet = new Set(built);
const trackedSet = new Set(tracked);

const missing = built.filter(path => !trackedSet.has(path));
const stale = tracked.filter(path => !builtSet.has(path));

const changed = [];
for (const path of built) {
  if (!trackedSet.has(path)) continue;
  const show = spawnSync('git', ['show', `HEAD:${path}`], { cwd: ROOT });
  if (show.status !== 0) continue;
  const committed = hashOf(show.stdout);
  const fresh = hashOf(await readFile(join(ROOT, path)));
  if (committed !== fresh) changed.push(path);
}

/**
 * 2a) 先查产物内部的资源路径。
 *
 * 放在与 git 比对**之前**且不走 `problems` 汇总：这条约束独立于「产物是否最新」，
 * 即使产物与 HEAD 完全一致，路径错了也是错的。若混进 `problems`，它会被
 * 「内容不一致」先一步 return 掉，等于这道守卫在最需要它的场景（改完没提交）
 * 反而失效——本次就踩到了。
 *
 * 为什么需要它：`dist/ui/index.html` 里写 `/app.js` 时产物文件本身完整、哈希
 * 也对得上，check-dist 全绿——但插件路由挂在 `/evcanvas/` 下，页面一打开就是
 * 「脚本 404、浏览器弹出下载」。这类故障从「路由 200」到「产物一致」全部看起来
 * 正常，只有真的在浏览器里打开才暴露，而那时已经装进宿主了。
 */
const PREFIX = '/evcanvas/';
const html = await readFile(join(SHIPPED, 'ui', 'index.html'), 'utf8');
const badRefs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)]
  .map(match => match[1])
  .filter(ref => !ref.startsWith(PREFIX));
if (badRefs.length > 0) {
  console.error(`check-dist: dist/ui/index.html 里的资源路径缺少 "${PREFIX}" 前缀`);
  for (const ref of badRefs) console.error(`  - ${ref}`);
  console.error('  原因通常是 vite.config.ts 没设 base，或 base 写错。');
  process.exit(1);
}

const problems = [];
if (missing.length > 0) problems.push(`新增产物未提交（${missing.length}）：${missing.slice(0, 6).join(', ')}`);
if (stale.length > 0) problems.push(`已提交但构建不再产出（${stale.length}）：${stale.slice(0, 6).join(', ')}`);
if (changed.length > 0) problems.push(`内容不一致（${changed.length}）：${changed.slice(0, 6).join(', ')}`);

if (problems.length > 0) {
  console.error('check-dist: dist/ 与源码不一致 —— 请提交重新构建后的产物');
  for (const item of problems) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(`check-dist: ${built.length} 个产物与源码一致（已忽略 sourcemap）；资源路径前缀正确`);
