// 来源: dsh-synapnova@3fd1d00 canvas/commands.js
/**
 * EV Canvas · 画布字段级命令与有界 undo/redo 栈
 *
 * 纯模块：无 DOM、无 Store、无 IO。命令**从不写任何东西**——它构造一份
 * *变更意图*（一组字段级补丁），由调用方经 Store 提交。这个切分是 undo 诚实性的
 * 来源：栈里存的是意图而不是文档快照，所以 undo 永远不可能复活整份工作区的旧副本，
 * 也不可能重放一次投影更新。
 *
 * 这里冻结的语义（T0 §3/§4，HANDOFF FR-09.6/FR-09.7）：
 * - 一次拖动 = 一步 undo。指针移动合并成单个意图；只有手势边界闭合时才记录。
 * - 连续视口手势（平移/缩放）= 一步 undo；调用方用 `beginGesture()` / `endGesture()`
 *   包住整段滚轮/指针流。
 * - 新的用户编辑清空 redo 分支。
 * - 后台同步走 `applyBackground()`，它不碰任何一个栈。单独入口是故意的。
 * - undo/redo 只产出逆补丁。它们从不发送提示、fork 会话、运行工具或触碰 `projection`。
 *
 * 与旧版的唯一偏离：缩放钳制范围从旧 app.js 的 `0.6–4` 改为 S1-9 / `constants.ts`
 * 的 `0.05–5`（与滚轮因子、滑杆范围严格一致，避免滑杆拖到滚轮到不了的档位）。
 */

import { DEFAULT_VIEWPORT } from '@/canvas/model';
import { MAX_ZOOM, MIN_ZOOM } from '@/shared/constants';

/**
 * undo 深度。
 *
 * 暂定起始值。FR-09.7 要求深度「容量实测后定」；100 只是为了让长编辑会话
 * 不至于无界增长。把它当**未实测**看待：真实会话采样后再改
 * （每条意图都保留 before/after，内存成本 = 单条大小 × 深度）。
 */
export const DEFAULT_HISTORY_LIMIT = 100;

/** 最小合法缩放，与 `constants.ts` 及滑杆 min 一致（5%）。 */
export { MIN_ZOOM, MAX_ZOOM };

export const COMMAND_KINDS = Object.freeze({
  moveCard: 'moveCard',
  toggleCollapse: 'toggleCollapse',
  setViewport: 'setViewport',
  resetPositions: 'resetPositions',
  createRegion: 'createRegion',
  updateRegion: 'updateRegion',
  deleteRegion: 'deleteRegion',
  addAnnotation: 'addAnnotation',
  updateAnnotation: 'updateAnnotation',
  deleteAnnotation: 'deleteAnnotation',
} as const);

/** 补丁可以落在哪些字段组。Store 适配层据此决定动哪一组，而不是 diff 整个文档。 */
export type PatchArea = 'layoutCards' | 'layoutCollapsed' | 'layoutViewport' | 'regions' | 'annotations' | 'materials';

