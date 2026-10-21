/**
 * S3-8 只读 why CLI 的**真实子进程**契约测试。
 *
 * 为什么要真进程：CLI 的契约有一半在进程边界上——退出码、stdout/stderr 分流、
 * 「不可读文件」与「未知卡」的区分、以及**是否偷偷读了别的东西**。这些用
 * 同进程 import 一个函数是测不出来的（函数被调用就会成功，进程根本不会退出）。
 *
 * 为了让被测 CLI 与仓库构建解耦，本套件把 provenance 的最小 TS 子图编译到
 * **`.tmp-test` 下的独立临时目录**，并将真实CLI复制到临时包scripts。
 * 这样：①不改 `dist`；②不依赖新包；③不制造第二套 CLI（跑的还是同一个
 * `scripts/why.mjs`）。编译与后处理都只作用于本次 mkdtemp 出来的目录。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceCli = join(repoRoot, 'scripts', 'why.mjs')
let cliPath = ''

/** 只该出现在夹具里、绝不该出现在输出里的正文标记。 */
const SECRET_BODY = 'CLI_SECRET_BODY_MARKER_正文'
const ISO = '2026-10-22T02:00:00.000Z'

/** provenance 的最小 TS 子图（本层只依赖这些）。 */
const SUBGRAPH = [
  'src/server/provenance.ts',
  'src/canvas/model.ts',
  'src/shared/session-id.ts',
  'src/shared/schema.ts',
  'src/shared/errors.ts',
]

let tmpRoot = ''
let moduleRoot = ''

/** 把子图编译进临时目录，并返回 `provenance.js` 所在目录。 */
async function compileSubgraph(root: string): Promise<string> {
  const outDir = join(root, 'dist')
  const tsconfig = join(root, 'tsconfig.subgraph.json')
  await writeFile(
    tsconfig,
    `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        skipLibCheck: true,
        noEmit: false,
        declaration: false,
        sourceMap: false,
        outDir,
        rootDir: join(repoRoot, 'src'),
        types: ['node'],
        typeRoots: [join(repoRoot, 'node_modules', '@types')],
      },
      include: SUBGRAPH.map(relative => join(repoRoot, relative)),
    }, null, 2)}\n`,
    'utf8',
  )
  const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) throw new Error(`未找到 tsc：${tsc}`)
  const compiled = spawnSync(process.execPath, [tsc, '-p', tsconfig], { encoding: 'utf8', cwd: repoRoot })
  if (compiled.status !== 0) {
    throw new Error(`子图编译失败（status=${String(compiled.status)}）：\n${compiled.stdout}\n${compiled.stderr}`)
  }
  const rewritten = spawnSync(process.execPath, [join(repoRoot, 'scripts/rewrite-alias.mjs')], { cwd: root, encoding: 'utf8' })
  if (rewritten.status !== 0) throw new Error(rewritten.stdout + rewritten.stderr)
  return join(outDir, 'server')
}

/** 跑真实 CLI 子进程。 */
function runCli(args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, ...env },
    ...(input === undefined ? {} : { input }),
  })
}

/** 一份最小用户消息。 */
function userMessage(seq: number): Record<string, unknown> {
  return { id: `m-${seq}`, kind: 'user', text: SECRET_BODY, sourceSeq: seq, at: ISO }
}

/** 一份最小的冻结完整文档（CLI 唯一接受的形状）。 */
function frozenDocument(
  threads: unknown[] = [{ id: 'thread-a', dshSessionId: 'session-abc', parentId: null, messages: [userMessage(0)], coverage: { ranges: [[0, 3]], historyComplete: true, textTruncated: false } }],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: 'dsh-evcanvas',
    schemaVersion: 1,
    updatedAt: ISO,
    hiddenSessionIds: [],
    idempotency: {},
    idempotencyFloor: null,
    workspaces: [{
      id: 'ws-1',
      kind: 'manual',
      createdAt: ISO,
      updatedAt: ISO,
      revision: 1,
      projectionEpoch: 1,
      projection: { threads },
      layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      materials: [],
      regions: [],
      annotations: [],
    }],
    ...overrides,
  }
}

/** 造一个夹具目录并写入若干文件，返回目录与路径查询函数。 */
async function makeFixtureFile(name: string, contents: string): Promise<string> {
  const dir = join(tmpRoot, 'fixtures')
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, contents, 'utf8')
  return path
}

