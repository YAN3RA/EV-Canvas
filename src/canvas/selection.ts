/**
 * EV Canvas · 多选与批量操作（FR-09.8 / S1-5）
 *
 * 为什么是独立模块：框选 / 加选 / 批量移动 / 批量删除是一组**集合操作**，
 * 它们不产生布局，也不产生命令意图——它们只回答「当前选中哪几个节点」，
 * 以及「把这一组节点整体位移多少」。把它们塞进命令历史会让「一次拖动一步
 * undo」的语义变模糊（框选不是编辑），而塞进 model 又会让纯投影层多出 UI 状态。
 *
 * 设计取舍：选择集用 `string[]`（保持点击顺序）而不是 `Set`。
 *   - 顺序有意义：批量删除时按逆序删、批量复制时按框选顺序排列结果；
 *   - 序列化友好：写进 UI 状态/URL 不需要先转数组；
 *   - 去重靠 `add` 守卫，重复调 `add` 不会产生重复项。
 *
 * 纯模块：无 DOM、无 Store、无 IO。输入是节点 id 集合，输出是新的 id 数组
 * 或字段级补丁；入参永不被修改。
 */

import { InputError } from '@/shared/errors';

/** 一次框选/点击能得到的最小命中形状：世界坐标矩形。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 参与框选的节点最小形状（不要求是完整 CanvasNode）。 */
export interface SelectableNode {
  nodeId: string;
  x: number | null;
  y: number | null;
  width?: number;
  height?: number;
  /** 隐藏节点不参与框选（FR-14：仅从画布隐藏的节点不可见也不可框到） */
  visibility?: string;
}

/** 全局字号/几何常量在这里只做兜底：真实尺寸由节点自己带。 */
const DEFAULT_NODE_WIDTH = 310;
const DEFAULT_NODE_HEIGHT = 276;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new InputError(`${field} 必须是非空字符串`);
  return value;
}

function toArray(selection: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(selection)) return [];
  const out: string[] = [];
  for (const id of selection) if (typeof id === 'string' && id !== '' && !out.includes(id)) out.push(id);
  return out;
}

/** 一个节点的世界坐标包围盒；坐标为 null（待自动布局）时返回 null。 */
export function nodeBounds(node: SelectableNode): Rect | null {
  if (node === null || typeof node !== 'object') return null;
  if (!finite(node.x) || !finite(node.y)) return null;
  const w = finite(node.width) && node.width > 0 ? node.width : DEFAULT_NODE_WIDTH;
  const h = finite(node.height) && node.height > 0 ? node.height : DEFAULT_NODE_HEIGHT;
  return { x: node.x, y: node.y, w, h };
}

/** 矩形是否相交（含完全包含）。退化矩形（w/h 为 0）只算点接触，不选中。 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  if (!isRect(a) || !isRect(b)) return false;
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function isRect(value: unknown): value is Rect {
  if (value === null || typeof value !== 'object') return false;
  const rect = value as Record<string, unknown>;
  return finite(rect['x']) && finite(rect['y']) && finite(rect['w']) && finite(rect['h']);
}

/**
 * 框选：返回与矩形相交的可见节点 id，按入参节点顺序。
 *
 * 隐藏节点（`visibility === 'hidden'`）永远不被框到：它们在画布上不可见，
 * 框选命中它们会让「我框了三个却删了四个」发生。坐标未定的节点同理。
 */
export function nodesInRect(nodes: readonly SelectableNode[], rect: Rect): string[] {
  if (!isRect(rect)) return [];
  const hit: string[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node === null || typeof node !== 'object') continue;
    if (typeof node.nodeId !== 'string' || node.nodeId === '') continue;
    if (node.visibility === 'hidden') continue;
    const bounds = nodeBounds(node);
    if (bounds === null) continue;
    if (rectsIntersect(bounds, rect)) hit.push(node.nodeId);
  }
  return hit;
}

/** 只保留仍然存在的节点 id（投影变化后清掉幽灵选中项）。 */
export function pruneSelection(selection: readonly string[], liveNodeIds: ReadonlySet<string>): string[] {
  return toArray(selection).filter(id => liveNodeIds.has(id));
}

/** 追加一个节点（已选中则原样返回，不改变顺序）。 */
export function addToSelection(selection: readonly string[], nodeId: string): string[] {
  const current = toArray(selection);
  requireId(nodeId, 'nodeId');
  if (current.includes(nodeId)) return current;
  return [...current, nodeId];
}

/** 移出一个节点。 */
export function removeFromSelection(selection: readonly string[], nodeId: string): string[] {
  const current = toArray(selection);
  requireId(nodeId, 'nodeId');
  return current.filter(id => id !== nodeId);
}

