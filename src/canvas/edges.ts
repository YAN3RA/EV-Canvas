/**
 * EV Canvas · 三类边（S0-2 / FR-12 / D25）
 *
 * 为什么单独一个模块：旧版只有 `thread.parentId` 隐式表达血缘，没有「边」概念。
 * vNext 要求 `lineage` / `context` / `input` 三类边**用 kind 区分，不靠颜色或位置**，
 * 于是需要一处集中回答三件事：
 *
 *   1. `lineage` 边**不入库**，每次从投影的 `parentId` 谱系推导（S0-2 §风险）
 *   2. 用户的增删只能碰 `context` / `input`，碰 `lineage` 必须硬拒（不变量 4）
 *   3. 只有 `context` / `input` 参与模型上下文，`lineage` 永远不参与（FR-12 表）
 *
 * 纯模块：无 DOM、无 Store、无 IO、无模型调用。输入是只读的 workspace 文档片段
 * （或显式字段），输出是新的边数组；入参永不被修改。
 *
 * 与 `node-schema.ts` 的分工：那边校验**单个**边的字段形状与自环，
 * 这里校验**边集**的语义（谁能创建、端点是否可用、血缘是否重复推导）。
 */

import { MAX_EDGES_PER_WORKSPACE } from '@/shared/constants';
import { InputError } from '@/shared/errors';
import type { CanvasEdge, CanvasNode, EdgeKind } from '@/shared/types';

/** 边类别在运行时的枚举，顺序即 UI 展示顺序（lineage 在前：只读层先画）。 */
export const EDGE_KINDS: readonly EdgeKind[] = ['lineage', 'context', 'input'] as const;

/** 用户可创建的边类别。`lineage` 缺失是有意的：它由系统推导，不接受用户输入。 */
export const USER_EDGE_KINDS: readonly EdgeKind[] = ['context', 'input'] as const;

/** 参与模型上下文的边类别（FR-12：`lineage` 不参与）。 */
export const CONTEXT_EDGE_KINDS: readonly EdgeKind[] = ['context', 'input'] as const;

/** 推导出的血缘边 id 前缀，保证与用户边（UUID）不会撞车。 */
export const LINEAGE_ID_PREFIX = 'lineage:';

/** 血缘推导的输入：一个节点的最小谱系形状。 */
export interface LineageSource {
  /** 节点 id */
  nodeId: string;
  /** 该节点的父节点 id（无父为 null / 缺省） */
  parentId?: string | null;
}

