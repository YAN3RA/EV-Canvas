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
console.log('check-dist: 重新构建…');
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

const problems = [];
if (missing.length > 0) problems.push(`新增产物未提交（${missing.length}）：${missing.slice(0, 6).join(', ')}`);
if (stale.length > 0) problems.push(`已提交但构建不再产出（${stale.length}）：${stale.slice(0, 6).join(', ')}`);
if (changed.length > 0) problems.push(`内容不一致（${changed.length}）：${changed.slice(0, 6).join(', ')}`);

if (problems.length > 0) {
  console.error('check-dist: dist/ 与源码不一致 —— 请提交重新构建后的产物');
  for (const item of problems) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(`check-dist: ${built.length} 个产物与源码一致（已忽略 sourcemap）`);
