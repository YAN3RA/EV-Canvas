#!/usr/bin/env node
/**
 * EV Canvas · 宿主兼容静态核验器（S3-13）
 *
 * ## 它证明什么、不证明什么
 *
 * 只做**离线静态契约核验**：包结构（main/exports/client/bundle patch 是否落在包根内）、
 * `dsh.client.inject` 是否声明了本插件真正用到的客户端服务、包名/插件 id 是否串位、
 * 版本能否对上兼容声明里的条目、运行形态（产物 import）是否缺依赖。
 *
 * **不等于**运行期兼容：不启动宿主、不开 HTTP 端口、不读 app.asar、不碰真实 profile。
 * 因此判定词只有 `pass-static`（静态通过），并且同时打印 `runtimeVerified=false`；
 * 「装了能跑」必须由真实 GUI 矩阵单独验收，本工具永不输出 supported。
 *
 * ## 权威来源
 *
 * 兼容声明唯一来源是**本脚本所在包内**的 `compatibility.json`（`--package-root` 指向的
 * 候选包无法自带白名单，避免「候选包说自己兼容」这种自证）。候选包只被**读取**，
 * 不执行它的任何代码。
 *
 * ## 退出码
 *
 *   0  静态通过（或无 --host-version 时的 not-checked）
 *   1  结构性问题（缺文件、路径逃逸、缺服务、id/名串位、缺依赖、声明不合法）
 *   2  宿主版本不在声明矩阵内（not-reviewed，明确不能判通过）
 *   3  用法错误（未知参数、非法路径）
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 脚本自身所在目录（scripts/），兼容声明固定取它的上一级。 */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OWN_ROOT = resolve(SCRIPT_DIR, '..');

/** 唯一允许的证据等级：静态契约已核对。真机结论必须另开条目并带 runtimeVerified。 */
const ALLOWED_LEVELS = new Set(['static-contract-reviewed']);

const USAGE = `EV Canvas 宿主兼容静态核验（S3-13，离线，不启动宿主）

用法:
  node scripts/check-compatibility.mjs [--package-root <dir>] [--host-version <ver>] [--json]

参数:
  --package-root <dir>    要核验的包根。缺省 = 本脚本所在包根（不是 cwd）
  --host-version <ver>    宿主版本，例如 0.2.1-rc.2。**缺省 = 不做版本判定**，
                          输出 not-checked，不冒充「对当前宿主通过」
  --json                  以 JSON 输出报告（机器可读）
  --help                  打印本帮助

判定与退出码:
  pass-static   = 结构全部通过且版本命中声明条目；仍打印 runtimeVerified=false
  not-checked   = 未提供 --host-version，无法判定版本兼容（退出码 0）
  not-reviewed  = 宿主版本不在 compatibility.json 声明矩阵内（退出码 2）
  fail          = 结构性问题（退出码 1）`;

/** 匹配 `from '...'` / `import('...')` / 裸 `import '...'` 里的模块说明符。 */
const SPECIFIER_RE = /(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

const NODE_BUILTIN_RE = /^node:/;

/** 某个绝对路径是否落在 root 内（含 root 自身）。用于路径逃逸判定。 */
function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 把一个 package.json 里的相对路径解析到包根内。
 *
 * 逃逸（`../../etc/passwd`、绝对路径、`..%2F` 这类解码后逃逸）一律标记，
 * 而不是「能读到就算存在」——安装形态里包根之外的文件不会被交付。
 */
function resolveDeclared(root, rel) {
  const abs = resolve(root, rel);
  return { rel, abs, escapes: !inside(root, abs) };
}

async function exists(path, root) {
  try {
    const [real, realRoot] = await Promise.all([realpath(path), realpath(root)]);
    return inside(realRoot, real) && (await stat(real)).isFile();
  } catch { return false; }
}

/** 读取本包内唯一的兼容声明。 */
export async function loadOwnDeclaration(declarationPath = join(OWN_ROOT, 'compatibility.json')) {
  const source = await readFile(declarationPath, 'utf8');
  return { file: declarationPath, declaration: JSON.parse(source) };
}

/** 从入口文件出发，沿相对 import 收集裸说明符（= 需要在 dependencies 里声明的运行期依赖）。 */
async function scanRuntimeImports(entryFile, root) {
  const bare = new Map(), escaping = [], visited = new Set();
  const realRoot = await realpath(root);
  async function visit(file) {
    if (!(await exists(file, root))) {
      escaping.push({ file: relative(root, file), specifier: '(missing/non-file/outside)' });
      return;
    }
    const canonical = await realpath(file);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    if (!/\.(?:mjs|cjs|js)$/.test(canonical)) return;
    let source;
    try { source = await readFile(canonical, 'utf8'); }
    catch { escaping.push({ file: relative(root, file), specifier: '(unreadable)' }); return; }
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(canonical), specifier);
        if (!inside(realRoot, target)) escaping.push({ file: relative(root, file), specifier });
        else await visit(target);
      } else if (isBuiltin(specifier)) continue;
      else if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || isAbsolute(specifier)) {
        escaping.push({ file: relative(root, file), specifier });
      } else {
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        bare.set(name, relative(root, file));
      }
    }
  }
  await visit(entryFile);
  return { bare, escaping };
}

