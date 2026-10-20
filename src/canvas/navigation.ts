// 来源: dsh-synapnova@3fd1d00 canvas/navigation.js（拆分后保留部分）
/**
 * EV Canvas · 画布导航（T4）——只保留导航与缩放级别
 *
 * **拆分说明（D14 / D17）**：旧 `navigation.js` 425 行同时含搜索、小地图、导航三类逻辑。
 * vNext 按裁决删除了前两类：
 *
 * | 旧能力 | 处置 | 依据 |
 * |---|---|---|
 * | `searchModel` / `searchScopeNotice` / `escapeRegExp` / `SEARCH_*` | **删除** | D17：删除节点搜索；只保留导出面板的 `exportSearchCards`（那是不同功能） |
 * | `minimapGeometry` / `minimapHitTest` / `minimapHitCard` / `MINIMAP_*` / `DEFAULT_SCREEN_SIZE` | **删除** | D14：移除小地图 |
 *
 * 保留并集中在这里的是**仍被使用**的部分：
 *   - `neighborCard`：键盘导航的父/子/同级/前后定位（FR-09.5）
 *   - `zoomLevelFor`：折叠与语义缩放的 LOD 档位（FR-09.3）
 *   - `cameraForWorldPoint`：把世界坐标居中到视口（适配视图/定位选中项）
 *
 * 为什么 `cameraForWorldPoint` 留下而小地图删除：它是相机变换本身，不是小地图专属。
 * 「定位选中项」「适配视图」都要用它，删掉会逼调用方各处重写变换。
 *
 * 纯模块：无 DOM、无 Store、无 IO、无 npm 依赖、无模型调用。输入是 `buildCanvasModel`
 * 产出的只读模型；每个函数返回新的普通数据，从不修改模型。
 */

import { getCard, getViewport } from '@/canvas/model';

/** 默认屏幕尺寸：视口宽高缺省时的兜底（不依赖 DOM，避免读到 0）。 */
export const DEFAULT_SCREEN_SIZE = Object.freeze({ width: 1280, height: 800 });

/**
 * 缩放级别（LOD）阈值。
 *
 * **待实测**：这是起始值，不是实测值。T4 要求真实切点对着运行中的画布采样
 * （卡片文字可读性 + 命中目标大小）后再校正。在此之前只要求默认值合理且单调。
 */
export const DEFAULT_ZOOM_THRESHOLDS = Object.freeze({
  /** 达到该缩放时卡片完整渲染。待实测。 */
  fullMinZoom: 1,
  /** 达到该缩放时卡片渲染为标题摘要。待实测。 */
  summaryMinZoom: 0.75,
});

/** 语义缩放档位 */
export type ZoomLevel = 'full' | 'summary' | 'dot';

/** 缩放阈值 */
export interface ZoomThresholds {
  fullMinZoom: number;
  summaryMinZoom: number;
}

/** 相机（= 视口）位置与缩放。 */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 卡片的最小形状：导航只读这些字段。 */
interface NavigableCard {
  id: string;
  parentId?: string | null;
}

function cardsOf(model: unknown): { cards: NavigableCard[]; byId: Map<string, NavigableCard> } {
  const cards: NavigableCard[] = [];
  const byId = new Map<string, NavigableCard>();
  if (!isPlainObject(model)) return { cards, byId };
  const raw = model['cards'];
  if (!Array.isArray(raw)) return { cards, byId };
  for (const card of raw) {
    if (!isPlainObject(card)) continue;
    const id = card['id'];
    if (typeof id !== 'string' || id === '') continue;
    if (byId.has(id)) continue;
    const typed = card as unknown as NavigableCard;
    cards.push(typed);
    byId.set(id, typed);
  }
  return { cards, byId };
}

/** 按画布绘制顺序（`model.cardOrder`）排列卡片，缺项补在末尾。 */
function orderedCards(model: unknown): NavigableCard[] {
  const { cards, byId } = cardsOf(model);
  const order = isPlainObject(model) && Array.isArray(model['cardOrder']) ? model['cardOrder'] : [];
  const seen = new Set<string>();
  const ordered: NavigableCard[] = [];
  for (const id of order) {
    if (typeof id !== 'string') continue;
    const card = byId.get(id);
    if (card === undefined || seen.has(id)) continue;
    seen.add(id);
    ordered.push(card);
  }
  for (const card of cards) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    ordered.push(card);
  }
  return ordered;
}

