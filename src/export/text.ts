// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova@3fd1d00 export/text.js，行为完整、类型标注待补。
// 来源: dsh-synapnova@3fd1d00 export/text.js

/**
 * Synapnova text snapshot exporters — Markdown and CSV.
 *
 * Pure functions only: no filesystem, no DOM, no network, no npm dependency.
 * Importing this module must never touch the host, so it can be called from the
 * server, from a test, or from a future browser surface without a shim.
 *
 * ## Snapshot shape (the only input contract)
 *
 * ```js
 * {
 *   schemaVersion: 1,                  // frozen root version, informational
 *   workspaceId: 'ws-uuid',
 *   revision: 12,                      // workspace revision at export time
 *   exportedAt: '2026-10-19T00:00:00.000Z',
 *   projection: {
 *     threads: [{
 *       id, title, dshSessionId, dshSessionTitle,
 *       messages: [{ id, text, kind, sourceSeq, at, turn, step, process: [...] }],
 *       pendingProcess: [...],
 *       coverage: { ranges: [[a, b]], historyComplete, textTruncated },
 *     }],
 *   },
 *   materials:   [{ id, name, importedAt, bytes, text }],
 *   regions:     [{ id, name, x, y, w, h }],
 *   annotations: [{ id, x, y, text, targetCardId?, targetRegionId? }],
 * }
 * ```
 *
 * Every read is defensive: a missing or malformed branch renders an explicit
 * placeholder instead of throwing, because an export is the last place where a
 * half-loaded document should produce an empty file with no explanation.
 *
 * ## What the output promises and what it must never promise
 *
 * The Markdown file carries conversation text, material text and annotation
 * text. It deliberately does NOT carry canvas geometry: it cannot restore node
 * positions, layout, viewport or card ordering on the canvas, and the exported
 * header says so in plain language. Region sizes are listed as readable facts
 * only — never as coordinates.
 *
 * Card ids follow the frozen canvas form `<threadId>:<userQuestionSeq>` owned by
 * `canvas/model.js` (0-based, projection order, only `kind === 'user'` messages
 * consume an ordinal). Injection/assistant/todo rows never advance it.
 */

import { MAX_PROJECTION_LENGTH } from '@/shared/schema'

export const DEFAULT_MAX_BODY_CHARS = MAX_PROJECTION_LENGTH
export const CSV_HEADER = ['session', 'seq', 'type', 'time', 'source', 'text']
export const CSV_BOM = '\uFEFF'
const CSV_NEWLINE = '\r\n'
const UNTITLED_SESSION = '未命名会话'

/** Inline-code span that survives a value containing backticks. */
function inlineCode(value) {
  const text = String(value)
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(longest + 1)
  return `${fence}${text}${fence}`
}

