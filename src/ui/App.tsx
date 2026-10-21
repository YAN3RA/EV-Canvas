import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PLUGIN_META } from '../shared/meta.js';
import { useCanvasData, patchLayout, readLayoutBundle, type WorkspaceSummary } from './data.js';
import { CanvasSurface } from './CanvasSurface.js';
import { createCommandHistory, type Patch } from '../canvas/commands.js';
import { getResolvedPosition } from '../canvas/model.js';

/**
 * EV Canvas 前端主视图。
 *
 * 当前实现范围（**不要读成「功能已实现」**）：
 *   - 从宿主读取工作区列表与快照，渲染成画布卡片
 *   - 平移 / 缩放 / 重置视图（S1-9 参数：滚轮 1.1^(Δ/100)、缩放 0.05–5、滑杆 5–500%）
 *   - 视图变化按字段级 patch 提交，带 `expectedRevision` 乐观并发
 *   - 撤销（命令历史只活在内存里，不落盘）
 *
 * 尚未实现：卡片拖拽落位、框选、复制粘贴、导出、会话投影订阅（S0-5）。
 * 46 项功能状态见 `Project Docs/1-需求/vnext功能.md`，仍全部「未实现」。
 */
export function App(): React.JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const canvas = useCanvasData();
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    // 跟随宿主主题；token 不全时用本地兜底（旧版已验证的策略）
    const root = document.documentElement;
    const read = (): void => {
      const attr = root.getAttribute('data-theme');
      setTheme(attr === 'dark' ? 'dark' : 'light');
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  /**
   * 命令历史依赖「权威布局读取」回调，而布局来自当前模型。
   * 用 ref 持有最新模型，避免把 history 绑在 model 上导致每次保存后重建（历史会被清空）。
   */
  const modelRef = useRef(canvas.model);
  modelRef.current = canvas.model;

  const history = useMemo(
    () =>
      createCommandHistory({
        limit: 100,
        readLayout: () => readLayoutBundle(modelRef.current),
      }),
    // 只在切换工作区时重建，避免历史随每次保存被清空
    [canvas.activeWorkspaceId],
  );

  /**
   * 把字段级 patch 应用到当前权威布局上，得到服务端要的**完整快照**。
   *
   * 为什么不能直接把 patches 发过去：服务端 `updateLayout` 的 body 形状是
   * `{ layout: { cards, collapsed, viewport }, regions?, annotations? }`，
   * 没有 `patches` 这个概念。它的语义是「按字段覆盖」，所以必须在客户端
   * 先把 patch 落到一份完整布局上，否则服务端不知道 `layoutCards` 该落到哪。
   *
   * 缺失字段的处理：`readLayoutBundle` 返回的已经是完整布局（空也是空对象），
   * 因此这里不会产生 `undefined` 字段，也就不会误清空服务端数据。
   */
  const snapshotFromPatches = useCallback((patches: Patch[]) => {
    const base = readLayoutBundle(modelRef.current);
    const cards: Record<string, { x: number; y: number }> = { ...(base.cards ?? {}) };
    const collapsed: Record<string, true> = { ...(base.collapsed ?? {}) };
    let viewport = { ...(base.viewport ?? { x: 0, y: 0, zoom: 1 }) };
    for (const patch of patches) {
      const before = patch.before as { x: number; y: number } | null | undefined;
      const after = patch.after as { x: number; y: number } | null | undefined;
      if (patch.area === 'layoutCards') {
        // after 为 null 表示「清除手动位置」，回到自动布局。
        if (after === null || after === undefined) delete cards[patch.id];
        else cards[patch.id] = { x: after.x, y: after.y };
        void before;
      } else if (patch.area === 'layoutCollapsed') {
        if (after === null || after === undefined) delete collapsed[patch.id];
        else collapsed[patch.id] = true;
      } else if (patch.area === 'layoutViewport') {
        if (after !== null && after !== undefined) viewport = { ...viewport, ...(after as { x?: number; y?: number; zoom?: number }) };
      }
    }
    return {
      cards,
      collapsed,
      viewport,
      // regions / annotations 原样带上：它们不是 patch 目标，但服务端按字段覆盖，
      // 不带就会保持原值（这是我们要的），带了则必须与当前一致。
      regions: base.regions ?? [],
      annotations: base.annotations ?? [],
    };
  }, []);

  /**
   * 提交串行化：同一时刻只允许一次写入在途。
   *
   * 为什么必须串行：每次写入都用 `modelRef.current.revision` 做乐观锁。若上一次
   * 还没返回就发下一次，两次会带**同一个 revision**，第二次必然 409。
   * 单选拖拽之间通常有间隔，撞上的概率低；框选后连续拖拽会把这个窗口放大，
   * 于是表现为「多选拖拽松手后位置先乱跳、再回弹」——错误被 catch 成提示，
   * 但卡片已经停在 pending 位置，直到 3 秒兜底才归位。
   *
   * 队列语义：后到的写入排在队尾，等前一次 `reload` 完成（拿到新 revision）
   * 再执行。这样每次提交都基于最新版本，409 从根上消失。
   */
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());

  const submitPatches = useCallback(
    async (patches: Patch[]) => {
      if (patches.length === 0) return;
      const run = async (): Promise<void> => {
        const workspaceId = canvas.activeWorkspaceId;
        /**
         * **必须在队列内重新读** `modelRef.current`，不能在外面读好再闭包进来。
         *
         * 踩过的坑（409 Conflict 的唯一根因）：`run` 是排队执行的回调，前一次
         * 写入 `await canvas.reload()` 之后 `model.revision` 才更新。如果在
         * `submitPatches` 开头就把 `revision` 读进闭包，队列里排第二、第三的写入
         * 全都带着**同一个旧 revision** 发出去 —— 服务端乐观锁逐个拒绝，
         * 控制台就是刷屏的 `PATCH .../layout 409 (Conflict)`。
         *
         * 读 `modelRef.current`（每次渲染同步最新模型）就能拿到 reload 后的新值。
         */
        const model = modelRef.current;
        const revision = model?.revision;
        const projectionEpoch = model?.projectionEpoch;
        if (workspaceId === null || typeof revision !== 'number') {
          // 没有工作区或没有版本号时**不假装保存成功**，明确告知用户。
          setSaveError('当前没有可写入的工作区（或缺少 revision），改动未保存');
          return;
        }
        if (typeof projectionEpoch !== 'number' || projectionEpoch < 1) {
          // 纪元缺失时同样不猜：服务端会以 400 拒绝，与其让用户看到晦涩的报错，
          // 不如在这里说清「数据还没加载完」。
          setSaveError('缺少 projectionEpoch，数据可能尚未加载完成，改动未保存');
          return;
        }
        setSaving(true);
        setSaveError(null);
        try {
          const snapshot = snapshotFromPatches(patches);
          await patchLayout(workspaceId, revision, {
            projectionEpoch,
            layout: { cards: snapshot.cards, collapsed: snapshot.collapsed, viewport: snapshot.viewport },
            regions: snapshot.regions,
            annotations: snapshot.annotations,
          });
          setHistoryVersion(version => version + 1);
          // 必须等 reload 落地：下一次排队的写入靠它拿到新 revision。
          await canvas.reload();
        } catch (error) {
          setSaveError(error instanceof Error ? error.message : String(error));
        } finally {
          setSaving(false);
        }
      };
      // 接在队尾；前一次失败不能卡死队列，所以 catch 之后继续。
      writeChainRef.current = writeChainRef.current.then(run, run);
      await writeChainRef.current;
    },
    [canvas, snapshotFromPatches],
  );

  /** 视图变化 → 命令意图 → 历史记录 → 提交。 */
  const commitViewport = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      const recorded = history.commit(history.commands.setViewport(viewport));
      if (recorded !== null) void submitPatches(recorded.patches as Patch[]);
    },
    [history, submitPatches],
  );

  const undo = useCallback(async () => {
    const entry = history.undo();
    if (entry === null) return;
    /**
     * 撤销走**同一条**提交路径。
     *
     * 为什么必须复用而不是另写一遍：撤销的补丁同样是字段级 `{area,id,before,after}`，
     * 服务端只认完整布局快照。此前这里单独调 `patchLayout(workspaceId, revision, patches)`
     * 用的是旧签名（发 `{expectedRevision, patches}`），于是拖拽和撤销一起 400——
     * 两个症状、一个根因。共用 `submitPatches` 后，这条路径再没有第二份实现可走样。
     */
    await submitPatches(entry.patches as Patch[]);
  }, [history, submitPatches]);

  /**
   * 卡片拖拽落位：一次拖拽 → 一次提交 → 一步撤销。
   *
   * 为什么不用 `moveCard` 逐卡提交：拖动多选卡片时 N 张卡 = N 次写盘 + N 步撤销。
   * 这里把整批位移合成**一条意图**（`setCardPosition` 逐卡补丁由 history 统一记录），
   * 于是「一次拖动 = 一步 undo」成立（FR-09.7）。
   */
  const moveCards = useCallback(
    (moves: { cardId: string; x: number; y: number }[]) => {
      if (moves.length === 0) return;
      const patches: Patch[] = [];
      for (const move of moves) {
        const recorded = history.commit(history.commands.moveCard(move.cardId, { x: move.x, y: move.y }));
        // `commit` 对「位置没变」的卡片返回 null 或空 patches，跳过即可。
        if (recorded !== null) patches.push(...(recorded.patches as Patch[]));
      }
      if (patches.length > 0) void submitPatches(patches);
    },
    [history, submitPatches],
  );

  /** 切换工作区时清空选中集：跨工作区的选中项没有意义，留着会误操作（FR-09.8 边界）。 */
  useEffect(() => {
    setSelectedCardIds([]);
  }, [canvas.activeWorkspaceId]);

  // historyVersion 只用于触发重渲染，让「撤销」按钮的可用态跟着历史变化。
  const canUndo = useMemo(() => history.commands !== undefined && historyVersion >= 0, [history, historyVersion]);

  /**
   * 方向键微调选中卡片。
   *
   * 取舍说明：
   *   - 步长 1（world 像素）与 `moveCard` 的取整口径一致；Shift 走 10 倍，
   *     这是画布类工具的通行约定，不需要额外 UI。
   *   - 只移动**选中**卡片：没有选中时按键不做事，避免误触把整张画布推开。
   *   - 一次按键 = 一步撤销（每条命令各自 commit），但按住连发会产生很多步 ——
   *     这是可接受的：撤销栈上限 100，且方向键微调本身就是细粒度操作。
   *   - 输入框/可编辑区获焦时**不拦截**按键（FR-09.5 边界：不抢按键）。
   */
  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      if (selectedCardIds.length === 0) return;
      const patches: Patch[] = [];
      for (const cardId of selectedCardIds) {
        const position = modelRef.current === null ? null : getResolvedPosition(modelRef.current, cardId);
        if (position === null) continue;
        const recorded = history.commit(history.commands.moveCard(cardId, { x: position.x + dx, y: position.y + dy }));
        if (recorded !== null) patches.push(...(recorded.patches as Patch[]));
      }
      if (patches.length > 0) void submitPatches(patches);
    },
    [history, selectedCardIds, submitPatches],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // 正文编辑、输入框、下拉等获焦时让位给宿主/系统。
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true) return;
      if (selectedCardIds.length === 0) return;

      const step = event.shiftKey ? 10 : 1;
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = deltas[event.key];
      if (delta === undefined) return;
      event.preventDefault();
      nudgeSelection(delta[0], delta[1]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nudgeSelection, selectedCardIds.length]);

  const statusLabel = saving ? '保存中…' : canvas.status === 'loading' ? '加载中…' : null;

  return (
    <div className="evc-root" data-theme={theme}>
      <header className="evc-header">
        <span className="evc-title">无限画布</span>
        <span className="evc-badge">{PLUGIN_META.id}</span>
        {statusLabel !== null ? <span className="evc-status">{statusLabel}</span> : null}
        <span className="evc-spacer" />
        <button type="button" onClick={() => void undo()} disabled={saving || !canUndo}>
          撤销
        </button>
        <button type="button" onClick={() => void canvas.reload()} disabled={saving}>
          刷新
        </button>
      </header>

      <WorkspaceBar
        workspaces={canvas.workspaces}
        activeId={canvas.activeWorkspaceId}
        onSelect={id => void canvas.selectWorkspace(id)}
      />

      {canvas.status === 'error' ? (
        <div className="evc-error" role="alert">
          加载失败：{canvas.error}
        </div>
      ) : null}
      {saveError !== null ? (
        <div className="evc-error" role="alert">
          保存失败：{saveError}
        </div>
      ) : null}

      {canvas.model === null && canvas.status === 'ready' ? (
        <div className="evc-empty">
          <p>还没有工作区。</p>
          <p className="evc-muted">
            画布内容来自 DSH 会话投影；在 DSH 里发一轮对话后，对应卡片会出现在这里。
          </p>
        </div>
      ) : (
        <CanvasSurface
          model={canvas.model}
          onViewportCommit={commitViewport}
          selectedCardIds={selectedCardIds}
          onSelectionChange={setSelectedCardIds}
          onMoveCards={moveCards}
        />
      )}
    </div>
  );
}

