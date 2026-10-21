// @ts-nocheck -- 测真实 .mjs 进程和不受信快照，不为交付脚本另造类型声明。
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readProvenance } from '@/server/provenance';
import { checkPackage } from '../scripts/check-compatibility.mjs';
import { run } from '../scripts/why.mjs';

const ROOT = resolve('.');
const WHY = join(ROOT, 'scripts/why.mjs');
const ISO = '2026-10-22T00:00:00.000Z';
function document() {
  return {
    format: 'dsh-evcanvas', schemaVersion: 1, updatedAt: ISO,
    hiddenSessionIds: [], idempotency: {}, idempotencyFloor: null,
    workspaces: [{
      id: 'review-ws', kind: 'manual', revision: 1, projectionEpoch: 1,
      createdAt: ISO, updatedAt: ISO,
      projection: { threads: [{ id: 't', messages: [{ id: 'q', kind: 'user', text: '夹具', sourceSeq: 0 }], pendingProcess: [], coverage: { ranges: [[0, 0]], historyComplete: false, textTruncated: false } }] },
      layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      materials: [], regions: [], annotations: [],
    }],
  };
}

describe('主代理反例：追溯不能制造来源', () => {
  it.each(['constructor', 'toString', '__proto__'])('继承属性 %s 不是卡片', cardId => {
    const result = readProvenance({ document: document(), workspaceId: 'review-ws', cardId });
    expect(result.ok).toBe(false);
  });

  it('衍生卡片ID相撞时拒绝解释，不选择最后写入对象', () => {
    const input = document();
    // t 的第一问和另一个名为 t:0 的占位线程，会派生相同卡片ID。
    input.workspaces[0].projection.threads.push({ id: 't:0', messages: [], pendingProcess: [], coverage: { ranges: [], historyComplete: false, textTruncated: false } });
    expect(readProvenance({ document: input, workspaceId: 'review-ws', cardId: 't:0' })).toMatchObject({ ok: false, code: 'ambiguous-card-id' });
  });

  it('不向正式CLI暴露测试模块替换入口', async () => {
    const stdout = { write() {} };
    const stderr = { write() {} };
    expect(await run(['--file', 'not-read.json', '--workspace', 'w', '--card', 'c', '--module-root', 'not-imported'], { stdout, stderr })).toBe(2);
  });

  it('被 node -e import 时没有命令执行副作用', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(WHY).href)})`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('通过目录链接启动的命令仍执行帮助，而非静默退出', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'why-link-review-'));
    try {
      // Windows junction 不要求文件符号链接权限；POSIX 忽略第三参数。
      await symlink(join(ROOT, 'scripts'), join(dir, 'scripts-link'), process.platform === 'win32' ? 'junction' : 'dir');
      const result = spawnSync(process.execPath, [join(dir, 'scripts-link/why.mjs'), '--help'], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('用法');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** 候选包均由测试创建，使用真实manifest与客户端注册，入口代码绝不执行。 */
async function candidate(base, body) {
  const root = join(base, 'candidate');
  const files = {
    'package.json': await readFile(join(ROOT, 'package.json'), 'utf8'),
    'cordis.patch.yml': await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8'),
    'src/client/index.js': await readFile(join(ROOT, 'src/client/index.js'), 'utf8'),
    'compatibility.json': await readFile(join(ROOT, 'compatibility.json'), 'utf8'),
    'scripts/check-compatibility.mjs': '// candidate checker is not authority',
    'scripts/why.mjs': '#!/usr/bin/env node\nthrow new Error("不要执行候选代码");',
    'dist/server/index.d.ts': 'export declare const name: string;',
  };
  if (body !== null) files['dist/server/index.js'] = body;
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  if (body === null) await mkdir(join(root, 'dist/server/index.js'));
  return root;
}

describe('独立审阅反馈回归', () => {
  it('兼容CLI经目录链接执行仍输出完整JSON', async () => {
    const base = await mkdtemp(join(tmpdir(), 'compat-bin-link-'));
    try {
      await symlink(join(ROOT, 'scripts'), join(base, 'tools'), process.platform === 'win32' ? 'junction' : 'dir');
      const result = spawnSync(process.execPath, [join(base, 'tools/check-compatibility.mjs'), '--host-version', '0.2.1-rc.2', '--json'], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'pass-static', runtimeVerified: false });
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it('坏包清单的解析异常不回显输入片段', async () => {
    const base = await mkdtemp(join(tmpdir(), 'compat-private-manifest-'));
    try {
      const root = await candidate(base, 'export const name="dsh-evcanvas";');
      await writeFile(join(root, 'package.json'), 'SECRET_MANIFEST_CONTENT');
      const report = await checkPackage({ packageRoot: root, hostVersion: '0.2.1-rc.2' });
      expect(report.verdict).toBe('fail');
      expect(JSON.stringify(report)).not.toContain('SECRET_MANIFEST_CONTENT');
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

describe('兼容检查参数与结构错误优先级', () => {
  it.each([['--host-version='], ['--package-root='], ['--host-version', '0.2.1-rc.2', '--host-version', '999.0.0']])('拒绝空值或重复参数 %j', args => {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts/check-compatibility.mjs'), ...args], { encoding: 'utf8' });
    expect(result.status).toBe(3);
  });
  it('坏包与未知版本并存时报告结构失败', async () => {
    const base = await mkdtemp(join(tmpdir(), 'compat-priority-review-'));
    try {
      const root = await candidate(base, null);
      expect((await checkPackage({ packageRoot: root, hostVersion: '999.0.0' })).verdict).toBe('fail');
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

describe('主代理反例：兼容核验不能静默放行缺件或包外文件', () => {
  it('缺少相对import文件必须失败', async () => {
    const base = await mkdtemp(join(tmpdir(), 'compat-missing-review-'));
    try {
      const root = await candidate(base, "import './not-shipped.js';");
      expect((await checkPackage({ packageRoot: root, hostVersion: '0.2.1-rc.2' })).verdict).toBe('fail');
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it('main不能把目录当可加载文件', async () => {
    const base = await mkdtemp(join(tmpdir(), 'compat-dir-review-'));
    try {
      const root = await candidate(base, null);
      expect((await checkPackage({ packageRoot: root, hostVersion: '0.2.1-rc.2' })).verdict).toBe('fail');
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it('相对import经目录链接逃出候选包必须失败', async () => {
    const base = await mkdtemp(join(tmpdir(), 'compat-link-review-'));
    try {
      const root = await candidate(base, "import './linked/outside.js';");
      const outside = join(base, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'outside.js'), 'throw new Error("不要执行包外代码");');
      await symlink(outside, join(root, 'dist/server/linked'), process.platform === 'win32' ? 'junction' : 'dir');
      expect((await checkPackage({ packageRoot: root, hostVersion: '0.2.1-rc.2' })).verdict).toBe('fail');
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it('兼容声明缺失服务要求时不能降级为无要求通过', async () => {
    const base = await mkdtemp(join(tmpdir(), 'compat-decl-review-'));
    try {
      const root = await candidate(base, 'export const name="dsh-evcanvas";');
      const declaration = JSON.parse(await readFile(join(ROOT, 'compatibility.json'), 'utf8'));
      delete declaration.requiredClientInject;
      const result = await checkPackage({ packageRoot: root, hostVersion: '0.2.1-rc.2', declaration }).catch(() => ({ verdict: 'fail' }));
      expect(result.verdict).toBe('fail');
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