/** 文件 SHA256；文件不存在时返回 null。 */
async function sha256(path: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch {
    return null
  }
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'evc-why-cli-'))
  await writeFile(join(tmpRoot, 'package.json'), '{"type":"module"}')
  await mkdir(join(tmpRoot, 'scripts'))
  cliPath = join(tmpRoot, 'scripts/why.mjs')
  await cp(sourceCli, cliPath)
  moduleRoot = await compileSubgraph(tmpRoot)
}, 120_000)
afterAll(async () => { if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }) })

describe('why CLI · 成功路径', () => {
  it('从显式快照解释一张卡，输出一行 JSON 且不含正文', async () => {
    const file = await makeFixtureFile('ok.json', JSON.stringify(frozenDocument()))

    const result = runCli(['--file', file, '--workspace', 'ws-1', '--card', 'thread-a:0'])

    expect(result.status).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)

    const data = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(data['kind']).toBe('dsh-evcanvas/card-provenance')
    expect(data['workspaceId']).toBe('ws-1')
    expect(data['card']).toMatchObject({ cardId: 'thread-a:0', threadId: 'thread-a', userQuestionSeq: 0, kind: 'question' })
    expect((data['source'] as Record<string, unknown>)['sessionId']).toBe('session-abc')
    // sourceSeq=0 必须原样保留：0 是合法事件序号，不是「没有来源」。
    expect((data['source'] as Record<string, unknown>)['sourceSeq']).toBe(0)
    expect((data['coverage'] as Record<string, unknown>)['nativeLogComplete']).toBe('unknown')

    // CLI 的默认输出是「来源元数据」，正文绝不外泄。
    expect(result.stdout).not.toContain(SECRET_BODY)
    expect(result.stderr).not.toContain(SECRET_BODY)
  })

  it('--help 退出 0 且不读任何快照', () => {
    const result = runCli(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('用法: why')
  })
})

describe('why CLI · 退出码契约', () => {
  it('非法参数（未知 / 重复 / 缺值）退出 2', async () => {
    const file = await makeFixtureFile('usage.json', JSON.stringify(frozenDocument()))
    const base = ['--file', file, '--workspace', 'ws-1', '--card', 'thread-a:0']

    expect(runCli([...base, '--nope']).status).toBe(2)
    expect(runCli(['--workspace', 'ws-1', '--card', 'thread-a:0']).status).toBe(2)
    expect(runCli([...base, '--workspace', 'ws-2']).status).toBe(2)
    // 少一个参数（没有 --card）
    expect(runCli(['--file', file, '--workspace', 'ws-1']).status).toBe(2)
  })

  it('快照不可读：不存在、目录、坏 JSON 都退出 3，且 stderr 不回显内容', async () => {
    const missing = join(tmpRoot, 'fixtures', 'no-such-file.json')
    const badJson = await makeFixtureFile('bad.json', `{"format": "dsh-evcanvas", "${SECRET_BODY}"`)

    const missingResult = runCli(['--file', missing, '--workspace', 'ws-1', '--card', 'thread-a:0'])
    expect(missingResult.status).toBe(3)
    expect(missingResult.stderr).toContain('无法读取快照')

    // 目录当文件：readFile 必然失败，走同一条 3。
    expect(runCli(['--file', tmpRoot, '--workspace', 'ws-1', '--card', 'thread-a:0']).status).toBe(3)

    const badResult = runCli(['--file', badJson, '--workspace', 'ws-1', '--card', 'thread-a:0'])
    expect(badResult.status).toBe(3)
    // 坏 JSON 的原文不得出现在任何输出里。
    expect(badResult.stdout).not.toContain(SECRET_BODY)
    expect(badResult.stderr).not.toContain(SECRET_BODY)
  })

  it('快照被拒绝退出 4：未知工作区、未知卡、旧版本、旧格式', async () => {
    const ok = await makeFixtureFile('reject.json', JSON.stringify(frozenDocument()))

    const unknownWorkspace = runCli(['--file', ok, '--workspace', 'ws-nope', '--card', 'thread-a:0'])
    expect(unknownWorkspace.status).toBe(4)
    expect(JSON.parse(unknownWorkspace.stdout.trim())).toEqual({ ok: false, code: 'workspace-not-found', field: 'workspaceId' })

    const unknownCard = runCli(['--file', ok, '--workspace', 'ws-1', '--card', 'thread-nope:7'])
    expect(unknownCard.status).toBe(4)
    expect(JSON.parse(unknownCard.stdout.trim())).toEqual({ ok: false, code: 'card-not-found', field: 'cardId' })

    const legacy = await makeFixtureFile('legacy.json', JSON.stringify({ version: 4, hiddenSessionIds: [], workspaces: [] }))
    expect(runCli(['--file', legacy, '--workspace', 'ws-1', '--card', 'thread-a:0']).status).toBe(4)

    const badVersion = await makeFixtureFile('bad-version.json', JSON.stringify(frozenDocument(undefined, { schemaVersion: 2 })))
    const badVersionResult = runCli(['--file', badVersion, '--workspace', 'ws-1', '--card', 'thread-a:0'])
    expect(badVersionResult.status).toBe(4)
    expect(JSON.parse(badVersionResult.stdout.trim())).toMatchObject({ ok: false, code: 'bad-version' })
  })

  it('解释模块不可用时退出 5，而不是假装成功或退回别的模块', async () => {
    const file = await makeFixtureFile('unavailable.json', JSON.stringify(frozenDocument()))
    const isolated = await mkdtemp(join(tmpRoot, 'no-module-'))
    await mkdir(join(isolated, 'scripts'))
    await cp(sourceCli, join(isolated, 'scripts/why.mjs'))
    const result = spawnSync(process.execPath, [join(isolated, 'scripts/why.mjs'), '--file', file, '--workspace', 'ws-1', '--card', 'thread-a:0'], { encoding: 'utf8' })
    expect(result.status).toBe(5)
    expect(result.stderr).toContain('解释模块不可用')
  })
})

