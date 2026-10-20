/**
 * 通过 DSH 官方 Inspector 的 CDP 后端检查插件挂载状态。
 *
 * 为什么不用 GUI 的 Ctrl+Shift+.：那个面板走 DevTools 前端，且 host target id
 * 每次重启都会变；面板若缓存了旧 id 就会报「Debugging connection was closed」。
 * 直接按 /json/list 现取 ws 地址再连，不受界面状态影响。
 *
 * 用法：
 *   node scripts/inspect-host.mjs            # 概览
 *   node scripts/inspect-host.mjs <js表达式>  # 在宿主上下文执行
 *
 * 前提：DSH 已启用 Developer Tools bundle（Inspector 后端默认监听 9230）。
 */

const HOST = 'http://127.0.0.1:9230';

let targets;
try {
  targets = await (await fetch(`${HOST}/json/list`)).json();
} catch (error) {
  console.error(`无法连接 Inspector 后端（${HOST}）：${error.message}`);
  console.error('请确认 DSH 已启用 Developer Tools bundle，且该端口未被占用。');
  process.exit(1);
}

if (!Array.isArray(targets) || targets.length === 0) {
  console.error('Inspector 后端没有可用 target。');
  process.exit(1);
}

const target = targets[0];
console.log(`target: ${target.title}`);
console.log(`  ${target.description}`);
console.log(`  ${target.webSocketDebuggerUrl}`);
console.log();

/** Node 22+ 自带全局 WebSocket，不引第三方依赖。 */
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`${method} 超时`)), 15000);
  });
}

ws.addEventListener('message', event => {
  const msg = JSON.parse(event.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(detail);
  }
  return result.result?.value;
}

const custom = process.argv[2];
if (custom) {
  try {
    const value = await evaluate(custom);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } catch (error) {
    console.error('执行失败:', error.message);
    process.exitCode = 1;
  }
} else {
  // 概览：宿主基本事实
  const overview = await evaluate(`
    (() => ({
      node: process.version,
      cwd: process.cwd(),
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
    }))()
  `);
  console.log('宿主', JSON.stringify(overview, null, 2));
}

ws.close();