/** 切换一个节点的选中态（框选后的 Ctrl+点击）。 */
export function toggleSelection(selection: readonly string[], nodeId: string): string[] {
  const current = toArray(selection);
  requireId(nodeId, 'nodeId');
  return current.includes(nodeId) ? current.filter(id => id !== nodeId) : [...current, nodeId];
}

/** 全选（按入参顺序）。 */
export function selectAll(nodes: readonly SelectableNode[]): string[] {
  const ids: string[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node === null || typeof node !== 'object') continue;
    if (node.visibility === 'hidden') continue;
    if (typeof node.nodeId === 'string' && node.nodeId !== '' && !ids.includes(node.nodeId)) ids.push(node.nodeId);
  }
  return ids;
}

/** 选中集的公共包围盒；空集返回 null。 */
export function selectionBounds(nodes: readonly SelectableNode[], selection: readonly string[]): Rect | null {
  const selected = new Set(toArray(selection));
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node === null || typeof node !== 'object') continue;
    if (!selected.has(node.nodeId)) continue;
    const bounds = nodeBounds(node);
    if (bounds === null) continue;
    found = true;
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.w);
    bottom = Math.max(bottom, bounds.y + bounds.h);
  }
  if (!found) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** 批量位移的一个字段补丁：`{ area: 'layoutCards', id, before, after }`。 */
export interface PositionPatch {
  area: 'layoutCards';
  id: string;
  before: { x: number; y: number };
  after: { x: number; y: number };
}

/**
 * 批量移动：把选中节点整体平移 `(dx, dy)`，产出**逐节点**的字段补丁。
 *
 * 为什么不产出一个「批量」补丁：undo 栈存的是字段级意图，一个批量补丁
 * 需要额外语义才能还原；逐节点补丁天然可逆，而且与单卡拖动走同一条提交路径。
 *
 * 位移按整数取整（与 `commands.moveCard` 一致），取整发生在**总量**上而不是
 * 每个节点各自累加，否则一次拖动后节点间的相对距离会漂移。
 */
export function movePatchesFor(
  nodes: readonly SelectableNode[],
  selection: readonly string[],
  dx: number,
  dy: number,
): PositionPatch[] {
  if (!finite(dx) || !finite(dy)) throw new InputError('位移必须是有限数字');
  const stepX = Math.round(dx);
  const stepY = Math.round(dy);
  if (stepX === 0 && stepY === 0) return [];
  const selected = new Set(toArray(selection));
  const patches: PositionPatch[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node === null || typeof node !== 'object') continue;
    if (!selected.has(node.nodeId)) continue;
    if (!finite(node.x) || !finite(node.y)) continue;
    patches.push({
      area: 'layoutCards',
      id: node.nodeId,
      before: { x: node.x, y: node.y },
      after: { x: Math.round(node.x) + stepX, y: Math.round(node.y) + stepY },
    });
  }
  return patches;
}

/**
 * 批量删除的候选集：选中项里**允许删除**的部分。
 *
 * `session` 节点不能在这里删：会话的权威在 DSH，画布只拥有投影（D5 受阻）。
 * 传进来的 `protectedKinds` 用来表达这条边界，默认不含任何 kind 时全部可删，
 * 但调用方（画布层）应当传 `['session']`。
 */
export function deletableSelection(
  nodes: readonly SelectableNode[],
  selection: readonly string[],
  protectedKinds: readonly string[] = ['session'],
): string[] {
  const selected = new Set(toArray(selection));
  const guarded = new Set(protectedKinds);
  const out: string[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node === null || typeof node !== 'object') continue;
    if (!selected.has(node.nodeId)) continue;
    const kind = (node as unknown as { kind?: unknown }).kind;
    if (typeof kind === 'string' && guarded.has(kind)) continue;
    out.push(node.nodeId);
  }
  return out;
}

/** 选择状态本身，便于调用方在 React 里直接 useState。 */
export interface SelectionState {
  ids: string[];
  /** 最近一次点中的节点（详情面板用它；批量操作不用） */
  anchorId: string | null;
}

/** 空选择。 */
export const EMPTY_SELECTION: Readonly<SelectionState> = Object.freeze({ ids: Object.freeze([]) as unknown as string[], anchorId: null });

/** 从一组 id 构造选择状态。 */
export function createSelection(ids: readonly string[] = [], anchorId: string | null = null): SelectionState {
  const normalized = toArray(ids);
  const anchor = typeof anchorId === 'string' && normalized.includes(anchorId) ? anchorId : (normalized.length > 0 ? normalized[normalized.length - 1] : null) ?? null;
  return { ids: normalized, anchorId: anchor };
}
