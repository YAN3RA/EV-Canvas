import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PLUGIN_META } from '../shared/meta.js';
import { useCanvasData, patchLayout, readLayoutBundle, type WorkspaceSummary } from './data.js';
import { CanvasSurface } from './CanvasSurface.js';
import { createCommandHistory, type Patch } from '../canvas/commands.js';

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
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
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

  const submitPatches = useCallback(
    async (patches: Patch[]) => {
      if (patches.length === 0) return;
      const workspaceId = canvas.activeWorkspaceId;
      const revision = modelRef.current?.revision;
      if (workspaceId === null || typeof revision !== 'number') {
        // 没有工作区或没有版本号时**不假装保存成功**，明确告知用户。
        setSaveError('当前没有可写入的工作区（或缺少 revision），改动未保存');
        return;
      }
      setSaving(true);
      setSaveError(null);
      try {
        await patchLayout(workspaceId, revision, patches);
        setHistoryVersion(version => version + 1);
        await canvas.reload();
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
    },
    [canvas],
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
    const workspaceId = canvas.activeWorkspaceId;
    const revision = modelRef.current?.revision;
    if (workspaceId === null || typeof revision !== 'number') {
      setSaveError('缺少 workspaceId 或 revision，撤销未提交到服务端');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await patchLayout(workspaceId, revision, entry.patches as Patch[]);
      setHistoryVersion(version => version + 1);
      await canvas.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [canvas, history]);

  // historyVersion 只用于触发重渲染，让「撤销」按钮的可用态跟着历史变化。
  const canUndo = useMemo(() => history.commands !== undefined && historyVersion >= 0, [history, historyVersion]);

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
            画布内容来自 DSH 会话投影；当前尚未接入投影订阅（S0-5），因此新建工作区后会一直为空。
          </p>
        </div>
      ) : (
        <CanvasSurface
          model={canvas.model}
          onViewportCommit={commitViewport}
          selectedCardId={selectedCardId}
          onSelectCard={setSelectedCardId}
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
  return (
    <div className="evc-workbar">
      {workspaces.map(item => (
        <button
          key={item.id}
          type="button"
          className={item.id === activeId ? 'is-active' : undefined}
          onClick={() => onSelect(item.id)}
        >
          {item.title ?? item.id}
        </button>
      ))}
    </div>
  );
}
