// 来源: dsh-synapnova@3fd1d00 shared/migration.js

/** Explicit v4 migration planning. No filesystem, browser storage or host calls. */
import { FROZEN_FORMAT, FROZEN_SCHEMA_VERSION, InputError, PROJECTION_TRUNCATED_SUFFIX, normalizeFrozenState, isoDate } from './schema'

const WS_FIELDS = ['id', 'kind', 'dshWorkspaceId', 'cwd', 'title', 'createdAt', 'updatedAt']
const THREAD_FIELDS = ['id', 'title', 'parentId', 'sourceParentSessionId', 'sourceSeedLength', 'dshSessionId', 'dshSessionTitle', 'color', 'createdAt', 'updatedAt']
const MESSAGE_FIELDS = ['id', 'text', 'kind', 'sourceSeq', 'at', 'turn', 'step']
const PROCESS_FIELDS = ['callId', 'turn', 'step', 'name', 'arguments', 'result', 'error']

/**
 * 宽松对象守卫：**接受数组**。
 *
 * 迁移规划用它判断「是不是可 pick 的对象」；换成排除数组的版本会改变对
 * 数组输入的判定（旧代码会走进去再被字段校验拒绝），所以逐字保留原口径。
 */
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const seq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const fail = (message: string): never => { throw new InputError(`迁移源非法：${message}`) }

/**
 * 断言型守卫：判定式与 `fail` 完全一致，只是让调用点在类型层也收窄。
 *
 * 旧代码靠 `if (!object(v)) fail(...)` 之后直接访问 `v.x` 运行；这里把同一个
 * 判定包成 `asserts`，行为（抛什么错、何时抛）逐字不变，但后续访问可以免断言。
 */
function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!object(value)) fail(`${label} 必须是对象`)
}
const requiredId = (value: unknown, label: string): void => { if (typeof value !== 'string' || value === '') fail(`${label} 必须是非空字符串`) }

/** 视口默认值。与 `schema.ts` 的冻结态默认一致（S1-8 视口迁移的回落目标）。 */
const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 1 })

/**
 * 从旧版 `workspace.layout.viewport` 取出用户真实视口（S1-8 视口状态迁移）。
 *
 * 为什么必须有这一步：`WS_FIELDS` 只收 7 个标量字段，**不含 `layout`**，而后面又把
 * `layout` 整块重置成默认值。缺了本函数，旧版用户的视口会被无条件抹平——实测旧版
 * `'dsh-synapnova'` 是 `(-4604.1, 144.7, 1)`、`'agent-opt'` 是 `(-9383.5, -122.3, 1)`，
 * 迁移后都变成 `(0,0,1)`，用户打开画布会跳回原点。
 *
 * 逐字段回落而不是整块放弃：旧版只缺 `zoom` 时，x/y 仍然可信，整块丢弃等于
 * 把能救的部分也扔了。
 *
 * 非法值（非有限数、zoom<=0）**回落默认值而不是让迁移失败**：旧版数据是既成事实，
 * 迁移的目标是「读得出来」。一个坏视口导致整份老工作区打不开，比丢一个视口更糟。
 * 这与 `schema.ts` 的不变量 9（zoom 必须 > 0）不冲突——这里是在写入前把坏数据换成
 * 合法默认值，而不是把坏数据放进冻结态。
 *
 * 注意本函数**只读视口**，不碰 `layout.cards`：旧版卡片坐标的来源是
 * `thread.position`（已单独迁移），`layout.cards` 是浏览器布局快照，只有调用方
 * 显式传 `browserLayout` 时才合并。两者混用会让坐标来源变得不可预测。
 */
function legacyViewportOf(layout: unknown): { x: number; y: number; zoom: number } {
  if (!object(layout)) return { ...DEFAULT_VIEWPORT }
  const raw = (layout as Record<string, unknown>)['viewport']
  if (!object(raw)) return { ...DEFAULT_VIEWPORT }
  const viewport = raw as Record<string, unknown>
  const x = typeof viewport['x'] === 'number' && Number.isFinite(viewport['x']) ? viewport['x'] : DEFAULT_VIEWPORT.x
  const y = typeof viewport['y'] === 'number' && Number.isFinite(viewport['y']) ? viewport['y'] : DEFAULT_VIEWPORT.y
  const rawZoom = viewport['zoom']
  const zoom = typeof rawZoom === 'number' && Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : DEFAULT_VIEWPORT.zoom
  return { x, y, zoom }
}
const array = (value: unknown, label: string): void => { if (!Array.isArray(value)) fail(`${label} 必须是数组`) }
const position = (value: unknown, label: string): { x: number; y: number } => {
  assertObject(value, label)
  if (!Number.isFinite(value['x']) || !Number.isFinite(value['y'])) fail(`${label} 必须包含有限坐标`)
  return { x: value['x'] as number, y: value['y'] as number }
}

