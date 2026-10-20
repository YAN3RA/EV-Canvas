/**
 * EV Canvas · 节点与边校验（S0-1 §6 十条不变量）
 *
 * 与 schema.ts 的分工：
 *   - schema.ts 管**顶层文档**（format / schemaVersion / workspace / thread），迁移自旧版
 *   - 本文件管**八类节点 + 三类边**，是 vNext 新增部分
 *
 * 为什么手写守卫而不用 zod：宿主侧要求零 runtime 依赖，且旧版已验证手写守卫模式可行。
 */

import {
  ALLOWED_ASSET_MIME,
  MAX_ASSET_BYTES,
  MAX_EDGES_PER_WORKSPACE,
  MAX_NODES_PER_WORKSPACE,
  MAX_TEXT_BYTES,
  NODE_ID_PATTERN,
} from './constants.js';
import { InputError } from './errors.js';
import type { CanvasEdge, CanvasNode, EdgeKind, NodeKind } from './types.js';

const NODE_KINDS: readonly NodeKind[] = [
  'session',
  'thought',
  'text',
  'image',
  'video',
  'audio',
  'generation',
  'group',
];

const EDGE_KINDS: readonly EdgeKind[] = ['lineage', 'context', 'input'];

/** 禁止 base64 数据内联（不变量 10） */
const BASE64_DATA_RE = /data:[a-z-]+\/[a-z0-9.+-]+;base64,/i;

function requireNodeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !NODE_ID_PATTERN.test(value)) {
    throw new InputError(`${field} 必须匹配 ${NODE_ID_PATTERN}`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(`${field} 必须是有限数字`);
  }
  return value;
}

/** 坐标允许 null（D26 ⑤：待自动布局） */
function requireCoord(value: unknown, field: string): number | null {
  if (value === null) return null;
  return requireFiniteNumber(value, field);
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new InputError(`${field} 必须是数组`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new InputError(`${field} 必须是字符串`);
  return value;
}

/** 递归检查不得含 base64 内联数据 */
function assertNoInlineBase64(node: Record<string, unknown>, where: string): void {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (BASE64_DATA_RE.test(value)) {
        throw new InputError(`${where}.${key} 含 base64 内联数据；媒体必须走 assetId`);
      }
    } else if (value !== null && typeof value === 'object') {
      assertNoInlineBase64(value as Record<string, unknown>, `${where}.${key}`);
    }
  }
}

/**
 * 校验单个节点（不变量 1 的基础，引用完整性由 validateWorkspace 负责）。
 */
export function validateNode(input: unknown, index: number): CanvasNode {
  if (input === null || typeof input !== 'object') {
    throw new InputError(`nodes[${index}] 必须是对象`);
  }
  const node = input as Record<string, unknown>;
  const where = `nodes[${index}]`;

  requireNodeId(node['nodeId'], `${where}.nodeId`);

  const kind = node['kind'];
  if (typeof kind !== 'string' || !NODE_KINDS.includes(kind as NodeKind)) {
    throw new InputError(`${where}.kind 必须是 ${NODE_KINDS.join(' | ')}`);
  }

  requireCoord(node['x'], `${where}.x`);
  requireCoord(node['y'], `${where}.y`);
  requireFiniteNumber(node['width'], `${where}.width`);
  requireFiniteNumber(node['height'], `${where}.height`);
  requireFiniteNumber(node['zIndex'], `${where}.zIndex`);

  if (node['visibility'] !== 'visible' && node['visibility'] !== 'hidden') {
    throw new InputError(`${where}.visibility 必须是 visible | hidden`);
  }

  // 不变量 10：任何字段不得含 base64
  assertNoInlineBase64(node, where);

  // 按 kind 补各自的必填字段
  switch (kind as NodeKind) {
    case 'session': {
      requireString(node['sessionId'], `${where}.sessionId`);
      const proj = node['projection'];
      if (proj === null || typeof proj !== 'object') {
        throw new InputError(`${where}.projection 必须是对象`);
      }
      const p = proj as Record<string, unknown>;
      const cursor = p['cursor'];
      if (cursor === null || typeof cursor !== 'object') {
        throw new InputError(`${where}.projection.cursor 必须是对象`);
      }
      requireFiniteNumber((cursor as Record<string, unknown>)['lastSeq'], `${where}.projection.cursor.lastSeq`);
      requireArray(p['turns'], `${where}.projection.turns`);
      break;
    }
    case 'thought': {
      requireString(node['text'], `${where}.text`);
      break;
    }
    case 'text': {
      const text = requireString(node['text'], `${where}.text`);
      // D26 ①：2 MiB 上限（按字节算，中文 3 字节）
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_TEXT_BYTES) {
        throw new InputError(`${where}.text 超限：${bytes} > ${MAX_TEXT_BYTES} 字节`);
      }
      break;
    }
    case 'image':
    case 'video':
    case 'audio': {
      requireString(node['assetId'], `${where}.assetId`);
      break;
    }
    case 'generation': {
      requireString(node['channelId'], `${where}.channelId`);
      requireArray(node['inputs'], `${where}.inputs`);
      break;
    }
    case 'group': {
      requireArray(node['childNodeIds'], `${where}.childNodeIds`);
      requireNodeId(node['primaryNodeId'], `${where}.primaryNodeId`);
      break;
    }
  }

  return node as unknown as CanvasNode;
}

/**
 * 校验边（不变量 2/3/4 由 validateWorkspace 汇总检查）。
 */
