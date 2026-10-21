/**
 * EV Canvas · 画布表面（world 坐标容器 + 卡片渲染 + 拖拽/框选交互）
 *
 * 职责边界：**只负责把模型摆到屏幕上，并把指针事件翻译成交互意图**。
 * 位置计算、邻接、碰撞、选中集运算全部来自 `src/canvas/*`；缩放钳制来自
 * `shared/constants`（S1-9：`0.05–5`，与旧版 `0.6–4` 不同，故意偏离并已记录）。
 *
 * 为什么用 CSS transform 而不是逐卡算屏幕坐标：
 * 平移/缩放时只有一层 transform 变化，浏览器可合成，不必重排每张卡；
 * 卡片自身的 world 坐标保持整数，便于调试与对齐网格。
 *
 * 交互优先级（从高到低）：拖卡片 > 框选 > 平移。
 * 三者都用 pointer capture 实现，同一时刻只会有一个手势在跑。
 *
 * **未实现**：复制粘贴（需要八类节点层，当前 `CanvasModel` 只有会话卡片）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getResolvedPosition, type CanvasModel } from '../canvas/model.js';
import { CARD_HEIGHT, CARD_WIDTH } from '../canvas/layout.js';
import { MAX_ZOOM, MIN_ZOOM } from '../shared/constants.js';
import {
  nodesInRect,
  selectionBounds,
  type Rect,
  type SelectableNode,
} from '../canvas/selection.js';
import type { Patch } from '../canvas/commands.js';

/** 滚轮缩放因子：`1.1^(Δ/100)`，取自 S1-9 实测参数。 */
const WHEEL_FACTOR_BASE = 1.1;
/** 滑杆范围（百分比），跟随 constants 的 MIN/MAX_ZOOM。 */
const SLIDER_MIN = Math.round(MIN_ZOOM * 100);
const SLIDER_MAX = Math.round(MAX_ZOOM * 100);
/** 网格步长（world 坐标，与 `base.css` 的 `background-size: 40px` 保持一致）。 */
const GRID_SIZE = 40;
/**
 * 网格步长的视觉下限（屏幕像素）。
 *
 * 缩到很小的时候 `40 * zoom` 会趋近 0，网格密到糊成一片灰。低于这个值时
 * 不再继续缩小步长——宁可让网格看起来「不再变密」，也不要变成噪声。
 */
const GRID_MIN_STEP_PX = 8;
/** 判定「这是拖拽不是点击」的像素阈值；低于它按点击处理。 */
const DRAG_THRESHOLD_PX = 3;
/** 松手后等待模型追上目标位置的上限；超时即视为保存失败并释放预览。 */
const PENDING_MOVE_TIMEOUT_MS = 3000;

/**
 * 平移手势埋点开关（**默认关闭，不影响正常使用**）。
 *
 * 为什么需要它：UI-D1「拖空白画布松手后跳远」已经连续两轮靠读代码推断改错
 * （`d3cd9e1` 改卡片路径、`bd1dd7a` 改 pan 路径，用户复测仍复现）。旧版那次
 * 真正的定位手段是控制台时间线——`[evc-drag]` 打点显示 `pending-check` 连续
 * 9 秒不释放，才找到 timer 被重置。所以这里同样先取证，不猜根因。
 *
 * 启用方式（任一即可）：
 *   - URL 加 `?evc-debug=1`（宿主 iframe 内可能需要拼在画布 URL 上）
 *   - 控制台执行 `localStorage.setItem('evcDebug','1')` 后刷新
 * 关闭：`localStorage.removeItem('evcDebug')`。
 *
 * 输出前缀固定 `[evc-pan]`，便于过滤；序号递增，便于判断「同一帧被调用两次」
 * 这类 StrictMode 双执行问题。
 */
function panTraceEnabled(): boolean {
  try {
    if (typeof location === 'undefined') return false;
    if (new URLSearchParams(location.search).get('evc-debug') === '1') return true;
    return localStorage.getItem('evcDebug') === '1';
  } catch {
    // localStorage 在部分沙箱/隐私模式下会抛错；埋点不能把画布搞挂。
    return false;
  }
}