/** 一张卡片的直接子节点，按卡片顺序。环安全（不递归）。 */
function childrenOf(model: unknown, cardId: string): NavigableCard[] {
  return orderedCards(model).filter(card => card.parentId === cardId && card.id !== cardId);
}

/** 导航方向。 */
export type NeighborDirection = 'parent' | 'child' | 'sibling' | 'next' | 'prev';

/**
 * 沿一个方向取相邻卡片。
 *
 * - `parent`  —— 卡片的 `parentId`；根节点或断链时为 null。
 * - `child`   —— 卡片顺序里的第一个子节点；叶子时为 null。
 * - `sibling` —— 在**同一父节点**分叉出来的另一张卡片（`parentId` 相同且非 null），
 *                卡片顺序里最近的那张：先往后找，再从后往前。
 *                线性链没有同级（它的邻居是 parent 与 child），两个根节点也不算同级。
 * - `next` / `prev` —— 卡片顺序里相邻的一张（整幅画布的阅读顺序），到两端为 null。
 *
 * 未知卡片或未知方向返回 null；从不抛错。
 */
export function neighborCard(model: unknown, cardId: string, direction: NeighborDirection): string | null {
  if (typeof cardId !== 'string' || cardId === '') return null;
  const { byId } = cardsOf(model);
  const card = byId.get(cardId);
  if (card === undefined) return null;
  const ordered = orderedCards(model);
  const index = ordered.findIndex(item => item.id === cardId);
  switch (direction) {
    case 'parent': {
      const parentId = card.parentId;
      if (typeof parentId !== 'string' || parentId === '' || parentId === cardId) return null;
      // 父卡片不在模型里（来源消失）时不返回一个画不出来的 id。
      return byId.has(parentId) ? parentId : null;
    }
    case 'child': {
      const children = childrenOf(model, cardId);
      const first = children[0];
      return first === undefined ? null : first.id;
    }
    case 'sibling': {
      // 根节点没有父，也就没有分叉同级：两个根是两条独立谱系，不是一次选择的备选项。
      if (typeof card.parentId !== 'string' || card.parentId === '') return null;
      const siblings = ordered.filter(item => item.id !== cardId && item.parentId === card.parentId);
      if (siblings.length === 0) return null;
      const after = siblings.filter(item => ordered.findIndex(other => other.id === item.id) > index);
      const nextSibling = after[0];
      if (nextSibling !== undefined) return nextSibling.id;
      const last = siblings[siblings.length - 1];
      return last === undefined ? null : last.id;
    }
    case 'next': {
      if (index === -1) return null;
      const next = ordered[index + 1];
      return next === undefined ? null : next.id;
    }
    case 'prev': {
      if (index <= 0) return null;
      const previous = ordered[index - 1];
      return previous === undefined ? null : previous.id;
    }
    default:
      return null;
  }
}

/**
 * 某个缩放值对应的细节级别：'full' | 'summary' | 'dot'。
 *
 * 阈值是 `{ fullMinZoom, summaryMinZoom }`，都是含等号的下界；
 * 传入值非法时回落默认。两个阈值大小颠倒也能用（内部先归一化）。
 */
export function zoomLevelFor(zoom: number, thresholds: ZoomThresholds | null | undefined = DEFAULT_ZOOM_THRESHOLDS): ZoomLevel {
  const source = isPlainObject(thresholds) ? (thresholds as unknown as Record<string, unknown>) : {};
  const full = finiteNumber(source['fullMinZoom']) && (source['fullMinZoom'] as number) > 0
    ? (source['fullMinZoom'] as number)
    : DEFAULT_ZOOM_THRESHOLDS.fullMinZoom;
  const summary = finiteNumber(source['summaryMinZoom']) && (source['summaryMinZoom'] as number) > 0
    ? (source['summaryMinZoom'] as number)
    : DEFAULT_ZOOM_THRESHOLDS.summaryMinZoom;
  const fullMin = Math.max(full, summary);
  const summaryMin = Math.min(full, summary);
  const value = finiteNumber(zoom) && zoom > 0 ? zoom : 1;
  if (value >= fullMin) return 'full';
  if (value >= summaryMin) return 'summary';
  return 'dot';
}

