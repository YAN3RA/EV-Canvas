/**
 * 验证「解开的 tgz」能被当成真实插件加载。
 *
 * 这一步比本地 dist 冒烟更严格：它验证的是**安装后的形态**——
 * package.json 的 main/exports 指得到文件、别名已改写、依赖不落空。
 * 仍然不等于真实 DSH 加载（那要 GUI），但能提前排掉「装上去起不来」。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkgRoot = resolve(process.argv[2] ?? '.tmp-verify/package');
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(pkgRoot, 'package.json'), 'utf8'));

// 按 package.json 的 exports 解析入口，而不是硬编码路径——
// 硬编码会掩盖「exports 写错但文件存在」这类问题。
const entryRel = manifest.exports['.'].import;
const entryUrl = pathToFileURL(join(pkgRoot, entryRel)).href;
console.log('entry =', entryRel);

const mod = await import(entryUrl);
console.log('name =', mod.name);
console.log('inject =', JSON.stringify(mod.inject));
console.log('meta =', JSON.stringify(mod.PLUGIN_META));
if (typeof mod.apply !== 'function') {
  console.error('FAIL: apply 不是函数');
  process.exit(1);
}

const workDir = await mkdtemp(join(tmpdir(), 'evcanvas-pkg-'));
const routes = [];
const ctx = {
  logger: { warn() {}, error() {}, info() {} },
  webServer: { register(route) { routes.push(route); return { dispose() {} }; } },
  effect(fn) { return fn(); },
};
mod.apply(ctx, { dataFile: join(workDir, 'workspaces.json'), trustedHosts: [] });

const server = createServer((req, res) => {
  for (const route of routes) {
    const hit = route.kind === 'exact'
      ? req.url === route.path || req.url === `${route.path}/`
      : req.url.startsWith(route.path);
    if (hit) {
      Promise.resolve(route.handler(req, res)).catch(error => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      });
      return;
    }
  }
  res.writeHead(404);
  res.end('{}');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

const checks = [];
for (const [label, path, expected] of [
  ['健康检查', '/evcanvas/api/health', 200],
  ['工作区列表', '/evcanvas/api/workspaces', 200],
  ['未知接口', '/evcanvas/api/nope', 404],
]) {
  const response = await fetch(`${base}${path}`);
  const ok = response.status === expected;
  checks.push({ label, ok, status: response.status });
}

server.close();
await rm(workDir, { recursive: true, force: true });

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label} (${item.status})`);
const failed = checks.filter(item => !item.ok).length;
if (failed > 0) {
  console.error(`pkg-verify: ${failed}/${checks.length} 失败`);
  process.exit(1);
}
console.log(`pkg-verify: 安装形态可加载，${checks.length}/${checks.length} 通过`);
