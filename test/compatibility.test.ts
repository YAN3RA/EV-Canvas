// @ts-nocheck
/**
 * S3-13 宿主兼容静态核验器的测试。
 *
 * ## 为什么用 @ts-nocheck
 *
 * 被核验的是 `scripts/check-compatibility.mjs`——宿主侧交付物，按项目约定是**裸 ESM
 * 的 .mjs**（不进 TS 编译，与 `verify-package.mjs` 一致）。`tsconfig.json` 没开
 * `allowJs`，`tsc --noEmit` 无法为它解析类型；给整个测试文件关闭类型检查，是为了
 * 不在 `npm run build` 的类型检查里制造一个与被测对象无关的报错。
 * （先例：`test/client-entry.test.ts` 同样 @ts-nocheck。）
 *
 * ## 这里为什么要有反例
 *
 * 这个核验器的作用是**拦住「装了但不加载」**。如果只测正例，等于把「所有包都算通过」
 * 写死在测试里：真的写错 exports、漏声明注入服务、包名串位时，测试照样全绿。
 * 所以每个正向检查都必须配一个**可定位的负向夹具**。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPackage, exitCodeFor } from '../scripts/check-compatibility.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** 仓库根（= 脚本所在包的根），测「真实包形态」时用它，绝不硬编码用户绝对路径。 */
const REPO_ROOT = resolve(TEST_DIR, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-compatibility.mjs');
const KNOWN_VERSION = '0.2.1-rc.2';

/** 本包权威声明的等价副本，用于显式注入（CLI 不提供这个入口）。 */
function declarationOf(overrides = {}) {
  return {
    schemaVersion: 1,
    package: { name: 'dsh-evcanvas', pluginId: 'evcanvas' },
    requiredClientInject: [
      '@deepseek-ai/dsh-client-ui-sidebar-right',
      '@deepseek-ai/dsh-client-ui-session',
    ],
    runtimeVerification: { performed: false, reason: '离线静态核验' },
    declarations: [
      {
        id: 'dsh-desktop-0.2.1-rc.2-static',
        hostVersion: KNOWN_VERSION,
        packageName: 'dsh-evcanvas',
        pluginId: 'evcanvas',
        level: 'static-contract-reviewed',
        runtimeVerified: false,
        evidence: [],
      },
    ],
    ...overrides,
  };
}

/** 最小但完整的「可交付包 shape」：入口、客户端、patch、声明、脚本全在包根内。 */
function minimalManifest(overrides = {}) {
  const base = {
    name: 'dsh-evcanvas',
    version: '0.0.1',
    main: './dist/server/index.js',
    exports: {
      '.': { import: './dist/server/index.js', default: './dist/server/index.js' },
      './client': { default: './src/client/index.js' },
      './package.json': './package.json',
    },
    files: [
      'dist/server',
      'src/client',
      'cordis.patch.yml',
      'compatibility.json',
      'scripts/check-compatibility.mjs',
    ],
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: [
          '@deepseek-ai/dsh-client-ui-sidebar-right',
          '@deepseek-ai/dsh-client-ui-session',
        ],
      },
    },
    ...overrides,
  };
  return base;
}

const PATCH_TEXT = `- insert:\n    - id: evcanvas\n      name: dsh-evcanvas\n      config: {}\n`;
const CLIENT_TEXT = `window.__ModuleLoader__.load({\n  id: 'dsh-evcanvas',\n  factory(require) { return {} },\n});\n`;
/** 无裸依赖的服务端入口：⑧ 的扫描不会因夹具自身而误报。 */
const SERVER_TEXT = `export const name = 'dsh-evcanvas';\nexport function apply() {}\n`;

/**
 * 造一个临时包 shape。
 *
 * `mutate` 拿到已写好的文件路径表，可精确破坏其中一处（每个负例只破坏一处，
 * 这样失败能归因到具体检查项）。
 */
async function makeFixture(mutate = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'evcanvas-compat-'));
  const files = {
    'dist/server/index.js': SERVER_TEXT,
    'src/client/index.js': CLIENT_TEXT,
    'cordis.patch.yml': PATCH_TEXT,
    'compatibility.json': JSON.stringify(declarationOf(), null, 2),
    'scripts/check-compatibility.mjs': '// 占位：安装形态里只需存在\n',
  };
  // 顺序很关键：先落默认 package.json，再让 mutate 覆盖它或改 files 映射，
  // 最后才把 files 写盘。反过来的话，mutate 里写的 package.json 会被默认值盖掉，
  // 负例就变成了「测正例」——这类静默失效比断言失败更难查。
  await writeFile(join(root, 'package.json'), JSON.stringify(minimalManifest(), null, 2), 'utf8');
  await mutate({ root, files });
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return root;
}