let panTraceSeq = 0;

/** 记录一条平移埋点；未启用时是空操作（零开销路径只多一次函数调用）。 */
function panTrace(event: string, detail: Record<string, unknown> = {}): void {
  if (!panTraceEnabled()) return;
  panTraceSeq += 1;
  // 用 console.log 而非 warn/error：这不是错误，只是取证。
  // eslint-disable-next-line no-console
  console.log(`[evc-pan] #${panTraceSeq} ${event}`, {
    t: typeof performance !== 'undefined' ? Math.round(performance.now()) : -1,
    ...detail,
  });
}

export interface CanvasSurfaceProps {
  model: CanvasModel | null;
  /** 视口变化提交入口；由外层决定是否落盘。 */
  onViewportCommit: (viewport: { x: number; y: number; zoom: number }) => void;
  /** 选中集变化；由外层持有，便于键盘与批量操作复用。 */
  selectedCardIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  /** 卡片拖拽落位；一次拖拽只提交一次，`dx/dy` 取整后的世界坐标位移。 */
  onMoveCards: (moves: { cardId: string; x: number; y: number }[]) => void;
  /**
   * HOME 键：把所有卡片重新排布到**当前视口**里（UI-D14）。
   *
   * 为什么由本组件发起而不是外层：只有这里同时持有 `transform`（当前平移/缩放）
   * 与容器尺寸。外层拿不到「用户现在正看着 world 坐标的哪一点」，只能退回绝对
   * 原点——那样按 HOME 会把视野甩到画布角落，正是用户报的问题。
   *
   * 参数是**已换算好的 world 原点**（当前视口左上角对应的 world 坐标）。
   */
  onArrangeAll: (origin: { x: number; y: number }) => void;
}

interface Transform {
  x: number;
  y: number;
  zoom: number;
}

/** 与 `commands.ts` 的 clampZoom 保持同一区间，此处不重复引依赖。 */
function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return NaN;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/** 一次进行中的手势。三种手势互斥，所以用一个判别联合而不是三个 ref。 */
type Gesture =
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'marquee'; pointerId: number; startX: number; startY: number; currentX: number; currentY: number }
  | {
      kind: 'cards';
      pointerId: number;
      startX: number;
      startY: number;
      /** 起始时的选中集，拖拽过程中不变 */
      ids: string[];
      /** 每个被拖卡片的原始位置（world） */
      origin: Record<string, { x: number; y: number }>;
      moved: boolean;
    };

/**
 * 把卡片适配成选中层认识的最小形状。
 *
 * 为什么需要这层适配：`selection.ts` 用 `nodeId` 表达稳定标识（为八类节点设计），
 * 而 `CanvasModel` 的卡片用 `id`。在这里翻译一次，好过把 `selection.ts` 改成
 * 同时认两种字段——那会让纯模块出现第二套命名，后续节点层接入时反而更乱。
 */
function toSelectable(model: CanvasModel | null): SelectableNode[] {
  if (model === null) return [];
  const out: SelectableNode[] = [];
  for (const card of model.cards) {
    const position = getResolvedPosition(model, card.id);
    if (position === null) continue;
    out.push({
      nodeId: card.id,
      x: position.x,
      y: position.y,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    });
  }
  return out;
}

