// @ts-nocheck -- 测试里用鸭子类型 model，断言精确。
// 迁移自 dsh-synapnova@3fd1d00 test/canvas-commands.test.js
import { describe, it, expect } from 'vitest';
import {
  annotationsForCard,
  annotationsForRegion,
  buildCanvasModel,
  cardsInsideRegion,
  getAnnotation,
  getCard,
  getCardPosition,
  getRegion,
  getResolvedPosition,
  getViewport,
  isCardCollapsed,
  layoutBundle,
  missingSourceAnnotations,
  parseCardId,
  questionCardId,
  threadCardId,
} from '@/canvas/model';
import { createCommandHistory, DEFAULT_HISTORY_LIMIT, MAX_ZOOM, MIN_ZOOM } from '@/canvas/commands';

const ISO = '2026-10-18T09:00:00.000Z';
const REGION_ID = '018f0000-0000-7000-8000-000000000001';
const NOTE_ID = '018f0000-0000-7000-8000-000000000002';
const REGION_NOTE_ID = '018f0000-0000-7000-8000-000000000003';

const userMessage = (id, text) => ({ id, kind: 'user', text, sourceSeq: Number(id.replace(/\D/g, '')) || 0, at: ISO });
const assistantMessage = (id, text) => ({ id, kind: 'assistant', text, sourceSeq: 999, at: ISO });

function thread(id, messages, extra = {}) {
  return { id, title: `标题 ${id}`, dshSessionId: `session-${id}`, messages, pendingProcess: [], ...extra };
}

/** 一份冻结文档形状的 workspace 快照；每次调用都重建，测试之间不可能串状态。 */
function snapshot(overrides = {}) {
  return {
    id: 'workspace-a',
    revision: 4,
    projectionEpoch: 2,
    projection: {
      threads: [
        thread('t1', [userMessage('u1', '第一个问题'), assistantMessage('a1', '答一'), userMessage('u2', '第二个问题'), assistantMessage('a2', '答二')]),
        thread('t2', [userMessage('u3', '另一个会话的问题'), assistantMessage('a3', '答三')], { parentId: 't1' }),
      ],
    },
    layout: {
      cards: { [questionCardId('t1', 1)]: { x: 500, y: 120 } },
      collapsed: { [questionCardId('t1', 1)]: true },
      viewport: { x: 12, y: 34, zoom: 0.9 },
    },
    regions: [{ id: REGION_ID, name: '分区甲', x: 100, y: 50, w: 800, h: 400 }],
    annotations: [
      { id: NOTE_ID, x: 520, y: 130, text: '卡片旁注', targetCardId: questionCardId('t1', 1) },
      { id: REGION_NOTE_ID, x: 120, y: 60, text: '分区旁注', targetRegionId: REGION_ID },
    ],
    ...overrides,
  };
}

/**
 * 接到一次性 bundle 上的 history，与 app.js 将来的接法一致。
 * bundle 的对象身份稳定并原地更新，所以解构出的引用永远看到当前布局。
 */
function historyFor(source = snapshot(), options = {}) {
  const bundle = layoutBundle(buildCanvasModel(source));
  const history = createCommandHistory({ readLayout: () => bundle, ...options });
  return {
    history,
    bundle,
    /** 按适配层的方式提交意图：本地应用 + 保留栈。 */
    apply(intent) {
      if (intent === null) return null;
      const next = history.applyTo(bundle, intent);
      for (const key of Object.keys(bundle)) delete bundle[key];
      Object.assign(bundle, next);
      return bundle;
    },
    setBundle(next) {
      for (const key of Object.keys(bundle)) delete bundle[key];
      Object.assign(bundle, next);
    },
  };
}

