// @ts-nocheck -- 测试里用鸭子类型 model，断言精确。
// 迁移自 dsh-synapnova@3fd1d00 test/canvas-navigation.test.js（拆分后只保留导航部分）
import { describe, it, expect } from 'vitest';
import { buildCanvasModel, questionCardId, threadCardId } from '@/canvas/model';
import {
  DEFAULT_SCREEN_SIZE,
  DEFAULT_ZOOM_THRESHOLDS,
  cameraForCard,
  cameraForWorldPoint,
  neighborCard,
  worldPointAtCenter,
  zoomLevelFor,
} from '@/canvas/navigation';

const ISO = '2026-10-18T09:00:00.000Z';
const userMessage = (id, text) => ({ id, kind: 'user', text, sourceSeq: Number(id.replace(/\D/g, '')) || 0, at: ISO });

function thread(id, messages, extra = {}) {
  return { id, title: `标题 ${id}`, dshSessionId: `session-${id}`, messages, pendingProcess: [], ...extra };
}

/** 投影驱动的模型：t1 有三轮问答，t2 是 t1 的子线程。 */
function snapshot(overrides = {}) {
  return {
    id: 'workspace-nav',
    revision: 2,
    projection: {
      threads: [
        thread('t1', [userMessage('u1', '第一个问题'), userMessage('u2', '第二个问题'), userMessage('u3', '第三个问题')]),
        thread('t2', [userMessage('u4', '子会话问题')], { parentId: 't1' }),
      ],
    },
    layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    regions: [],
    annotations: [],
    ...overrides,
  };
}

function modelOf(overrides = {}) {
  return buildCanvasModel(snapshot(overrides));
}

/** 手写字段的模型，用于负坐标与失源场景。 */
function modelWithCards(cards, extra = {}) {
  const cardsById = {};
  for (const card of cards) cardsById[card.id] = card;
  return {
    viewport: { x: 0, y: 0, zoom: 1 },
    cards,
    cardsById,
    cardOrder: cards.map(card => card.id),
    threads: [],
    regions: [],
    annotations: [],
    layoutCards: {},
    ...extra,
  };
}

function card(id, fields = {}) {
  return {
    id,
    threadId: id.split(':')[0],
    userQuestionSeq: null,
    parentId: null,
    threadParentId: null,
    previousCardId: null,
    title: '',
    question: '',
    naturalPosition: { x: 0, y: 0 },
    position: null,
    positionLocked: false,
    collapsed: false,
    ...fields,
  };
}

describe('D14/D17 删除口径守卫', () => {
  it('小地图与节点搜索已从模块里移除，不再可导入', async () => {
    const navigation = await import('@/canvas/navigation');
    for (const removed of ['minimapGeometry', 'minimapHitTest', 'minimapHitCard', 'MINIMAP_CARD_SIZE', 'MINIMAP_PADDING', 'searchModel', 'searchScopeNotice', 'escapeRegExp', 'SEARCH_HIT_LIMIT', 'SEARCH_SNIPPET_RADIUS', 'SEARCH_FIELD_MAX_LENGTH']) {
      expect(navigation[removed], `${removed} 应已被删除（D14/D17）`).toBeUndefined();
    }
  });

  it('保留下来的导航能力都还在', async () => {
    const navigation = await import('@/canvas/navigation');
    for (const kept of ['neighborCard', 'zoomLevelFor', 'cameraForWorldPoint', 'DEFAULT_ZOOM_THRESHOLDS', 'DEFAULT_SCREEN_SIZE']) {
      expect(navigation[kept], `${kept} 不应被误删`).toBeDefined();
    }
  });
});

