import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PLUGIN_META } from '../shared/meta.js';
import { useCanvasData, patchLayout, readLayoutBundle, type WorkspaceSummary } from './data.js';
import { CanvasSurface } from './CanvasSurface.js';
import { createCommandHistory, type Patch } from '../canvas/commands.js';
import { getResolvedPosition } from '../canvas/model.js';
import { LAYOUT_MODES, layoutIntent } from '../canvas/layout.js';

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
   * 提交串行化 + **队列自己维护 revision**。
   *
   * 为什么必须串行：每次写入都带 `baseRevision` 做乐观锁。若上一次还没返回就发下一次，
   * 两次会带同一个 revision，第二次必然 409。
   *
   * ## 为什么不能靠 `modelRef.current` 拿新 revision（这是 409 的真正根因）
   *
   * 原先的注释写着「等 `await canvas.reload()` 完成后 `modelRef.current` 就是新值」。
   * **这不成立**：`reload()` 只是 `setState`，React 的重渲染在下一个任务里才发生，
   * 而队列里的下一个 `run()` 是**同一个微任务链上立刻执行**的。于是它读到的仍是
   * 旧 `modelRef`，带着已过期的 revision 发出去 → 服务端拒绝 → 409 刷屏。
   *
   * 用户的体感是「动一下就刷新」「框选拖拽后卡片丢了」，本质都是这串 409 引起的
   * 连坐：写入失败 → 界面停在旧数据 → 卡片看起来消失。
   *
   * 修法：**不信 React 状态，直接信服务端返回值**。`PATCH` 响应里带 `revision`
   * （见 `patchLayout` 的返回类型），把它记在 ref 里作为下一次写入的 base。
   * ref 是同步的，不受渲染时机影响。
   */
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  /** 队列内部维护的「下一次写入应使用的 revision」；`null` 表示需要回落到模型。 */
  const nextRevisionRef = useRef<number | null>(null);
  /** `nextRevisionRef` 归属哪个工作区——切工作区后必须失效，否则会用别处的 revision 写。 */
  const nextRevisionWorkspaceRef = useRef<string | null>(null);

  const submitPatches = useCallback(
    async (patches: Patch[]) => {
      if (patches.length === 0) return;
      const run = async (): Promise<void> => {
        const workspaceId = canvas.activeWorkspaceId;
        const model = modelRef.current;
        /**
         * revision 的取值顺序：
         *   1. 队列自己记的（上一次 PATCH 的响应），**且必须属于同一个工作区**；
         *   2. 回落到模型里的值（首次写入、或刚切过工作区）。
         *
         * 第 1 步是关键：它不依赖任何 React 状态更新时机。
         */
        const queuedRevision =
          nextRevisionWorkspaceRef.current === workspaceId ? nextRevisionRef.current : null;
        const revision = queuedRevision ?? model?.revision;
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
          const written = await patchLayout(workspaceId, revision, {
            projectionEpoch,
            layout: { cards: snapshot.cards, collapsed: snapshot.collapsed, viewport: snapshot.viewport },
            regions: snapshot.regions,
            annotations: snapshot.annotations,
          });
          /**
           * **先记 revision，再 reload**。
           *
           * 顺序不能反：`reload()` 会 `await` 一次网络往返，期间队列里可能已经有
           * 下一个 `run` 在等。把 revision 记在 ref 里是同步的，必须趁现在做完。
           *
           * `written.revision` 缺失时（服务端没回这个字段）就**清空 ref**，
           * 让下一次写入回落到模型值——宁可多等一次 reload，也不要拿一个
           * 猜出来的 revision 去撞乐观锁。
           */
          if (typeof written.revision === 'number') {
            nextRevisionRef.current = written.revision;
            nextRevisionWorkspaceRef.current = workspaceId;
          } else {
            nextRevisionRef.current = null;
            nextRevisionWorkspaceRef.current = null;
          }
          setHistoryVersion(version => version + 1);
          /**
           * 就地更新模型，**不再全量 reload**（UI-D15，M1）。
           *
           * 为什么能不 reload：`PATCH` 响应已经带回提交后的 `layout` 与 `revision`，
           * 本地重建模型的结果与重新拉一次完全等价。原先每次拖拽都要重拉两次
           * （列表 + 18 MB 的整份工作区文档），这是「动一下就刷新」的来源，
           * 也让拖拽后的 selection box 要等一个往返才消失。
           *
           * 回落条件：只有当模型确实属于这个工作区时才就地应用。否则（刚切过
           * 工作区、或模型尚未加载完）仍走 reload，避免把 A 的布局套到 B 上。
           */
          const applied =
            written.layout !== undefined &&
            canvas.applyLayoutLocally(workspaceId, written.layout, written.revision);
          if (!applied) await canvas.reload();
        } catch (error) {
          /**
           * 写入失败后**必须让缓存的 revision 失效**。
           *
           * 若保留：下一次写入会带着一个「服务端从未确认过」的版本号继续撞 409；
           * 若清空：下一次回落到模型里的 revision（来自最近一次成功的 reload），
           * 至少是一个真实存在过的版本，有机会恢复。
           */
          nextRevisionRef.current = null;
          nextRevisionWorkspaceRef.current = null;
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
    /**
     * 同时让队列缓存的 revision 失效。
     *
     * 每个工作区有自己的 revision 序列。若切换后仍用上一个工作区的号去写，
     * 要么 409，要么（更糟）恰好撞上同号，把 A 的布局写到 B 上。
     * `submitPatches` 里已经按 workspaceId 比对过，这里再清一次是为了
     * 让「切回来」也不会复用旧值——那段时间里服务端可能已被别的路径改过。
     */
    nextRevisionRef.current = null;
    nextRevisionWorkspaceRef.current = null;
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

  /**
   * HOME 键：把全部卡片按自动布局放回视野中心（UI-D11）。
   *
   * 用户的原话是「移动后找不到卡片难以寻找」。这是真实痛点：画布没有小地图
   * （D14 已移除），卡片一旦被拖到视口外就只能靠滚轮盲找。所以给一个
   * 「一键盘活」的出口。
   *
   * 两个设计取舍：
   *
   * 1. **走 `layoutIntent` 而不是自己算坐标**：自动排版已经有三套引擎
   *    （横向 / 纵向 / 按分支），重写一份必然与 FR-09.1 走样。这里只挑一种模式
   *    并保证它进撤销栈——用户按错了能 Ctrl+Z 回去。
   *
   * 2. **用 `byBranch` 而不是 `horizontal`**：画布内容是会话卡片，一个会话就是
   *    一条链。按分支排版能把不同会话分开成行，比挤在一行里更容易扫视。
   *
   * 为什么 HOME 要放在「有选中项才响应」之前：下面那段箭头键处理在
   * `selectedCardIds.length === 0` 时直接 return，但 HOME 恰恰是「没有选中项、
   * 也找不到卡片」时才最需要——顺序放反会让它在最该生效的场景里失效。
   */
  /**
   * 把全部卡片按自动布局排到 `origin` 处（UI-D14）。
   *
   * `origin` 由 `CanvasSurface` 换算后传进来：它是**当前视口左上角对应的 world
   * 坐标**，不是画布绝对原点。
   *
   * 为什么必须这样：用户报「按 HOME 后卡片回到画布绝对坐标，我要的是回到我
   * 当前画布位置的坐标」。布局引擎的 `origin` 语义就是「结果从哪开始铺」，
   * 传绝对原点就会把卡片铺到 (86,82)——用户若正看着 world (-5000,-3000) 一带，
   * 视野会瞬间跳到画布角落。
   */
  const arrangeAllCards = useCallback((origin: { x: number; y: number }) => {
    const intent = layoutIntent(modelRef.current, LAYOUT_MODES.branch, { origin });
    if (intent.patches.length === 0) return;
    // 复用同一条提交路径：撤销栈、乐观锁、revision 跟踪都由它统一处理。
    void submitPatches(intent.patches as Patch[]);
  }, [submitPatches]);

  const arrangeAllRef = useRef(arrangeAllCards);
  arrangeAllRef.current = arrangeAllCards;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // 正文编辑、输入框、下拉等获焦时让位给宿主/系统。
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true) return;

      /**
       * HOME 不再在这里处理 —— 它需要 `transform` 才能算出「当前视口在哪」，
       * 而 `transform` 只存在于 `CanvasSurface` 内部。键监听已经下移到那里，
       * 本处只保留「有选中项」的箭头微调。
       *
       * 保留这条注释是为了防止后人把 HOME 又挪回这里：那样拿到的是绝对原点，
       * 按 HOME 会把视野甩到画布角落（用户已报过这个 bug）。
       */

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

  /** 当前工作区的摘要（用于只读标题；顶栏目录已移除，见渲染处注释）。 */
  const activeWorkspace = useMemo(() => {
    const id = canvas.activeWorkspaceId;
    if (id === null) return null;
    return canvas.workspaces.find(item => item.id === id) ?? null;
  }, [canvas.activeWorkspaceId, canvas.workspaces]);
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

      {/*
       * 顶栏目录已移除（UI-D19）。
       *
       * 用户原话：「把目录删掉，直接用宿主栏的对话即可」。现在的工作方式：
       * 在宿主左侧栏点一个会话 → 打开「无限画布」→ `conversation.view` 槽位
       * 通过 `scope.cwd` 把目录传进 iframe URL（`?cwd=`）→ 画布自动定位到该
       * 会话所在的工作区。
       *
       * 保留一个**只读**的当前目录标识：用户仍需要知道「我看的是哪个目录的画布」。
       * 但不提供切换按钮——切换的权威在宿主侧栏，画布另造一套目录选择器会变成
       * 第二份目录权威（AGENTS §5.2）。
       */}
      {activeWorkspace !== null ? (
        <div className="evc-canvas-caption" title={activeWorkspace.cwd ?? undefined}>
          {activeWorkspace.title ?? '未命名工作区'}
        </div>
      ) : null}

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
          onArrangeAll={arrangeAllCards}
        />
      )}
    </div>
  );
}
