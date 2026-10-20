/**
 * EV Canvas · 节点复制与粘贴（FR-09.8 / S1-5）
 *
 * 为什么是独立模块：复制粘贴的难点不在"拷一份"，而在**引用重映射**。
 * 一个节点的字段里可能引用别的节点（`group.childNodeIds`、`generation.inputs`），
 * 边也引用节点。粘贴时如果只换自己的 id，这些引用会全部指回原节点，
 * 于是新粘贴出来的一组节点会诡异地挂在旧节点上。
 *
 * 三条硬边界（FR-09.8）：
 *   1. **跨工作区不复制**：payload 带来源工作区 id，粘贴到别的工作区直接拒绝。
 *   2. **只复制内部边**：两端不在选中集里的边不跟着走，否则粘贴出来会
 *      与画布原有节点产生跨界连接。
 *   3. **引用要么重映射，要么丢弃**：如果 `group` 的子节点没被一起选中，
 *      该 child 从 `childNodeIds` 里移除；不会留下指向旧节点的悬空引用。
 *
 * 纯模块：无 DOM、无 Store、无 IO。入参永不被修改（深拷贝后才改）。
 */

import { InputError } from '@/shared/errors';
import type { CanvasEdge, CanvasNode } from '@/shared/types';

/** 剪贴板内容：一段自洽的、可粘贴到同一工作区的节点子图。 */
export interface ClipboardPayload {
  /** 复制时所在工作区；粘贴时用来拒绝跨工作区操作 */
  sourceWorkspaceId: string | null;
  nodes: CanvasNode[];
  /** 只包含两端都在 `nodes` 里的边 */
  edges: CanvasEdge[];
  /** 复制时刻（严格 ISO），仅用于 UI 提示"多久前复制的" */
  copiedAt: string;
}

/** id 生成器：默认是「前缀 + 递增计数」，测试里可注入确定性实现。 */
export type NodeIdFactory = (originalId: string, index: number) => string;

/** 粘贴选项 */
export interface PasteOptions {
  /** 目标工作区 id；与 `payload.sourceWorkspaceId` 不同则拒绝 */
  targetWorkspaceId: string | null;
  /** 整体位移；默认 (20, 20)，与宿主其它粘贴行为一致 */
  offset?: { x: number; y: number };
  /** 新 id 生成器 */
  idFactory?: NodeIdFactory;
  /** 新边 id 生成器 */
  edgeIdFactory?: (originalEdgeId: string, index: number) => string;
  /** 粘贴时刻（严格 ISO），默认由调用方给，不给则用固定纪元（可复现） */
  pastedAt?: string;
}

/** 粘贴结果 */
export interface PasteResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** 原 id → 新 id，供调用方设置选中态与日志 */
  idMap: Record<string, string>;
  /** 因对端不在选中集而被丢弃的引用（数量 + 位置，便于 UI 提示） */
  droppedRefs: { nodeId: string; field: string; value: string }[];
}

/** 默认位移：粘贴出来的节点稍偏右下，避免与原节点完全重叠。 */
export const DEFAULT_PASTE_OFFSET = Object.freeze({ x: 20, y: 20 });

/** 粘贴时刻的固定兜底值：纯函数默认必须可复现。 */
const DEFAULT_PASTED_AT = '1970-01-01T00:00:00.000Z';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => deepClone(item)) as unknown as T;
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) copy[key] = deepClone(value[key]);
    return copy as unknown as T;
  }
  return value;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new InputError(`${field} 必须是非空字符串`);
  return value;
}

/**
 * 默认 id 生成器：`原 id + -copy-N`。
 *
 * 为什么不用随机 UUID：`NODE_ID_PATTERN` 允许它，但复制粘贴是可预期操作，
 * 可读 id 让「这组节点是粘出来的」在数据里可查。
 *
 * `index` 是**复制代次**，不是节点序号：同一次粘贴里所有节点拿同一个 N
 * （`a-copy-1` / `b-copy-1`），下一次粘贴才是 `-copy-2`。用节点序号会得到
 * `a-copy-1` / `b-copy-2` 这种"看起来像重复粘贴了两次"的误导性 id。
 * 超过 64 字符上限的原 id 会被截断（pattern 上限，不是任意值）。
 */
export function defaultNodeIdFactory(originalId: string, index: number): string {
  const suffix = `-copy-${index + 1}`;
  const room = 64 - suffix.length;
  const base = originalId.length > room ? originalId.slice(0, room) : originalId;
  return `${base}${suffix}`;
}