describe('why CLI · 只读不变量', () => {
  it('跑完前后，快照与仓库文件哈希不变', async () => {
    const file = await makeFixtureFile('hash.json', JSON.stringify(frozenDocument()))
    const watched = [file, cliPath, join(repoRoot, 'src', 'server', 'provenance.ts'), join(repoRoot, 'src', 'canvas', 'model.ts')]
    const before = await Promise.all(watched.map(sha256))

    const result = runCli(['--file', file, '--workspace', 'ws-1', '--card', 'thread-a:0'])
    expect(result.status).toBe(0)

    const after = await Promise.all(watched.map(sha256))
    expect(after).toEqual(before)
  })

  it('不隐式读取 DSH_HOME：把诱饵数据放进去，输出仍只来自 --file', async () => {
    const dshHome = join(tmpRoot, 'fake-dsh-home', 'evcanvas')
    await mkdir(dshHome, { recursive: true })
    // 诱饵：一份**有效**文档，卡片来源与夹具明显不同。CLI 若偷偷读 DSH_HOME，
    // 就能解释出这张卡，测试立刻失败。
    const decoy = frozenDocument([{
      id: 'thread-decoy',
      dshSessionId: 'session-DECOY',
      parentId: null,
      messages: [userMessage(0)],
      coverage: { ranges: [], historyComplete: false, textTruncated: false },
    }])
    await writeFile(join(dshHome, 'workspaces.json'), JSON.stringify(decoy), 'utf8')

    const file = await makeFixtureFile('explicit.json', JSON.stringify(frozenDocument()))
    const env = { DSH_HOME: join(tmpRoot, 'fake-dsh-home') }

    const result = runCli(['--file', file, '--workspace', 'ws-1', '--card', 'thread-a:0'], env)
    expect(result.status).toBe(0)
    expect((JSON.parse(result.stdout.trim()) as Record<string, unknown>)['source']).toMatchObject({ sessionId: 'session-abc' })
    expect(result.stdout).not.toContain('session-DECOY')

    // 诱饵里的卡用同一份 CLI 也**必须**拒绝：输入永远是 --file 那一份。
    const decoyFile = await makeFixtureFile('decoy.json', JSON.stringify(decoy))
    expect(runCli(['--file', decoyFile, '--workspace', 'ws-1', '--card', 'thread-decoy:0']).status).toBe(0)
    expect(runCli(['--file', file, '--workspace', 'ws-1', '--card', 'thread-decoy:0']).status).toBe(4)
  })

  it('只读不写：成功与失败路径都不在 --file 所在目录新增文件', async () => {
    const dir = join(tmpRoot, 'readonly-dir')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'snapshot.json')
    await writeFile(file, JSON.stringify(frozenDocument()), 'utf8')
    const beforeNames = (await readdir(dir)).sort()

    expect(runCli(['--file', file, '--workspace', 'ws-1', '--card', 'thread-a:0']).status).toBe(0)
    expect(runCli(['--file', file, '--workspace', 'ws-1', '--card', 'thread-missing:0']).status).toBe(4)

    expect((await readdir(dir)).sort()).toEqual(beforeNames)
  })
})