/** 一个 workspace 快照里与边有关的部分。 */
export interface EdgeSnapshot {
  nodes?: readonly unknown[];
  edges?: readonly unknown[];
  /** 投影线程（旧版形状 `{ id, parentId }`），用于推导血缘 */
  threads?: readonly unknown[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is EdgeKind {
  return typeof value === 'string' && (EDGE_KINDS as readonly string[]).includes(value);
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new InputError(`${field} 必须是非空字符串`);
  }
  return value;
}

/**
 * 这条边是不是系统推导的只读边。
 *
 * 判断只看 `kind`，不看 id 前缀：id 前缀只是**生成**时的约定，
 * 用来让调试时一眼看出这条边不入库；语义权威仍然是 `kind`。
 */
export function isLineageEdge(edge: unknown): boolean {
  return isPlainObject(edge) && edge['kind'] === 'lineage';
}

/** 这条边是否允许用户在画布上编辑（增删改）。 */
export function isUserEditableEdge(edge: unknown): boolean {
  if (!isPlainObject(edge)) return false;
  return isKind(edge['kind']) && (USER_EDGE_KINDS as readonly string[]).includes(edge['kind']);
}

/** 这条边是否参与模型上下文（FR-12）。 */
export function participatesInContext(edge: unknown): boolean {
  if (!isPlainObject(edge)) return false;
  return isKind(edge['kind']) && (CONTEXT_EDGE_KINDS as readonly string[]).includes(edge['kind']);
}

/**
 * 血缘边 id：由父子 id 派生，天然幂等。
 *
 * 同一条父子关系重复推导必须得到**同一个 id**，否则每次重算都会在渲染层
 * 造出一条新边，选中态和动画会跟着抖。
 */
export function lineageEdgeId(parentId: string, childId: string): string {
  requireId(parentId, 'parentId');
  requireId(childId, 'childId');
  if (parentId === childId) throw new InputError('血缘边不允许自环');
  return `${LINEAGE_ID_PREFIX}${parentId}->${childId}`;
}

/**
 * 从谱系推导 `lineage` 边。
 *
 * 三种来源按优先级合并，后到的不覆盖已推导的：
 *   1. 显式 `threads[]`（投影线程的 `parentId`）
 *   2. 节点自带的 `parentId` 字段
 *
 * 只保留**两端都存在**的关系：父节点已被归档/删除时，血缘边不是"悬空边"，
 * 而是根本不存在——渲染层不该画一条指向虚空的连线。
 * 父节点缺失时进 `orphaned`，由调用方决定是否提示。
 *
 * 返回值永远不带 `before`/`after`，也不含用户边；调用方把它与 `edges[]`
 * 里的用户边拼起来即可。
 */
export function deriveLineageEdges(snapshot: EdgeSnapshot, existingNodeIds?: ReadonlySet<string>): CanvasEdge[] {
  if (!isPlainObject(snapshot)) throw new InputError('snapshot 必须是对象');
  // 已知节点 = 显式传入的集合，否则由 `nodes[]` 与 `threads[].id` 共同决定。
  // threads 也是节点来源：投影线程本身就是一个 session 节点，只查 `nodes[]`
  // 会让「只传投影、不传节点」的调用方拿到空结果。
  const known = existingNodeIds ?? unionIds(snapshot);
  const seen = new Set<string>();
  const edges: CanvasEdge[] = [];
  const push = (parentId: string, childId: string): void => {
    if (parentId === childId) return;
    if (!known.has(parentId) || !known.has(childId)) return;
    const edgeId = lineageEdgeId(parentId, childId);
    if (seen.has(edgeId)) return;
    seen.add(edgeId);
    edges.push({ edgeId, kind: 'lineage', from: parentId, to: childId, createdAt: EDGE_DERIVED_AT });
  };

  for (const thread of Array.isArray(snapshot.threads) ? snapshot.threads : []) {
    if (!isPlainObject(thread)) continue;
    const childId = thread['id'];
    const parentId = thread['parentId'];
    if (typeof childId !== 'string' || childId === '') continue;
    if (typeof parentId !== 'string' || parentId === '') continue;
    push(parentId, childId);
  }
  for (const node of Array.isArray(snapshot.nodes) ? snapshot.nodes : []) {
    if (!isPlainObject(node)) continue;
    const childId = node['nodeId'];
    const parentId = node['parentId'];
    if (typeof childId !== 'string' || childId === '') continue;
    if (typeof parentId !== 'string' || parentId === '') continue;
    push(parentId, childId);
  }
  return edges;
}

/**
 * 推导边的 `createdAt`。
 *
 * 血缘边不入库，所以它没有一个"真实创建时刻"可持久化。这里用一个固定的
 * 纪元字符串而不是 `new Date()`：纯函数必须可复现，否则同一快照两次推导
 * 会产出不相等的结果，任何基于等值的缓存都会永远失效。
 */
export const EDGE_DERIVED_AT = '1970-01-01T00:00:00.000Z';

function nodeIdSet(nodes: readonly unknown[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!isPlainObject(node)) continue;
    const nodeId = node['nodeId'];
    if (typeof nodeId === 'string' && nodeId !== '') ids.add(nodeId);
  }
  return ids;
}