/**
 * 选一个**整批都不撞车**的代次。
 *
 * 每个节点各自找第一个空位会让同一批里出现不同代次（`a-copy-1` / `b-copy-2`），
 * 所以这里按代次整体探测：从 1 开始，直到这一代生成的全部 id 都空闲为止。
 */
function nextGeneration(nodeIds: readonly string[], taken: ReadonlySet<string>): number {
  for (let generation = 0; generation < 10_000; generation++) {
    const clear = nodeIds.every(originalId => !taken.has(defaultNodeIdFactory(originalId, generation)));
    if (clear) return generation;
  }
  throw new InputError('找不到可用的复制 id 代次（节点过多或 id 空间耗尽）');
}

/** 默认边 id 生成器（边 id 不受 NODE_ID_PATTERN 约束，但保持可读）。 */
export function defaultEdgeIdFactory(originalEdgeId: string, index: number): string {
  return `${originalEdgeId}-copy-${index + 1}`;
}

/**
 * 复制一段节点子图。
 *
 * `selection` 为节点 id 数组；不存在的 id 被忽略（投影变化后的幽灵选中项）。
 * 边只保留两端都在结果里的部分——这样粘贴出来的子图是自洽的，
 * 不会拖一条连到画布原有节点的线。
 */
export function copyNodes(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  selection: readonly string[],
  options: { sourceWorkspaceId?: string | null; copiedAt?: string } = {},
): ClipboardPayload {
  const selected = new Set<string>();
  for (const id of Array.isArray(selection) ? selection : []) {
    if (typeof id === 'string' && id !== '') selected.add(id);
  }
  const picked: CanvasNode[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!isPlainObject(node)) continue;
    const nodeId = node['nodeId'];
    if (typeof nodeId !== 'string' || !selected.has(nodeId)) continue;
    picked.push(deepClone(node) as unknown as CanvasNode);
  }
  const ids = new Set(picked.map(node => node.nodeId));
  const pickedEdges: CanvasEdge[] = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!isPlainObject(edge)) continue;
    if (!ids.has(String(edge['from'])) || !ids.has(String(edge['to']))) continue;
    pickedEdges.push(deepClone(edge) as unknown as CanvasEdge);
  }
  return {
    sourceWorkspaceId: typeof options.sourceWorkspaceId === 'string' ? options.sourceWorkspaceId : null,
    nodes: picked,
    edges: pickedEdges,
    copiedAt: typeof options.copiedAt === 'string' && options.copiedAt !== '' ? options.copiedAt : DEFAULT_PASTED_AT,
  };
}

/** 剪贴板是否为空（空粘贴不该产生一步 undo）。 */
export function isEmptyPayload(payload: ClipboardPayload | null | undefined): boolean {
  return payload === null || payload === undefined || !Array.isArray(payload.nodes) || payload.nodes.length === 0;
}

/**
 * 粘贴一段子图：重映射全部节点 id、边 id 与内部引用。
 *
 * 拒绝条件（都抛 `InputError`，不静默降级）：
 *   - payload 为空
 *   - `sourceWorkspaceId` 与 `targetWorkspaceId` 不同（跨工作区不复制）
 *   - 生成出的新 id 与原有 id 冲突（调用方的 idFactory 有问题）
 *
 * 引用处理矩阵：
 *   - `group.childNodeIds`：只保留在选中集里的，其余进 `droppedRefs`
 *   - `group.primaryNodeId`：不在选中集里则回落到第一个子节点，再没有就丢弃该属性
 *   - `generation.inputs`：只保留在选中集里的，其余进 `droppedRefs`
 *   - `thought.sourceRef` / `session.sessionId`：**外部引用，不重映射**（它们指向宿主）
 */