export function CanvasSurface({
  model,
  onViewportCommit,
  selectedCardIds,
  onSelectionChange,
  onMoveCards,
  onArrangeAll,
}: CanvasSurfaceProps): React.JSX.Element {
  const viewport = model?.viewport ?? { x: 0, y: 0, zoom: 1 };
  const [transform, setTransform] = useState<Transform>({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
  /**
   * 最新 transform 的同步副本。
   *
   * 为什么需要：`endGesture` 是 `useCallback`，它捕获的是**渲染时**的 `transform`。
   * 而 `onPointerMove` 里的 `setTransform` 要到下一次渲染才生效，所以松手那次
   * `endGesture` 看到的往往是**上一帧**的值——提交上去的 viewport 比用户最后
   * 看到的位置旧一帧。ref 在每次 setTransform 的同一步写入，读它拿到的必是最新。
   */
  const transformRef = useRef<Transform>({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
  /** 统一的 transform 写入口：同时更新 ref 与 state，避免两者不一致。 */
  const applyTransform = useCallback((next: Transform | ((previous: Transform) => Transform)) => {
    setTransform(previous => {
      const value = typeof next === 'function' ? next(previous) : next;
      transformRef.current = value;
      return value;
    });
  }, []);
  const gestureRef = useRef<Gesture | null>(null);
  /** 框选矩形的屏幕坐标，仅用于绘制视觉反馈。 */
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** 拖拽中的卡片预览位移（world），避免每帧写回模型。 */
  const [dragPreview, setDragPreview] = useState<{ dx: number; dy: number } | null>(null);
  /**
   * 松手后、模型尚未追上新位置期间继续使用的位移。
   *
   * 存在的唯一理由是消除「松手→回跳→再跳到新位置」的闪跳：从 `onMoveCards`
   * 发出到 `reload` 落地之间有一次网络往返，这段时间必须继续把卡片画在新位置。
   * 一旦模型里这些卡片的位置真的等于目标值，就释放（见下面的 effect）。
   */
  const [pendingMove, setPendingMove] = useState<{ dx: number; dy: number; targets: { cardId: string; x: number; y: number }[] } | null>(null);
  const [dragging, setDragging] = useState(false);

  const selectable = useMemo(() => toSelectable(model), [model]);
  const selectedSet = useMemo(() => new Set(selectedCardIds), [selectedCardIds]);

  /**
   * 视图变换的**唯一**来源：本地手势状态。
   *
   * 不再从 `model.viewport` 回灌 —— 这是「拖空白画布放下就跳远」的根因。
   *
   * 踩过的坑：原先写 `useEffect(() => { if (dragging) return; setTransform(viewport) },
   * [viewport.x, viewport.y, viewport.zoom, dragging])`。松手时 `setDragging(false)`
   * 立刻执行，而此刻 `viewport` 仍是**保存前的旧值**（PATCH + reload 还没回来），
   * effect 于是把画布弹回旧位置；等 reload 带回新 viewport 再跳过去 —— 一放一弹。
   * 卡片那条路径我当时单独修了，pan 这条漏掉了。
   *
   * 现在本地手势是唯一权威：拖动时直接改 `transform`，松手提交，reload 不回灌。
   * `hasViewportCommitRef` 保障「切换工作区」时仍然跟随：只有 workspaceId 变化才
   * 用服务端 viewport 重置本地，同一工作区内的刷新不覆盖用户的视图。
   */
  const workspaceIdRef = useRef<string | null>(null);
  useEffect(() => {
    const workspaceId = model?.workspaceId ?? null;
    if (workspaceId === workspaceIdRef.current) return;
    // UI-D1 取证点：这里一旦被触发，本地 transform 就会被服务端 viewport 覆盖。
    // 若日志显示「pan-end 之后紧接 pan-rehydrate」，而用户没切换工作区，
    // 那就是 model 在 reload 期间短暂变成 null（或 workspaceId 抖动）导致的回灌。
    panTrace('pan-rehydrate', {
      from: workspaceIdRef.current,
      to: workspaceId,
      serverViewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
    });
    workspaceIdRef.current = workspaceId;
    applyTransform({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
    // 只在**换工作区**时同步一次；同一工作区的 viewport 更新不回灌（见上方注释）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.workspaceId]);

  /**
   * 模型追上目标后**同步**失效 `pendingMove`（不再用 effect）。
   *
   * 为什么不能放 effect：`useEffect` 在浏览器**绘制之后**执行。effect 里
   * `setPendingMove(null)` 会触发第二次渲染，于是这一帧先用旧值画一次、
   * 下一帧再画新值 —— 正好是用户看到的「松手后闪一下/跳一下」。
   * 在渲染期算出「是否已追上」，同一帧就用正确值渲染，中间没有可观测的中间态。
   *
   * 副作用是渲染期读模型，这是允许的：纯读、幂等、不触发额外渲染。
   */
  const pendingMoveActive = useMemo(() => {
    if (pendingMove === null) return null;
    const settledNow = pendingMove.targets.every(({ cardId, x, y }) => {
      const position = getResolvedPosition(model, cardId);
      if (position === null) return true;
      return Math.abs(position.x - x) < 0.5 && Math.abs(position.y - y) < 0.5;
    });
    return settledNow ? null : pendingMove;
  }, [pendingMove, model]);

  /**
   * 兜底计时器：**只随 pendingMove 重建，不跟 model**。
   *
   * 踩过的坑：依赖写成 `[pendingMove, model]`，而会话投影在实时更新（`model`
   * 每几十毫秒换一次），effect 的 cleanup 就不断清掉 timer 再重设 —— 3 秒兜底
   * 永远走不到。控制台里 `[evc-drag]` 从 t=9754 一直打到 t=18954（9 秒）就是
   * 这个现象。后果是 `pendingMove` 永久驻留：`pinned` 优先级高于 `dragPreview`，
   * 于是**框选后再拖拽完全拖不动**，且卡片卡在虚拟坐标上直到刷新。
   */
  useEffect(() => {
    if (pendingMove === null) return;
    const timer = setTimeout(() => setPendingMove(null), PENDING_MOVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // 依赖只留 pendingMove 的身份变化（`d3cd9e1` 起如此）。
    // 曾经这里还留着一个 `startedAt` 常量，只为「可读性」而存在、从未被读取，
    // 属于死代码，已删；需要计时就走 `[evc-drag]` 埋点里的 `performance.now()`。
  }, [pendingMove]);

  /** 提交视口变化。只在交互结束时落一次盘，避免拖拽过程中刷爆服务端。 */
  const commitViewport = useCallback(
    (next: Transform) => {
      panTrace('viewport-commit', { x: next.x, y: next.y, zoom: next.zoom });
      onViewportCommit({ x: next.x, y: next.y, zoom: next.zoom });
    },
    [onViewportCommit],
  );

  /**
   * 滚轮缩放。
   *
   * **必须用原生 addEventListener + `{ passive: false }`**，不能挂在 React 的
   * `onWheel` 上：React 19 把根容器的 wheel 监听注册为 passive，React 合成事件
   * 里的 `preventDefault()` 会被浏览器忽略并刷出
   * 「Unable to preventDefault inside passive event listener invocation」。
   * 后果不只是脏日志——页面会同时被浏览器整体缩放，画布缩放叠加浏览器缩放，
   * 观感上就是「拖/滚一下位置全乱」。
   */
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = surfaceRef.current;
    if (host === null) return;
    const onWheelNative = (event: WheelEvent): void => {
      event.preventDefault();
      const delta = -event.deltaY;
      applyTransform(previous => {
        const zoom = clampZoom(previous.zoom * WHEEL_FACTOR_BASE ** (delta / 100));
        // clampZoom 对非法输入返回 NaN —— 那是 bug，不是「用 1 兜底」的场景，
        // 静默兜底会把一次计算错误藏起来，所以保持原值不变。
        return Number.isFinite(zoom) ? { ...previous, zoom } : previous;
      });
    };
    host.addEventListener('wheel', onWheelNative, { passive: false });
    return () => host.removeEventListener('wheel', onWheelNative);
  }, [applyTransform]);

  /**
   * HOME：把全部卡片排到**当前视口**里（UI-D14）。
   *
   * 换算方式：视口左上角在屏幕上的位置是 `(transform.x, transform.y)`，
   * 而 world 坐标 0 就在屏幕的 `(transform.x, transform.y)` 处，所以
   * 视口左上角对应的 world 坐标是 `(-x/zoom, -y/zoom)`。
   *
   * 为什么监听挂在这里而不是 App：只有这里同时握有 `transform` 与容器尺寸。
   * App 拿不到「用户正看着哪儿」，只能退回绝对原点——那样按 HOME 会把视野
   * 甩到画布角落。
   *
   * 用 ref 读 `transformRef`（而非闭包里的 `transform`）：keydown 监听只挂一次，
   * 闭包捕获的会是首次渲染的值，用户平移之后按 HOME 就会算错原点。
   */
  useEffect(() => {
    const onHomeKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Home') return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      // 输入框等获焦时让位：HOME 在文本框里是「跳到行首」。
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true) return;
      event.preventDefault();
      const current = transformRef.current;
      const zoom = Number.isFinite(current.zoom) && current.zoom > 0 ? current.zoom : 1;
      // 留一点内边距，让第一张卡不贴着视口左上角。
      onArrangeAll({
        x: Math.round(-current.x / zoom) + 40,
        y: Math.round(-current.y / zoom) + 40,
      });
    };
    window.addEventListener('keydown', onHomeKey);
    return () => window.removeEventListener('keydown', onHomeKey);
  }, [onArrangeAll]);

  /** 屏幕坐标 → world 坐标。框选与拖拽都要用。 */
  const toWorld = useCallback(
    (clientX: number, clientY: number, host: HTMLElement): { x: number; y: number } => {
      const box = host.getBoundingClientRect();
      return {
        x: (clientX - box.left - transform.x) / transform.zoom,
        y: (clientY - box.top - transform.y) / transform.zoom,
      };
    },
    [transform.x, transform.y, transform.zoom],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const host = event.currentTarget;
      const cardElement = (event.target as HTMLElement).closest('[data-card-id]');
      const cardId = cardElement?.getAttribute('data-card-id') ?? null;

      if (cardId !== null) {
        // ── 拖卡片 ────────────────────────────────────────────────
        event.stopPropagation();
        // Shift/Ctrl 点击是加选/减选，不进入拖拽。
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          const next = selectedSet.has(cardId)
            ? selectedCardIds.filter(id => id !== cardId)
            : [...selectedCardIds, cardId];
          onSelectionChange(next);
          return;
        }
        // 点未选中的卡片：先把它变成唯一选中项，再开始拖。
        const ids = selectedSet.has(cardId) ? [...selectedCardIds] : [cardId];
        if (!selectedSet.has(cardId)) onSelectionChange(ids);
        const origin: Record<string, { x: number; y: number }> = {};
        for (const id of ids) {
          const position = getResolvedPosition(model, id);
          if (position !== null) origin[id] = { x: position.x, y: position.y };
        }
        if (Object.keys(origin).length === 0) return;
        host.setPointerCapture(event.pointerId);
        gestureRef.current = {
          kind: 'cards',
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          ids,
          origin,
          moved: false,
        };
        return;
      }

      // 空白处：Shift 或按住 Alt 才是框选，否则是平移。
      // 为什么不默认框选：画布最常见的动作是挪视图，框选是低频操作。
      if (event.shiftKey || event.altKey) {
        const start = toWorld(event.clientX, event.clientY, host);
        host.setPointerCapture(event.pointerId);
        gestureRef.current = {
          kind: 'marquee',
          pointerId: event.pointerId,
          startX: start.x,
          startY: start.y,
          currentX: start.x,
          currentY: start.y,
        };
        setMarquee({ x: 0, y: 0, w: 0, h: 0 });
        onSelectionChange([]);
        return;
      }

      host.setPointerCapture(event.pointerId);
      gestureRef.current = {
        kind: 'pan',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: transform.x,
        originY: transform.y,
      };
      panTrace('pan-start', {
        pointerId: event.pointerId,
        at: { x: event.clientX, y: event.clientY },
        origin: { x: transform.x, y: transform.y },
        zoom: transform.zoom,
      });
      setDragging(true);
    },
    [model, onSelectionChange, selectedCardIds, selectedSet, toWorld, transform.x, transform.y],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (gesture === null || gesture.pointerId !== event.pointerId) return;
      const host = event.currentTarget;

      if (gesture.kind === 'pan') {
        applyTransform(previous => ({
          ...previous,
          x: gesture.originX + (event.clientX - gesture.startX),
          y: gesture.originY + (event.clientY - gesture.startY),
        }));
        return;
      }

      if (gesture.kind === 'cards') {
        const dxScreen = event.clientX - gesture.startX;
        const dyScreen = event.clientY - gesture.startY;
        // 阈值：小于它视为点击，不产生位移补丁（避免「点一下就挪了 1px」）。
        if (!gesture.moved && Math.abs(dxScreen) < DRAG_THRESHOLD_PX && Math.abs(dyScreen) < DRAG_THRESHOLD_PX) return;
        gesture.moved = true;
        const dx = Math.round(dxScreen / transform.zoom);
        const dy = Math.round(dyScreen / transform.zoom);
        setDragPreview({ dx, dy });
        return;
      }

      // marquee
      const current = toWorld(event.clientX, event.clientY, host);
      gesture.currentX = current.x;
      gesture.currentY = current.y;
      setMarquee({
        x: Math.min(gesture.startX, current.x),
        y: Math.min(gesture.startY, current.y),
        w: Math.abs(current.x - gesture.startX),
        h: Math.abs(current.y - gesture.startY),
      });
    },
    [toWorld, transform.zoom],
  );

  const endGesture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (gesture === null || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);

      if (gesture.kind === 'pan') {
        setDragging(false);
        /**
         * 松手：**在 updater 之外**提交一次。
         *
         * 踩过的坑（UI-D1 的真正成因之一）：这里原先是
         * `setTransform(current => { commitViewport(current); return current })`。
         * 把副作用写进 updater 有两重问题：
         *   1. StrictMode 下 updater 会**被调用两次**，于是同一次松手提交两次
         *      viewport；两次提交各自带同一 revision 进入写队列，后一次基于
         *      尚未 reload 的旧模型重算快照，把前一次的正确位置**覆盖回旧值**。
         *   2. updater 允许被 React 丢弃或重放，副作用不在它的契约里。
         * 现在改为读 `transformRef.current`（已经是最新位置），只提交一次。
         */
        const settled = transformRef.current;
        panTrace('pan-end', { x: settled.x, y: settled.y, zoom: settled.zoom });
        commitViewport(settled);
        return;
      }

      if (gesture.kind === 'cards') {
        if (!gesture.moved) {
          setDragPreview(null);
          return;
        }
        const dx = Math.round((event.clientX - gesture.startX) / transform.zoom);
        const dy = Math.round((event.clientY - gesture.startY) / transform.zoom);
        if (dx === 0 && dy === 0) {
          setDragPreview(null);
          return;
        }
        const moves = gesture.ids
          .filter(id => gesture.origin[id] !== undefined)
          .map(id => ({ cardId: id, x: gesture.origin[id]!.x + dx, y: gesture.origin[id]!.y + dy }));
        if (moves.length === 0) {
          setDragPreview(null);
          return;
        }
        /**
         * 松手：把位移交给 `pendingMove` 接管，**同时清掉 `dragPreview`**。
         *
         * 这两步必须成对。踩过的坑：只设 `pendingMove` 不清 `dragPreview`，
         * 渲染时 `pinned` 优先所以看着正常；但 `pendingMove` 一被释放
         * （模型追上或 3s 超时），残留的 `dragPreview` 就重新生效，
         * 在**已经含位移的新位置**上再叠一次 dx/dy —— 卡片松手后瞬间跳远。
         *
         * 同一批次里更新，React 会合并成一次渲染，中间不产生回弹帧。
         */
        setDragPreview(null);
        setPendingMove({ dx, dy, targets: moves });
        onMoveCards(moves);
        return;
      }

      // marquee：用 world 矩形跑命中测试
      const rect: Rect = {
        x: Math.min(gesture.startX, gesture.currentX),
        y: Math.min(gesture.startY, gesture.currentY),
        w: Math.abs(gesture.currentX - gesture.startX),
        h: Math.abs(gesture.currentY - gesture.startY),
      };
      setMarquee(null);
      if (rect.w < 1 || rect.h < 1) return;
      onSelectionChange(nodesInRect(selectable, rect));
    },
    [commitViewport, onMoveCards, onSelectionChange, selectable, transform.zoom],
  );

  const resetView = useCallback(() => {
    const next = { x: 0, y: 0, zoom: 1 };
    applyTransform(next);
    commitViewport(next);
  }, [applyTransform, commitViewport]);

  /** 卡片列表：位置走纯函数解析，保证与导出/布局算法看到的是同一套坐标。 */
  const placedCards = useMemo(() => {
    if (model === null) return [];
    return model.cards.map(card => ({ card, position: getResolvedPosition(model, card.id) }));
  }, [model]);

  /** 选中集的 world 包围盒，用于画一圈「批量选中」提示。 */
  const selectionBox = useMemo(
    () => selectionBounds(selectable, selectedCardIds),
    [selectable, selectedCardIds],
  );

  /**
   * 会话血缘连线的 SVG 路径（UI-D16）。
   *
   * 数据源是 `card.parentId`——它是同一会话内「上一张卡」的链接，由
   * `buildCanvasModel` 在血缘分析阶段填好（`model.ts` 的 lineage pass）。
   * 这里不重新推导血缘，只把已有的父子关系画出来，避免第二套判定。
   *
   * 几何：从父卡**右侧中点**连到子卡**左侧中点**，用三次贝塞尔（控制点水平
   * 外推半个卡宽）画成柔和的 S 形。直线会让同一行内的连线与卡片边缘重叠，
   * 看不出方向。
   *
   * 跳过条件：任一端点没有坐标（`getResolvedPosition` 返回 null，说明卡片
   * 已被裁掉或数据缺失）时整条线不画——画一条悬空的线比不画更让人困惑。
   */
  const lineagePaths = useMemo(() => {
    if (model === null) return [];
    const byId = new Map<string, { x: number; y: number }>();
    for (const { card, position } of placedCards) {
      if (position !== null) byId.set(card.id, position);
    }
    const paths: { id: string; d: string }[] = [];
    for (const { card } of placedCards) {
      const parentId = card.parentId;
      if (parentId === null || parentId === undefined) continue;
      const from = byId.get(parentId);
      const to = byId.get(card.id);
      if (from === undefined || to === undefined) continue;
      const x1 = from.x + CARD_WIDTH;
      const y1 = from.y + CARD_HEIGHT / 2;
      const x2 = to.x;
      const y2 = to.y + CARD_HEIGHT / 2;
      const bend = Math.max(40, Math.abs(x2 - x1) / 2);
      paths.push({
        id: parentId + '->' + card.id,
        d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      });
    }
    return paths;
  }, [model, placedCards]);

  return (
    <div className="evc-canvas">
      <div className="evc-canvas-toolbar">
        <button type="button" onClick={resetView} title="重置视图">
          重置
        </button>
        <input
          type="range"
          min={SLIDER_MIN}
          max={SLIDER_MAX}
          value={Math.round(transform.zoom * 100)}
          onChange={event => {
            const zoom = clampZoom(Number(event.target.value) / 100);
            if (Number.isFinite(zoom)) applyTransform(previous => ({ ...previous, zoom }));
          }}
          /**
           * 滑杆松手提交一次。
           *
           * 原先写成 `setTransform(current => (commitViewport(current), current))`——
           * 与 pan 松手同一类错误：副作用在 updater 里，StrictMode 会提交两次。
           * 这里读 `transformRef.current`（onChange 已同步写入），提交一次即可。
           */
          onPointerUp={() => commitViewport(transformRef.current)}
          aria-label="缩放"
        />
        <span className="evc-zoom-label">{Math.round(transform.zoom * 100)}%</span>
        {selectedCardIds.length > 0 ? (
          <span className="evc-selection-label">已选 {selectedCardIds.length} 张</span>
        ) : null}
        <span className="evc-muted evc-hint">Shift+拖拽空白＝框选</span>
      </div>

      <div
        ref={surfaceRef}
        className={`evc-canvas-surface${dragging ? ' is-dragging' : ''}`}
        /**
         * 网格跟随平移/缩放（UI-D8）。
         *
         * 为什么用内联 `backgroundSize` / `backgroundPosition` 而不是把网格画在
         * `.evc-canvas-world` 里：world 层已经整体 `scale()` 了，网格若也放进去，
         * 线条会跟着放大变粗（1px 变 5px），观感是「网格糊成一团」。这里只把
         * 「步长」按 zoom 缩放、把「原点」按平移量偏移，线条本身始终 1px——
         * 这是 Infinite Canvas 一类工具的标准做法（S1-9 参考清单同款）。
         *
         * 下限保护：zoom 极小时（0.05）步长会缩到 2px，密到发灰。所以设一个
         * 视觉下限，低于它就不再把步长继续缩小，改为停止渲染细线——宁可网格消失，
         * 不要糊成一片。
         */
        style={{
          backgroundSize: `${Math.max(GRID_SIZE * transform.zoom, GRID_MIN_STEP_PX)}px ${Math.max(GRID_SIZE * transform.zoom, GRID_MIN_STEP_PX)}px`,
          backgroundPosition: `${transform.x}px ${transform.y}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        <div
          className="evc-canvas-world"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          {/*
           * 会话血缘连线（UI-D16，FR-12 的 `lineage` 一类）。
           *
           * 为什么画在 world 层内：连线必须跟着卡片一起平移缩放，画在外层就得
           * 每帧自己换算坐标，多一处容易出错的重复实现。
           *
           * 为什么用 SVG 而不是 div 边框：血缘是折线（父卡右侧 → 子卡左侧），
           * 用 div 拼要么变形要么留缝。SVG 的 `pointer-events: none` 也保证
           * 连线不吃掉画布的拖拽/框选事件。
           *
           * 只画 `lineage`（系统生成、只读）。`context`/`input` 是用户手工连线，
           * 需要交互（拉线、删除），不属于本次「只读渲染」范围。
           */}
          {lineagePaths.length > 0 ? (
            <svg className="evc-lineage-layer" aria-hidden="true">
              {lineagePaths.map(path => (
                <path key={path.id} className="evc-lineage-edge" d={path.d} />
              ))}
            </svg>
          ) : null}
          {placedCards.map(({ card, position }) => {
            if (position === null) return null;
            const selected = selectedSet.has(card.id);
            /**
             * 拖拽中：相对位移叠在当前位置上。
             *
             * 松手后（pendingMove）：**直接用绝对目标坐标**，不叠相对位移。
             * 这一点踩过：叠相对位移时，模型一旦追上（position 已变成目标），
             * 再叠一次 dx/dy 就会多移一倍 —— 卡片会二次跳动。绝对坐标在
             * 「模型未追上」和「已追上」两种状态下都指向同一个位置，天然无跳变。
             */
            const draggingThis = dragPreview !== null && selectedSet.has(card.id) ? dragPreview : null;
            const pinned = pendingMoveActive?.targets.find(target => target.cardId === card.id) ?? null;
            const moving = draggingThis !== null || pinned !== null;
            const left = pinned !== null ? pinned.x : position.x + (draggingThis?.dx ?? 0);
            const top = pinned !== null ? pinned.y : position.y + (draggingThis?.dy ?? 0);
            return (
              <article
                key={card.id}
                className={`evc-card${selected ? ' is-selected' : ''}${card.collapsed ? ' is-collapsed' : ''}${moving ? ' is-moving' : ''}`}
                style={{
                  left,
                  top,
                  width: CARD_WIDTH,
                  height: card.collapsed ? 'auto' : CARD_HEIGHT,
                }}
                data-card-id={card.id}
              >
                <header className="evc-card-title">{card.title || '（无标题）'}</header>
                {card.collapsed ? null : (
                  <p className="evc-card-question">{card.question || '（无提问内容）'}</p>
                )}
                {card.parentIdInferred === true ? <span className="evc-card-flag">推断父级</span> : null}
              </article>
            );
          })}

          {/* 框选矩形：画在 world 层内，跟着缩放走 */}
          {marquee !== null ? (
            <div
              className="evc-marquee"
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
            />
          ) : null}

          {/* 选中集包围盒：让「批量选中」在画布上看得见 */}
          {selectionBox !== null && selectedCardIds.length > 1 ? (
            <div
              className="evc-selection-box"
              style={{ left: selectionBox.x, top: selectionBox.y, width: selectionBox.w, height: selectionBox.h }}
            />
          ) : null}
        </div>
      </div>

      {model !== null && model.skipped.length > 0 ? (
        <div className="evc-canvas-warnings" role="status">
          已跳过 {model.skipped.length} 个无法解析的输入：{model.skipped[0]?.area}（{model.skipped[0]?.reason}）
        </div>
      ) : null}
    </div>
  );
}