/**
 * 纯核验函数：输入包根（与可选版本/声明），输出结构化报告。
 *
 * `declaration` 可显式注入（供定向测试用）；CLI **不暴露**该入口，
 * 保证命令行永远读本包 compatibility.json。
 */
export async function checkPackage(options = {}) {
  const packageRoot = resolve(options.packageRoot ?? OWN_ROOT);
  const hostVersion = typeof options.hostVersion === 'string' && options.hostVersion !== ''
    ? options.hostVersion
    : null;
  const own = options.declaration
    ? { file: options.declarationFile ?? '(injected)', declaration: options.declaration }
    : await loadOwnDeclaration();

  const decl = own.declaration;
  if (!decl || !Array.isArray(decl.declarations)) {
    throw new Error('compatibility.json 缺少 declarations 数组：声明权威本身不合法');
  }

  /** @type {{code:string,ok:boolean,severity:'error'|'warn',detail?:string}[]} */
  const checks = [];
  const add = (code, ok, detail, severity = 'error') => {
    checks.push({ code, ok, severity, ...(ok ? {} : { detail }) });
  };

  const report = {
    packageRoot,
    declarationFile: own.file,
    hostVersion,
    runtimeVerified: false,
    verdict: 'fail',
    matchedDeclaration: null,
    checks,
  };

  const nonempty = value => typeof value === 'string' && value.trim() !== '';
  add('declaration-schema-invalid', decl.schemaVersion === 1, '声明 schemaVersion 必须为1');
  add('declaration-package-invalid', nonempty(decl.package?.name) && nonempty(decl.package?.pluginId), '声明缺少 package 身份');
  add('declaration-required-inject-invalid', Array.isArray(decl.requiredClientInject) && decl.requiredClientInject.length > 0 && decl.requiredClientInject.every(nonempty), 'requiredClientInject 必须为非空字符串数组');
  add('declaration-empty', decl.declarations.length > 0, 'declarations 不能为空');
  const manifestPath = join(packageRoot, 'package.json');
  if (!(await exists(manifestPath, packageRoot))) {
    add('package-json-missing', false, `包根内没有 package.json：${packageRoot}`);
    return finish(report, checks, hostVersion);
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    add('package-json-invalid', false, 'package.json 不是合法 JSON');
    return finish(report, checks, hostVersion);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    add('package-json-invalid', false, 'package.json 根必须为对象');
    return finish(report, checks, hostVersion);
  }

  // ① 包名与声明权威一致（防止拿别人的包去对声明）。
  add('manifest-name-mismatch', manifest.name === decl.package?.name,
    `package.json name=${manifest.name} 但共享声明写的是 ${decl.package?.name}`);

  // ② main 入口存在且在包根内。
  const mainEntry = typeof manifest.main === 'string' ? resolveDeclared(packageRoot, manifest.main) : null;
  if (mainEntry === null) {
    add('entry-main-missing', false, 'package.json 没有字符串型 main');
  } else if (mainEntry.escapes) {
    add('entry-main-escapes-root', false, `main=${mainEntry.rel} 逃出包根`);
  } else {
    add('entry-main-missing', await exists(mainEntry.abs, packageRoot), `main 指向的文件不存在：${mainEntry.rel}`);
  }

  // ③ exports['.'] 的 import 条件：按 exports 解析入口，不硬编码路径。
  const dotExport = manifest.exports?.['.'];
  const dotImport = typeof dotExport?.import === 'string' ? dotExport.import : null;
  if (dotImport === null) {
    add('exports-dot-import-missing', false, "exports['.'] 缺少字符串型 import 条件");
  } else {
    const resolved = resolveDeclared(packageRoot, dotImport);
    if (resolved.escapes) add('exports-dot-import-escapes-root', false, `import=${dotImport} 逃出包根`);
    else add('exports-dot-import-missing', await exists(resolved.abs, packageRoot), `import 指向的文件不存在：${dotImport}`);
  }

  // ④ exports['./client'] 必须是 { default: path } 对象形式（宿主客户端装载约定），
  //    且文件存在于包根内；写成 import 条件或裸字符串都会让侧栏永远没有入口。
  const clientExport = manifest.exports?.['./client'];
  const clientRel = typeof clientExport?.default === 'string' ? clientExport.default : null;
  if (clientRel === null || typeof clientExport !== 'object' || clientExport === null) {
    add('exports-client-shape', false,
      "exports['./client'] 必须是 { default: '<路径>' } 对象；宿主客户端装载只认 default");
  } else {
    const resolved = resolveDeclared(packageRoot, clientRel);
    if (resolved.escapes) add('exports-client-escapes-root', false, `client=${clientRel} 逃出包根`);
    else add('exports-client-missing', await exists(resolved.abs, packageRoot), `client 入口文件不存在：${clientRel}`);
  }

  add('exports-package-json-missing', manifest.exports?.['./package.json'] === './package.json',
    "exports 缺少 './package.json' 自引用（宿主读取插件元信息时需要）");

  // ⑤ bundle patch 必须在包根内存在（缺了加载器静默跳过，插件装了不加载）。
  const patchRel = manifest.dsh?.bundle?.patch;
  if (typeof patchRel !== 'string' || patchRel === '') {
    add('bundle-patch-missing', false, 'package.json 缺少 dsh.bundle.patch');
  } else {
    const resolved = resolveDeclared(packageRoot, patchRel);
    if (resolved.escapes) add('bundle-patch-escapes-root', false, `bundle.patch=${patchRel} 逃出包根`);
    else add('bundle-patch-missing', await exists(resolved.abs, packageRoot), `bundle patch 文件不存在：${patchRel}`);
  }

  // ⑥ dsh.client.inject 必须覆盖声明要求的两个客户端服务。
  const inject = Array.isArray(manifest.dsh?.client?.inject) ? manifest.dsh.client.inject : null;
  if (inject === null) {
    add('client-inject-missing', false, 'package.json 缺少 dsh.client.inject 数组');
  } else {
    const required = Array.isArray(decl.requiredClientInject) ? decl.requiredClientInject : [];
    const missing = required.filter(service => !inject.includes(service));
    add('client-inject-missing', missing.length === 0,
      `dsh.client.inject 缺少必需服务：${missing.join(', ')}`);
  }

  // ⑦ 身份三处必须一致：包名 / bundle patch 注册行 / 客户端装载 id。
  if (typeof patchRel === 'string' && patchRel !== '' && !resolveDeclared(packageRoot, patchRel).escapes
    && await exists(resolveDeclared(packageRoot, patchRel).abs, packageRoot)) {
    const patch = await readFile(resolveDeclared(packageRoot, patchRel).abs, 'utf8');
    const patchId = patch.match(/^\s*-\s*id:\s*(\S+)\s*$/m)?.[1] ?? null;
    const patchName = patch.match(/^\s*name:\s*(\S+)\s*$/m)?.[1] ?? null;
    add('plugin-id-mismatch', patchId === decl.package?.pluginId,
      `bundle patch id=${patchId} 与声明 pluginId=${decl.package?.pluginId} 不一致`);
    add('bundle-name-mismatch', patchName === manifest.name,
      `bundle patch name=${patchName} 与包名 ${manifest.name} 不一致（加载器按包名解析）`);
  }

  if (clientRel !== null && !resolveDeclared(packageRoot, clientRel).escapes
    && await exists(resolveDeclared(packageRoot, clientRel).abs, packageRoot)) {
    const clientSource = await readFile(resolveDeclared(packageRoot, clientRel).abs, 'utf8');
    const loaderId = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    add('client-loader-id-mismatch', loaderId === manifest.name,
      `客户端 __ModuleLoader__ id=${loaderId} 与包名 ${manifest.name} 不一致`);
  }

  // ⑧ 运行形态缺依赖：沿服务端入口的相对 import 走一遍，任何裸说明符都必须已声明。
  if (mainEntry !== null && !mainEntry.escapes && await exists(mainEntry.abs, packageRoot)) {
    const { bare, escaping } = await scanRuntimeImports(mainEntry.abs, packageRoot);
    add('runtime-import-escapes-root', escaping.length === 0,
      `运行期产物 import 逃出包根：${escaping.map(item => `${item.file} → ${item.specifier}`).join(', ')}`);
    const declaredDeps = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);
    const undeclared = [...bare.keys()].filter(specifier => !declaredDeps.has(specifier));
    add('runtime-dep-undeclared', undeclared.length === 0,
      `运行期依赖未声明（安装后 ERR_MODULE_NOT_FOUND）：${undeclared.map(name => `${name} @ ${bare.get(name)}`).join(', ')}`);
  }

  // ⑨ 安装形态：files 必须带着本来就要交付的东西，否则装上去缺件。
  if (Array.isArray(manifest.files)) {
    // 两侧都要规范化：package.json 里 `./cordis.patch.yml` 与 files 里的
    // `cordis.patch.yml` 是同一条路径，不去前缀会把「已交付」误报成缺件——
    // 那会让人去改本来正确的 files，属于假阳性比漏报更糟的一类。
    const normalize = rel => rel.replaceAll('\\', '/').replace(/^\.\//, '');
    const shipped = manifest.files.map(normalize);
    const mustShip = ['compatibility.json', 'scripts/check-compatibility.mjs'];
    // 客户端入口按它所在的交付目录检查（files 通常写目录而不是逐个文件）。
    if (clientRel !== null) mustShip.push(normalize(clientRel));
    if (typeof patchRel === 'string' && patchRel !== '') mustShip.push(normalize(patchRel));
    const missing = mustShip.filter(rel => !shipped.some(
      entry => entry === rel || rel.startsWith(`${entry}/`)));
    add('package-files-missing-entry', missing.length === 0,
      `package.json files 缺交付项（安装形态会缺件）：${missing.join(', ')}`);
  } else {
    add('package-files-missing-entry', false, 'package.json 缺少 files 白名单');
  }

  // ⑩ 声明条目自校验：不允许用 supported / runtimeVerified=true 冒充真机兼容。
  const entries = decl.declarations;
  for (const [index, entry] of entries.entries()) {
    const label = `declarations[${index}] (${entry?.id ?? '无 id'})`;
    if (!ALLOWED_LEVELS.has(entry?.level)) {
      add('declaration-invalid-level', false,
        `${label} level=${entry?.level} 不在允许集合 [static-contract-reviewed]；不得用 supported 冒充真机兼容`);
    }
    if (entry?.runtimeVerified !== false) {
      add('declaration-runtime-verified-claim', false,
        `${label} runtimeVerified=${entry?.runtimeVerified} 必须为 false（本轮没有真实 GUI 矩阵）`);
    }
    if (typeof entry?.hostVersion !== 'string' || entry.hostVersion === '') {
      add('declaration-invalid-level', false, `${label} 缺少字符串型 hostVersion`);
    }
  }

  // ⑪ 版本判定：缺 --host-version 就老实说 not-checked，不冒充当前宿主。
  if (hostVersion !== null) {
    const matched = entries.find(entry => entry?.hostVersion === hostVersion) ?? null;
    if (matched === null) {
      const known = entries.map(entry => entry?.hostVersion).filter(Boolean).join(', ');
      add('host-version-not-reviewed', false,
        `宿主版本 ${hostVersion} 不在声明矩阵内（已知：${known || '无'}）；不能判定通过`);
    } else {
      report.matchedDeclaration = matched.id ?? matched.hostVersion;
      add('declaration-package-mismatch', matched.packageName === manifest.name,
        `条目 packageName=${matched.packageName} 与包名 ${manifest.name} 不一致`);
      add('declaration-plugin-id-mismatch', matched.pluginId === decl.package?.pluginId,
        `条目 pluginId=${matched.pluginId} 与声明 pluginId=${decl.package?.pluginId} 不一致`);
      if (typeof matched.packageVersion === 'string') {
        add('declaration-package-version-mismatch', matched.packageVersion === manifest.version,
          `条目核对于 packageVersion=${matched.packageVersion}，当前包版本=${manifest.version}（声明需同步）`);
      }
    }
  }

  return finish(report, checks, hostVersion);
}