export function pasteNodes(
  payload: ClipboardPayload | null | undefined,
  existingNodeIds: ReadonlySet<string>,
  options: PasteOptions,
): PasteResult {
  if (isEmptyPayload(payload) || payload === null || payload === undefined) {
    throw new InputError('剪贴板为空，没有可粘贴的节点');
  }
  if (!isPlainObject(options)) throw new InputError('pasteNodes 需要 options');
  const target = options.targetWorkspaceId ?? null;
  if ((payload.sourceWorkspaceId ?? null) !== target) {
    throw new InputError('跨工作区不支持复制粘贴（FR-09.8）');
  }
  const offset = options.offset ?? DEFAULT_PASTE_OFFSET;
  if (!isPlainObject(offset) || !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) {
    throw new InputError('粘贴位移必须是有限数字');
  }
  const makeNodeId = options.idFactory ?? defaultNodeIdFactory;
  const makeEdgeId = options.edgeIdFactory ?? defaultEdgeIdFactory;
  const pastedAt = typeof options.pastedAt === 'string' && options.pastedAt !== '' ? options.pastedAt : DEFAULT_PASTED_AT;

  // ── 第一步：先把所有新 id 定下来 ────────────────────────────
  // 必须先全量生成再改引用，否则「A 引用 B」时 B 的新 id 还不存在。
  const idMap: Record<string, string> = {};
  const taken = new Set<string>(existingNodeIds);
  const originals = payload.nodes.map(node => node.nodeId);
  // 默认生成器按「整批同一代次」探测；调用方给了自己的 factory 就用 index 逐项生成。
  const generation = options.idFactory === undefined ? nextGeneration(originals, taken) : 0;
  payload.nodes.forEach((node, index) => {
    const original = node.nodeId;
    const next = requireId(makeNodeId(original, options.idFactory === undefined ? generation : index), `idFactory(${original})`);
    if (taken.has(next)) throw new InputError(`生成的节点 id 与已有节点冲突：${next}`);
    taken.add(next);
    idMap[original] = next;
  });

  const droppedRefs: PasteResult['droppedRefs'] = [];
  const nodes: CanvasNode[] = payload.nodes.map(node => {
    const next = deepClone(node) as unknown as Record<string, unknown>;
    const originalId = node.nodeId;
    next['nodeId'] = idMap[originalId];
    next['createdAt'] = pastedAt;
    next['updatedAt'] = pastedAt;

    // 坐标：null 表示"待自动布局"，粘贴不能把它变成 0（那会把节点甩到原点）。
    if (Number.isFinite(next['x'])) next['x'] = Math.round((next['x'] as number) + offset.x);
    if (Number.isFinite(next['y'])) next['y'] = Math.round((next['y'] as number) + offset.y);

    const kind = next['kind'];

    if (kind === 'group') {
      const rawChildren = Array.isArray(next['childNodeIds']) ? (next['childNodeIds'] as unknown[]) : [];
      const children: string[] = [];
      for (const child of rawChildren) {
        if (typeof child !== 'string') continue;
        const mapped = idMap[child];
        if (mapped === undefined) {
          droppedRefs.push({ nodeId: originalId, field: 'childNodeIds', value: child });
          continue;
        }
        if (!children.includes(mapped)) children.push(mapped);
      }
      next['childNodeIds'] = children;
      const primary = typeof next['primaryNodeId'] === 'string' ? next['primaryNodeId'] : '';
      const mappedPrimary = idMap[primary];
      if (mappedPrimary !== undefined) next['primaryNodeId'] = mappedPrimary;
      else if (children.length > 0) next['primaryNodeId'] = children[0];
      else {
        droppedRefs.push({ nodeId: originalId, field: 'primaryNodeId', value: primary });
        delete next['primaryNodeId'];
      }
    }

    if (kind === 'generation') {
      const rawInputs = Array.isArray(next['inputs']) ? (next['inputs'] as unknown[]) : [];
      const inputs: string[] = [];
      for (const input of rawInputs) {
        if (typeof input !== 'string') continue;
        const mapped = idMap[input];
        if (mapped === undefined) {
          droppedRefs.push({ nodeId: originalId, field: 'inputs', value: input });
          continue;
        }
        inputs.push(mapped);
      }
      // 顺序即生成顺序（S0-1 §4.6），所以这里不做排序，只做映射。
      next['inputs'] = inputs;
    }

    return next as unknown as CanvasNode;
  });

  // ── 第二步：边也重映射；端点在粘贴集内才保留 ───────────────
  const edges: CanvasEdge[] = payload.edges.map((edge, index) => {
    const from = idMap[edge.from];
    const to = idMap[edge.to];
    if (from === undefined || to === undefined) {
      throw new InputError(`边的端点不在粘贴集内：${edge.edgeId}`);
    }
    return {
      edgeId: requireId(makeEdgeId(edge.edgeId, index), `edgeIdFactory(${edge.edgeId})`),
      kind: edge.kind,
      from,
      to,
      createdAt: pastedAt,
    };
  });

  return { nodes, edges, idMap, droppedRefs };
}

/** 一次复制 + 粘贴的组合便利函数（UI 的 Ctrl+C / Ctrl+V 直接调这个）。 */
export function copyAndPaste(
  source: { nodes: readonly CanvasNode[]; edges: readonly CanvasEdge[]; workspaceId: string | null },
  selection: readonly string[],
  options: PasteOptions & { copiedAt?: string },
): PasteResult {
  const payload = copyNodes(source.nodes, source.edges, selection, {
    sourceWorkspaceId: source.workspaceId,
    copiedAt: options.copiedAt,
  });
  return pasteNodes(payload, new Set(source.nodes.map(node => node.nodeId)), options);
}