describe('模型基础接口', () => {
  it('稳定卡片 ID 由 threadId 与问答序号组成，不用数组下标', () => {
    const model = buildCanvasModel(snapshot());
    expect(model.cardOrder).toEqual([questionCardId('t1', 0), questionCardId('t1', 1), questionCardId('t2', 0)]);
    expect(questionCardId('t1', 0)).toBe('t1:0');
    expect(parseCardId('t1:0')).toEqual({ threadId: 't1', userQuestionSeq: 0 });
    expect(parseCardId(threadCardId('t9'))).toEqual({ threadId: 't9', userQuestionSeq: null });
    expect(threadCardId('t9')).toBe('t9');
  });

  it('构造是纯函数，不改入参且输出深冻结', () => {
    const source = snapshot();
    const before = structuredClone(source);
    const model = buildCanvasModel(source);
    expect(source).toEqual(before);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.cards[0])).toBe(true);
    expect(() => {
      model.cards.push({ id: 'x' });
    }).toThrow();
    // 通过布局包副本的改动不得传回源快照。
    const bundle = layoutBundle(model);
    bundle.cards[questionCardId('t1', 0)] = { x: 1, y: 2 };
    expect(source.layout.cards[questionCardId('t1', 1)]).toEqual({ x: 500, y: 120 });
  });

  it('读取接口取位置/折叠/分区/旁注，未手动放置时为 null', () => {
    const model = buildCanvasModel(snapshot());
    expect(getCardPosition(model, questionCardId('t1', 1))).toEqual({ x: 500, y: 120 });
    expect(getCardPosition(model, questionCardId('t1', 0))).toBeNull();
    expect(isCardCollapsed(model, questionCardId('t1', 1))).toBe(true);
    expect(isCardCollapsed(model, questionCardId('t1', 0))).toBe(false);
    expect(getResolvedPosition(model, questionCardId('t1', 0))).toEqual({ x: 86, y: 82 });
    expect(getViewport(model)).toEqual({ x: 12, y: 34, zoom: 0.9 });
    expect(getRegion(model, REGION_ID).name).toBe('分区甲');
    expect(getAnnotation(model, NOTE_ID).text).toBe('卡片旁注');
    expect(annotationsForCard(model, questionCardId('t1', 1)).map(note => note.id)).toEqual([NOTE_ID]);
    expect(annotationsForRegion(model, REGION_ID).map(note => note.id)).toEqual([REGION_NOTE_ID]);
    expect(missingSourceAnnotations(model)).toEqual([]);
    expect(cardsInsideRegion(model, REGION_ID).sort()).toEqual([questionCardId('t1', 1)].sort());
  });

  it('来源消失的旁注保留并标记，不静默丢失', () => {
    const source = snapshot();
    source.projection.threads = [thread('t2', [userMessage('u3', '另一个会话的问题')])];
    const model = buildCanvasModel(source);
    expect(getCard(model, questionCardId('t1', 1))).toBeNull();
    const orphan = getAnnotation(model, NOTE_ID);
    expect(orphan.availability).toBe('missing-source');
    expect(orphan.text).toBe('卡片旁注');
    expect(missingSourceAnnotations(model).map(note => note.id).sort()).toEqual([NOTE_ID].sort());
    expect(layoutBundle(model).annotations.length).toBe(2);
  });

  it('新增消息改变数组下标，位置与折叠态仍跟原卡片，不串位', () => {
    const source = snapshot();
    const before = buildCanvasModel(source);
    expect(getCard(before, questionCardId('t1', 1)).question).toBe('第二个问题');

    source.projection.threads[0].messages = [
      userMessage('u1', '第一个问题'),
      { id: 'ctx', kind: 'assistant', text: 'runtime-context 注入', sourceSeq: 900, at: ISO },
      assistantMessage('a1', '答一'),
      userMessage('u2', '第二个问题'),
      userMessage('u9', '第三个问题'),
      assistantMessage('a2', '答二'),
    ];
    const after = buildCanvasModel(source);
    expect(getCard(after, questionCardId('t1', 1)).question).toBe('第二个问题');
    expect(getCardPosition(after, questionCardId('t1', 1)).x).toBe(500);
    expect(isCardCollapsed(after, questionCardId('t1', 1))).toBe(true);
    expect(getCardPosition(after, questionCardId('t1', 2))).toBeNull();
    expect(isCardCollapsed(after, questionCardId('t1', 2))).toBe(false);

    source.projection.threads.reverse();
    const reordered = buildCanvasModel(source);
    expect(getCardPosition(reordered, questionCardId('t1', 1)).x).toBe(500);
    expect(isCardCollapsed(reordered, questionCardId('t1', 1))).toBe(true);
  });
});