/** 一条未知字段警告。 */
export interface MigrationWarning {
  code: string;
  path: string;
  message: string;
}

/** 一条阻断性歧义（存在即 `canCommit === false`）。 */
export interface MigrationAmbiguity {
  code: string;
  path: string;
  message: string;
}

/** 旧卡片键 → 新卡片的映射项。 */
export interface MigrationMapping {
  workspaceId: string;
  threadId: string;
  sourceSeq: number;
  userQuestionSeq: number;
  cardId: string;
}

/** 迁移计数。 */
export interface MigrationCounts {
  workspaces: number;
  sessions: number;
  cards: number;
  messages?: number;
  materials: number;
  positions: number;
  collapsed: number;
  skipped?: number;
}

/** 计数字段的语义说明（避免把「身份数」误读成「渲染卡数」）。 */
export interface MigrationCountsMeaning {
  cards: string;
}

/** `buildMigrationPlan` 的产物。 */
export interface MigrationPlan {
  document: Record<string, unknown>;
  counts: MigrationCounts;
  countsMeaning: MigrationCountsMeaning;
  ambiguities: MigrationAmbiguity[];
  warnings: MigrationWarning[];
  mapping: MigrationMapping[];
  canCommit: boolean;
}

/** `buildLayoutMigrationPlan` 的产物。 */
export interface LayoutMigrationPlan {
  workspaceId: string;
  baseRevision: number;
  projectionEpoch: number;
  layout: { cards: Record<string, { x: number; y: number }>; collapsed: Record<string, unknown>; viewport: { x: number; y: number; zoom: number } };
  counts: MigrationCounts;
  countsMeaning: MigrationCountsMeaning;
  ambiguities: MigrationAmbiguity[];
  warnings: MigrationWarning[];
  mapping: MigrationMapping[];
  canCommit: boolean;
}

/** 浏览器布局快照（`positions` / `collapsed` / `branchAnchors` / `raw`）。 */
export interface BrowserLayout {
  positions?: unknown;
  collapsed?: unknown;
  branchAnchors?: unknown;
  raw?: unknown;
  [key: string]: unknown;
}

/** 迁移规划里的「卡片目标」。 */
interface CardTarget {
  workspace: Record<string, unknown>;
  cardId: string;
}

/** `pick` 的产物：白名单字段的深拷贝。 */
type PickedFields = Record<string, unknown>;

function pick(value: unknown, fields: readonly string[], path: string, warnings: MigrationWarning[], extras: readonly string[] = []): PickedFields {
  assertObject(value, path)
  const result: PickedFields = {}
  for (const key of fields) if (Object.hasOwn(value, key) && value[key] !== undefined) result[key] = structuredClone(value[key])
  for (const key of Object.keys(value)) {
    if (!fields.includes(key) && !extras.includes(key)) warnings.push({ code: 'unknown-field', path: `${path}.${key}`, message: '未知字段不进入新文档；原字节保留在备份' })
  }
  return result
}

function processList(value: unknown, path: string, warnings: MigrationWarning[]): PickedFields[] {
  if (value === undefined) return []
  array(value, path)
  return (value as unknown[]).map((entry, index) => pick(entry, PROCESS_FIELDS, `${path}[${index}]`, warnings))
}

