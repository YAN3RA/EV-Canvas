#!/usr/bin/env node
/**
 * why — 只读卡片来源 CLI（S3-8）
 *
 * 用法：
 *   why --file <snapshot.json> --workspace <id> --card <stableCardId>
 *   why --help
 *
 * 它做的事只有一件：从**调用方显式给出的**冻结投影快照里，解释**一张卡片**
 * 的来源（sessionId / sourceSeq / 父链 / coverage 标记），以一行 JSON 写到
 * stdout。默认只输出这份来源元数据，**不输出正文或工具内容**。
 *
 * 明确的边界（都直接影响本脚本的可用范围，别把它当成完整的 why 图）：
 *   - 只支持当前冻结完整文档（`format: 'dsh-evcanvas'` + `schemaVersion: 1`
 *     + 顶层 `workspaces`）。旧版 v1–v4 文档、单工作区信封、projection 片段
 *     一律**明确拒绝**，不做猜测式兼容。
 *   - `--workspace` 与 `--card` 必须显式指定；没有任何默认值，也不会去猜
 *     「当前工作区 / 最近卡片」。
 *   - 不读 `DSH_HOME`、不读用户数据目录、不访问网络、不写任何文件、
 *     不调用模型；唯一读入的字节是 `--file` 指定的这一份快照。
 *   - 不加载 `WorkspaceStore`：本脚本只做解释，不做持久化。
 *   - 出错时 stderr 只给机器码 / 字段名 / 路径，**不回显快照内容**。
 *
 * 退出码（稳定契约，供脚本化调用判断）：
 *   0 成功
 *   2 用法错误（缺参数、未知参数、重复参数）
 *   3 快照不可读（文件不存在 / 读失败 / 不是合法 JSON）
 *   4 快照被拒绝（格式、版本、重复 id、工作区不存在、卡片不存在）
 *   5 解释模块不可用（dist 未构建，需要 lead 先构建）
 */

import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 稳定退出码。 */
const EXIT = Object.freeze({
  ok: 0,
  usage: 2,
  input: 3,
  rejected: 4,
  unavailable: 5,
})

/** 拒绝码 → 面向人的一句话（只描述原因，不含快照内容）。 */
const REJECT_TEXT = Object.freeze({
  'not-an-object': '快照根必须是对象',
  'bad-format': "只支持 format 为 'dsh-evcanvas' 的冻结完整文档；旧格式或单工作区信封请勿直接解释",
  'bad-version': '只支持 schemaVersion 为 1 的冻结文档',
  'ambiguous-card-id': '多个实体派生相同卡片标识，无法确定来源',
  'duplicate-id': '快照内部存在重复实体 id，结论不可信',
  'invalid-document': '快照未通过冻结 schema 校验',
  'workspace-required': '必须显式指定 --workspace',
  'card-required': '必须显式指定 --card',
  'workspace-not-found': '该 workspace 不在这份快照里',
  'card-not-found': '该 stableCardId 不在这份快照的该 workspace 里',
})

const USAGE = `用法: why --file <snapshot.json> --workspace <id> --card <stableCardId>

  --file         冻结投影快照（当前格式 dsh-evcanvas schemaVersion 1）
  --workspace    工作区 id（必填，不猜默认值）
  --card         稳定卡片 id，形如 <threadId>:<userQuestionSeq>（必填）
  --help         显示本帮助

只输出一行 JSON 来源元数据，不含正文与工具内容；永不写文件、不读 DSH_HOME、不发网络。`

/** 带机器码的用法错误。 */
class UsageError extends Error {}

/**
 * 解析 `--k v` 与 `--k=v`。
 *
 * 未知参数与重复参数都**明确报错**：让「后一个覆盖前一个」这种静默歧义不可能发生
 * ——脚本化调用里静默覆盖最危险，它会让一条看起来成功的命令用的是别的 workspace。
 */