describe('邻居导航', () => {
  it('父/子/同级/前后，缺失相邻返回 null', () => {
    const model = modelOf();
    const first = questionCardId('t1', 0);
    const second = questionCardId('t1', 1);
    const third = questionCardId('t1', 2);
    const child = questionCardId('t2', 0);

    // 同一线程内的父链。
    expect(neighborCard(model, first, 'parent')).toBeNull();
    expect(neighborCard(model, second, 'parent')).toBe(first);
    expect(neighborCard(model, third, 'parent')).toBe(second);
    // 子 = 链上的下一张，且（因为 t2 从 t1 分叉）链尾现在也有了子节点。
    expect(neighborCard(model, first, 'child')).toBe(second);
    expect(neighborCard(model, second, 'child')).toBe(third);
    expect(neighborCard(model, third, 'child')).toBe(child);
    // 线性链没有分叉，因此谁都没有同级。
    expect(neighborCard(model, second, 'sibling')).toBeNull();
    // t2 声明 parentId: 't1'，所以它的第一张卡片现在有父边了。
    expect(neighborCard(model, child, 'parent')).toBe(model.cardsById[third].id);
    expect(model.cardsById[child].parentIdInferred).toBe(true);
    // 仍然不是同级：同级共享父节点，而 t1:0 的父是 null。
    expect(neighborCard(model, child, 'sibling')).toBeNull();
    expect(neighborCard(model, first, 'parent')).toBeNull();

    // 真正的分叉：一个根带两个子节点。
    const forked = modelWithCards([
      card('r', { parentId: null }),
      card('c1', { parentId: 'r' }),
      card('c2', { parentId: 'r' }),
      card('leaf', { parentId: 'c2' }),
    ]);
    expect(neighborCard(forked, 'c1', 'sibling')).toBe('c2');
    expect(neighborCard(forked, 'c2', 'sibling')).toBe('c1');
    expect(neighborCard(forked, 'leaf', 'sibling')).toBeNull();
    expect(neighborCard(forked, 'r', 'sibling')).toBeNull();
    expect(neighborCard(forked, 'r', 'child')).toBe('c1');

    // 整幅画布的阅读顺序。
    expect(neighborCard(model, first, 'next')).toBe(second);
    expect(neighborCard(model, child, 'prev')).toBe(third);
    expect(neighborCard(model, child, 'next')).toBeNull();
    expect(neighborCard(model, first, 'prev')).toBeNull();

    // 未知卡片 / 未知方向 / 空 id 都不抛错。
    expect(neighborCard(model, 'ghost:0', 'next')).toBeNull();
    expect(neighborCard(model, first, 'diagonal')).toBeNull();
    expect(neighborCard(model, '', 'next')).toBeNull();
    expect(neighborCard(null, first, 'next')).toBeNull();

    // 没有任何用户问答的线程是一张线程级占位卡。
    const placeholder = buildCanvasModel({
      projection: { threads: [thread('t9', [])] },
      layout: { cards: {}, collapsed: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      regions: [],
      annotations: [],
    });
    expect(neighborCard(placeholder, threadCardId('t9'), 'parent')).toBeNull();
    expect(neighborCard(placeholder, threadCardId('t9'), 'next')).toBeNull();
  });

  it('父卡片已从投影消失时 parent 返回 null，不返回画不出来的 id', () => {
    const orphan = modelWithCards([card('child', { parentId: 'gone' })]);
    expect(neighborCard(orphan, 'child', 'parent')).toBeNull();
  });
});

describe('缩放级别', () => {
  it('full/summary/dot 由可配置阈值决定，默认值标注待实测', () => {
    expect(DEFAULT_ZOOM_THRESHOLDS.fullMinZoom >= DEFAULT_ZOOM_THRESHOLDS.summaryMinZoom).toBe(true);
    expect(zoomLevelFor(2)).toBe('full');
    expect(zoomLevelFor(DEFAULT_ZOOM_THRESHOLDS.fullMinZoom)).toBe('full');
    expect(zoomLevelFor(0.8)).toBe('summary');
    expect(zoomLevelFor(DEFAULT_ZOOM_THRESHOLDS.summaryMinZoom)).toBe('summary');
    expect(zoomLevelFor(0.3)).toBe('dot');
    expect(zoomLevelFor(0.6)).toBe('dot');
    // 自定义阈值生效，颠倒输入也能用（内部归一化）。
    const custom = { fullMinZoom: 1.5, summaryMinZoom: 0.9 };
    expect(zoomLevelFor(1.5, custom)).toBe('full');
    expect(zoomLevelFor(1.4, custom)).toBe('summary');
    expect(zoomLevelFor(0.9, custom)).toBe('summary');
    expect(zoomLevelFor(0.89, custom)).toBe('dot');
    expect(zoomLevelFor(2, { fullMinZoom: 0.9, summaryMinZoom: 1.5 })).toBe('full');
    expect(zoomLevelFor(1.2, { fullMinZoom: 0.9, summaryMinZoom: 1.5 })).toBe('summary');
    // 非法缩放/阈值回落默认，不抛错。
    expect(zoomLevelFor(Number.NaN)).toBe('full');
    expect(zoomLevelFor(0)).toBe('full');
    expect(zoomLevelFor(2, { fullMinZoom: -1, summaryMinZoom: 'x' })).toBe('full');
    expect(zoomLevelFor(0.2, null)).toBe('dot');
    // 阈值数组被冻结，调用方改不到模块默认值。
    expect(Object.isFrozen(DEFAULT_ZOOM_THRESHOLDS)).toBe(true);
  });
});

describe('相机变换', () => {
  it('把世界点居中到屏幕中心', () => {
    const camera = cameraForWorldPoint({ x: 100, y: 50 }, { x: 0, y: 0, zoom: 2 }, { width: 1000, height: 600 });
    expect(camera).toEqual({ x: 1000 / 2 - 100 * 2, y: 600 / 2 - 50 * 2 });
    expect(cameraForWorldPoint(null, null, null)).toBeNull();
    expect(cameraForWorldPoint({ x: Number.NaN, y: 0 }, null, null)).toBeNull();
  });

  it('退化输入回落默认屏幕尺寸，不产生 NaN', () => {
    const camera = cameraForWorldPoint({ x: 0, y: 0 }, { x: 0, y: 0, zoom: 0 }, { width: 0, height: -5 });
    expect(camera).toEqual({ x: DEFAULT_SCREEN_SIZE.width / 2, y: DEFAULT_SCREEN_SIZE.height / 2 });
    for (const value of Object.values(camera)) expect(Number.isFinite(value)).toBe(true);
  });

  it('视口中心的世界坐标是 cameraForWorldPoint 的逆', () => {
    const viewport = { x: 120, y: -80, zoom: 2.5 };
    const screen = { width: 1200, height: 800 };
    const world = worldPointAtCenter(viewport, screen);
    const back = cameraForWorldPoint(world, viewport, screen);
    expect(back.x).toBeCloseTo(viewport.x, 6);
    expect(back.y).toBeCloseTo(viewport.y, 6);
  });

  it('定位卡片把卡片中心放到屏幕中心', () => {
    const model = modelWithCards([card('a', { position: { x: 100, y: 200 }, width: 310, height: 276 })]);
    model.viewport = { x: 0, y: 0, zoom: 1 };
    const camera = cameraForCard(model, 'a', { width: 1000, height: 600 });
    // 卡片中心 = (100+155, 200+138)
    expect(camera).toEqual({ x: 500 - 255, y: 300 - 338 });
  });

  it('定位不存在的卡片返回 null，不把视口甩到原点', () => {
    const model = modelWithCards([card('a', { position: { x: 100, y: 200 } })]);
    expect(cameraForCard(model, 'ghost', { width: 1000, height: 600 })).toBeNull();
    expect(cameraForCard(model, 'a', null)).not.toBeNull();
  });

  it('没有坐标的卡片无法定位', () => {
    const model = modelWithCards([card('float', { position: null, naturalPosition: undefined })]);
    expect(cameraForCard(model, 'float', { width: 1000, height: 600 })).toBeNull();
  });
});
