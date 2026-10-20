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
/** 滑杆范围（百分比），S1-9。 */
const SLIDER_MIN = 5;
const SLIDER_MAX = 500;
/** 判定「这是拖拽不是点击」的像素阈值；低于它按点击处理。 */
const DRAG_THRESHOLD_PX = 3;

export interface CanvasSurfaceProps {
  model: CanvasModel | null;
  /** 视口变化提交入口；由外层决定是否落盘。 */
  onViewportCommit: (viewport: { x: number; y: number; zoom: number }) => void;
  /** 选中集变化；由外层持有，便于键盘与批量操作复用。 */
  selectedCardIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  /** 卡片拖拽落位；一次拖拽只提交一次，`dx/dy` 取整后的世界坐标位移。 */
  onMoveCards: (moves: { cardId: string; x: number; y: number }[]) => void;
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
}: CanvasSurfaceProps): React.JSX.Element {
  const viewport = model?.viewport ?? { x: 0, y: 0, zoom: 1 };
  const [transform, setTransform] = useState<Transform>({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
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

  // 模型换了（切换工作区/重新加载）就跟随，除非用户正在拖拽。
  useEffect(() => {
    if (dragging) return;
    setTransform({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
  }, [viewport.x, viewport.y, viewport.zoom, dragging]);

  /**
   * 模型追上目标位移后释放 `pendingMove`。
   *
   * 判据用「所有被拖卡片是否已经落在目标坐标上」而不是定时器：定时器要么太短
   * （网络慢时照样闪），要么太长（松手后位置发虚、下次拖拽起点错）。用真实
   * 坐标判定，写盘快慢都不影响观感。
   *
   * `targets` 是松手时算出的绝对坐标；某个 id 不在 `targets` 里就不参与判定。
   * 兜底：3 秒内仍未追上（保存失败）也释放 —— 失败时外层会显示错误，
   * 卡片回到服务端真实位置才是对的，不能永远停在预览位置。
   */
  useEffect(() => {
    if (pendingMove === null) return;
    const settled = pendingMove.targets.every(({ cardId, x, y }) => {
      const position = getResolvedPosition(model, cardId);
      if (position === null) return true;
      return Math.abs(position.x - x) < 0.5 && Math.abs(position.y - y) < 0.5;
    });
    if (settled) {
      setPendingMove(null);
      return;
    }
    const timer = setTimeout(() => setPendingMove(null), 3000);
    return () => clearTimeout(timer);
  }, [pendingMove, model]);

  /** 提交视口变化。只在交互结束时落一次盘，避免拖拽过程中刷爆服务端。 */
  const commitViewport = useCallback(
    (next: Transform) => {
      onViewportCommit({ x: next.x, y: next.y, zoom: next.zoom });
    },
    [onViewportCommit],
  );

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    // 只按滚轮缩放；不让浏览器默认缩放叠加。
    event.preventDefault();
    const delta = -event.deltaY;
    setTransform(previous => {
      const zoom = clampZoom(previous.zoom * WHEEL_FACTOR_BASE ** (delta / 100));
      // clampZoom 对非法输入返回 NaN —— 那是 bug，不是「用 1 兜底」的场景，
      // 静默兜底会把一次计算错误藏起来，所以保持原值不变。
      return Number.isFinite(zoom) ? { ...previous, zoom } : previous;
    });
  }, []);

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
        setTransform(previous => ({
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
        setTransform(current => {
          commitViewport(current);
          return current;
        });
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
         * **不要在这里清掉预览。**
         *
         * 松手时模型里还是旧坐标：提交要经过 PATCH → 服务端落盘 → reload 才回来。
         * 若此时 `setDragPreview(null)`，卡片会立刻弹回旧位置，等 reload 到达再跳到
         * 新位置——用户看到的就是「松手后闪一下再跳」。这是肉眼可见的卡帧。
         *
         * 正确做法：把当前位移记成「待确认位移」，继续画在新位置上，等模型真的
         * 追上来（见下方 effect）再释放。中间不产生任何回跳。
         */
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
    setTransform(next);
    commitViewport(next);
  }, [commitViewport]);

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
            if (Number.isFinite(zoom)) setTransform(previous => ({ ...previous, zoom }));
          }}
          onPointerUp={() => setTransform(current => (commitViewport(current), current))}
          aria-label="缩放"
        />
        <span className="evc-zoom-label">{Math.round(transform.zoom * 100)}%</span>
        {selectedCardIds.length > 0 ? (
          <span className="evc-selection-label">已选 {selectedCardIds.length} 张</span>
        ) : null}
        <span className="evc-muted evc-hint">Shift+拖拽空白＝框选</span>
      </div>

      <div
        className={`evc-canvas-surface${dragging ? ' is-dragging' : ''}`}
        onWheel={onWheel}
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
            const pinned = pendingMove?.targets.find(target => target.cardId === card.id) ?? null;
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
