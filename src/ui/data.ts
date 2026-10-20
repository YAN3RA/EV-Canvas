/**
 * EV Canvas · 前端数据接入层
 *
 * 职责边界：**只做 IO 与状态，不做画布计算**。
 * 布局、邻接、选择、命令历史全部来自 `src/canvas/*`（纯函数、已测），
 * 这里只负责把它们和宿主 HTTP 接口缝起来。
 *
 * 硬约束：
 *   - 不缓存会话内容（权威在 DSH）；只缓存画布元数据
 *   - 不伪造 revision / workspaceId；服务端给什么就是什么
 *   - 网络失败不吞：向上暴露为 `error` 状态，由 UI 明示
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildCanvasModel, type CanvasModel } from '../canvas/model.js';
import { cloneLayout, type LayoutBundle, type LayoutBundleInput, type Patch } from '../canvas/commands.js';
import { ROUTE_PREFIX } from '../shared/meta.js';

/** 服务端 `GET /api/workspaces` 的响应形状。 */
export interface WorkspaceSummary {
  id: string;
  title?: string;
  revision?: number;
  updatedAt?: string;
}

interface WorkspaceListResponse {
  workspaces: WorkspaceSummary[];
}

interface WorkspaceDocument extends LayoutBundleInput {
  id?: string;
  revision?: number;
  title?: string;
}

/** 一次加载的结果；`null` 表示尚未加载完成。 */
export interface CanvasDataState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  model: CanvasModel | null;
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  error: string | null;
}

const EMPTY_STATE: CanvasDataState = {
  status: 'idle',
  model: null,
  workspaces: [],
  activeWorkspaceId: null,
  error: null,
};

/** 把 HTTP 错误转成可读文案；不抛异常，交给调用方决定怎么显示。 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${text ? `：${text.slice(0, 200)}` : ''}`);
  }
  return (await response.json()) as T;
}

/**
 * 读取工作区列表与指定工作区的快照，构建成画布模型。
 *
 * 为什么不合并成一次请求：宿主侧目前分开暴露（列表轻、快照重）。
 * 合并属于接口设计变更，要等 D12 定稿路由后再做。
 */
export function useCanvasData(initialWorkspaceId?: string): CanvasDataState & {
  reload: () => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
} {
  const [state, setState] = useState<CanvasDataState>(EMPTY_STATE);
  /** 防止卸载后 setState（React 19 已不告警，但避免无谓工作）。 */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadWorkspace = useCallback(async (workspaceId: string | null) => {
    if (workspaceId === null) {
      if (aliveRef.current) {
        setState(previous => ({ ...previous, status: 'ready', model: null, activeWorkspaceId: null, error: null }));
      }
      return;
    }
    const document = await requestJson<WorkspaceDocument>(`/api/workspaces/${encodeURIComponent(workspaceId)}`);
    // 服务端返回的文档直接喂给纯函数模型；模型层负责校验与降级。
    const model = buildCanvasModel(document);
    if (aliveRef.current) {
      setState(previous => ({
        ...previous,
        status: 'ready',
        model,
        activeWorkspaceId: workspaceId,
        error: null,
      }));
    }
  }, []);

  const reload = useCallback(async () => {
    if (aliveRef.current) setState(previous => ({ ...previous, status: 'loading', error: null }));
    try {
      const list = await requestJson<WorkspaceListResponse>('/api/workspaces');
      const workspaces = Array.isArray(list.workspaces) ? list.workspaces : [];
      if (aliveRef.current) {
        setState(previous => ({ ...previous, workspaces }));
      }
      // 选中优先级：显式指定 > 当前选中 > 列表第一个
      const target = initialWorkspaceId ?? state.activeWorkspaceId ?? workspaces[0]?.id ?? null;
      await loadWorkspace(target);
    } catch (error) {
      if (aliveRef.current) {
        setState(previous => ({
          ...previous,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    // state.activeWorkspaceId 故意不进依赖：只在首次/显式 reload 时决定默认目标，
    // 否则每次切换都会触发一次多余的全量 reload。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWorkspaceId, loadWorkspace]);

  const selectWorkspace = useCallback(
    async (workspaceId: string) => {
      if (aliveRef.current) setState(previous => ({ ...previous, status: 'loading', error: null }));
      try {
        await loadWorkspace(workspaceId);
      } catch (error) {
        if (aliveRef.current) {
          setState(previous => ({
            ...previous,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    },
    [loadWorkspace],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload, selectWorkspace };
}

/**
 * 把字段级 patch 提交到服务端。
 *
 * 服务端要求 `expectedRevision` 做乐观并发：不传就等于放任覆盖别人。
 * 这里强制调用方给出 revision，缺失时直接拒绝，不猜。
 */
export async function patchLayout(
  workspaceId: string,
  expectedRevision: number,
  patches: Patch[],
): Promise<{ revision?: number }> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('patchLayout: 需要合法的 expectedRevision，拒绝无版本号写入');
  }
  if (patches.length === 0) return {};
  return requestJson<{ revision?: number }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/layout`, {
    method: 'PATCH',
    body: JSON.stringify({ expectedRevision, patches }),
  });
}

/**
 * 读取布局集合（供命令历史初始化）。缺失字段一律降级为空，不抛错。
 *
 * 返回 `LayoutBundleInput` 而不是 `LayoutBundle`：`CommandHistoryOptions.readLayout`
 * 要的是带索引签名的宽类型，而 `cloneLayout` 产出的是严格 `LayoutBundle`。
 * 两者的形状一致，差异只在类型层；这里显式放宽，避免调用侧到处断言。
 */
export function readLayoutBundle(model: CanvasModel | null): LayoutBundleInput {
  const bundle: LayoutBundle = cloneLayout(
    model === null
      ? {}
      : {
          cards: model.layoutCards,
          collapsed: Object.fromEntries(model.collapsedCardIds.map(id => [id, true])),
          viewport: model.viewport,
          regions: model.regions,
          annotations: model.annotations,
        },
  );
  return bundle as LayoutBundleInput;
}