describe('拖动手势', () => {
  it('一次拖动恰好记一步 undo，不是每次 pointermove 一步', () => {
    const { history, bundle, apply } = historyFor();
    const cardId = questionCardId('t1', 1);
    history.beginGesture('moveCard');
    for (let step = 0; step < 40; step++) history.updateGesture(history.commands.moveCard(cardId, { x: 500 + step * 3, y: 120 + step * 2 }));
    // 实时预览跟着指针走，栈仍然是空的。
    expect(history.undoDepth).toBe(0);
    const intent = history.endGesture();
    expect(history.undoDepth).toBe(1);
    apply(intent);
    expect(bundle.cards[cardId]).toEqual({ x: 617, y: 198 });
    // 恰好一条补丁，带拖动起点作为 before、落点作为 after。
    const recorded = history.inspect().undo[0];
    expect(recorded.kind).toBe('moveCard');
    expect(recorded.patches.length).toBe(1);
    expect(recorded.patches[0].before).toEqual({ x: 500, y: 120 });
    expect(recorded.patches[0].after).toEqual({ x: 617, y: 198 });
  });

  it('坐标未变或只有点击的 drag 不产生 undo 步', () => {
    const { history } = historyFor();
    const cardId = questionCardId('t1', 1);
    history.beginGesture('moveCard');
    history.updateGesture(history.commands.moveCard(cardId, { x: 500, y: 120 }));
    expect(history.endGesture()).toBeNull();
    expect(history.undoDepth).toBe(0);
    expect(history.commit(history.commands.moveCard(cardId, { x: 500, y: 120 }))).toBeNull();
    expect(history.undoDepth).toBe(0);
  });
});

describe('视口命令', () => {
  it('连续平移/缩放手势合并为一步', () => {
    const { history, bundle, apply } = historyFor();
    // 缩放值全部落在 0.05–1 内：上限改为 100% 后，1.25 / 2.4 会被 clamp 掉，
    // 那样这条用例测的就不再是「手势合并」而是「钳制」，失去原意。
    history.beginGesture('setViewport');
    for (let step = 1; step <= 25; step++) history.updateGesture(history.commands.setViewport({ x: 12 - step * 4, y: 34 - step * 2, zoom: 0.85 }));
    history.updateGesture(history.commands.setViewport({ x: -88, y: -16, zoom: 0.6 }));
    const intent = history.endGesture();
    expect(history.undoDepth).toBe(1);
    apply(intent);
    expect(bundle.viewport).toEqual({ x: -88, y: -16, zoom: 0.6 });
    expect(history.inspect().undo[0].patches.length).toBe(1);
    apply(history.undo());
    expect(bundle.viewport).toEqual({ x: 12, y: 34, zoom: 0.9 });
    expect(history.undoDepth).toBe(0);
    expect(history.redoDepth).toBe(1);
  });

  it('独立 setViewport 命令被夹到 0.05–1，并各记一步', () => {
    // 三次钳制区间的变迁，每一次都是用户裁定：
    //   旧 app.js        0.6–4
    //   vNext 首版(S1-9) 0.05–5   —— 对齐 Infinite Canvas
    //   **现值**         0.05–1   —— 2026-10-21 用户要求「最大别超过 100%」，
    //                              画布内容以会话卡片为主，放大超过 100% 只缩窄视野
    // 这条断言就是区间偏离的守卫：改常量必须同步改它，否则说明有人动了钳制却没意识到。
    expect(MIN_ZOOM).toBe(0.05);
    expect(MAX_ZOOM).toBe(1);
    const { history, bundle, apply } = historyFor();
    apply(history.commit(history.commands.setViewport({ zoom: 99 })));
    apply(history.commit(history.commands.setViewport({ x: -10, y: -20, zoom: 0.01 })));
    expect(bundle.viewport).toEqual({ x: -10, y: -20, zoom: 0.05 });
    expect(history.undoDepth).toBe(2);
    apply(history.undo());
    expect(bundle.viewport).toEqual({ x: 12, y: 34, zoom: 1 });
  });

  it('缩放取到两位小数，与滑杆 1% 档一致', () => {
    const { history, apply, bundle } = historyFor();
    apply(history.commit(history.commands.setViewport({ zoom: 0.93456789 })));
    expect(bundle.viewport.zoom).toBe(0.93);
  });
});

