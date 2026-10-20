// @ts-nocheck -- TODO(types): 迁移自 dsh-synapnova@3fd1d00 shared/migration.js，行为完整、类型标注待补。
// 来源: dsh-synapnova@3fd1d00 shared/migration.js

/** Explicit v4 migration planning. No filesystem, browser storage or host calls. */
import { FROZEN_FORMAT, FROZEN_SCHEMA_VERSION, InputError, PROJECTION_TRUNCATED_SUFFIX, normalizeFrozenState, isoDate } from './schema'

const WS_FIELDS = ['id', 'kind', 'dshWorkspaceId', 'cwd', 'title', 'createdAt', 'updatedAt']
const THREAD_FIELDS = ['id', 'title', 'parentId', 'sourceParentSessionId', 'sourceSeedLength', 'dshSessionId', 'dshSessionTitle', 'color', 'createdAt', 'updatedAt']
const MESSAGE_FIELDS = ['id', 'text', 'kind', 'sourceSeq', 'at', 'turn', 'step']
const PROCESS_FIELDS = ['callId', 'turn', 'step', 'name', 'arguments', 'result', 'error']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const seq = value => Number.isSafeInteger(value) && value >= 0
const fail = message => { throw new InputError(`迁移源非法：${message}`) }
const requiredId = (value, label) => { if (typeof value !== 'string' || value === '') fail(`${label} 必须是非空字符串`) }
const array = (value, label) => { if (!Array.isArray(value)) fail(`${label} 必须是数组`) }
const position = (value, label) => {
  if (!object(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) fail(`${label} 必须包含有限坐标`)
  return { x: value.x, y: value.y }
}

function pick(value, fields, path, warnings, extras = []) {
  if (!object(value)) fail(`${path} 必须是对象`)
  const result = {}
  for (const key of fields) if (Object.hasOwn(value, key) && value[key] !== undefined) result[key] = structuredClone(value[key])
  for (const key of Object.keys(value)) {
    if (!fields.includes(key) && !extras.includes(key)) warnings.push({ code: 'unknown-field', path: `${path}.${key}`, message: '未知字段不进入新文档；原字节保留在备份' })
  }
  return result
}

function processList(value, path, warnings) {
  if (value === undefined) return []
  array(value, path)
  return value.map((entry, index) => pick(entry, PROCESS_FIELDS, `${path}[${index}]`, warnings))
}

function rangesFor(messages) {
  const result = []
  for (const value of messages.map(message => message.sourceSeq).sort((a, b) => a - b)) {
    const last = result.at(-1)
    if (last && value === last[1] + 1) last[1] = value
    else result.push([value, value])
  }
  return result
}

/**
 * browserLayout: { positions: [[legacyCardId,{x,y}]], collapsed: [legacyCardId],
 *                  branchAnchors?: [[sessionId,legacyCardId]] }.
 * Supply an explicit snapshot, never a storage object. Unknown/stale keys block
 * commit rather than guessing by array index. Both aliases may map to one card
 * only when their stored positions agree.
 */
export function buildMigrationPlan({ legacyState, browserLayout, hostWorkspaces = [], now } = {}) {
  if (!object(legacyState) || legacyState.version !== 4 || Object.hasOwn(legacyState, 'format') || Object.hasOwn(legacyState, 'schemaVersion')) {
    fail('本迁移仅接受 version:4；v1/v2/v3 与已有 canonical 文档不属于本迁移')
  }
  array(legacyState.workspaces, 'workspaces')
  array(legacyState.hiddenSessionIds, 'hiddenSessionIds')
  array(hostWorkspaces, 'hostWorkspaces')
  if (!legacyState.hiddenSessionIds.every(id => typeof id === 'string')) fail('hiddenSessionIds 只能包含字符串')
  const warnings = [], ambiguities = [], mapping = []
  const updatedAt = now ?? legacyState.updatedAt ?? legacyState.workspaces[0]?.updatedAt
  try { isoDate(updatedAt, 'updatedAt') } catch (error) { fail(error.message) }
  const issue = (code, path, message) => ambiguities.push({ code, path, message })
  pick(legacyState, ['version', 'hiddenSessionIds', 'workspaces', 'updatedAt'], '$', warnings)
  const workspaceIds = new Set(), threadIds = new Set(), sessionIds = new Set(), aliases = new Map()
  const counts = { workspaces: legacyState.workspaces.length, sessions: 0, cards: 0, messages: 0, materials: 0, positions: 0, collapsed: 0 }
  const document = { format: FROZEN_FORMAT, schemaVersion: FROZEN_SCHEMA_VERSION, updatedAt, hiddenSessionIds: [...legacyState.hiddenSessionIds], idempotency: {}, idempotencyFloor: null, workspaces: [] }
  function alias(key, target) {
    const values = aliases.get(key) ?? []
    values.push(target)
    aliases.set(key, values)
  }
  for (const [wi, source] of legacyState.workspaces.entries()) {
    const path = `workspaces[${wi}]`
    const workspace = pick(source, WS_FIELDS, path, warnings, ['threads'])
    requiredId(workspace.id, `${path}.id`)
    if (workspaceIds.has(workspace.id)) fail(`重复的 workspace id: ${workspace.id}`)
    workspaceIds.add(workspace.id)
    array(source.threads, `${path}.threads`)
    workspace.kind ??= 'manual'
    workspace.cwd ??= null
    workspace.dshWorkspaceId ??= null
    if (workspace.kind === 'dsh' && workspace.dshWorkspaceId === null) {
      const candidates = hostWorkspaces.filter(host => object(host) && typeof host.id === 'string' && host.id !== '' && (host.path ?? host.cwd ?? null) === workspace.cwd)
      if (candidates.length === 1 && workspace.cwd !== null) workspace.dshWorkspaceId = candidates[0].id
      else issue('workspace-ownership', path, `cwd 对应 ${candidates.length} 个宿主工作区，无法唯一映射`)
    }
    workspace.revision = 1
    workspace.projectionEpoch = 1
    workspace.projection = { threads: [] }
    workspace.layout = { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } }
    workspace.materials = []; workspace.regions = []; workspace.annotations = []
    for (const [ti, value] of source.threads.entries()) {
      const tp = `${path}.threads[${ti}]`
      const thread = pick(value, THREAD_FIELDS, tp, warnings, ['position', 'messages', 'pendingProcess'])
      requiredId(thread.id, `${tp}.id`)
      if (threadIds.has(thread.id)) fail(`重复的 thread id: ${thread.id}`)
      if (['__proto__', 'constructor', 'prototype'].includes(thread.id)) fail('thread.id 不能是原型属性名')
      threadIds.add(thread.id)
      if (thread.dshSessionId != null) {
        requiredId(thread.dshSessionId, `${tp}.dshSessionId`)
        if (sessionIds.has(thread.dshSessionId)) issue('session-duplicate', tp, '同一宿主 session 对应多个 thread')
        sessionIds.add(thread.dshSessionId)
        counts.sessions += 1
      }
      array(value.messages, `${tp}.messages`)
      const messageIds = new Set(), seqs = new Set()
      thread.messages = value.messages.map((entry, mi) => {
        const mp = `${tp}.messages[${mi}]`
        const message = pick(entry, MESSAGE_FIELDS, mp, warnings, ['process'])
        requiredId(message.id, `${mp}.id`)
        if (messageIds.has(message.id)) fail(`重复的 message id: ${message.id}`)
        messageIds.add(message.id)
        if (!seq(message.sourceSeq)) fail(`${mp}.sourceSeq 必须是非负安全整数`)
        if (seqs.has(message.sourceSeq)) fail(`重复的事件键 seq: ${message.sourceSeq}`)
        seqs.add(message.sourceSeq)
        if (typeof message.text !== 'string') fail(`${mp}.text 必须是字符串`)
        if (!['user', 'assistant', 'error', 'tool', 'tool-result'].includes(message.kind)) fail(`${mp}.kind 非法`)
        try { isoDate(message.at, `${mp}.at`) } catch (error) { fail(error.message) }
        if (Object.hasOwn(entry, 'process')) message.process = processList(entry.process, `${mp}.process`, warnings)
        return message
      })
      if (thread.messages.some((message, index) => index > 0 && message.sourceSeq < thread.messages[index - 1].sourceSeq)) issue('event-order', tp, '消息数组未按来源 seq 排序，无法证明 turn-index 对应问题序号')
      thread.pendingProcess = processList(value.pendingProcess, `${tp}.pendingProcess`, warnings)
      if (thread.messages.some(message => message.kind === 'tool' || message.kind === 'tool-result')) issue('legacy-tool-card', tp, 'v4 含独立工具卡，无法证明唯一工具关联，未按相邻顺序猜配')
      thread.coverage = { ranges: rangesFor(thread.messages), historyComplete: false, textTruncated: thread.messages.some(message => message.text.endsWith(PROJECTION_TRUNCATED_SUFFIX) || message.text.length >= 8000) }
      counts.messages += thread.messages.length
      counts.cards += 1 + thread.messages.filter(message => message.kind === 'user').length
      if (value.position !== undefined) Object.defineProperty(workspace.layout.cards, thread.id, { value: position(value.position, `${tp}.position`), enumerable: true, writable: true, configurable: true })
      alias(thread.id, { workspace, cardId: thread.id })
      let questionIndex = 0
      for (const message of thread.messages) {
        if (message.kind !== 'user') continue
        const cardId = `${thread.id}:${questionIndex}`
        const target = { workspace, cardId }
        alias(`${thread.id}:turn:${message.sourceSeq}`, target)
        alias(`${thread.id}:turn-index:${questionIndex}`, target)
        mapping.push({ workspaceId: workspace.id, threadId: thread.id, sourceSeq: message.sourceSeq, userQuestionSeq: questionIndex, cardId })
        questionIndex += 1
      }
      workspace.projection.threads.push(thread)
    }
    const localIds = new Set(workspace.projection.threads.map(thread => thread.id))
    for (const thread of workspace.projection.threads) {
      if (thread.parentId != null && !localIds.has(thread.parentId)) issue('parent-missing', `${path}.${thread.id}`, 'parentId 不在同一工作区')
      const visited = new Set([thread.id]); let parent = thread.parentId
      while (parent != null && localIds.has(parent)) {
        if (visited.has(parent)) { issue('parent-cycle', `${path}.${thread.id}`, '线程血缘存在环'); break }
        visited.add(parent)
        parent = workspace.projection.threads.find(item => item.id === parent)?.parentId
      }
    }
    document.workspaces.push(workspace)
  }
  const hostBindings = new Set()
  for (const workspace of document.workspaces) {
    if (workspace.kind !== 'dsh' || workspace.dshWorkspaceId === null) continue
    if (hostBindings.has(workspace.dshWorkspaceId)) issue('workspace-duplicate-binding', workspace.id, '多个旧工作区对应同一宿主工作区，未合并或猜配')
    hostBindings.add(workspace.dshWorkspaceId)
  }
  if (browserLayout !== undefined) applyBrowserLayout({ aliases, browserLayout, counts, issue, warnings })
  if (browserLayout === undefined) warnings.push({ code: 'browser-layout-not-supplied', path: 'browserLayout', message: '未提供浏览器布局快照；仅迁移服务端线程坐标，浏览器布局未覆盖且旧字节保留' })
  return { document, counts, countsMeaning: { cards: '线程锚点与用户问题身份数合计，不是当前渲染卡数' }, ambiguities, warnings, mapping, canCommit: ambiguities.length === 0 }
}

