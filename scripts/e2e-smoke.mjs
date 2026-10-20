/**
 * 服务端产物端到端冒烟（U2 前置验证）。
 *
 * 目的：证明 `dist/server/index.js` 不只能在 Node 里 import，而且**能真的挂载到
 * 一个宿主形态的 ctx 上、接住真实 HTTP 请求**。这比单元测试强的地方在于：
 * 单元测试用假 ctx、假 req/res；这里用真 http server + 真 socket。
 *
 * 仍然**不是**真实 DSH 加载——那需要 9222 与宿主进程内观察。本脚本只排除
 * 「装上去第一行 import 就挂」「路由注册了但接不住请求」这两类硬失败。
 */
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply } = await import('../dist/server/index.js');

const workDir = await mkdtemp(join(tmpdir(), 'evcanvas-e2e-'));
const dataFile = join(workDir, 'workspaces.json');

/** 类似宿主 ctx 的最小实现：真 http server + effect/logger。 */
const routes = [];
const ctx = {
  logger: { warn() {}, error() {}, info() {} },
  webServer: {
    register(route) {
      routes.push(route);
      return { dispose() {} };
    },
  },
  effect(fn) {
    return fn();
  },
};

apply(ctx, { dataFile, trustedHosts: [] });

const server = createServer((req, res) => {
  for (const route of routes) {
    const matches = route.kind === 'exact'
      ? req.url === route.path || req.url === `${route.path}/`
      : req.url.startsWith(route.path);
    if (matches) {
      Promise.resolve(route.handler(req, res)).catch(error => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      });
      return;
    }
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'no route' }));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const results = [];
async function check(label, path, expectStatus, predicate) {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const ok = response.status === expectStatus && (predicate === undefined || predicate(body));
  results.push({ label, ok, status: response.status, body });
  return { ok, body };
}

await check('健康检查返回插件元信息', '/evcanvas/api/health', 200, body => body.ok === true && body.id === 'evcanvas');
await check('工作区列表可读', '/evcanvas/api/workspaces', 200, body => Array.isArray(body.workspaces));
await check('未知接口 404', '/evcanvas/api/nope', 404);
await check('非法标识符被拒', '/evcanvas/api/workspaces/..%2Fetc', 400);

// 宿主侧只允许 localhost；这里用 127.0.0.1 访问，应通过
await check('Host 围栏放行 127.0.0.1', '/evcanvas/api/health', 200);

server.close();
await rm(workDir, { recursive: true, force: true });

const failed = results.filter(item => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}  (${item.status})`);
}
if (failed.length > 0) {
  for (const item of failed) console.log('  详情:', JSON.stringify(item.body).slice(0, 200));
  console.error(`e2e: ${failed.length}/${results.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log(`e2e: ${results.length}/${results.length} 通过（真实 HTTP，非假 ctx）`);
}