describe('undo/redo 语义', () => {
  it('新用户编辑清空 redo 分支', () => {
    const { history, apply } = historyFor();
    apply(history.commit(history.commands.moveCard(questionCardId('t1', 0), { x: 10, y: 10 })));
    apply(history.commit(history.commands.toggleCollapse(questionCardId('t1', 0))));
    expect(history.undoDepth).toBe(2);
    apply(history.undo());
    apply(history.undo());
    expect(history.redoDepth).toBe(2);
    apply(history.commit(history.commands.setViewport({ zoom: 2 })));
    expect(history.redoDepth).toBe(0);
    expect(history.canRedo()).toBe(false);
    expect(history.redo()).toBeNull();
  });

  it('undo 只回退目标字段，不恢复整个旧库也不碰 projection', () => {
    const source = snapshot();
    const { history, bundle, apply } = historyFor(source);
    const otherCard = questionCardId('t1', 0);
    apply(history.commit(history.commands.moveCard(otherCard, { x: 900, y: 900 })));
    const untouched = structuredClone(bundle);
    const cardId = questionCardId('t1', 1);
    apply(history.commit(history.commands.moveCard(cardId, { x: 700, y: 700 })));
    expect(bundle.cards[cardId]).toEqual({ x: 700, y: 700 });
    const undoIntent = history.undo();
    expect(undoIntent.patches.map(patch => `${patch.area}:${patch.id}`)).toEqual([`layoutCards:${cardId}`]);
    for (const patch of undoIntent.patches) expect(Object.keys(patch).sort()).toEqual(['after', 'area', 'before', 'id']);
    apply(undoIntent);
    expect(bundle.cards[cardId]).toEqual({ x: 500, y: 120 });
    expect(bundle.cards[otherCard]).toEqual(untouched.cards[otherCard]);
    expect(bundle.viewport).toEqual(untouched.viewport);
    expect(bundle.regions).toEqual(untouched.regions);
    expect(bundle.annotations).toEqual(untouched.annotations);
    // undo 只产意图，从不产动作：没有任何提示/fork/工具面。
    expect(Object.hasOwn(undoIntent, 'prompt')).toBe(false);
    expect(Object.hasOwn(undoIntent, 'fork')).toBe(false);
    expect(Object.hasOwn(undoIntent, 'tool')).toBe(false);
  });

  it('撤销删除分区会连同旁注一起恢复', () => {
    const { history, bundle, apply } = historyFor();
    apply(history.commit(history.commands.deleteRegion(REGION_ID)));
    expect(bundle.regions.length).toBe(0);
    expect(bundle.annotations.map(note => note.id)).toEqual([NOTE_ID]);
    apply(history.undo());
    expect(bundle.regions.map(region => region.id)).toEqual([REGION_ID]);
    expect(bundle.annotations.map(note => note.id).sort()).toEqual([NOTE_ID, REGION_NOTE_ID].sort());
    apply(history.redo());
    expect(bundle.regions.length).toBe(0);
    expect(bundle.annotations.map(note => note.id)).toEqual([NOTE_ID]);
  });

  it('容量上限：超过上限丢弃最旧一步，栈长度封顶', () => {
    const { history, bundle, apply } = historyFor(snapshot(), { limit: 3 });
    expect(history.limit).toBe(3);
    for (let index = 0; index < 6; index++) apply(history.commit(history.commands.moveCard(questionCardId('t1', 1), { x: 100 + index, y: 100 })));
    expect(history.undoDepth).toBe(3);
    const recorded = history.inspect().undo.map(entry => entry.patches[0].after.x);
    expect(recorded).toEqual([103, 104, 105]);
    for (let index = 0; index < 3; index++) apply(history.undo());
    expect(bundle.cards[questionCardId('t1', 1)].x).toBe(102);
    expect(history.undo()).toBeNull();
    expect(DEFAULT_HISTORY_LIMIT).toBe(100);
  });
});