export interface Position {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Region {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Annotation {
  id: string;
  x: number;
  y: number;
  text: string;
  targetCardId: string | null;
  targetRegionId: string | null;
}

export interface Material {
  id: string;
  name: string;
  importedAt: string;
  bytes: number;
  text: string;
}

/**
 * 一条字段级写入：`{ area, id, field, before, after }`。
 * `before` / `after` 在入栈前已深拷贝，调用方后续改值不会污染历史。
 */
export interface Patch<T = unknown> {
  area: PatchArea;
  id: string;
  before: T;
  after: T;
}

/** 一份变更意图。`patches` 为空表示没有实际改动。 */
export interface Intent {
  kind: string;
  patches: Patch[];
}

/** 已记录的意图（带 entryId 与 meta）。 */
export interface RecordedIntent extends Intent {
  entryId: number;
  meta: Record<string, unknown> & { recorded: true };
}

/** undo/redo 返回的意图。`undo()` 已经把 before/after 交换过，调用方一律正向应用。 */
export interface DirectionalIntent extends Intent {
  direction: 'undo' | 'redo';
  meta: Record<string, unknown>;
}

/**
 * 命令收发的布局包。
 *
 * 形状 = 冻结文档里的 `layout` + `regions` + `annotations` + `materials`。
 * `materials` 是**顶层**文档字段（不是 `layout` 成员），但同样走这套补丁词汇——
 * 这样「导入一个材料」与「拖动一张卡片」是同一栈里相邻的一步，而不是第二套
 * 无法与之交错的栈。
 */
export interface LayoutBundle {
  cards: Record<string, Position>;
  collapsed: Record<string, true>;
  viewport: Viewport;
  regions: Region[];
  annotations: Annotation[];
  materials: Material[];
}

export type LayoutBundleInput = Partial<LayoutBundle> & Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as unknown as T;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value) as unknown as T;
  }
  return value;
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T;
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) copy[key] = deepClone(value[key]);
    return copy as unknown as T;
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} 必须是有限数字`);
  return value;
}

function requireCardId(cardId: unknown): string {
  if (typeof cardId !== 'string' || cardId === '') throw new TypeError('cardId 必须是非空字符串');
  return cardId;
}

function requireId(id: unknown, field: string): string {
  if (typeof id !== 'string' || id === '') throw new TypeError(`${field} 必须是非空字符串`);
  return id;
}

/** 把缩放钳到 `[MIN_ZOOM, MAX_ZOOM]`，并取到两位小数（与滑杆 1% 档一致）。 */
export function clampZoom(zoom: number): number {
  const value = finiteNumber(zoom, 'zoom');
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function normalizePosition(position: unknown, field = 'position'): Position {
  if (!isPlainObject(position)) throw new TypeError(`${field} 必须是对象`);
  return {
    x: Math.round(finiteNumber(position['x'], `${field}.x`)),
    y: Math.round(finiteNumber(position['y'], `${field}.y`)),
  };
}

function normalizeViewportInput(viewport: unknown): Partial<Viewport> {
  if (!isPlainObject(viewport)) throw new TypeError('viewport 必须是对象');
  const next: Partial<Viewport> = {};
  if (viewport['x'] !== undefined) next.x = finiteNumber(viewport['x'], 'viewport.x');
  if (viewport['y'] !== undefined) next.y = finiteNumber(viewport['y'], 'viewport.y');
  if (viewport['zoom'] !== undefined) next.zoom = clampZoom(viewport['zoom'] as number);
  return next;
}

function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

/**
 * 一条 undo 记录。
 *
 * `patches` 是有序的字段级写入；`area` 是 `layoutCards` / `layoutCollapsed` /
 * `layoutViewport` / `regions` / `annotations` / `materials` 之一。
 */
function entry(kind: string, patches: Patch[], meta: Record<string, unknown> = {}): RecordedEntry {
  return deepFreeze({ kind, patches, ...meta }) as RecordedEntry;
}

type RecordedEntry = { kind: string; patches: Patch[]; meta: Record<string, unknown> };

function applyPatchesForward(state: LayoutBundle, patches: readonly Patch[]): void {
  for (const patch of patches) writePatch(state, { area: patch.area, id: patch.id, value: patch.after });
}

/** 交换每条补丁的 before/after——这是意图被取逆的唯一方式。 */
function invertPatches(patches: readonly Patch[]): Patch[] {
  return patches.map(patch => deepClone({ area: patch.area, id: patch.id, before: patch.after, after: patch.before }) as Patch);
}

interface PatchWrite {
  area: PatchArea;
  id: string;
  value: unknown;
}

/**
 * 把一条字段补丁写进调用方持有的布局包。
 *
 * `state` 是调用方的工作副本，永远不是 Store 对象。实体已被其它路径删掉的补丁
 * 是 no-op——undo 不得复活用户主动删掉的实体。
 */
function writePatch(state: LayoutBundle, write: PatchWrite): void {
  switch (write.area) {
    case 'layoutCards': {
      if (!isPlainObject(state.cards)) state.cards = {};
      if (write.value === null) delete state.cards[write.id];
      else {
        const position = write.value as Position;
        state.cards[write.id] = { x: position.x, y: position.y };
      }
      return;
    }
    case 'layoutCollapsed': {
      if (!isPlainObject(state.collapsed)) state.collapsed = {};
      if (write.value === true) state.collapsed[write.id] = true;
      else delete state.collapsed[write.id];
      return;
    }
    case 'layoutViewport': {
      const viewport = write.value as Viewport;
      state.viewport = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
      return;
    }
    case 'regions': {
      if (!Array.isArray(state.regions)) state.regions = [];
      const index = state.regions.findIndex(region => region.id === write.id);
      if (write.value === null) {
        if (index !== -1) state.regions.splice(index, 1);
        return;
      }
      if (index === -1) state.regions.push(deepClone(write.value as Region));
      else state.regions[index] = deepClone(write.value as Region);
      return;
    }
    case 'annotations': {
      if (!Array.isArray(state.annotations)) state.annotations = [];
      const index = state.annotations.findIndex(annotation => annotation.id === write.id);
      if (write.value === null) {
        if (index !== -1) state.annotations.splice(index, 1);
        return;
      }
      if (index === -1) state.annotations.push(deepClone(write.value as Annotation));
      else state.annotations[index] = deepClone(write.value as Annotation);
      return;
    }
    // `materials` 是**顶层** workspace 字段（shared/schema），不是 `layout` 成员。
    // 仍然走同一套补丁词汇，理由见 LayoutBundle 注释。
    case 'materials': {
      if (!Array.isArray(state.materials)) state.materials = [];
      const index = state.materials.findIndex(material => material.id === write.id);
      if (write.value === null) {
        if (index !== -1) state.materials.splice(index, 1);
        return;
      }
      if (index === -1) state.materials.push(deepClone(write.value as Material));
      else state.materials[index] = deepClone(write.value as Material);
      return;
    }
    default:
      throw new TypeError(`未知的 patch area: ${String((write as { area: string }).area)}`);
  }
}

/** 把任意布局输入规范化成一份完整的布局包（缺字段补默认值，坏值丢弃）。 */
export function cloneLayout(layout: LayoutBundleInput | null | undefined): LayoutBundle {
  const source: Record<string, unknown> = isPlainObject(layout) ? layout : {};
  const cards: Record<string, Position> = {};
  const rawCards = source['cards'];
  if (isPlainObject(rawCards)) {
    for (const [id, position] of Object.entries(rawCards)) {
      if (isPlainObject(position) && Number.isFinite(position['x']) && Number.isFinite(position['y'])) {
        cards[id] = { x: position['x'] as number, y: position['y'] as number };
      }
    }
  }
  const collapsed: Record<string, true> = {};
  const rawCollapsed = source['collapsed'];
  if (isPlainObject(rawCollapsed)) {
    for (const [id, value] of Object.entries(rawCollapsed)) if (value === true) collapsed[id] = true;
  }
  const rawViewport = source['viewport'];
  const viewport: Viewport = isPlainObject(rawViewport)
    ? {
        x: Number.isFinite(rawViewport['x']) ? (rawViewport['x'] as number) : DEFAULT_VIEWPORT.x,
        y: Number.isFinite(rawViewport['y']) ? (rawViewport['y'] as number) : DEFAULT_VIEWPORT.y,
        zoom: Number.isFinite(rawViewport['zoom']) && (rawViewport['zoom'] as number) > 0
          ? (rawViewport['zoom'] as number)
          : DEFAULT_VIEWPORT.zoom,
      }
    : { ...DEFAULT_VIEWPORT };
  return {
    cards,
    collapsed,
    viewport,
    regions: Array.isArray(source['regions']) ? (source['regions'] as Region[]).map(item => deepClone(item)) : [],
    annotations: Array.isArray(source['annotations']) ? (source['annotations'] as Annotation[]).map(item => deepClone(item)) : [],
    // `materials` 是顶层文档字段，但随这个包一起流转，理由同 regions/annotations：
    // 不在这里带上，没被它碰到的材料就会在下一次 undo/redo 后消失。
    materials: Array.isArray(source['materials']) ? (source['materials'] as Material[]).map(item => deepClone(item)) : [],
  };
}

/** 命令构造器：纯函数，只读当前布局，产出意图。 */
export interface Commands {
  moveCard(cardId: string, position: unknown): Intent;
  setCardPosition(cardId: string, position: unknown | null): Intent;
  toggleCollapse(cardId: string): Intent;
  setCollapsed(cardId: string, collapsed: boolean): Intent;
  resetCardPositions(): Intent;
  setViewport(viewport: unknown): Intent;
  createRegion(region: unknown): Intent;
  updateRegion(regionId: string, changes: unknown): Intent;
  deleteRegion(regionId: string): Intent;
  addAnnotation(annotation: unknown): Intent;
  updateAnnotation(annotationId: string, changes: unknown): Intent;
  deleteAnnotation(annotationId: string): Intent;
}

export interface CommandHistoryOptions {
  limit?: number;
  /** 必须返回**权威的**当前布局包（通常是 `layoutBundle(buildCanvasModel(snapshot))`）。 */
  readLayout?: () => LayoutBundleInput | null | undefined;
}

export interface CommandHistory {
  commands: Commands;
  commit(command: Intent): RecordedIntent | null;
  beginGesture(kind?: string, meta?: Record<string, unknown>): void;
  updateGesture(command: Intent): Intent & { pending: true };
  endGesture(): RecordedIntent | null;
  cancelGesture(): void;
  gestureOpen(): boolean;
  applyBackground(intent?: Intent | null): { kind: string; patches: Patch[]; recorded: false };
  undo(): DirectionalIntent | null;
  redo(): DirectionalIntent | null;
  applyTo(bundle: LayoutBundleInput | null | undefined, intent: Intent | null | undefined): LayoutBundle;
  preview(bundle: LayoutBundleInput | null | undefined, command: Intent): LayoutBundle;
  readonly limit: number;
  readonly undoDepth: number;
  readonly redoDepth: number;
  canUndo(): boolean;
  canRedo(): boolean;
  inspect(): { undo: Intent[]; redo: Intent[] };
  reset(): void;
}

interface Gesture {
  kind: string;
  meta: Record<string, unknown>;
  patches: Map<string, Patch>;
}

/**
 * 命令构造器 + 历史栈。
 *
 * 实例只拥有两个栈与一个未闭合手势。它从不持有文档：`apply(command)` 返回意图，
 * 由调用方提交。
 *
 * 用法（全纯，无 DOM）：
 *
 *   const history = createCommandHistory({ limit: 100 })
 *   const intent = history.commit(history.commands.moveCard(cardId, { x, y }))
 *   await store.commit(intent.patches)          // 调用方的活
 *   history.undo()                              // 返回意图，无 IO
 *
 * `readLayout()` 必须返回权威的当前布局包。它在构造命令时被咨询，
 * 所以每条意图都带真实的 before/after。
 */
export function createCommandHistory(options: CommandHistoryOptions = {}): CommandHistory {
  const limit = Number.isSafeInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : DEFAULT_HISTORY_LIMIT;
  const readLayout = typeof options.readLayout === 'function' ? options.readLayout : (): LayoutBundleInput => ({});
  let undoStack: RecordedEntry[] = [];
  let redoStack: RecordedEntry[] = [];
  let gesture: Gesture | null = null;
  let sequence = 0;

  function currentLayout(): LayoutBundle {
    return cloneLayout(readLayout());
  }

  function trim(stack: RecordedEntry[]): RecordedEntry[] {
    // 有界单环：最旧的条目从队头掉出，永远不是整份文档的还原点。
    if (stack.length > limit) stack.splice(0, stack.length - limit);
    return stack;
  }

  function push(record: RecordedEntry): RecordedEntry | null {
    if (record.patches.length === 0) return null;
    undoStack = trim([...undoStack, record]);
    // 新的用户编辑让 redo 分支作废（FR-09.7）。
    redoStack = [];
    return record;
  }

  function nextToken(): number {
    sequence += 1;
    return sequence;
  }

  const commands: Commands = {
    /** 移动一张卡片。坐标取整到整数，世界空间。 */
    moveCard(cardId, position) {
      requireCardId(cardId);
      const next = normalizePosition(position);
      const state = currentLayout();
      const stored = state.cards[cardId];
      const before = stored === undefined ? null : { ...stored };
      if (before !== null && samePosition(before, next)) return { kind: COMMAND_KINDS.moveCard, patches: [] };
      return {
        kind: COMMAND_KINDS.moveCard,
        patches: [{ area: 'layoutCards', id: cardId, before, after: next }],
      };
    },

    /** 显式设置（或清空，用 `null`）一张卡片的手动位置。 */
    setCardPosition(cardId, position) {
      requireCardId(cardId);
      const state = currentLayout();
      const stored = state.cards[cardId];
      const before = stored === undefined ? null : { ...stored };
      const after = position === null ? null : normalizePosition(position);
      if (before === null && after === null) return { kind: 'setCardPosition', patches: [] };
      if (before !== null && after !== null && samePosition(before, after)) return { kind: 'setCardPosition', patches: [] };
      return { kind: 'setCardPosition', patches: [{ area: 'layoutCards', id: cardId, before, after }] };
    },

    /** 翻转持久化的折叠标记。只有这一个字段变化。 */
    toggleCollapse(cardId) {
      requireCardId(cardId);
      const state = currentLayout();
      const before = state.collapsed[cardId] === true;
      return {
        kind: COMMAND_KINDS.toggleCollapse,
        patches: [{ area: 'layoutCollapsed', id: cardId, before, after: !before }],
      };
    },

    setCollapsed(cardId, collapsed) {
      requireCardId(cardId);
      if (typeof collapsed !== 'boolean') throw new TypeError('collapsed 必须是 boolean');
      const state = currentLayout();
      const before = state.collapsed[cardId] === true;
      if (before === collapsed) return { kind: 'setCollapsed', patches: [] };
      return { kind: 'setCollapsed', patches: [{ area: 'layoutCollapsed', id: cardId, before, after: collapsed }] };
    },

    /**
     * 一步 undo 清空全部手动卡片位置（「整理布局」）。
     *
     * 位置是逐卡片字段，所以「全部重置」不是特殊批量操作：它就是每张**确实有**
     * 手动位置的卡片各一条 `after: null` 补丁。从未放置过的卡片不出现在意图里，
     * 于是意图与真实编辑量成正比，undo 能精确还原上一张画面。
     */
    resetCardPositions() {
      const state = currentLayout();
      const patches: Patch[] = [];
      for (const [cardId, position] of Object.entries(state.cards)) {
        patches.push({ area: 'layoutCards', id: cardId, before: { x: position.x, y: position.y }, after: null });
      }
      return { kind: COMMAND_KINDS.resetPositions, patches };
    },

    /** viewport 是整对象字段：一条补丁带三个数字。 */
    setViewport(viewport) {
      const nextInput = normalizeViewportInput(viewport);
      const state = currentLayout();
      const before = { ...state.viewport };
      const after = { ...before, ...nextInput };
      if (sameViewport(before, after)) return { kind: COMMAND_KINDS.setViewport, patches: [] };
      return {
        kind: COMMAND_KINDS.setViewport,
        patches: [{ area: 'layoutViewport', id: 'viewport', before, after }],
      };
    },

    createRegion(region) {
      if (!isPlainObject(region)) throw new TypeError('region 必须是对象');
      const id = requireId(region['id'], 'region.id');
      const state = currentLayout();
      if (state.regions.some(item => item.id === id)) throw new TypeError(`分区 ${id} 已存在`);
      const next: Region = {
        id,
        name: typeof region['name'] === 'string' ? (region['name'] as string) : '',
        x: Math.round(finiteNumber(region['x'], 'region.x')),
        y: Math.round(finiteNumber(region['y'], 'region.y')),
        w: Math.round(finiteNumber(region['w'], 'region.w')),
        h: Math.round(finiteNumber(region['h'], 'region.h')),
      };
      if (next.w <= 0 || next.h <= 0) throw new TypeError('分区尺寸必须为正');
      return { kind: COMMAND_KINDS.createRegion, patches: [{ area: 'regions', id, before: null, after: next }] };
    },

    updateRegion(regionId, changes) {
      requireId(regionId, 'regionId');
      if (!isPlainObject(changes)) throw new TypeError('changes 必须是对象');
      const state = currentLayout();
      const current = state.regions.find(region => region.id === regionId);
      if (current === undefined) throw new TypeError(`分区 ${regionId} 不存在`);
      const after: Region = { ...current };
      if (changes['name'] !== undefined) {
        if (typeof changes['name'] !== 'string') throw new TypeError('region.name 必须是文本');
        after.name = changes['name'] as string;
      }
      for (const field of ['x', 'y', 'w', 'h'] as const) {
        if (changes[field] !== undefined) after[field] = Math.round(finiteNumber(changes[field], `region.${field}`));
      }
      if (after.w <= 0 || after.h <= 0) throw new TypeError('分区尺寸必须为正');
      if (JSON.stringify(after) === JSON.stringify(current)) return { kind: COMMAND_KINDS.updateRegion, patches: [] };
      return { kind: COMMAND_KINDS.updateRegion, patches: [{ area: 'regions', id: regionId, before: current, after }] };
    },

    /**
     * 删除分区**框**。
     *
     * 只碰框本身与挂在它上面的旁注。框内的卡片由几何推导（`cardsInsideRegion`），
     * 从不存储，所以这里即使想删也删不到卡片。
     */
    deleteRegion(regionId) {
      requireId(regionId, 'regionId');
      const state = currentLayout();
      const current = state.regions.find(region => region.id === regionId);
      if (current === undefined) throw new TypeError(`分区 ${regionId} 不存在`);
      const patches: Patch[] = [{ area: 'regions', id: regionId, before: current, after: null }];
      for (const annotation of state.annotations) {
        if (annotation.targetRegionId === regionId) {
          patches.push({ area: 'annotations', id: annotation.id, before: annotation, after: null });
        }
      }
      // 故意没有 `layoutCards` 补丁：成员关系是几何的，删框在结构上碰不到卡与会话。
      return { kind: COMMAND_KINDS.deleteRegion, patches };
    },

    /** 添加旁注。必须恰好给一个目标（冻结形状）。 */
    addAnnotation(annotation) {
      if (!isPlainObject(annotation)) throw new TypeError('annotation 必须是对象');
      const id = requireId(annotation['id'], 'annotation.id');
      const state = currentLayout();
      if (state.annotations.some(item => item.id === id)) throw new TypeError(`旁注 ${id} 已存在`);
      const targetCardId = typeof annotation['targetCardId'] === 'string' && annotation['targetCardId'] !== ''
        ? (annotation['targetCardId'] as string)
        : null;
      const targetRegionId = typeof annotation['targetRegionId'] === 'string' && annotation['targetRegionId'] !== ''
        ? (annotation['targetRegionId'] as string)
        : null;
      if ((targetCardId === null) === (targetRegionId === null)) {
        throw new TypeError('旁注必须恰好指定一个 targetCardId 或 targetRegionId');
      }
      if (targetRegionId !== null && !state.regions.some(region => region.id === targetRegionId)) {
        throw new TypeError(`分区 ${targetRegionId} 不存在`);
      }
      const next: Annotation = {
        id,
        x: Math.round(finiteNumber(annotation['x'], 'annotation.x')),
        y: Math.round(finiteNumber(annotation['y'], 'annotation.y')),
        text: typeof annotation['text'] === 'string' ? (annotation['text'] as string) : '',
        targetCardId,
        targetRegionId,
      };
      return { kind: COMMAND_KINDS.addAnnotation, patches: [{ area: 'annotations', id, before: null, after: next }] };
    },

    updateAnnotation(annotationId, changes) {
      requireId(annotationId, 'annotationId');
      if (!isPlainObject(changes)) throw new TypeError('changes 必须是对象');
      const state = currentLayout();
      const current = state.annotations.find(annotation => annotation.id === annotationId);
      if (current === undefined) throw new TypeError(`旁注 ${annotationId} 不存在`);
      const after: Annotation = { ...current };
      if (changes['text'] !== undefined) {
        if (typeof changes['text'] !== 'string') throw new TypeError('annotation.text 必须是文本');
        after.text = changes['text'] as string;
      }
      for (const field of ['x', 'y'] as const) {
        if (changes[field] !== undefined) after[field] = Math.round(finiteNumber(changes[field], `annotation.${field}`));
      }
      if (JSON.stringify(after) === JSON.stringify(current)) return { kind: COMMAND_KINDS.updateAnnotation, patches: [] };
      return { kind: COMMAND_KINDS.updateAnnotation, patches: [{ area: 'annotations', id: annotationId, before: current, after }] };
    },

    deleteAnnotation(annotationId) {
      requireId(annotationId, 'annotationId');
      const state = currentLayout();
      const current = state.annotations.find(annotation => annotation.id === annotationId);
      if (current === undefined) throw new TypeError(`旁注 ${annotationId} 不存在`);
      return { kind: COMMAND_KINDS.deleteAnnotation, patches: [{ area: 'annotations', id: annotationId, before: current, after: null }] };
    },
  };

  /**
   * 把一条命令记为一步 undo，并返回要提交的意图。
   * 无变化的命令返回 `null`，所以点一张已经折叠的卡片不会长栈。
   */
  function commit(command: Intent): RecordedIntent | null {
    if (!isPlainObject(command) || !Array.isArray(command['patches'])) throw new TypeError('command 必须是由 commands 构造的意图');
    const intent = command as unknown as Intent;
    const record = entry(intent.kind ?? 'unknown', intent.patches.map(patch => deepClone(patch)), (command as { meta?: Record<string, unknown> }).meta ?? {});
    const pushed = push(record);
    if (pushed === null) return null;
    return { kind: record.kind, patches: deepClone(record.patches), entryId: nextToken(), meta: { ...record.meta, recorded: true } };
  }

  /**
   * 开始一个手势，但**现在不记录**。
   *
   * 这是拖动路径：指针移动喂 `updateGesture`，边界（`endGesture`）只记一条记录，
   * 而不是每次 pointermove 一条。
   */
  function beginGesture(kind = 'gesture', meta: Record<string, unknown> = {}): void {
    if (gesture !== null) throw new Error('已有一个未结束的手势');
    gesture = { kind, meta: deepClone(meta), patches: new Map() };
  }

  function gestureOpen(): boolean {
    return gesture !== null;
  }

  /**
   * 往未闭合手势里喂一个中间值。
   *
   * 只保留**第一个** `before` 与**最新**的 `after`，所以 60Hz 指针流塌成一条补丁，
   * 同时调用方在画布上仍能看到实时渲染。
   */
  function updateGesture(command: Intent): Intent & { pending: true } {
    if (gesture === null) throw new Error('没有进行中的手势');
    if (!isPlainObject(command) || !Array.isArray(command['patches'])) throw new TypeError('command 必须是由 commands 构造的意图');
    const open = gesture;
    for (const patch of command.patches) {
      const key = `${patch.area}:${patch.id}`;
      const existing = open.patches.get(key);
      if (existing === undefined) {
        open.patches.set(key, deepClone(patch));
        continue;
      }
      // 同一手势里的同一字段：保留最初的 `before`，取最新的 `after`。
      // 这就是「一次拖动一步」的成因。
      existing.after = deepClone(patch.after);
    }
    return { kind: open.kind, patches: [...open.patches.values()].map(patch => deepClone(patch)), pending: true };
  }

  /**
   * 关闭未闭合手势并记为**一步** undo。
   * 返回要提交的单条意图；什么都没变（比如只点击没移动）或没有手势时返回 null。
   */
  function endGesture(): RecordedIntent | null {
    if (gesture === null) return null;
    const open = gesture;
    const patches = [...open.patches.values()]
      .filter(patch => JSON.stringify(patch.before) !== JSON.stringify(patch.after))
      .map(patch => deepClone(patch));
    const kind = open.kind;
    const meta = open.meta;
    gesture = null;
    if (patches.length === 0) return null;
    const record = push(entry(kind, patches, meta));
    if (record === null) return null;
    return { kind: record.kind, patches: deepClone(record.patches), entryId: nextToken(), meta: { recorded: true } };
  }

  function cancelGesture(): void {
    gesture = null;
  }

  /**
   * 后台投影更新：显式地**不是**一步 undo。
   *
   * 返回给调用方应用的补丁（通常为空——投影字段是 Store 的事），两个栈都不动。
   * 独立签名正是重点：同步路径不可能误用 `commit`。
   */
  function applyBackground(intent: Intent | null = null): { kind: string; patches: Patch[]; recorded: false } {
    if (intent === null) return { kind: 'background', patches: [], recorded: false };
    if (!isPlainObject(intent) || !Array.isArray(intent['patches'])) throw new TypeError('intent 必须是字段级意图');
    const typed = intent as unknown as Intent;
    return { kind: typed.kind ?? 'background', patches: typed.patches.map(patch => deepClone(patch)), recorded: false };
  }

  /**
   * 弹出一条记录，返回它的**逆**意图与 redo 记录。
   *
   * 不写任何东西：补丁的 before/after 被交换后交回。调用方经 Store 应用；
   * undo 从不还原整份文档。
   */
  function undo(): DirectionalIntent | null {
    const record = undoStack.pop();
    if (record === undefined) return null;
    redoStack = trim([...redoStack, record]);
    return {
      kind: record.kind,
      direction: 'undo',
      // 已经是逆的：一律正向应用，不要二次取反。
      patches: invertPatches(record.patches),
      meta: { ...record.meta },
    };
  }

  function redo(): DirectionalIntent | null {
    const record = redoStack.pop();
    if (record === undefined) return null;
    undoStack = trim([...undoStack, record]);
    return { kind: record.kind, direction: 'redo', patches: record.patches.map(patch => deepClone(patch)), meta: { ...record.meta } };
  }

  /**
   * 把意图的补丁应用到调用方持有的布局包上。
   *
   * 适配层的便利方法：补丁解释只留在一处，UI 层不再自己实现「layoutCards 补丁是什么意思」。
   * 纯函数：包被拷贝、修改、返回。
   *
   * 方向说明：`undo()` 已经返回**逆**意图（before/after 交换过），所以这里一律正向应用。
   * 让调用方再翻一次方向，正是这里要挡在适配层之外的二次取反 bug。
   */
  function applyTo(bundle: LayoutBundleInput | null | undefined, intent: Intent | null | undefined): LayoutBundle {
    const state = cloneLayout(bundle);
    if (intent === null || intent === undefined) return state;
    applyPatchesForward(state, intent.patches);
    return state;
  }

  /** 把已构造好的命令（正向）应用到布局包——用于预览。 */
  function preview(bundle: LayoutBundleInput | null | undefined, command: Intent): LayoutBundle {
    const state = cloneLayout(bundle);
    if (isPlainObject(command) && Array.isArray(command['patches'])) applyPatchesForward(state, command.patches);
    return state;
  }

  return {
    commands,
    commit,
    beginGesture,
    updateGesture,
    endGesture,
    cancelGesture,
    gestureOpen,
    applyBackground,
    undo,
    redo,
    applyTo,
    preview,
    get limit() {
      return limit;
    },
    get undoDepth() {
      return undoStack.length;
    },
    get redoDepth() {
      return redoStack.length;
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    /** 测试/调试视图；条目是冻结的，且只含字段补丁。 */
    inspect() {
      return {
        undo: undoStack.map(record => ({ kind: record.kind, patches: deepClone(record.patches), meta: { ...record.meta } })),
        redo: redoStack.map(record => ({ kind: record.kind, patches: deepClone(record.patches), meta: { ...record.meta } })),
      };
    },
    /** 清空两个栈（新打开周期 / 切工作区）。 */
    reset() {
      undoStack = [];
      redoStack = [];
      gesture = null;
    },
  };
}

export default createCommandHistory;