function rangesFor(messages: readonly Record<string, unknown>[]): number[][] {
  const result: number[][] = []
  // `sourceSeq` 已在上游逐条校验为安全整数，这里的排序与并区间逐字沿用旧实现。
  const seqs = messages.map(message => message['sourceSeq'] as number).sort((a, b) => a - b)
  for (const value of seqs) {
    const last = result.at(-1)
    if (last !== undefined && value === (last[1] as number) + 1) last[1] = value
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
export function buildMigrationPlan({ legacyState, browserLayout, hostWorkspaces = [], now }: {
  legacyState?: unknown;
  browserLayout?: BrowserLayout;
  hostWorkspaces?: unknown;
  now?: string;
} = {}): MigrationPlan {
  const source = legacyState as Record<string, unknown> | null | undefined
  if (!object(source) || source['version'] !== 4 || Object.hasOwn(source, 'format') || Object.hasOwn(source, 'schemaVersion')) {
    fail('本迁移仅接受 version:4；v1/v2/v3 与已有 canonical 文档不属于本迁移')
  }
  const legacy = source as Record<string, unknown>
  array(legacy['workspaces'], 'workspaces')
  array(legacy['hiddenSessionIds'], 'hiddenSessionIds')
  array(hostWorkspaces, 'hostWorkspaces')
  const rawWorkspaces = legacy['workspaces'] as unknown[]
  const rawHiddenSessionIds = legacy['hiddenSessionIds'] as unknown[]
  if (!rawHiddenSessionIds.every(id => typeof id === 'string')) fail('hiddenSessionIds 只能包含字符串')
  const warnings: MigrationWarning[] = [], ambiguities: MigrationAmbiguity[] = [], mapping: MigrationMapping[] = []
  const firstWorkspace = rawWorkspaces[0] as Record<string, unknown> | undefined
  const updatedAt = now ?? (legacy['updatedAt'] as string | undefined) ?? (firstWorkspace?.['updatedAt'] as string | undefined)
  try { isoDate(updatedAt, 'updatedAt') } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
  const issue = (code: string, path: string, message: string): void => { ambiguities.push({ code, path, message }) }
  pick(legacyState, ['version', 'hiddenSessionIds', 'workspaces', 'updatedAt'], '$', warnings)
  const workspaceIds = new Set<unknown>(), threadIds = new Set<unknown>(), sessionIds = new Set<unknown>(), aliases = new Map<string, CardTarget[]>()
  const counts: MigrationCounts = { workspaces: rawWorkspaces.length, sessions: 0, cards: 0, messages: 0, materials: 0, positions: 0, collapsed: 0 }
  const document: { format: string; schemaVersion: number; updatedAt: string | undefined; hiddenSessionIds: string[]; idempotency: Record<string, unknown>; idempotencyFloor: null; workspaces: Record<string, unknown>[] } = {
    format: FROZEN_FORMAT,
    schemaVersion: FROZEN_SCHEMA_VERSION,
    updatedAt,
    hiddenSessionIds: [...(rawHiddenSessionIds as string[])],
    idempotency: {},
    idempotencyFloor: null,
    workspaces: [],
  }
  const alias = (key: string, target: CardTarget): void => {
    const values = aliases.get(key) ?? []
    values.push(target)
    aliases.set(key, values)
  }
  const hostWorkspaceList = hostWorkspaces as unknown[]
  for (const [wi, rawSource] of rawWorkspaces.entries()) {
    const path = `workspaces[${wi}]`
    if (!object(rawSource)) fail(`${path} 必须是对象`)
    const source = rawSource as Record<string, unknown>
    const workspace = pick(rawSource, WS_FIELDS, path, warnings, ['threads'])
    requiredId(workspace['id'], `${path}.id`)
    if (workspaceIds.has(workspace['id'])) fail(`重复的 workspace id: ${String(workspace['id'])}`)
    workspaceIds.add(workspace['id'])
    array(source['threads'], `${path}.threads`)
    workspace['kind'] ??= 'manual'
    workspace['cwd'] ??= null
    workspace['dshWorkspaceId'] ??= null
    if (workspace['kind'] === 'dsh' && workspace['dshWorkspaceId'] === null) {
      const candidates = hostWorkspaceList.filter(host => object(host) && typeof host['id'] === 'string' && host['id'] !== '' && ((host['path'] ?? host['cwd'] ?? null) === workspace['cwd']))
      if (candidates.length === 1 && workspace['cwd'] !== null) workspace['dshWorkspaceId'] = (candidates[0] as Record<string, unknown>)['id']
      else issue('workspace-ownership', path, `cwd 对应 ${candidates.length} 个宿主工作区，无法唯一映射`)
    }
    workspace['revision'] = 1
    workspace['projectionEpoch'] = 1
    workspace['projection'] = { threads: [] }
    workspace['layout'] = { cards: {}, collapsed: {}, viewport: legacyViewportOf(source['layout']) }
    workspace['materials'] = []; workspace['regions'] = []; workspace['annotations'] = []
    const rawThreads = source['threads'] as unknown[]
    const layoutCards = (workspace['layout'] as Record<string, unknown>)['cards'] as Record<string, unknown>
    const projection = workspace['projection'] as { threads: Record<string, unknown>[] }
    for (const [ti, rawValue] of rawThreads.entries()) {
      const tp = `${path}.threads[${ti}]`
      if (!object(rawValue)) fail(`${tp} 必须是对象`)
      const value = rawValue as Record<string, unknown>
      const thread = pick(rawValue, THREAD_FIELDS, tp, warnings, ['position', 'messages', 'pendingProcess'])
      requiredId(thread['id'], `${tp}.id`)
      if (threadIds.has(thread['id'])) fail(`重复的 thread id: ${String(thread['id'])}`)
      if (['__proto__', 'constructor', 'prototype'].includes(thread['id'] as string)) fail('thread.id 不能是原型属性名')
      threadIds.add(thread['id'])
      if (thread['dshSessionId'] != null) {
        requiredId(thread['dshSessionId'], `${tp}.dshSessionId`)
        if (sessionIds.has(thread['dshSessionId'])) issue('session-duplicate', tp, '同一宿主 session 对应多个 thread')
        sessionIds.add(thread['dshSessionId'])
        counts.sessions += 1
      }
      array(value['messages'], `${tp}.messages`)
      const messageIds = new Set<unknown>(), seqs = new Set<unknown>()
      const rawMessages = value['messages'] as unknown[]
      thread['messages'] = rawMessages.map((entry, mi) => {
        const mp = `${tp}.messages[${mi}]`
        const message = pick(entry, MESSAGE_FIELDS, mp, warnings, ['process'])
        requiredId(message['id'], `${mp}.id`)
        if (messageIds.has(message['id'])) fail(`重复的 message id: ${String(message['id'])}`)
        messageIds.add(message['id'])
        if (!seq(message['sourceSeq'])) fail(`${mp}.sourceSeq 必须是非负安全整数`)
        if (seqs.has(message['sourceSeq'])) fail(`重复的事件键 seq: ${String(message['sourceSeq'])}`)
        seqs.add(message['sourceSeq'])
        if (typeof message['text'] !== 'string') fail(`${mp}.text 必须是字符串`)
        if (!['user', 'assistant', 'error', 'tool', 'tool-result'].includes(message['kind'] as string)) fail(`${mp}.kind 非法`)
        try { isoDate(message['at'], `${mp}.at`) } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
        if (object(entry) && Object.hasOwn(entry, 'process')) message['process'] = processList((entry as Record<string, unknown>)['process'], `${mp}.process`, warnings)
        return message
      })
      const threadMessages = thread['messages'] as Record<string, unknown>[]
      if (threadMessages.some((message, index) => index > 0 && (message['sourceSeq'] as number) < (threadMessages[index - 1]?.['sourceSeq'] as number))) issue('event-order', tp, '消息数组未按来源 seq 排序，无法证明 turn-index 对应问题序号')
      thread['pendingProcess'] = processList(value['pendingProcess'], `${tp}.pendingProcess`, warnings)
      if (threadMessages.some(message => message['kind'] === 'tool' || message['kind'] === 'tool-result')) issue('legacy-tool-card', tp, 'v4 含独立工具卡，无法证明唯一工具关联，未按相邻顺序猜配')
      thread['coverage'] = {
        ranges: rangesFor(threadMessages),
        historyComplete: false,
        textTruncated: threadMessages.some(message => (message['text'] as string).endsWith(PROJECTION_TRUNCATED_SUFFIX) || (message['text'] as string).length >= 8000),
      }
      counts.messages = (counts.messages ?? 0) + threadMessages.length
      counts.cards += 1 + threadMessages.filter(message => message['kind'] === 'user').length
      if (value['position'] !== undefined) Object.defineProperty(layoutCards, thread['id'] as string, { value: position(value['position'], `${tp}.position`), enumerable: true, writable: true, configurable: true })
      alias(thread['id'] as string, { workspace, cardId: thread['id'] as string })
      let questionIndex = 0
      for (const message of threadMessages) {
        if (message['kind'] !== 'user') continue
        const cardId = `${thread['id'] as string}:${questionIndex}`
        const target: CardTarget = { workspace, cardId }
        alias(`${thread['id'] as string}:turn:${String(message['sourceSeq'])}`, target)
        alias(`${thread['id'] as string}:turn-index:${questionIndex}`, target)
        mapping.push({
          workspaceId: workspace['id'] as string,
          threadId: thread['id'] as string,
          sourceSeq: message['sourceSeq'] as number,
          userQuestionSeq: questionIndex,
          cardId,
        })
        questionIndex += 1
      }
      projection.threads.push(thread)
    }
    const localIds = new Set(projection.threads.map(thread => thread['id']))
    for (const thread of projection.threads) {
      if (thread['parentId'] != null && !localIds.has(thread['parentId'])) issue('parent-missing', `${path}.${String(thread['id'])}`, 'parentId 不在同一工作区')
      const visited = new Set<unknown>([thread['id']]); let parent = thread['parentId']
      while (parent != null && localIds.has(parent)) {
        if (visited.has(parent)) { issue('parent-cycle', `${path}.${String(thread['id'])}`, '线程血缘存在环'); break }
        visited.add(parent)
        parent = projection.threads.find(item => item['id'] === parent)?.['parentId']
      }
    }
    document.workspaces.push(workspace)
  }
  const hostBindings = new Set<unknown>()
  for (const workspace of document.workspaces) {
    if (workspace['kind'] !== 'dsh' || workspace['dshWorkspaceId'] === null) continue
    if (hostBindings.has(workspace['dshWorkspaceId'])) issue('workspace-duplicate-binding', workspace['id'] as string, '多个旧工作区对应同一宿主工作区，未合并或猜配')
    hostBindings.add(workspace['dshWorkspaceId'])
  }
  if (browserLayout !== undefined) applyBrowserLayout({ aliases, browserLayout, counts, issue, warnings })
  if (browserLayout === undefined) warnings.push({ code: 'browser-layout-not-supplied', path: 'browserLayout', message: '未提供浏览器布局快照；仅迁移服务端线程坐标，浏览器布局未覆盖且旧字节保留' })
  return { document, counts, countsMeaning: { cards: '线程锚点与用户问题身份数合计，不是当前渲染卡数' }, ambiguities, warnings, mapping, canCommit: ambiguities.length === 0 }
}

/** Merge explicitly supplied legacy entries into one existing canonical layout. */
export function buildLayoutMigrationPlan({ document: inputDocument, workspaceId, browserLayout }: {
  document?: unknown;
  workspaceId?: string;
  browserLayout?: BrowserLayout;
} = {}): LayoutMigrationPlan {
  const state = normalizeFrozenState(inputDocument).state
  const selected = state.workspaces.find(workspace => workspace.id === workspaceId)
  if (selected === undefined) fail('所选工作区不存在')
  if (browserLayout === undefined) fail('必须提供 browserLayout 显式快照')
  // 上方两次 fail() 必然抛出（`fail` 声明为 `never`）。下面两行只是把「已经排除
  // undefined」这件事告诉类型系统：条件与上面完全相同，运行时零成本、零新分支。
  const chosen = selected ?? fail('所选工作区不存在')
  const layoutSnapshot = browserLayout ?? fail('必须提供 browserLayout 显式快照')
  const aliases = new Map<string, CardTarget[]>(), mapping: MigrationMapping[] = [], warnings: MigrationWarning[] = [], ambiguities: MigrationAmbiguity[] = []
  const counts: MigrationCounts = { workspaces: 1, sessions: 0, cards: 0, materials: chosen.materials.length, positions: 0, collapsed: 0, skipped: 0 }
  const alias = (key: string, target: CardTarget): void => {
    const values = aliases.get(key) ?? []
    if (!values.some(value => value.workspace['id'] === target.workspace['id'] && value.cardId === target.cardId)) values.push(target)
    aliases.set(key, values)
  }
  for (const workspace of state.workspaces) for (const thread of workspace.projection.threads) {
    // 冻结文档里的 workspace/thread 是结构化对象，这里转成迁移规划内部使用的
    // 可变字典视图（旧实现同样按任意属性访问，不做形状校验）。
    const workspaceRecord = workspace as unknown as Record<string, unknown>
    const threadRecord = thread as unknown as Record<string, unknown>
    alias(thread.id, { workspace: workspaceRecord, cardId: thread.id })
    if (workspace === selected) { counts.cards += 1; if (thread.dshSessionId) counts.sessions += 1 }
    let index = 0
    for (const message of thread.messages) {
      if (message.kind !== 'user') continue
      const cardId = `${thread.id}:${index}`, target: CardTarget = { workspace: workspaceRecord, cardId }
      alias(cardId, target)
      alias(`${thread.id}:turn-index:${index}`, target)
      if (seq(message.sourceSeq)) alias(`${thread.id}:turn:${String(message.sourceSeq)}`, target)
      if (workspace === selected) {
        counts.cards += 1
        mapping.push({
          workspaceId: workspaceId as string,
          threadId: thread.id,
          sourceSeq: message.sourceSeq as number,
          userQuestionSeq: index,
          cardId,
        })
      }
      index += 1
    }
    void threadRecord
  }
  applyBrowserLayout({ aliases, browserLayout: layoutSnapshot, counts, warnings, workspaceId, issue: (code, path, message) => ambiguities.push({ code, path, message }) })
  // This plan deliberately has no whole-document candidate.
  return {
    workspaceId: workspaceId as string,
    baseRevision: chosen.revision,
    projectionEpoch: chosen.projectionEpoch,
    layout: chosen.layout,
    counts,
    countsMeaning: { cards: '所选工作区线程锚点与用户问题身份数；skipped为唯一归属其他工作区的布局条目' },
    ambiguities,
    warnings,
    mapping,
    canCommit: ambiguities.length === 0,
  }
}

function applyBrowserLayout({ aliases, browserLayout, counts, issue, warnings, workspaceId }: {
  aliases: Map<string, CardTarget[]>;
  browserLayout: BrowserLayout;
  counts: MigrationCounts;
  issue: (code: string, path: string, message: string) => void;
  warnings: MigrationWarning[];
  workspaceId?: string;
}): void {
  if (!object(browserLayout)) fail('browserLayout 必须是显式快照对象')
  for (const key of Object.keys(browserLayout)) if (!['positions', 'collapsed', 'branchAnchors', 'raw'].includes(key)) fail(`不支持的 browserLayout 字段 ${key}`)
  if (browserLayout.raw !== undefined) {
    if (!object(browserLayout.raw) || Object.values(browserLayout.raw).some(value => value !== null && typeof value !== 'string')) fail('browserLayout.raw 必须是原始字符串或 null 的键值表')
    warnings.push({ code: 'raw-browser-backup', path: 'browserLayout.raw', message: '原始浏览器键值仅备份，不按未知旧格式猜配布局' })
  }
  const resolved = (key: string): CardTarget | null => {
    const targets = aliases.get(key) ?? []
    if (targets.length !== 1) { issue('card-mapping', key, `旧卡片键对应 ${targets.length} 个目标，未猜配`); return null }
    const target = targets[0] as CardTarget
    if (workspaceId !== undefined && target.workspace['id'] !== workspaceId) {
      counts.skipped = (counts.skipped ?? 0) + 1
      warnings.push({ code: 'other-workspace', path: key, message: '唯一归属其他工作区，本次不改动；可切换后另行预览' })
      return null
    }
    return target
  }
  const storedPositions = new Map<string, { x: number; y: number }>()
  const rawPositions = browserLayout.positions ?? []
  array(rawPositions, 'browserLayout.positions')
  for (const entry of rawPositions as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') fail('positions 每项必须是 [cardId,{x,y}]')
    const entryPair = entry as [string, unknown]
    const point = position(entryPair[1], entryPair[0]), target = resolved(entryPair[0])
    if (!target) continue
    const key = JSON.stringify([target.workspace['id'], target.cardId]), previous = storedPositions.get(key)
    if (previous !== undefined && (previous.x !== point.x || previous.y !== point.y)) { issue('position-conflict', entryPair[0], '同一卡片的旧别名坐标冲突'); continue }
    storedPositions.set(key, point)
    Object.defineProperty((target.workspace['layout'] as Record<string, unknown>)['cards'] as Record<string, unknown>, target.cardId, { value: point, enumerable: true, writable: true, configurable: true })
    counts.positions += 1
  }
  const rawCollapsed = browserLayout.collapsed ?? []
  array(rawCollapsed, 'browserLayout.collapsed')
  for (const key of rawCollapsed as unknown[]) {
    requiredId(key, 'collapsed cardId')
    const target = resolved(key as string)
    if (target) {
      Object.defineProperty((target.workspace['layout'] as Record<string, unknown>)['collapsed'] as Record<string, unknown>, target.cardId, { value: true, enumerable: true, writable: true, configurable: true })
      counts.collapsed += 1
    }
  }
  const rawBranchAnchors = browserLayout.branchAnchors ?? []
  array(rawBranchAnchors, 'browserLayout.branchAnchors')
  for (const entry of rawBranchAnchors as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || !entry.every(item => typeof item === 'string')) fail('branchAnchors 每项必须是 [sessionId,cardId]')
    const entryPair = entry as [string, string]
    resolved(entryPair[1])
    warnings.push({ code: 'branch-anchor-preserved-only', path: entryPair[0], message: '旧分支锚点仅在浏览器快照备份保留；冻结格式没有该字段，未改变原生血缘' })
  }
}