/**
 * 把某个世界坐标居中到屏幕视口所需的相机位置。
 *
 * `screen = world * zoom + camera`（与 `export/scene` 同一套变换），
 * 所以把 `world` 放到屏幕中心的相机是 `centre - world * zoom`。
 */
export function cameraForWorldPoint(world: { x: number; y: number } | null, viewport: Camera | null, screen: { width: number; height: number } | null): { x: number; y: number } | null {
  if (!isPlainObject(world) || !finiteNumber(world.x) || !finiteNumber(world.y)) return null;
  const zoom = isPlainObject(viewport) && finiteNumber(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const width = isPlainObject(screen) && finiteNumber(screen.width) && screen.width > 0 ? screen.width : DEFAULT_SCREEN_SIZE.width;
  const height = isPlainObject(screen) && finiteNumber(screen.height) && screen.height > 0 ? screen.height : DEFAULT_SCREEN_SIZE.height;
  return { x: width / 2 - world.x * zoom, y: height / 2 - world.y * zoom };
}

/** 视口中心对应的世界坐标（`cameraForWorldPoint` 的逆）。 */
export function worldPointAtCenter(viewport: Camera | null, screen: { width: number; height: number } | null): { x: number; y: number } {
  const camera = isPlainObject(viewport) ? viewport : getViewport(null);
  const zoom = finiteNumber(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
  const width = isPlainObject(screen) && finiteNumber(screen.width) && screen.width > 0 ? screen.width : DEFAULT_SCREEN_SIZE.width;
  const height = isPlainObject(screen) && finiteNumber(screen.height) && screen.height > 0 ? screen.height : DEFAULT_SCREEN_SIZE.height;
  return { x: (width / 2 - camera.x) / zoom, y: (height / 2 - camera.y) / zoom };
}

/**
 * 定位一张卡片所需的相机位置：把卡片中心放在屏幕中心。
 *
 * 卡片不存在或没有可解析位置时返回 null——「定位」不该把视口甩到原点。
 */
export function cameraForCard(model: unknown, cardId: string, screen: { width: number; height: number } | null): { x: number; y: number } | null {
  const { byId } = cardsOf(model);
  const card = byId.get(cardId);
  if (card === undefined) return null;
  const position = resolvePosition(model, cardId);
  if (position === null) return null;
  const width = isPlainObject(card) && finiteNumber((card as unknown as Record<string, unknown>)['width'])
    ? ((card as unknown as Record<string, unknown>)['width'] as number)
    : 0;
  const height = isPlainObject(card) && finiteNumber((card as unknown as Record<string, unknown>)['height'])
    ? ((card as unknown as Record<string, unknown>)['height'] as number)
    : 0;
  return cameraForWorldPoint(
    { x: position.x + width / 2, y: position.y + height / 2 },
    getViewport(model),
    screen,
  );
}

/** 解析后的绘制坐标：手动位置优先，否则自然位置。 */
function resolvePosition(model: unknown, cardId: string): { x: number; y: number } | null {
  const card = getCard(model as never, cardId) as unknown as Record<string, unknown> | null;
  if (card === null) return null;
  const position = card['position'];
  if (isPlainObject(position) && finiteNumber(position['x']) && finiteNumber(position['y'])) {
    return { x: position['x'] as number, y: position['y'] as number };
  }
  const natural = card['naturalPosition'];
  if (isPlainObject(natural) && finiteNumber(natural['x']) && finiteNumber(natural['y'])) {
    return { x: natural['x'] as number, y: natural['y'] as number };
  }
  // 新模型用 `x`/`y` 直存坐标（S0-1 八类节点形状），见 `resolveCardPosition`。
  if (finiteNumber(card['x']) && finiteNumber(card['y'])) return { x: card['x'] as number, y: card['y'] as number };
  return null;
}