function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') return { help: true, values }
    if (typeof token !== 'string' || !token.startsWith('--')) throw new UsageError(`不认识的参数：${String(token)}`)
    const equal = token.indexOf('=')
    const key = equal === -1 ? token : token.slice(0, equal)
    if (!['--file', '--workspace', '--card'].includes(key)) throw new UsageError(`不认识的参数：${key}`)
    let value
    if (equal === -1) {
      value = argv[index + 1]
      if (value === undefined || String(value).startsWith('--')) throw new UsageError(`${key} 缺少取值`)
      index += 1
    } else {
      value = token.slice(equal + 1)
      if (value === '') throw new UsageError(`${key} 缺少取值`)
    }
    const name = key.slice(2)
    if (Object.hasOwn(values, name)) throw new UsageError(`${key} 重复指定`)
    values[name] = String(value)
  }
  return { help: false, values }
}

/** 入口：把「解析参数 → 读快照 → 调解释层 → 打印」串起来；导出以便测试直接驱动。 */
export async function run(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    io.stderr.write(`why: ${error.message}\n${USAGE}\n`)
    return EXIT.usage
  }
  if (parsed.help) {
    io.stdout.write(`${USAGE}\n`)
    return EXIT.ok
  }
  const { file, workspace, card } = parsed.values
  for (const [flag, value] of [['--file', file], ['--workspace', workspace], ['--card', card]]) {
    if (typeof value !== 'string' || value === '') {
      io.stderr.write(`why: 缺少必填参数 ${flag}\n${USAGE}\n`)
      return EXIT.usage
    }
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const serverDir = resolve(here, '..', 'dist', 'server')
  const entry = join(serverDir, 'provenance.js')
  if (!existsSync(entry)) {
    io.stderr.write(`why: 解释模块不可用（未找到 ${entry}），请先构建 dsh-evcanvas\n`)
    return EXIT.unavailable
  }

  const filePath = resolve(file)
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    // 不把读取异常原文拼进来（可能含路径以外的内容），只报用户自己给的路径。
    io.stderr.write(`why: 无法读取快照：${filePath}\n`)
    return EXIT.input
  }
  let document
  try {
    document = JSON.parse(raw)
  } catch {
    io.stderr.write(`why: 快照不是合法 JSON：${filePath}\n`)
    return EXIT.input
  }

  let readProvenance
  try {
    ;({ readProvenance } = await import(pathToFileURL(entry).href))
    if (typeof readProvenance !== 'function') {
      io.stderr.write(`why: 解释模块未导出 readProvenance（${entry}）\n`)
      return EXIT.unavailable
    }
  } catch (error) {
    io.stderr.write(`why: 载入解释模块失败（${entry}）：${error instanceof Error ? error.message : 'unknown'}\n`)
    return EXIT.unavailable
  }

  let result
  try { result = readProvenance({ document, workspaceId: workspace, cardId: card }) }
  catch {
    io.stderr.write('why: 快照解释失败，未输出来源结论\n')
    return EXIT.rejected
  }
  if (result.ok !== true) {
    // 拒绝结果也是机器可读 JSON，写到 stdout；人话提示走 stderr。
    io.stdout.write(`${JSON.stringify({ ok: false, code: result.code, field: result.field ?? null })}\n`)
    io.stderr.write(`why: ${REJECT_TEXT[result.code] ?? result.code}${result.field === undefined ? '' : `（字段 ${result.field}）`}\n`)
    return EXIT.rejected
  }
  io.stdout.write(`${JSON.stringify(result.data)}\n`)
  return EXIT.ok
}

// 仅在被直接执行时运行；被 import（测试夹具）时不自动跑。
const invokedDirectly = await (async () => {
  const invoked = process.argv[1]
  if (typeof invoked !== 'string') return false
  try { return await realpath(invoked) === await realpath(fileURLToPath(import.meta.url)) }
  catch { return false }
})()

if (invokedDirectly) {
  // 用 exitCode 而不是 process.exit：Windows 上 stdout 走管道时写入是异步的，
  // 立刻 exit 会把刚写的那行 JSON 截断，脚本化调用拿到半个对象。
  process.exitCode = await run()
}

export { EXIT, USAGE, parseArgs }