describe('分区与旁注命令', () => {
  it('删分区只删框与关联，不删框内会话/卡片', () => {
    const source = snapshot();
    const model = buildCanvasModel(source);
    const insideBefore = cardsInsideRegion(model, REGION_ID);
    expect(insideBefore).toEqual([questionCardId('t1', 1)]);
    const { history, bundle, apply } = historyFor(source);
    const intent = history.commit(history.commands.deleteRegion(REGION_ID));
    apply(intent);
    expect(getRegion(buildCanvasModel({ ...source, ...bundle }), REGION_ID)).toBeNull();
    expect(bundle.regions.length).toBe(0);
    expect(bundle.annotations.some(note => note.targetRegionId === REGION_ID)).toBe(false);
    expect(bundle.cards).toEqual(source.layout.cards);
    expect(bundle.annotations.length).toBe(1);
    const after = buildCanvasModel({ ...source, layout: { cards: bundle.cards, collapsed: bundle.collapsed, viewport: bundle.viewport }, regions: bundle.regions, annotations: bundle.annotations });
    expect(after.cardOrder).toEqual([questionCardId('t1', 0), questionCardId('t1', 1), questionCardId('t2', 0)]);
    expect(source.projection.threads[0].messages.length).toBe(4);
    expect(after.threads.length).toBe(2);
    // 结构上：删除意图完全不带卡片补丁。
    expect(intent.patches.filter(patch => patch.area === 'layoutCards')).toEqual([]);
    expect(intent.patches.map(patch => patch.area)).toEqual(['regions', 'annotations']);
  });

  it('折叠命令只改 collapsed 字段，不删卡片也不改日志', () => {
    const source = snapshot();
    const { history, bundle, apply } = historyFor(source);
    const cardId = questionCardId('t1', 0);
    apply(history.commit(history.commands.toggleCollapse(cardId)));
    expect(bundle.collapsed[cardId]).toBe(true);
    expect(bundle.cards[cardId]).toBeUndefined();
    const model = buildCanvasModel({ ...source, layout: { cards: bundle.cards, collapsed: bundle.collapsed, viewport: bundle.viewport }, regions: bundle.regions, annotations: bundle.annotations });
    expect(isCardCollapsed(model, cardId)).toBe(true);
    expect(model.cards.length).toBe(3);
    expect(source.projection.threads[0].messages.length).toBe(4);
  });

  it('旁注命令：卡片/分区二选一，非法目标被拒', () => {
    const { history } = historyFor();
    const fresh = '018f0000-0000-7000-8000-00000000000a';
    expect(() => history.commands.addAnnotation({ id: fresh, x: 1, y: 2, text: 'x' })).toThrow(/恰好指定一个/);
    expect(() => history.commands.addAnnotation({ id: fresh, x: 1, y: 2, text: 'x', targetCardId: 't1:0', targetRegionId: REGION_ID })).toThrow(/恰好指定一个/);
    expect(() => history.commands.addAnnotation({ id: NOTE_ID, x: 1, y: 2, text: 'x', targetRegionId: REGION_ID })).toThrow(/已存在/);
    expect(() => history.commands.addAnnotation({ id: fresh, x: 1, y: 2, text: 'x', targetRegionId: 'missing-region' })).toThrow(/分区 missing-region 不存在/);
    const intent = history.commit(history.commands.addAnnotation({ id: fresh, x: 1, y: 2, text: '新的', targetCardId: 't1:0' }));
    expect(intent.patches.length).toBe(1);
    expect(intent.patches[0].area).toBe('annotations');
    // 卡片目标即使卡片已消失也允许（失源场景）：模型会标记，命令不静默丢弃旁注。
    const orphan = history.commit(history.commands.addAnnotation({ id: '018f0000-0000-7000-8000-00000000000b', x: 3, y: 4, text: '失源', targetCardId: 't9:0' }));
    expect(orphan.patches.length).toBe(1);
  });

  it('分区命令：创建/更新/尺寸校验', () => {
    const { history, bundle, apply } = historyFor();
    const freshId = '018f0000-0000-7000-8000-00000000000c';
    apply(history.commit(history.commands.createRegion({ id: freshId, name: '新分区', x: 0, y: 0, w: 200, h: 150 })));
    expect(bundle.regions.some(region => region.id === freshId)).toBe(true);
    expect(() => history.commands.createRegion({ id: freshId, x: 0, y: 0, w: 10, h: 10 })).toThrow(/已存在/);
    expect(() => history.commands.createRegion({ id: 'x1', x: 0, y: 0, w: 0, h: 10 })).toThrow(/尺寸必须为正/);
    apply(history.commit(history.commands.updateRegion(freshId, { name: '改名', w: 300 })));
    expect(getRegion(buildCanvasModel({ ...snapshot(), ...bundle }), freshId).name).toBe('改名');
    expect(() => history.commands.updateRegion('ghost', { name: 'x' })).toThrow(/不存在/);
    // 无变化的更新不产生 undo 步
    expect(history.commit(history.commands.updateRegion(freshId, {}))).toBeNull();
  });
});