export function validateEdge(input: unknown, index: number): CanvasEdge {
  if (input === null || typeof input !== 'object') {
    throw new InputError(`edges[${index}] 必须是对象`);
  }
  const edge = input as Record<string, unknown>;
  const where = `edges[${index}]`;

  requireString(edge['edgeId'], `${where}.edgeId`);

  const kind = edge['kind'];
  if (typeof kind !== 'string' || !EDGE_KINDS.includes(kind as EdgeKind)) {
    throw new InputError(`${where}.kind 必须是 ${EDGE_KINDS.join(' | ')}`);
  }

  requireNodeId(edge['from'], `${where}.from`);
  requireNodeId(edge['to'], `${where}.to`);

  if (edge['from'] === edge['to']) {
    throw new InputError(`${where} 不允许自环`);
  }

  return edge as unknown as CanvasEdge;
}

/** 校验结果：合法则返回，非法抛 InputError */
export interface WorkspaceInput {
  nodes: unknown;
  edges: unknown;
  viewport?: unknown;
}

/**
 * 校验整个 workspace 的节点与边（不变量 1–5、7）。
 * 资产存在性（不变量 7）由调用方传入已知 assetId 集合检查。
 */
export function validateWorkspace(input: WorkspaceInput, knownAssetIds?: ReadonlySet<string>): void {
  const rawNodes = requireArray(input.nodes, 'nodes');
  const rawEdges = requireArray(input.edges, 'edges');

  if (rawNodes.length > MAX_NODES_PER_WORKSPACE) {
    throw new InputError(`nodes 超限：${rawNodes.length} > ${MAX_NODES_PER_WORKSPACE}`);
  }
  if (rawEdges.length > MAX_EDGES_PER_WORKSPACE) {
    throw new InputError(`edges 超限：${rawEdges.length} > ${MAX_EDGES_PER_WORKSPACE}`);
  }

  // 不变量 1：nodeId 全局唯一
  const ids = new Set<string>();
  const nodeById = new Map<string, Record<string, unknown>>();
  rawNodes.forEach((raw, i) => {
    const node = validateNode(raw, i);
    if (ids.has(node.nodeId)) {
      throw new InputError(`nodeId 重复：${node.nodeId}`);
    }
    ids.add(node.nodeId);
    nodeById.set(node.nodeId, raw as Record<string, unknown>);
  });

  // 不变量 2：边端点必须存在；3：同 kind 不重复；4：lineage 不得由用户建（由调用方标记）
  const edgeKeys = new Set<string>();
  rawEdges.forEach((raw, i) => {
    const edge = validateEdge(raw, i);
    if (!ids.has(edge.from)) {
      throw new InputError(`edges[${i}].from 指向不存在的节点：${edge.from}`);
    }
    if (!ids.has(edge.to)) {
      throw new InputError(`edges[${i}].to 指向不存在的节点：${edge.to}`);
    }
    const key = `${edge.kind}:${edge.from}->${edge.to}`;
    if (edgeKeys.has(key)) {
      throw new InputError(`重复的边：${key}`);
    }
    edgeKeys.add(key);
  });

  // 不变量 5：group.childNodeIds 必须存在且不得自引用
  for (const [nodeId, node] of nodeById) {
    if (node['kind'] !== 'group') continue;
    const children = requireArray(node['childNodeIds'], `${nodeId}.childNodeIds`);
    for (const child of children) {
      const childId = requireNodeId(child, `${nodeId}.childNodeIds[]`);
      if (childId === nodeId) {
        throw new InputError(`${nodeId} 的 childNodeIds 不得自引用`);
      }
      if (!ids.has(childId)) {
        throw new InputError(`${nodeId} 的 childNodeIds 指向不存在的节点：${childId}`);
      }
    }
  }

  // 不变量 6：generation.inputs 只允许 text/image/video/audio
  for (const [nodeId, node] of nodeById) {
    if (node['kind'] !== 'generation') continue;
    const inputs = requireArray(node['inputs'], `${nodeId}.inputs`);
    for (const inputId of inputs) {
      const id = requireNodeId(inputId, `${nodeId}.inputs[]`);
      if (!ids.has(id)) {
        throw new InputError(`${nodeId}.inputs 指向不存在的节点：${id}`);
      }
      const target = nodeById.get(id);
      const targetKind = target?.['kind'];
      if (!['text', 'image', 'video', 'audio'].includes(String(targetKind))) {
        throw new InputError(`${nodeId}.inputs 只允许指向 text/image/video/audio，收到 ${String(targetKind)}`);
      }
    }
  }

  // 不变量 7：媒体节点的 assetId 必须存在
  if (knownAssetIds) {
    for (const [nodeId, node] of nodeById) {
      const kind = node['kind'];
      if (kind !== 'image' && kind !== 'video' && kind !== 'audio') continue;
      const assetId = requireString(node['assetId'], `${nodeId}.assetId`);
      if (!knownAssetIds.has(assetId)) {
        throw new InputError(`${nodeId}.assetId 指向不存在的资产：${assetId}`);
      }
    }
  }

  // 不变量 9：zoom > 0
  const viewport = input.viewport;
  if (viewport !== undefined) {
    if (viewport === null || typeof viewport !== 'object') {
      throw new InputError('viewport 必须是对象');
    }
    const zoom = (viewport as Record<string, unknown>)['zoom'];
    if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0) {
      throw new InputError('viewport.zoom 必须 > 0');
    }
  }
}

/** 校验 MIME 是否在白名单内（FR-13） */
export function isAllowedAssetMime(mime: string): boolean {
  return (ALLOWED_ASSET_MIME as readonly string[]).includes(mime);
}

/** 校验资产大小（FR-13） */
export function assertAssetSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new InputError('资产字节数必须是非负有限数');
  }
  if (bytes > MAX_ASSET_BYTES) {
    throw new InputError(`资产超限：${bytes} > ${MAX_ASSET_BYTES}`);
  }
}