/** 只破坏一处后核验：返回报告，供逐个断言。 */
async function checkBroken(mutate, options = {}) {
  const root = await makeFixture(async fixture => { await mutate(fixture); });
  try {
    return await checkPackage({ packageRoot: root, hostVersion: KNOWN_VERSION, ...options });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const errorCodes = report => report.checks.filter(check => !check.ok).map(check => check.code);

let sharedRoot = '';
beforeAll(async () => { sharedRoot = await makeFixture(); });
afterAll(async () => { if (sharedRoot !== '') await rm(sharedRoot, { recursive: true, force: true }); });

describe('S3-13 静态核验：正例', () => {
  it('最小完整包 shape 命中已知版本 → pass-static，且不声称真机核验', async () => {
    const report = await checkPackage({ packageRoot: sharedRoot, hostVersion: KNOWN_VERSION });
    expect(errorCodes(report)).toEqual([]);
    expect(report.verdict).toBe('pass-static');
    expect(report.matchedDeclaration).toBe('dsh-desktop-0.2.1-rc.2-static');
    // 关键：静态通过也绝不能顺手说成运行期兼容。
    expect(report.runtimeVerified).toBe(false);
    expect(exitCodeFor(report)).toBe(0);
  });

  it('缺少 --host-version → not-checked，不冒充「对当前宿主通过」', async () => {
    const report = await checkPackage({ packageRoot: sharedRoot });
    expect(report.verdict).toBe('not-checked');
    expect(report.hostVersion).toBe(null);
    expect(report.matchedDeclaration).toBe(null);
    expect(exitCodeFor(report)).toBe(0);
  });

  it('未知宿主版本 → not-reviewed 且退出码非零，明确「不能判通过」', async () => {
    const report = await checkPackage({ packageRoot: sharedRoot, hostVersion: '9.9.9-future' });
    expect(report.verdict).toBe('not-reviewed');
    expect(errorCodes(report)).toContain('host-version-not-reviewed');
    expect(exitCodeFor(report)).toBe(2);
  });
});

describe('S3-13 静态核验：结构反例', () => {
  it('main 指向的文件不存在 → fail（不是「能读到就算过」）', async () => {
    const report = await checkBroken(async ({ files }) => { delete files['dist/server/index.js']; });
    expect(errorCodes(report)).toContain('entry-main-missing');
    expect(report.verdict).toBe('fail');
    expect(exitCodeFor(report)).toBe(1);
  });

  it('main 用绝对/上级路径逃出包根 → fail（逃逸专用代码，不是缺文件）', async () => {
    const report = await checkBroken(async ({ root }) => {
      const manifest = minimalManifest({ main: '../outside/index.js' });
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).toContain('entry-main-escapes-root');
  });

  it('exports["."].import 逃出包根 → fail', async () => {
    const report = await checkBroken(async ({ root }) => {
      const manifest = minimalManifest({
        exports: { '.': { import: '../../escape.js', default: './dist/server/index.js' } },
      });
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).toContain('exports-dot-import-escapes-root');
  });

  it('exports["./client"] 写成 import 条件而非 { default } → fail（宿主只认 default）', async () => {
    const report = await checkBroken(async ({ root }) => {
      const manifest = minimalManifest();
      manifest.exports['./client'] = { import: './src/client/index.js' };
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).toContain('exports-client-shape');
  });

  it('exports["./client"] 缺 default 指向的文件 → fail', async () => {
    const report = await checkBroken(async ({ files }) => { delete files['src/client/index.js']; });
    expect(errorCodes(report)).toContain('exports-client-missing');
  });

  it('缺 dsh.bundle.patch → fail（加载器会静默跳过，插件装了不加载）', async () => {
    const report = await checkBroken(async ({ root }) => {
      const manifest = minimalManifest();
      delete manifest.dsh.bundle;
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).toContain('bundle-patch-missing');
  });

  it('dsh.bundle.patch 指向包根之外 → fail', async () => {
    const report = await checkBroken(async ({ root }) => {
      const manifest = minimalManifest({ dsh: { ...minimalManifest().dsh, bundle: { patch: '../patch.yml' } } });
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).toContain('bundle-patch-escapes-root');
  });

  it('注入服务缺 sidebar-right → fail（右栏注册位不会存在）', async () => {
    const report = await checkBroken(async ({ root }) => {
      const manifest = minimalManifest();
      manifest.dsh.client.inject = ['@deepseek-ai/dsh-client-ui-session'];
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).toContain('client-inject-missing');
    const failed = report.checks.find(check => check.code === 'client-inject-missing');
    expect(failed.detail).toContain('sidebar-right');
  });

  it('缺 dsh.client.inject 数组 → fail', async () => {
    const report = await checkBroken(async ({ root }) => {
      const manifest = minimalManifest();
      delete manifest.dsh.client.inject;
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).toContain('client-inject-missing');
  });

  it('包名串位（package.json name 与声明权威不同）→ fail', async () => {
    const report = await checkBroken(async ({ root }) => {
      const manifest = minimalManifest({ name: 'dsh-synapnova' });
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).toContain('manifest-name-mismatch');
  });

  it('bundle patch 的注册 name 与包名不一致 → fail（Loader 按包名解析）', async () => {
    const report = await checkBroken(async ({ files }) => {
      files['cordis.patch.yml'] = `- insert:\n    - id: evcanvas\n      name: dsh-other\n`;
    });
    expect(errorCodes(report)).toContain('bundle-name-mismatch');
  });

  it('bundle patch 的 id 与声明 pluginId 不一致 → fail', async () => {
    const report = await checkBroken(async ({ files }) => {
      files['cordis.patch.yml'] = `- insert:\n    - id: not-evcanvas\n      name: dsh-evcanvas\n`;
    });
    expect(errorCodes(report)).toContain('plugin-id-mismatch');
  });

  it('客户端 __ModuleLoader__ id 与包名不一致 → fail（侧栏会什么都没有）', async () => {
    const report = await checkBroken(async ({ files }) => {
      files['src/client/index.js'] = `window.__ModuleLoader__.load({ id: 'someone-else', factory() { return {} } });\n`;
    });
    expect(errorCodes(report)).toContain('client-loader-id-mismatch');
  });

  it('运行形态引用了未声明的依赖 → fail（装上会 ERR_MODULE_NOT_FOUND）', async () => {
    const report = await checkBroken(async ({ files }) => {
      files['dist/server/index.js'] = `import { inject } from '@deepseek-ai/dsh-runtime-sdk';\nexport function apply() {}\n`;
    });
    expect(errorCodes(report)).toContain('runtime-dep-undeclared');
    const failed = report.checks.find(check => check.code === 'runtime-dep-undeclared');
    expect(failed.detail).toContain('@deepseek-ai/dsh-runtime-sdk');
  });

  it('未声明的依赖若写进 dependencies 就应当通过（不是一刀切拒绝）', async () => {
    const report = await checkBroken(async ({ root, files }) => {
      files['dist/server/index.js'] = `import { inject } from '@deepseek-ai/dsh-runtime-sdk';\nexport function apply() {}\n`;
      const manifest = minimalManifest({ dependencies: { '@deepseek-ai/dsh-runtime-sdk': '^1.0.0' } });
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).not.toContain('runtime-dep-undeclared');
  });

  it('运行形态的相对 import 逃出包根 → fail', async () => {
    const report = await checkBroken(async ({ files }) => {
      files['dist/server/index.js'] = `import '../../../../evil.js';\nexport function apply() {}\n`;
    });
    expect(errorCodes(report)).toContain('runtime-import-escapes-root');
  });

  it('files 缺交付项（声明/脚本）→ fail，指出具体缺件', async () => {
    const report = await checkBroken(async ({ root }) => {
      const manifest = minimalManifest({ files: ['dist/server'] });
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).toContain('package-files-missing-entry');
    const failed = report.checks.find(check => check.code === 'package-files-missing-entry');
    expect(failed.detail).toContain('compatibility.json');
  });

  it('files 里写 `./` 前缀目录也算已交付（不制造假阳性）', async () => {
    const report = await checkBroken(async ({ root }) => {
      const manifest = minimalManifest({
        files: ['./dist/server', './src/client', './cordis.patch.yml', './compatibility.json', './scripts/check-compatibility.mjs'],
      });
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    });
    expect(errorCodes(report)).not.toContain('package-files-missing-entry');
  });

  it('package.json 不是合法 JSON → fail，不抛未捕获异常', async () => {
    const root = await makeFixture();
    try {
      await writeFile(join(root, 'package.json'), '{ 不是 JSON', 'utf8');
      const report = await checkPackage({ packageRoot: root, hostVersion: KNOWN_VERSION });
      expect(errorCodes(report)).toContain('package-json-invalid');
      expect(report.verdict).toBe('fail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('包根里没有 package.json → fail（可定位，不是崩溃）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evcanvas-compat-empty-'));
    try {
      const report = await checkPackage({ packageRoot: root, hostVersion: KNOWN_VERSION });
      expect(errorCodes(report)).toContain('package-json-missing');
      expect(report.verdict).toBe('fail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('S3-13 声明自校验：不得冒充真机兼容', () => {
  it('条目 level 写成 supported → fail', async () => {
    const declaration = declarationOf();
    declaration.declarations[0].level = 'supported';
    const report = await checkBroken(async () => {}, { declaration, declarationFile: '(injected)' });
    expect(errorCodes(report)).toContain('declaration-invalid-level');
  });

  it('条目 runtimeVerified=true → fail（本轮没有真实 GUI 矩阵）', async () => {
    const declaration = declarationOf();
    declaration.declarations[0].runtimeVerified = true;
    const report = await checkBroken(async () => {}, { declaration, declarationFile: '(injected)' });
    expect(errorCodes(report)).toContain('declaration-runtime-verified-claim');
  });

  it('条目缺少 hostVersion → fail', async () => {
    const declaration = declarationOf();
    delete declaration.declarations[0].hostVersion;
    const report = await checkBroken(async () => {}, { declaration, declarationFile: '(injected)' });
    expect(errorCodes(report)).toContain('declaration-invalid-level');
  });

  it('版本命中但条目 packageName/pluginId 与包不一致 → fail', async () => {
    const declaration = declarationOf();
    declaration.declarations[0].packageName = 'dsh-other';
    declaration.declarations[0].pluginId = 'other';
    const report = await checkBroken(async () => {}, { declaration, declarationFile: '(injected)' });
    expect(errorCodes(report)).toContain('declaration-package-mismatch');
    expect(errorCodes(report)).toContain('declaration-plugin-id-mismatch');
  });

  it('条目声明了 packageVersion 就必须与当前包版本一致 → 不一致即 fail', async () => {
    const declaration = declarationOf();
    declaration.declarations[0].packageVersion = '9.9.9';
    const report = await checkBroken(async () => {}, { declaration, declarationFile: '(injected)' });
    expect(errorCodes(report)).toContain('declaration-package-version-mismatch');
  });

  it('候选包自带的 compatibility.json 不构成权威（白名单绕过必须无效）', async () => {
    const root = await makeFixture(async ({ files }) => {
      // 候选包试图自带一份「很宽松」的声明：只要检查器改了读文件口径就会被骗过。
      files['compatibility.json'] = JSON.stringify(
        declarationOf({ requiredClientInject: [], declarations: [] }), null, 2);
    });
    try {
      // 不注入声明 → 走本包权威；夹具的 inject 正是两个必需服务，应当仍判通过，
      // 且报告里的声明来源必须是**本包**，不是夹具里那份。
      const report = await checkPackage({ packageRoot: root, hostVersion: KNOWN_VERSION });
      expect(report.declarationFile).toBe(join(REPO_ROOT, 'compatibility.json'));
      expect(report.checks.some(check => check.code === 'client-inject-missing' && !check.ok)).toBe(false);
      // 反向证明：把夹具的 inject 也清空后，本包声明仍要求两个服务 → 必须失败。
      const hostile = await makeFixture(async ({ root: inner, files }) => {
        files['compatibility.json'] = JSON.stringify(declarationOf({ requiredClientInject: [] }), null, 2);
        const manifest = minimalManifest();
        manifest.dsh.client.inject = [];
        await writeFile(join(inner, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
      });
      try {
        const hostileReport = await checkPackage({ packageRoot: hostile, hostVersion: KNOWN_VERSION });
        expect(errorCodes(hostileReport)).toContain('client-inject-missing');
      } finally {
        await rm(hostile, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('注入非法声明（缺 declarations 数组）→ 抛出可读错误，不静默通过', async () => {
    await expect(checkPackage({
      packageRoot: sharedRoot,
      declaration: { package: { name: 'dsh-evcanvas' } },
      declarationFile: '(injected)',
    })).rejects.toThrow(/declarations/);
  });
});

describe('S3-13 真实包形态（源码与安装 shape）', () => {
  it('真实仓库包在已知版本下全部通过（源码与安装 shape 一致）', async () => {
    const report = await checkPackage({ packageRoot: REPO_ROOT, hostVersion: KNOWN_VERSION });
    expect(report.errors).toEqual([]);
    expect(report.verdict).toBe('pass-static');
    expect(report.runtimeVerified).toBe(false);
    expect(exitCodeFor(report)).toBe(0);
  });

  it('真实包声明的条目必须都是静态等级且 runtimeVerified=false', async () => {
    const declaration = JSON.parse(await readFile(join(REPO_ROOT, 'compatibility.json'), 'utf8'));
    expect(declaration.declarations.length).toBeGreaterThan(0);
    for (const entry of declaration.declarations) {
      expect(entry.level).toBe('static-contract-reviewed');
      expect(entry.runtimeVerified).toBe(false);
    }
    expect(declaration.runtimeVerification.performed).toBe(false);
    // 声明的必需服务与 package.json 实际注入必须双向一致，否则声明就是空话。
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(new Set(declaration.requiredClientInject))
      .toEqual(new Set(manifest.dsh.client.inject));
  });

  it('核验过程不修改被检包（前后文件 SHA256 不变）', async () => {
    const targets = ['package.json', 'cordis.patch.yml', 'compatibility.json'];
    const hashAll = async () => Object.fromEntries(await Promise.all(targets.map(async rel => [
      rel, createHash('sha256').update(await readFile(join(REPO_ROOT, rel))).digest('hex'),
    ])));
    const before = await hashAll();
    await checkPackage({ packageRoot: REPO_ROOT, hostVersion: KNOWN_VERSION });
    await checkPackage({ packageRoot: REPO_ROOT });
    expect(await hashAll()).toEqual(before);
  });
});

describe('S3-13 核验器 CLI 真实进程', () => {
  const run = (args, options = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? REPO_ROOT,
  });

  it('--help 退出码 0 并打印用法', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--package-root');
    expect(result.stdout).toContain('--host-version');
  });

  it('未知参数退出码 3，不做宽容忽略', () => {
    const result = run(['--nope']);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('未知参数');
  });

  it('--package-root 缺取值退出码 3', () => {
    const result = run(['--package-root']);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('缺少取值');
  });

  it('不存在的 --package-root 退出码 3（可定位），不是崩溃', () => {
    const result = run(['--package-root', join(tmpdir(), 'evcanvas-does-not-exist-xyz')]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('不存在');
  });

  it('真实进程核验夹具：未给版本 → not-checked 且退出码 0', () => {
    const result = run(['--package-root', sharedRoot]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not-checked');
    expect(result.stdout).toContain('runtimeVerified=false');
  });

  it('真实进程核验夹具：已知版本 → pass-static，仍未声称运行期兼容', () => {
    const result = run(['--package-root', sharedRoot, '--host-version', KNOWN_VERSION]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pass-static');
    expect(result.stdout).toContain('runtimeVerified=false');
    expect(result.stdout).not.toMatch(/supported/i);
  });

  it('真实进程：未知版本 → not-reviewed 且退出码 2', () => {
    const result = run(['--package-root', sharedRoot, '--host-version', '9.9.9-future']);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('not-reviewed');
  });

  it('真实进程：结构破坏的包 → 退出码 1', () => {
    const root = makeFixtureSyncBrokenPath();
    const result = run(['--package-root', root, '--host-version', KNOWN_VERSION]);
    expect(result.status).toBe(1);
  });

  it('--package-root 缺省时用脚本所在包根，而不是 cwd', () => {
    const result = run([], { cwd: tmpdir() });
    // cwd 是系统临时目录（里面没有包），若实现按 cwd 解析就会变成「找不到 package.json」。
    expect(result.stdout).toContain(`包根：${REPO_ROOT}`);
    expect(result.stdout).not.toContain('package-json-missing');
  });

  it('--json 输出机器可读报告，字段与退出码自洽', () => {
    const result = run(['--package-root', sharedRoot, '--host-version', KNOWN_VERSION, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.verdict).toBe('pass-static');
    expect(report.runtimeVerified).toBe(false);
    expect(report.matchedDeclaration).toBe('dsh-desktop-0.2.1-rc.2-static');
    expect(Array.isArray(report.checks)).toBe(true);
  });
});

/** 同步造一个「main 指向的文件不存在」的包根（CLI 用例需要真实目录，且不能 await）。 */
function makeFixtureSyncBrokenPath() {
  const root = mkdtempSync(join(tmpdir(), 'evcanvas-compat-broken-'));
  const manifest = minimalManifest();
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
  mkdirSync(join(root, 'src', 'client'), { recursive: true });
  writeFileSync(join(root, 'src', 'client', 'index.js'), CLIENT_TEXT, 'utf8');
  writeFileSync(join(root, 'cordis.patch.yml'), PATCH_TEXT, 'utf8');
  writeFileSync(join(root, 'compatibility.json'), JSON.stringify(declarationOf(), null, 2), 'utf8');
  // dist/server/index.js 故意不创建 → main 缺件。
  return root;
}