/** `nodes[]` 与 `threads[].id` 的并集：两者都是已知节点来源。 */
function unionIds(snapshot: EdgeSnapshot): Set<string> {
  const ids = nodeIdSet(Array.isArray(snapshot.nodes) ? snapshot.nodes : []);
  for (const thread of Array.isArray(snapshot.threads) ? snapshot.threads : []) {
    if (!isPlainObject(thread)) continue;
    const id = thread['id'];
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return ids;
}

/** 用户建边的入参。`edgeId` / `createdAt` 由调用方给（通常来自服务端 UUIDv7）。 */
export interface UserEdgeInput {
  edgeId: string;
  kind: EdgeKind;
  from: string;
  to: string;
  createdAt: string;
}

/**
 * 校验并构造一条用户边。
 *
 * 硬拒的情形（每条都有独立错误文案，方便 UI 直接显示）：
 *   - `kind === 'lineage'`：系统推导，用户不得创建（FR-12 / 不变量 4）
 *   - 自环
 *   - 与已有边重复（同 kind 同方向）
 *   - 端点不存在
 */
export function createUserEdge(input: UserEdgeInput, nodeIds: ReadonlySet<string>, existing: readonly CanvasEdge[] = []): CanvasEdge {
  if (!isPlainObject(input)) throw new InputError('边必须是对象');
  const kind = input.kind;
  if (!isKind(kind)) throw new InputError(`边 kind 必须是 ${EDGE_KINDS.join(' | ')}`);
  if (kind === 'lineage') {
    throw new InputError('lineage 边由系统从会话谱系推导，不能手工创建');
  }
  const from = requireId(input.from, 'edge.from');
  const to = requireId(input.to, 'edge.to');
  if (from === to) throw new InputError('边不允许自环');
  if (!nodeIds.has(from)) throw new InputError(`边起点指向不存在的节点：${from}`);
  if (!nodeIds.has(to)) throw new InputError(`边终点指向不存在的节点：${to}`);
  const edgeId = requireId(input.edgeId, 'edge.edgeId');
  if (existing.some(edge => edge.edgeId === edgeId)) throw new InputError(`边 ${edgeId} 已存在`);
  if (existing.some(edge => edge.kind === kind && edge.from === from && edge.to === to)) {
    throw new InputError(`重复的边：${kind}:${from}->${to}`);
  }
  return { edgeId, kind, from, to, createdAt: requireId(input.createdAt, 'edge.createdAt') };
}

/**
 * 删除一条用户边，返回新数组。
 *
 * `lineage` 边删不掉——不是"删了没效果"，而是显式抛错：静默忽略会让
 * 调用方以为操作成功，把失败藏进重试里。
 */
export function removeUserEdge(edges: readonly CanvasEdge[], edgeId: string): CanvasEdge[] {
  requireId(edgeId, 'edgeId');
  const target = edges.find(edge => edge.edgeId === edgeId);
  if (target === undefined) throw new InputError(`边 ${edgeId} 不存在`);
  if (isLineageEdge(target)) throw new InputError('lineage 边由系统推导，不能删除');
  return edges.filter(edge => edge.edgeId !== edgeId);
}

/**
 * 把「库里的用户边」与「推导出的血缘边」合成渲染用的完整边集。
 *
 * 输出顺序固定为 `lineage → context → input`，让同一次渲染的绘制层次稳定
 * （血缘垫底，用户的语义连线压在上面）。同一 `edgeId` 只出现一次；若库里
 * 意外存过一条 `lineage`（旧数据/手改文件），以推导结果为准，库里那条丢弃。
 *
 * 返回的数组本身可变，但每个元素是深冻结的新对象：调用方不能通过返回值
 * 改到库里的边。
 */
export function mergeEdges(stored: readonly unknown[], derived: readonly CanvasEdge[]): CanvasEdge[] {
  const merged: CanvasEdge[] = [];
  const seen = new Set<string>();
  const take = (edge: CanvasEdge): void => {
    if (seen.has(edge.edgeId)) return;
    seen.add(edge.edgeId);
    merged.push(edge);
  };
  // 推理结果先入：血缘边永远来自这里，库里那条同名 lineage 因此被自然挤掉。
  for (const edge of derived) take(deepFreezeEdge(edge));
  for (const raw of Array.isArray(stored) ? stored : []) {
    if (!isPlainObject(raw)) continue;
    if (!isKind(raw['kind'])) continue;
    // 库里存的 lineage 不可信：运行时以推导为准（S0-2「血缘边不入库」）。
    if (raw['kind'] === 'lineage') continue;
    const edge = normalizeEdge(raw);
    if (edge !== null) take(deepFreezeEdge(edge));
  }
  const rank = (kind: EdgeKind): number => EDGE_KINDS.indexOf(kind);
  // 稳定排序：同 kind 内保持入参顺序（Array.prototype.sort 在 V8 上稳定）。
  return merged.sort((a, b) => rank(a.kind) - rank(b.kind));
}

function normalizeEdge(raw: Record<string, unknown>): CanvasEdge | null {
  const edgeId = raw['edgeId'];
  const kind = raw['kind'];
  const from = raw['from'];
  const to = raw['to'];
  const createdAt = raw['createdAt'];
  if (typeof edgeId !== 'string' || edgeId === '') return null;
  if (!isKind(kind)) return null;
  if (typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') return null;
  if (typeof createdAt !== 'string' || createdAt === '') return null;
  return { edgeId, kind, from, to, createdAt };
}

function deepFreezeEdge(edge: CanvasEdge): CanvasEdge {
  return Object.freeze({ edgeId: edge.edgeId, kind: edge.kind, from: edge.from, to: edge.to, createdAt: edge.createdAt });
}

/**
 * 边集完整性检查（不变量 2/3/4）。
 *
 * 与 `node-schema.ts:validateWorkspace` 的区别：那边校验的是**落盘前的文档**，
 * 要求每条边都在 `edges[]` 里；这里校验的是**渲染前的合并结果**，所以
 * `lineage` 是合法成员。两边都拒绝重复边与悬空端点，规则一致但输入不同。
 */
export function assertEdgeSet(edges: readonly CanvasEdge[], nodeIds: ReadonlySet<string>): void {
  if (edges.length > MAX_EDGES_PER_WORKSPACE) {
    throw new InputError(`edges 超限：${edges.length} > ${MAX_EDGES_PER_WORKSPACE}`);
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const edge of edges) {
    if (ids.has(edge.edgeId)) throw new InputError(`edgeId 重复：${edge.edgeId}`);
    ids.add(edge.edgeId);
    if (!nodeIds.has(edge.from)) throw new InputError(`边 ${edge.edgeId} 的起点不存在：${edge.from}`);
    if (!nodeIds.has(edge.to)) throw new InputError(`边 ${edge.edgeId} 的终点不存在：${edge.to}`);
    const key = `${edge.kind}:${edge.from}->${edge.to}`;
    if (keys.has(key)) throw new InputError(`重复的边：${key}`);
    keys.add(key);
  }
}

/** 按方向取端点：`from`/`to`/`both`。用于按节点聚合边。 */
export function edgesOfNode(edges: readonly CanvasEdge[], nodeId: string, direction: 'from' | 'to' | 'both' = 'both'): CanvasEdge[] {
  if (typeof nodeId !== 'string' || nodeId === '') return [];
  if (direction === 'from') return edges.filter(edge => edge.from === nodeId);
  if (direction === 'to') return edges.filter(edge => edge.to === nodeId);
  return edges.filter(edge => edge.from === nodeId || edge.to === nodeId);
}

/** 只取参与模型上下文的边（FR-12：`lineage` 被排除在外）。 */
export function contextEdges(edges: readonly CanvasEdge[]): CanvasEdge[] {
  return edges.filter(edge => participatesInContext(edge));
}

/** 节点 id 集合：把 `CanvasNode[]` 压成校验用的集合。 */
export function nodeIdsOf(nodes: readonly CanvasNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (isPlainObject(node) && typeof node.nodeId === 'string' && node.nodeId !== '') ids.add(node.nodeId);
  }
  return ids;
}