/** 由检查项汇总判定；任何 error 都压过版本结论。 */
function finish(report, checks, hostVersion) {
  const errors = checks.filter(check => !check.ok && check.severity === 'error');
  const warnings = checks.filter(check => !check.ok && check.severity === 'warn');
  report.errors = errors.map(check => check.code);
  report.warnings = warnings.map(check => check.code);

  if (errors.some(check => check.code !== 'host-version-not-reviewed')) {
    report.verdict = 'fail';
  } else if (errors.length > 0) {
    report.verdict = 'not-reviewed';
  } else if (hostVersion === null) {
    report.verdict = 'not-checked';
  } else {
    report.verdict = 'pass-static';
  }
  return report;
}

/** 退出码：0 通过/未判；1 结构失败；2 版本不在矩阵。 */
export function exitCodeFor(report) {
  if (report.verdict === 'fail') return 1;
  if (report.verdict === 'not-reviewed') return 2;
  return 0;
}

/** 人类可读输出；始终显式声明没有做真机核验。 */
export function formatReport(report) {
  const lines = [];
  lines.push(`包根：${report.packageRoot}`);
  lines.push(`声明：${report.declarationFile}`);
  lines.push(`宿主版本：${report.hostVersion ?? '(未提供 --host-version)'}`);
  for (const check of report.checks) {
    if (check.ok) continue;
    lines.push(`  [${check.severity}] ${check.code}: ${check.detail}`);
  }
  lines.push(`判定：${report.verdict}${report.matchedDeclaration ? `（条目 ${report.matchedDeclaration}）` : ''}`);
  lines.push('runtimeVerified=false —— 本轮只做静态契约核验，真实 GUI 兼容矩阵未执行，不得读作「已支持」。');
  if (report.verdict === 'not-checked') lines.push('未提供 --host-version，版本兼容性未判定（不冒充当前宿主）。');
  if (report.verdict === 'not-reviewed') {
    lines.push('该宿主版本不在声明矩阵内，无法判通过；需新增静态核验条目或做真机验收。');
  }
  return lines.join('\n');
}

