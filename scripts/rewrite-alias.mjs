/**
 * 构建后处理：把产物里的 `@/...` 别名改写成相对路径。
 *
 * 为什么必须有这一步：`tsconfig.json` 的 `paths` 只在**类型检查期**生效，
 * `tsc` 会把 `import ... from '@/shared/errors'` 原样写进 `.js` 产物。
 * Node 与宿主都不认这个别名，装上去第一行 import 就 ERR_MODULE_NOT_FOUND。
 * （前端产物由 Vite 解析别名，所以只有服务端需要这一层。）
 *
 * 为什么不用 `tsc-alias`：宿主侧要求零 runtime 依赖，构建期也不为此新增依赖。
 * 规则足够简单——`@/` 之后就是 `src/` 下的相对位置——这里逐文件重写即可。
 *
 * 只改 `from '...'` / `import('...')` 里的说明符，不碰注释与字符串内容以外的代码。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** 产物根：tsconfig.server.json 的 outDir */
const OUT_ROOT = resolve('dist');

/** 别名前缀 → 源码根目录在产物里的位置 */
const ALIAS_PREFIX = '@/';
const ALIAS_TARGET = '';

/** 需要扫描的产物目录（server 与 shared 是服务端产物；ui 由 Vite 处理，跳过）。 */
const SCAN_DIRS = ['server', 'shared'];

/** 匹配 `from '<spec>'` 与 `import('<spec>')`。 */
const SPECIFIER_RE = /((?:from\s*|import\s*\(\s*)['"])(@\/[^'"]+)(['"])/g;

/**
 * 匹配**相对**说明符，用于补 `.js` 扩展名。
 *
 * 为什么需要：源码里写 `from './errors'`（`moduleResolution: bundler` 允许省略扩展名），
 * 但 Node ESM 与宿主加载器要求显式扩展名，否则 ERR_MODULE_NOT_FOUND。
 * 只补真实存在的 `.js`，其余（如已经是 `.js` 或指向目录）原样保留。
 */
const RELATIVE_RE = /((?:from\s*|import\s*\(\s*)['"])(\.\.?\/[^'"]+)(['"])/g;

/** 一个 `.js` / `.d.ts` 是否需要改写（先粗筛，避免读全量文件）。 */
async function rewriteFile(filePath) {
  const source = await readFile(filePath, 'utf8');
  let changed = 0;
  let next = source;

  // ① 别名 → 相对路径（并补扩展名）
  next = next.replace(SPECIFIER_RE, (match, head, specifier, tail) => {
    const target = specifier.slice(ALIAS_PREFIX.length);
    // 产物里的目标从 OUT_ROOT 起算；源文件在 src 下与别名路径结构一致。
    const absoluteTarget = join(OUT_ROOT, ALIAS_TARGET, target);
    let spec = relative(dirname(filePath), absoluteTarget).replaceAll('\\', '/');
    if (!spec.startsWith('.')) spec = `./${spec}`;
    if (existsSync(`${absoluteTarget}.js`) && !spec.endsWith('.js')) spec = `${spec}.js`;
    changed += 1;
    return `${head}${spec}${tail}`;
  });

  // ② 相对路径补 `.js`（只补真实存在的文件，不猜测）
  next = next.replace(RELATIVE_RE, (match, head, specifier, tail) => {
    if (specifier.endsWith('.js') || specifier.endsWith('.json') || specifier.endsWith('.mjs')) return match;
    const absoluteTarget = resolve(dirname(filePath), specifier);
    if (!existsSync(`${absoluteTarget}.js`)) return match;
    changed += 1;
    return `${head}${specifier}.js${tail}`;
  });

  if (changed > 0) await writeFile(filePath, next, 'utf8');
  return changed;
}

/** 递归遍历产物目录。 */
async function walk(dir) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

let total = 0;
for (const dir of SCAN_DIRS) {
  const root = join(OUT_ROOT, dir);
  if (!existsSync(root)) continue;
  for (const file of await walk(root)) total += await rewriteFile(file);
}

if (total === 0) {
  console.error('rewrite-alias: 没有改写任何说明符——若产物里本应存在别名，说明这一步没生效');
  process.exitCode = 1;
} else {
  console.log(`rewrite-alias: 改写 ${total} 处别名引用`);
}