describe('后台同步与手势边界', () => {
  it('后台同步路径不进入 undo 栈，也不清 redo', () => {
    const { history, apply } = historyFor();
    apply(history.commit(history.commands.moveCard(questionCardId('t1', 0), { x: 300, y: 300 })));
    apply(history.undo());
    expect(history.undoDepth).toBe(0);
    expect(history.redoDepth).toBe(1);
    const background = history.applyBackground({ kind: 'projection', patches: [{ area: 'layoutCards', id: questionCardId('t2', 0), before: null, after: { x: 5, y: 5 } }] });
    expect(background.recorded).toBe(false);
    expect(history.undoDepth).toBe(0);
    expect(history.redoDepth).toBe(1);
    expect(history.canRedo()).toBe(true);
    history.applyBackground();
    expect(history.redoDepth).toBe(1);
    expect(() => history.commit({ kind: 'projection' })).toThrow(/命令必须|字段级|意图/);
  });

  it('手势边界：未结束的手势不会被计入，取消手势零写入', () => {
    const { history } = historyFor();
    history.beginGesture('moveCard');
    history.updateGesture(history.commands.moveCard(questionCardId('t1', 1), { x: 1, y: 1 }));
    expect(history.gestureOpen()).toBe(true);
    expect(history.undoDepth).toBe(0);
    expect(() => history.beginGesture('moveCard')).toThrow(/未结束的手势/);
    history.cancelGesture();
    expect(history.gestureOpen()).toBe(false);
    expect(history.endGesture()).toBeNull();
    expect(history.undoDepth).toBe(0);
  });

  it('reset 清空两个栈（新打开周期不恢复历史）', () => {
    const { history, apply } = historyFor();
    apply(history.commit(history.commands.toggleCollapse(questionCardId('t1', 0))));
    apply(history.undo());
    expect(history.redoDepth).toBe(1);
    history.reset();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});

describe('命令构造的纯性与边界', () => {
  it('preview 不改入参 bundle', () => {
    const { history, bundle } = historyFor();
    const before = structuredClone(bundle);
    history.preview(bundle, history.commands.moveCard(questionCardId('t1', 0), { x: 1, y: 1 }));
    expect(bundle).toEqual(before);
  });

  it('后台补丁可以带 materials 区域（顶层字段也走同一栈）', () => {
    const { history, bundle, apply } = historyFor();
    const material = { id: 'm1', name: 'a.txt', importedAt: ISO, bytes: 3, text: 'abc' };
    apply(history.commit({ kind: 'addMaterial', patches: [{ area: 'materials', id: 'm1', before: null, after: material }] }));
    expect(bundle.materials).toEqual([material]);
    apply(history.undo());
    expect(bundle.materials).toEqual([]);
  });

  it('未知 patch area 被拒（不静默吞掉）', () => {
    const { history } = historyFor();
    expect(() => history.applyTo({}, { kind: 'x', patches: [{ area: 'unknown', id: 'a', before: null, after: 1 }] })).toThrow(/未知的 patch area/);
  });

  it('非法位置与非法 cardId 被拒', () => {
    const { history } = historyFor();
    expect(() => history.commands.moveCard('', { x: 1, y: 1 })).toThrow(/cardId/);
    expect(() => history.commands.moveCard('a', { x: Number.NaN, y: 1 })).toThrow(/有限数字/);
    expect(() => history.commands.setCollapsed('a', 'yes')).toThrow(/boolean/);
  });
});