/** Fenced-block opener long enough that the body can never close it early. */
function fenceFor(text) {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** One-line clip for tool arguments/results so a dump never flattens the turn. */
function clipInline(value, limit = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const flat = String(text).replaceAll(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** Render one block of body text with truncation accounting. */
function bodyBlock(text, maxBodyChars) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const clipped = raw.length > maxBodyChars
  const shown = clipped ? raw.slice(0, maxBodyChars) : raw
  const fence = fenceFor(shown)
  const lines = [`${fence}text`, shown, fence]
  if (clipped) {
    lines.push('', `_（正文已截断：原长 ${raw.length} 字符，这里只保留前 ${maxBodyChars} 字符。）_`)
  }
  return lines.join('\n')
}

function threadsOf(snapshot) {
  const threads = snapshot?.projection?.threads
  return Array.isArray(threads) ? threads.filter(thread => thread && typeof thread === 'object') : []
}

function listOf(snapshot, field) {
  const list = snapshot?.[field]
  return Array.isArray(list) ? list.filter(item => item && typeof item === 'object') : []
}

/** Collapse a value to one line so it can never break a heading or a list item. */
function oneLine(value) {
  return String(value).replaceAll(/\s+/g, ' ').trim()
}

/** Session display title: the DSH session title wins, then the thread title. */
function displayTitle(thread) {
  for (const candidate of [thread.dshSessionTitle, thread.title]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return oneLine(candidate)
  }
  return UNTITLED_SESSION
}

function messageKind(message) {
  return typeof message.kind === 'string' && message.kind !== '' ? message.kind : 'unknown'
}

function seqOf(message) {
  return Number.isSafeInteger(message.sourceSeq) ? message.sourceSeq : null
}

/** One thread's messages in projection order, with 0-based user ordinals. */
function entriesOf(thread) {
  const messages = Array.isArray(thread.messages) ? thread.messages : []
  const entries = []
  let userQuestionSeq = 0
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const isUser = messageKind(message) === 'user'
    entries.push({
      thread,
      message,
      kind: messageKind(message),
      seq: seqOf(message),
      userQuestionSeq: isUser ? userQuestionSeq : null,
    })
    if (isUser) userQuestionSeq += 1
  }
  return entries
}

function coverageOf(thread) {
  const coverage = thread.coverage && typeof thread.coverage === 'object' ? thread.coverage : null
  const ranges = Array.isArray(coverage?.ranges)
    ? coverage.ranges.filter(range => Array.isArray(range) && range.length === 2 && Number.isSafeInteger(range[0]) && Number.isSafeInteger(range[1]))
    : []
  return {
    ranges,
    // A thread with no coverage record cannot claim completeness.
    historyComplete: coverage?.historyComplete === true,
    textTruncated: coverage?.textTruncated === true,
  }
}

function formattedRanges(ranges) {
  if (ranges.length === 0) return '（没有可声明的事件序号区间）'
  return ranges.map(range => `[${range[0]}, ${range[1]}]`).join('、')
}

/**
 * Group threads by session and sort each group by event sequence.
 *
 * Grouping key is the DSH session id when present; a thread without one is its
 * own group keyed by thread id. Groups keep first-seen order so an export of an
 * unchanged revision is byte-stable. Sorting is stable, so rows that carry no
 * `sourceSeq` keep projection order relative to each other and land last.
 */
function buildGroups(snapshot) {
  const groups = []
  const byKey = new Map()
  for (const thread of threadsOf(snapshot)) {
    const dshSessionId = typeof thread.dshSessionId === 'string' && thread.dshSessionId !== '' ? thread.dshSessionId : null
    const key = dshSessionId === null ? `thread:${String(thread.id ?? '')}` : `dsh:${dshSessionId}`
    let group = byKey.get(key)
    if (group === undefined) {
      group = { key, threads: [], entries: [], title: '', dshSessionId: null }
      byKey.set(key, group)
      groups.push(group)
    }
    group.threads.push(thread)
    group.entries.push(...entriesOf(thread))
    if (group.title === '') group.title = displayTitle(thread)
    if (group.dshSessionId === null && dshSessionId !== null) group.dshSessionId = dshSessionId
  }
  for (const group of groups) {
    group.entries.sort((left, right) => {
      const a = left.seq === null ? Number.POSITIVE_INFINITY : left.seq
      const b = right.seq === null ? Number.POSITIVE_INFINITY : right.seq
      if (a === b) return 0
      return a < b ? -1 : 1
    })
    const ranges = []
    let historyComplete = true
    let textTruncated = false
    for (const thread of group.threads) {
      const coverage = coverageOf(thread)
      if (!coverage.historyComplete) historyComplete = false
      if (coverage.textTruncated) textTruncated = true
      ranges.push(...coverage.ranges)
    }
    group.coverage = { ranges, historyComplete, textTruncated }
  }
  return groups
}

function processesOf(message) {
  return (Array.isArray(message.process) ? message.process : []).filter(entry => entry && typeof entry === 'object')
}

function renderProcessList(processes) {
  const lines = []
  for (const process of processes) {
    const name = typeof process.name === 'string' && process.name !== '' ? process.name : '未命名工具'
    const callId = typeof process.callId === 'string' && process.callId !== '' ? `（callId ${inlineCode(process.callId)}）` : ''
    lines.push(`- **${name}**${callId}`)
    if (process.arguments !== undefined && process.arguments !== null) lines.push(`  - 参数：${clipInline(process.arguments)}`)
    if (process.result !== undefined && process.result !== null) lines.push(`  - 结果：${clipInline(process.result)}`)
    if (process.error !== undefined && process.error !== null) lines.push(`  - 错误：${clipInline(process.error)}`)
  }
  return lines
}

function renderDetails(summary, lines) {
  return [`<details><summary>${summary}</summary>`, '', ...lines, '', '</details>'].join('\n')
}

/** One turn: the user question, its answers, then every tool record folded. */
function renderTurnLines(turn, ordinal, maxBodyChars) {
  const { entry } = turn
  const cardId = `${String(entry.thread.id ?? '')}:${entry.userQuestionSeq}`
  const lines = [`### 轮次 ${ordinal}（卡片 ${inlineCode(cardId)}）`, '']
  lines.push('**问**', '', bodyBlock(entry.message.text, maxBodyChars), '')

  const processes = []
  for (const item of turn.body) {
    if (item.kind === 'assistant') {
      lines.push('**答**', '', bodyBlock(item.message.text, maxBodyChars), '')
    } else {
      lines.push(`**${item.kind}**`, '', bodyBlock(item.message.text, maxBodyChars), '')
    }
    processes.push(...processesOf(item.message))
  }
  processes.push(...processesOf(entry.message))
  if (processes.length > 0) {
    lines.push(renderDetails(`工具记录 ${processes.length} 条`, renderProcessList(processes)), '')
  }
  return lines
}

function renderGroupLines(group, index, maxBodyChars) {
  const lines = [`## 会话 ${index + 1}：${group.title}`, '']
  if (group.dshSessionId !== null) lines.push(`- 会话 ID：${inlineCode(group.dshSessionId)}`)
  else lines.push('- 会话 ID：（未关联 DSH 会话）')
  for (const thread of group.threads) {
    lines.push(`- 线程：${inlineCode(String(thread.id ?? ''))}`)
  }
  lines.push('')

  if (!group.coverage.historyComplete) {
    lines.push(`> ⚠ 覆盖不完整：本导出只覆盖部分历史。已覆盖的事件序号区间：${formattedRanges(group.coverage.ranges)}。`)
    lines.push('')
  } else if (group.coverage.textTruncated) {
    lines.push('> 提示：部分超长正文在投影阶段已被截断，原文请回到 DSH 会话查看。')
    lines.push('')
  }

  const turns = []
  let current = null
  const preamble = []
  for (const entry of group.entries) {
    if (entry.kind === 'user') {
      current = { entry, body: [] }
      turns.push(current)
      continue
    }
    if (current === null) preamble.push(entry)
    else current.body.push(entry)
  }

  if (preamble.length > 0) {
    lines.push('### 会话开始前的记录', '')
    for (const entry of preamble) {
      lines.push(`**${entry.kind}**`, '', bodyBlock(entry.message.text, maxBodyChars), '')
    }
  }
  turns.forEach((turn, ordinal) => {
    lines.push(...renderTurnLines(turn, ordinal + 1, maxBodyChars))
  })
  if (turns.length === 0 && preamble.length === 0) {
    lines.push('_（该会话没有已投影的消息。）_', '')
  }

  const pending = group.threads.flatMap(thread => (Array.isArray(thread.pendingProcess) ? thread.pendingProcess : []))
    .filter(entry => entry && typeof entry === 'object')
  if (pending.length > 0) {
    lines.push(renderDetails(`未完成的工具记录 ${pending.length} 条`, renderProcessList(pending)), '')
  }
  return lines
}

function renderMaterials(snapshot, maxBodyChars) {
  const materials = listOf(snapshot, 'materials')
  const lines = [`## 材料（${materials.length} 项）`, '']
  if (materials.length === 0) {
    lines.push('_（没有材料。）_', '')
    return lines
  }
  materials.forEach((material, index) => {
    const name = typeof material.name === 'string' && material.name.trim() !== '' ? oneLine(material.name) : `材料 ${index + 1}`
    lines.push(`### ${index + 1}. ${name}`, '')
    if (Number.isSafeInteger(material.bytes)) lines.push(`- 字节数：${material.bytes}`)
    if (typeof material.importedAt === 'string' && material.importedAt !== '') lines.push(`- 导入时间：${inlineCode(material.importedAt)}`)
    lines.push('', bodyBlock(material.text, maxBodyChars), '')
  })
  return lines
}

function renderRegions(snapshot) {
  const regions = listOf(snapshot, 'regions')
  const lines = [`## 分区（${regions.length} 项）`, '']
  if (regions.length === 0) {
    lines.push('_（没有分区。）_', '')
    return lines
  }
  // Sizes are readable facts; the origin is intentionally not exported.
  for (const region of regions) {
    const name = typeof region.name === 'string' && region.name !== '' ? oneLine(region.name) : inlineCode(String(region.id ?? ''))
    const size = Number.isFinite(region.w) && Number.isFinite(region.h) ? `：${region.w}×${region.h}` : ''
    lines.push(`- ${name}${size}`)
  }
  lines.push('')
  return lines
}

function renderAnnotations(snapshot) {
  const annotations = listOf(snapshot, 'annotations')
  const regions = listOf(snapshot, 'regions')
  const regionNames = new Map()
  for (const region of regions) {
    if (typeof region.id === 'string') regionNames.set(region.id, typeof region.name === 'string' && region.name !== '' ? oneLine(region.name) : region.id)
  }
  const lines = [`## 批注（${annotations.length} 条）`, '']
  if (annotations.length === 0) {
    lines.push('_（没有批注。）_', '')
    return lines
  }
  for (const annotation of annotations) {
    const text = typeof annotation.text === 'string' ? annotation.text : ''
    if (typeof annotation.targetCardId === 'string' && annotation.targetCardId !== '') {
      lines.push(`- → 卡片 ${inlineCode(annotation.targetCardId)}：${text}`)
    } else if (typeof annotation.targetRegionId === 'string' && annotation.targetRegionId !== '') {
      const name = regionNames.get(annotation.targetRegionId)
      lines.push(`- → 分区${name === undefined ? ` ${inlineCode(annotation.targetRegionId)}` : `「${name}」`}：${text}`)
    } else {
      lines.push(`- → （未指定目标）：${text}`)
    }
  }
  lines.push('')
  return lines
}

/**
 * Render a workspace snapshot as one Markdown document.
 *
 * @param {object} snapshot workspace snapshot (see the module header)
 * @param {{ maxBodyChars?: number }} [options]
 * @returns {string}
 */
export function toMarkdown(snapshot, options = {}) {
  const maxBodyChars = Number.isSafeInteger(options?.maxBodyChars) && options.maxBodyChars > 0
    ? options.maxBodyChars
    : DEFAULT_MAX_BODY_CHARS
  const groups = buildGroups(snapshot)
  const workspaceId = typeof snapshot?.workspaceId === 'string' && snapshot.workspaceId !== '' ? snapshot.workspaceId : '（未指定）'
  const exportedAt = typeof snapshot?.exportedAt === 'string' && snapshot.exportedAt !== '' ? snapshot.exportedAt : '（未指定）'
  const revision = Number.isSafeInteger(snapshot?.revision) ? String(snapshot.revision) : '（未指定）'
  const schemaVersion = Number.isSafeInteger(snapshot?.schemaVersion) ? String(snapshot.schemaVersion) : '（未指定）'

  const lines = [
    '# Synapnova 导出快照',
    '',
    `- 工作区：${inlineCode(workspaceId)}`,
    `- 修订：${revision}`,
    `- 导出时间：${inlineCode(exportedAt)}`,
    `- schemaVersion：${schemaVersion}`,
    `- 会话数：${groups.length}`,
    '',
    '> 说明：本文件是文本快照，只包含会话投影、材料与批注的文字内容。它不包含画布坐标，',
    '> 因此无法据此还原节点位置、布局、视口或卡片排布；请把它当作阅读与检索用的副本。',
    '',
  ]

  const incomplete = groups.filter(group => !group.coverage.historyComplete)
  if (incomplete.length > 0) {
    lines.push('## 覆盖完整性', '', '> ⚠ 本导出只覆盖部分历史。下列会话的历史不完整，已覆盖的事件序号区间如下：', '')
    for (const group of incomplete) {
      lines.push(`> - ${group.title}（${group.dshSessionId === null ? '未关联会话' : inlineCode(group.dshSessionId)}）：${formattedRanges(group.coverage.ranges)}`)
    }
    lines.push('')
  }

  if (groups.length === 0) {
    lines.push('## 会话', '', '_（这个工作区没有已投影的会话。）_', '')
  } else {
    groups.forEach((group, index) => {
      lines.push(...renderGroupLines(group, index, maxBodyChars))
    })
  }

  lines.push(...renderMaterials(snapshot, maxBodyChars))
  lines.push(...renderRegions(snapshot))
  lines.push(...renderAnnotations(snapshot))
  return lines.join('\n')
}

const NUMERIC_AFTER_SIGN = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/**
 * Spreadsheet formula-injection guard.
 *
 * A cell whose first meaningful character is one of `=`, `@`, tab or carriage
 * return is executed as a formula by spreadsheet software, so it is prefixed
 * with an apostrophe and stays literal text. A leading `+` or `-` is only
 * dangerous when what follows is NOT a plain number: `+41`, `-41`, `-41.5` and
 * `+1e3` are ordinary values and are preserved untouched, while `-1+2` is a
 * formula and gets quoted. Leading spaces are skipped for the decision but the
 * original text (including those spaces) is what ends up in the cell.
 *
 * @param {unknown} value raw cell value
 * @returns {boolean} true when the value must be quoted as text
 */
export function needsFormulaGuard(value) {
  const text = value === null || value === undefined ? '' : String(value)
  let index = 0
  while (index < text.length && (text[index] === ' ' || text[index] === '\u00A0')) index += 1
  const first = text[index]
  if (first === undefined) return false
  if (first === '=' || first === '@' || first === '\t' || first === '\r') return true
  if (first === '+' || first === '-') return !NUMERIC_AFTER_SIGN.test(text.slice(index + 1))
  return false
}

/** RFC 4180 field escaping: quote when the field holds a quote, comma or break. */
export function escapeCsvField(value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (!/[",\r\n]/.test(text)) return text
  return `"${text.replaceAll('"', '""')}"`
}

/** One CSV cell: formula guard first, then RFC 4180 escaping. */
export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return escapeCsvField(needsFormulaGuard(text) ? `'${text}` : text)
}

/**
 * Render the projected events of a workspace snapshot as RFC 4180 CSV.
 *
 * One row per projected message, ordered by session group then ascending
 * `sourceSeq` — the same order the Markdown export uses. The file starts with a
 * UTF-8 BOM so spreadsheet software detects UTF-8 without a manual import step,
 * uses CRLF row endings, and carries only already-projected text: no
 * credentials, no host paths, no layout data.
 *
 * @param {object} snapshot workspace snapshot (see the module header)
 * @returns {string}
 */
export function toCsv(snapshot) {
  const rows = [CSV_HEADER.join(',')]
  for (const group of buildGroups(snapshot)) {
    for (const entry of group.entries) {
      const source = typeof entry.thread.dshSessionId === 'string' && entry.thread.dshSessionId !== ''
        ? entry.thread.dshSessionId
        : (typeof entry.thread.id === 'string' ? entry.thread.id : '')
      rows.push([
        csvCell(group.title),
        csvCell(entry.seq === null ? '' : entry.seq),
        csvCell(entry.kind),
        csvCell(typeof entry.message.at === 'string' ? entry.message.at : ''),
        csvCell(source),
        csvCell(typeof entry.message.text === 'string' ? entry.message.text : ''),
      ].join(','))
    }
  }
  return `${CSV_BOM}${rows.join(CSV_NEWLINE)}${CSV_NEWLINE}`
}
