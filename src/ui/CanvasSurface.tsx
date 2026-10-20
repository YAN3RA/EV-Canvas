/**
 * EV Canvas · 画布表面（world 坐标容器 + 卡片渲染）
 *
 * 职责边界：**只负责把模型摆到屏幕上**。
 * 位置计算、邻接、碰撞全部来自 `src/canvas/*`；缩放钳制来自 `shared/constants`
 * （S1-9：`0.05–5`，与旧版 `0.6–4` 不同，故意偏离并已记录）。
 *
 * 为什么用 CSS transform 而不是逐卡算屏幕坐标：
 * 平移/缩放时只有一层 transform 变化，浏览器可合成，不必重排每张卡；
 * 卡片自身的 world 坐标保持整数，便于调试与对齐网格。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getResolvedPosition, type CanvasModel } from '../canvas/model.js';
import { CARD_HEIGHT, CARD_WIDTH } from '../canvas/layout.js';
import { MAX_ZOOM, MIN_ZOOM } from '../shared/constants.js';
import type { Patch } from '../canvas/commands.js';

/** 滚轮缩放因子：`1.1^(Δ/100)`，取自 S1-9 实测参数。 */
const WHEEL_FACTOR_BASE = 1.1;
/** 滑杆范围（百分比），S1-9。 */
const SLIDER_MIN = 5;
const SLIDER_MAX = 500;

export interface CanvasSurfaceProps {
  model: CanvasModel | null;
  /** 视口变化提交入口；由外层决定是否落盘。 */
  onViewportCommit: (viewport: { x: number; y: number; zoom: number }) => void;
  /** 当前选中卡片，用于高亮。 */
  selectedCardId?: string | null;
  onSelectCard?: (cardId: string) => void;
}

interface Transform {
  x: number;
  y: number;
  zoom: number;
}

/** 与 `commands.ts` 的 clampZoom 保持同一区间，此处不重复引依赖。 */
function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function CanvasSurface({ model, onViewportCommit, selectedCardId, onSelectCard }: CanvasSurfaceProps): React.JSX.Element {
  const viewport = model?.viewport ?? { x: 0, y: 0, zoom: 1 };
  const [transform, setTransform] = useState<Transform>({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // 模型换了（切换工作区/重新加载）就跟随，除非用户正在拖拽。
  useEffect(() => {
    if (dragging) return;
    setTransform({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
  }, [viewport.x, viewport.y, viewport.zoom, dragging]);

  /** 提交视口变化。只在交互结束时落一次盘，避免拖拽过程中刷爆服务端。 */
  const commitViewport = useCallback(
    (next: Transform) => {
      onViewportCommit({ x: next.x, y: next.y, zoom: next.zoom });
    },
    [onViewportCommit],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      // 只按滚轮缩放；按住 ctrl 时也让浏览器默认缩放走开，避免双缩放。
      event.preventDefault();
      const delta = -event.deltaY;
      setTransform(previous => {
        const zoom = clampZoom(previous.zoom * WHEEL_FACTOR_BASE ** (delta / 100));
        return { ...previous, zoom };
      });
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // 只在空白处开始平移；点在卡片上交给卡片自己处理。
      if (event.target !== event.currentTarget && (event.target as HTMLElement).closest('.evc-card')) return;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: transform.x,
        originY: transform.y,
      };
      setDragging(true);
    },
    [transform.x, transform.y],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    setTransform(previous => ({
      ...previous,
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    }));
  }, []);

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragRef.current === null) return;
      dragRef.current = null;
      setDragging(false);
      (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
      // 用最新 transform 落盘
      setTransform(current => {
        commitViewport(current);
        return current;
      });
    },
    [commitViewport],
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
            setTransform(previous => ({ ...previous, zoom }));
          }}
          onPointerUp={() => setTransform(current => (commitViewport(current), current))}
          aria-label="缩放"
        />
        <span className="evc-zoom-label">{Math.round(transform.zoom * 100)}%</span>
      </div>

      <div
        className={`evc-canvas-surface${dragging ? ' is-dragging' : ''}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
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
            const selected = selectedCardId === card.id;
            return (
              <article
                key={card.id}
                className={`evc-card${selected ? ' is-selected' : ''}${card.collapsed ? ' is-collapsed' : ''}`}
                style={{
                  left: position.x,
                  top: position.y,
                  width: CARD_WIDTH,
                  height: card.collapsed ? 'auto' : CARD_HEIGHT,
                }}
                onPointerDown={event => {
                  // 卡片自身不参与平移，避免拖空白与拖卡片混淆
                  event.stopPropagation();
                  onSelectCard?.(card.id);
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
