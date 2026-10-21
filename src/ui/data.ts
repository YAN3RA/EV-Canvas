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

/**
 * 服务端 `GET /api/workspaces` 的响应形状。
 *
 * `cwd` / `threadCount` 服务端 `summary()` 一直在返回（见 workspace-store），
 * 只是前端类型此前没声明，导致顶栏无法按目录分组——只能把工作区名平铺成一排，
 * 用户看到的是「所有会话都挤在顶栏」。
 */
export interface WorkspaceSummary {
  id: string;
  title?: string;
  revision?: number;
  updatedAt?: string;
  /** 工作区对应的宿主目录；`null` 表示尚未绑定。 */
  cwd?: string | null;
  /** 该工作区内的会话（thread）数量。 */
  threadCount?: number;
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
  /**
   * 当前工作区 id 的**同步副本**。
   *
   * 为什么必须用 ref：`reload` 是 `useCallback`，依赖里**故意不含**
   * `state.activeWorkspaceId`（否则每次切换工作区都会多一次全量 reload）。
   * 于是 `reload` 体内读到的 `state.activeWorkspaceId` 永远是**首次渲染时**的值。
   *
   * 后果（这是 UI-D6「切换会话后一拖拽就被打回第一个会话」的根因）：
   * 保存布局 → `await canvas.reload()` → 内部按过期闭包挑目标工作区 →
   * 选中的是**第一个/旧的那个**工作区 → 界面被强行切走，拖拽状态跟着丢。
   *
   * ref 在每次 `loadWorkspace` 落地时同步写入，`reload` 读它拿到的必是最新值。
   */
  const activeWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadWorkspace = useCallback(async (workspaceId: string | null) => {
    if (workspaceId === null) {
      activeWorkspaceIdRef.current = null;
      if (aliveRef.current) {
        setState(previous => ({ ...previous, status: 'ready', model: null, activeWorkspaceId: null, error: null }));
      }
      return;
    }
    const document = await requestJson<WorkspaceDocument>(`/api/workspaces/${encodeURIComponent(workspaceId)}`);
    // 服务端返回的文档直接喂给纯函数模型；模型层负责校验与降级。
    const model = buildCanvasModel(document);
    // 先写 ref 再 setState：保证 reload 在任何时刻都能拿到最新目标。
    activeWorkspaceIdRef.current = workspaceId;
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
      // 选中优先级：显式指定 > 当前选中（ref，见上）> 列表第一个。
      // 读 ref 而不是 `state.activeWorkspaceId`：后者是过期闭包，会把用户打回首个工作区。
      const target = initialWorkspaceId ?? activeWorkspaceIdRef.current ?? workspaces[0]?.id ?? null;
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
    // 依赖不含 `state.activeWorkspaceId`：reload 的身份应保持稳定，
    // 当前工作区改由 `activeWorkspaceIdRef` 承载（见其声明处的说明）。
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
 * 生成一个标准小写 UUIDv7（服务端 `validateEnvelope` 强制要求）。
 *
 * 为什么必须 v7 而不是 v4：服务端的幂等窗口按 `operationId` 排序并推进
 * `idempotencyFloor`（`trimIdempotency` 依赖「id 越大越新」）。v4 是随机序，
 * 会把这个假设打穿——旧条目可能排在新条目之后，floor 一旦推进过头，
 * 后续合法请求会被判成 `IdempotencyExpiredError`。
 *
 * 位布局（RFC 9562）：48 位毫秒时间戳 + 4 位版本(7) + 12 位随机 + 2 位变体(10) + 62 位随机。
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  const now = Date.now();
  // 时间戳高位在前（大端），占前 6 字节。
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // 版本 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // 变体 10xx
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 服务端 `updateLayout` 接受的布局字段（其余字段一概不发，避免误清空）。 */
export interface LayoutSnapshot {
  cards: Record<string, { x: number; y: number }>;
  collapsed: Record<string, true>;
  viewport: { x: number; y: number; zoom: number };
}

export interface PatchLayoutOptions {
  /** 工作区当前纪元；服务端用它拒绝「基于旧投影」的写入。 */
  projectionEpoch: number;
  /** 要提交的完整布局快照（服务端按字段覆盖，缺字段即不动）。 */
  layout: LayoutSnapshot;
  /** 可选：随同提交的顶层字段。不传则服务端保留原值。 */
  regions?: unknown[];
  annotations?: unknown[];
  /** 幂等键；不传则自动生成。重试同一操作时必须复用同一个值。 */
  operationId?: string;
}

/**
 * 提交布局到服务端。
 *
 * ## 请求形状由服务端契约决定，不是自由发挥
 *
 * `WorkspaceStore.updateLayout` 走 `mutate` → `validateEnvelope`，要求**完整信封**：
 *
 *   workspaceId / baseRevision / operationId(UUIDv7) / projectionEpoch / action / body
 *
 * 其中 `body` 必须是 `{ layout: {...}, regions?, annotations? }`，而 `layout` 内部
 * 才是 `cards` / `collapsed` / `viewport`。**不是** `{ expectedRevision, patches }`
 * ——早先按后者发，服务端直接 400「layout 写入必须携带 projectionEpoch」，
 * 拖拽和撤销一起失效（两者共用这条提交路径）。
 *
 * ## 为什么 revision 与 epoch 都必须给
 *
 * `baseRevision` 是乐观锁：版本落后即 409，防覆盖别人。`projectionEpoch` 是投影
 * 世代：数据文件被外部重写或工作区重建后纪元会 +1，此时基于旧纪元的布局补丁
 * 必须被拒，否则会把陈旧坐标写到新投影上。
 */
export async function patchLayout(
  workspaceId: string,
  baseRevision: number,
  options: PatchLayoutOptions,
): Promise<{ revision?: number | null }> {
  if (!Number.isInteger(baseRevision) || baseRevision < 1) {
    throw new Error('patchLayout: baseRevision 必须是不小于 1 的整数（服务端拒绝无版本号写入）');
  }
  if (!Number.isSafeInteger(options.projectionEpoch) || options.projectionEpoch < 1) {
    throw new Error('patchLayout: projectionEpoch 必须是正安全整数（服务端拒绝缺纪元的写入）');
  }
  const body: Record<string, unknown> = { layout: options.layout };
  // regions / annotations 是工作区**顶层**字段，只在调用方真的带了才发：
  // 无条件发送等于用空数组清空它们（服务端见 `Object.hasOwn` 即覆盖）。
  if (options.regions !== undefined) body['regions'] = options.regions;
  if (options.annotations !== undefined) body['annotations'] = options.annotations;

  const envelope = {
    workspaceId,
    baseRevision,
    operationId: options.operationId ?? uuidv7(),
    projectionEpoch: options.projectionEpoch,
    action: 'workspace.layout',
    body,
  };
  return requestJson<{ revision?: number }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/layout`, {
    method: 'PATCH',
    body: JSON.stringify(envelope),
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