/** 参数解析；未知参数直接报错，不做「忽略后继续」的宽容。 */
function parseArgs(argv) {
  const options = { packageRoot: null, hostVersion: null, json: false, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const split = token.indexOf('=');
    const key = split < 0 ? token : token.slice(0, split);
    if (seen.has(key)) return { error: `${key} 重复指定` };
    seen.add(key);
    if (key === '--help' || key === '-h' || key === '--json') {
      if (split >= 0) return { error: `${key} 不接受取值` };
      if (key === '--json') options.json = true; else options.help = true;
    } else if (key === '--package-root' || key === '--host-version') {
      const value = split < 0 ? argv[++index] : token.slice(split + 1);
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) return { error: `${key} 缺少取值` };
      if (key === '--package-root') options.packageRoot = value; else options.hostVersion = value;
    } else return { error: `未知参数：${key}` };
  }
  return { options };
}

/** CLI 主体；仅在真实进程里执行（被 import 时保持纯函数可用）。 */
async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    console.error(`check-compatibility: ${parsed.error}`);
    console.error(USAGE);
    return 3;
  }
  const { options } = parsed;
  if (options.help) { console.log(USAGE); return 0; }
  if (options.packageRoot !== null) {
    try { await realpath(resolve(options.packageRoot)); }
    catch { console.error(`check-compatibility: --package-root 不存在：${options.packageRoot}`); return 3; }
  }
  let report;
  try { report = await checkPackage({ packageRoot: options.packageRoot ?? OWN_ROOT, hostVersion: options.hostVersion }); }
  catch { console.error('check-compatibility: 声明或包结构不可读取，未判通过'); return 3; }
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  return exitCodeFor(report);
}

const directlyInvoked = process.argv[1] !== undefined && await (async () => {
  try { return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (directlyInvoked) process.exitCode = await main(process.argv.slice(2));