/** Merge explicitly supplied legacy entries into one existing canonical layout. */
export function buildLayoutMigrationPlan({ document, workspaceId, browserLayout } = {}) {
  const state = normalizeFrozenState(document).state
  const selected = state.workspaces.find(workspace => workspace.id === workspaceId)
  if (!selected) fail('所选工作区不存在')
  if (browserLayout === undefined) fail('必须提供 browserLayout 显式快照')
  const aliases = new Map(), mapping = [], warnings = [], ambiguities = []
  const counts = { workspaces: 1, sessions: 0, cards: 0, materials: selected.materials.length, positions: 0, collapsed: 0, skipped: 0 }
  const alias = (key, target) => {
    const values = aliases.get(key) ?? []
    if (!values.some(value => value.workspace.id === target.workspace.id && value.cardId === target.cardId)) values.push(target)
    aliases.set(key, values)
  }
  for (const workspace of state.workspaces) for (const thread of workspace.projection.threads) {
    alias(thread.id, { workspace, cardId: thread.id })
    if (workspace === selected) { counts.cards += 1; if (thread.dshSessionId) counts.sessions += 1 }
    let index = 0
    for (const message of thread.messages) {
      if (message.kind !== 'user') continue
      const cardId = `${thread.id}:${index}`, target = { workspace, cardId }
      alias(cardId, target)
      alias(`${thread.id}:turn-index:${index}`, target)
      if (seq(message.sourceSeq)) alias(`${thread.id}:turn:${message.sourceSeq}`, target)
      if (workspace === selected) { counts.cards += 1; mapping.push({ workspaceId, threadId: thread.id, sourceSeq: message.sourceSeq, userQuestionSeq: index, cardId }) }
      index += 1
    }
  }
  applyBrowserLayout({ aliases, browserLayout, counts, warnings, workspaceId, issue: (code, path, message) => ambiguities.push({ code, path, message }) })
  // This plan deliberately has no whole-document candidate.
  return { workspaceId, baseRevision: selected.revision, projectionEpoch: selected.projectionEpoch, layout: selected.layout, counts, countsMeaning: { cards: '所选工作区线程锚点与用户问题身份数；skipped为唯一归属其他工作区的布局条目' }, ambiguities, warnings, mapping, canCommit: ambiguities.length === 0 }
}

