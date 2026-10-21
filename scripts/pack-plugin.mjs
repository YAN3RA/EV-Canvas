/**
 * 生成可安装的插件组合包（`release/dsh-evcanvas-<version>.tgz`）。
 *
 * 为什么需要：DSH 的插件从 GitHub / tgz 安装时，**不会替我们跑构建**。
 * `dist/` 已随仓库交付；这里生成同样可安装的独立tgz，并补齐CLI运行文件。
 * 仅改源码或 package.files 不会自动更新此组合包，实际归档须单独核验。
 *
 * 所以安装组合必须是「构建产物 + 清单」：
 *   dist/server/**   服务端入口与全部依赖（已由 rewrite-alias 处理过别名）
 *   dist/shared/**   服务端共享模块
 *   dist/ui/**       前端 iframe 产物
 *   cordis.patch.yml 插件注册项
 *   package.json     只保留运行时必需字段（不含 devDependencies）
 *   README.md
 *
 * 与其它已装插件（`lib/` + `main: lib/index.js`）是同一形态，只是我们的产物
 * 需要先编译，不能直接把 `src/` 当产物发。
 *
 * 用法：`npm run build && npm run pack:plugin`
 */

import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';

const ROOT = resolve(process.cwd());
const STAGE = join(ROOT, 'release', 'stage');
const OUT_DIR = join(ROOT, 'release');

/**
 * 打进包里的产物目录（相对仓库根）。
 *
 * `src/client` 也必须带上：它是**尚未编译的客户端入口**（裸 `__ModuleLoader__`
 * 写法，由宿主浏览器侧装载，不经过我们的构建），`package.json` 的
 * `exports['./client']` 直接指向它。漏掉它 = 侧栏永远没有入口。
 */
const INCLUDE_DIRS = ['dist/server', 'dist/shared', 'dist/ui', 'dist/canvas', 'src/client'];
/** 单独拷贝的文件。 */
const INCLUDE_FILES = ['cordis.patch.yml', 'README.md', 'compatibility.json', 'scripts/why.mjs', 'scripts/check-compatibility.mjs'];
/** 运行时必需的 package.json 字段（dsh 与 CLI bin 都是实际入口）。 */
const KEEP_FIELDS = ['name', 'version', 'description', 'license', 'type', 'engines', 'main', 'exports', 'files', 'dsh', 'bin'];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(join(ROOT, 'dist', 'server', 'index.js')))) {
  console.error('pack-plugin: 缺少 dist/server/index.js —— 先跑 `npm run build`');
  process.exit(1);
}
if (!(await exists(join(ROOT, 'dist', 'ui', 'app.js')))) {
  console.error('pack-plugin: 缺少 dist/ui/app.js —— 先跑 `npm run build`');
  process.exit(1);
}

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });

for (const dir of INCLUDE_DIRS) {
  await cp(join(ROOT, dir), join(STAGE, dir), { recursive: true });
}
for (const file of INCLUDE_FILES) {
  await mkdir(dirname(join(STAGE, file)), { recursive: true });
  await cp(join(ROOT, file), join(STAGE, file));
}

// 运行时不带 devDependencies：安装方不需要 typescript / vite / vitest。
const source = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const manifest = {};
for (const field of KEEP_FIELDS) {
  if (Object.hasOwn(source, field)) manifest[field] = source[field];
}
await writeFile(join(STAGE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

/**
 * 手写最小 tar（ustar）打包器。
 *
 * 为什么不用 `tar` 依赖：宿主侧要求零 runtime 依赖，构建期也不为此新增包。
 * ustar 格式固定 512 字节块，写起来比引一个依赖更可控。
 */
const BLOCK = 512;

function tarHeader({ name, size, mode = 0o644, type = '0' }) {
  const header = Buffer.alloc(BLOCK, 0);
  const write = (offset, length, value) => header.write(value, offset, length, 'utf8');
  write(0, 100, name.slice(0, 100));
  write(100, 8, `${mode.toString(8).padStart(7, '0')}\0`); // mode
  write(108, 8, '0000000\0'); // uid
  write(116, 8, '0000000\0'); // gid
  write(124, 12, `${size.toString(8).padStart(11, '0')}\0`); // size
  write(136, 12, '00000000000\0'); // mtime（固定为 0，保证可复现）
  write(148, 8, '        '); // checksum 占位
  write(156, 1, type); // typeflag
  write(257, 6, 'ustar\0');
  write(263, 2, '00');
  write(265, 32, ''); // uname
  write(297, 32, ''); // gname
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return header;
}

/** 递归收集 stage 下所有文件，按路径排序保证可复现。 */
const { readdir } = await import('node:fs/promises');
async function collect(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full, rel)));
    else out.push({ rel, full });
  }
  return out;
}

const files = (await collect(STAGE)).sort((a, b) => (a.rel < b.rel ? -1 : 1));

const chunks = [];
for (const { rel, full } of files) {
  const body = await readFile(full);
  // ustar 单文件上限 8 GiB；这里都远小于此，不实现 GNU 长文件名分块。
  if (rel.length > 99) {
    console.error(`pack-plugin: 路径超过 100 字符，ustar 头放不下：${rel}`);
    process.exit(1);
  }
  const binPaths = typeof manifest.bin === 'string'
    ? [manifest.bin]
    : Object.values(manifest.bin ?? {});
  const executable = binPaths.some(path => typeof path === 'string' && path.replace(/^\.\//, '') === rel);
  chunks.push(tarHeader({ name: `package/${rel}`, size: body.length, mode: executable ? 0o755 : 0o644 }));
  chunks.push(body);
  const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
  if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
}
// 结束标记：两个全零块
chunks.push(Buffer.alloc(BLOCK * 2, 0));

const tarBuffer = Buffer.concat(chunks);
const version = manifest.version ?? '0.0.0';
const tgzPath = join(OUT_DIR, `dsh-evcanvas-${version}.tgz`);

await pipeline(Readable.from(tarBuffer), createGzip({ level: 9 }), createWriteStream(tgzPath));

const gz = await readFile(tgzPath);
const sha256 = createHash('sha256').update(gz).digest('hex');

await writeFile(
  join(OUT_DIR, `dsh-evcanvas-${version}.sha256`),
  `${sha256}  dsh-evcanvas-${version}.tgz\n`,
  'utf8',
);

await rm(STAGE, { recursive: true, force: true });

const listed = files.map(item => item.rel);
console.log(`pack-plugin: ${listed.length} 个文件`);
for (const item of listed.slice(0, 12)) console.log(`  ${item}`);
if (listed.length > 12) console.log(`  ... 其余 ${listed.length - 12} 个`);
console.log(`pack-plugin: ${tgzPath}`);
console.log(`pack-plugin: ${gz.length} 字节  sha256=${sha256}`);