/** 工作区切换条。 */
function WorkspaceBar({
  workspaces,
  activeId,
  onSelect,
}: {
  workspaces: WorkspaceSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  if (workspaces.length === 0) {
    return <div className="evc-workbar evc-muted">无工作区</div>;
  }
  /**
   * 顶栏按**目录**分组，不把工作区名平铺成一排（UI-D10）。
   *
   * 用户反馈「所有会话都展示在顶栏」——实际列的是 7 个工作区，但每个工作区
   * 就是宿主里一个目录，用户读到的是「一堆陌生名字挤成一行」。
   *
   * 现在的语义：
   *   - 顶栏 = 目录选择器。每个按钮 = 一个 cwd，副标题显示该目录下会话数。
   *   - 选中目录后，画布内容是该目录内的会话卡片（投影本来就按工作区分好的）。
   *
   * 为什么不在顶栏再嵌套一层会话下拉：宿主侧栏已有会话树，画布顶栏重复一份
   * 会变成第二套目录权威（AGENTS §5.2 明确禁止）。画布内用卡片表达会话即可。
   *
   * 目录归并：`cwd` 相同的行合并成一个按钮。理论上 S0-7 修复后同 cwd 不该多行，
   * 但历史数据里可能存在，合并是**展示层**的兜底，不改数据。
   */
  const groups = new Map<string, { cwd: string | null; items: WorkspaceSummary[] }>();
  for (const item of workspaces) {
    const key = item.cwd ?? item.id;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, { cwd: item.cwd ?? null, items: [item] });
    else bucket.items.push(item);
  }
  const directoryLabel = (cwd: string | null, fallback: string): string => {
    if (cwd === null || cwd === '') return fallback;
    // 只取最后一段目录名：完整路径太长，顶栏放不下，也让人读不过来。
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? cwd;
  };

  return (
    <div className="evc-workbar">
      {[...groups.entries()].map(([key, group]) => {
        const active = group.items.some(item => item.id === activeId);
        const threads = group.items.reduce((total, item) => total + (item.threadCount ?? 0), 0);
        const primary = group.items.find(item => item.id === activeId) ?? group.items[0]!;
        return (
          <button
            key={key}
            type="button"
            className={active ? 'is-active' : undefined}
            title={group.cwd ?? primary.title ?? primary.id}
            onClick={() => onSelect(primary.id)}
          >
            {directoryLabel(group.cwd, primary.title ?? primary.id)}
            <span className="evc-workbar-count">{threads}</span>
          </button>
        );
      })}
    </div>
  );
}