function applyBrowserLayout({ aliases, browserLayout, counts, issue, warnings, workspaceId }) {
  if (!object(browserLayout)) fail('browserLayout 必须是显式快照对象')
  for (const key of Object.keys(browserLayout)) if (!['positions', 'collapsed', 'branchAnchors', 'raw'].includes(key)) fail(`不支持的 browserLayout 字段 ${key}`)
  if (browserLayout.raw !== undefined) {
    if (!object(browserLayout.raw) || Object.values(browserLayout.raw).some(value => value !== null && typeof value !== 'string')) fail('browserLayout.raw 必须是原始字符串或 null 的键值表')
    warnings.push({ code: 'raw-browser-backup', path: 'browserLayout.raw', message: '原始浏览器键值仅备份，不按未知旧格式猜配布局' })
  }
  const resolved = key => {
    const targets = aliases.get(key) ?? []
    if (targets.length !== 1) { issue('card-mapping', key, `旧卡片键对应 ${targets.length} 个目标，未猜配`); return null }
    const target = targets[0]
    if (workspaceId !== undefined && target.workspace.id !== workspaceId) {
      counts.skipped += 1
      warnings.push({ code: 'other-workspace', path: key, message: '唯一归属其他工作区，本次不改动；可切换后另行预览' })
      return null
    }
    return target
  }
  const storedPositions = new Map()
  array(browserLayout.positions ?? [], 'browserLayout.positions')
  for (const entry of browserLayout.positions ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') fail('positions 每项必须是 [cardId,{x,y}]')
    const point = position(entry[1], entry[0]), target = resolved(entry[0])
    if (!target) continue
    const key = JSON.stringify([target.workspace.id, target.cardId]), previous = storedPositions.get(key)
    if (previous && (previous.x !== point.x || previous.y !== point.y)) { issue('position-conflict', entry[0], '同一卡片的旧别名坐标冲突'); continue }
    storedPositions.set(key, point)
    Object.defineProperty(target.workspace.layout.cards, target.cardId, { value: point, enumerable: true, writable: true, configurable: true })
    counts.positions += 1
  }
  array(browserLayout.collapsed ?? [], 'browserLayout.collapsed')
  for (const key of browserLayout.collapsed ?? []) {
    requiredId(key, 'collapsed cardId')
    const target = resolved(key)
    if (target) { Object.defineProperty(target.workspace.layout.collapsed, target.cardId, { value: true, enumerable: true, writable: true, configurable: true }); counts.collapsed += 1 }
  }
  array(browserLayout.branchAnchors ?? [], 'browserLayout.branchAnchors')
  for (const entry of browserLayout.branchAnchors ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2 || !entry.every(item => typeof item === 'string')) fail('branchAnchors 每项必须是 [sessionId,cardId]')
    resolved(entry[1])
    warnings.push({ code: 'branch-anchor-preserved-only', path: entry[0], message: '旧分支锚点仅在浏览器快照备份保留；冻结格式没有该字段，未改变原生血缘' })
  }
}
