/**
 * EV Canvas · 统一节点与边类型定义
 * 依据：Project Docs/2-设计/S0-1-统一节点schema设计.md
 *
 * 八类节点 + 三类边。kind 为判别式（discriminant），可安全收窄。
 * 注意：本文件的字段是**契约**，校验实现在 validate.ts。
 */

/** 节点类别 */
export type NodeKind =
  | 'session'
  | 'thought'
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'generation'
  | 'group';

/** 边类别（D25：按可编辑性与权威来源分，不靠颜色） */
export type EdgeKind = 'lineage' | 'context' | 'input';

/** 可见性（FR-14：仅影响画布显示，不等于 DSH 归档） */
export type Visibility = 'visible' | 'hidden';

/** ISO-8601 时间字符串 */
export type IsoDate = string;

/** 生成任务状态 */
export type GenerationStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';

/** 生成任务类型 */
export type GenerationTask =
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'image-to-video';

/** 所有节点的公共字段（S0-1 §4.1） */
export interface BaseNode {
  nodeId: string;
  kind: NodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  collapsed: boolean;
  visibility: Visibility;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** 会话投影中的消息（只读，内容权威在 DSH） */
export interface ProjectedTurn {
  messageId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  at: IsoDate;
  /** 超长正文已被截断（原文仍在 DSH） */
  truncated?: boolean;
}

/** 4.2 session — DSH 会话节点 */
export interface SessionNode extends BaseNode {
  kind: 'session';
  /** DSH 原生 session id。比较必须先过 sameDshSessionId()（旧版前缀陷阱） */
  sessionId: string;
  projection: {
    cursor: { lastSeq: number };
    title: string;
    turns: ProjectedTurn[];
  };
  /** 只读镜像宿主归档状态，插件不改 */
  archivedInHost: boolean;
  /** 宿主侧会话已不可用时的降级标记（不删节点） */
  degraded?: boolean;
}

/** 4.3 thought — 思维/想法节点 */
export interface ThoughtNode extends BaseNode {
  kind: 'thought';
  text: string;
  /** 从会话提取时保留来源定位 */
  sourceRef: { sessionId: string; messageId: string } | null;
}

/** 4.4 text — 文本/材料节点 */
export interface TextNode extends BaseNode {
  kind: 'text';
  text: string;
  mime: 'text/plain' | 'text/markdown' | 'text/csv' | 'application/json';
  /** HTML 快照时的原始 URL */
  sourceUrl: string | null;
  /** 快照时间戳 */
  snapshotAt: IsoDate | null;
}

/** 4.5 媒体节点公共部分。只存 assetId，不存数据 */
export interface MediaNodeBase extends BaseNode {
  kind: 'image' | 'video' | 'audio';
  assetId: string;
  transform: {
    rotate: 0 | 90 | 180 | 270;
    crop: { x: number; y: number; w: number; h: number } | null;
  };
  alt: string;
}

export interface ImageNode extends MediaNodeBase {
  kind: 'image';
}
export interface VideoNode extends MediaNodeBase {
  kind: 'video';
}
export interface AudioNode extends MediaNodeBase {
  kind: 'audio';
}

/** 4.6 generation — 生成配置节点 */
export interface GenerationNode extends BaseNode {
  kind: 'generation';
  /** 指渠道配置。实际凭证与管理在宿主侧，不入本文档 */
  channelId: string;
  task: GenerationTask;
  params: {
    prompt: string;
    negativePrompt: string | null;
    model: string;
    aspectRatio: string;
    count: number;
    seed: number | null;
  };
  /** 上游节点 id，**顺序即生成顺序**，不可丢 */
  inputs: string[];
  status: GenerationStatus;
  lastRun: {
    at: IsoDate;
    resultNodeIds: string[];
    error: string | null;
  } | null;
}

/** 4.7 group — 批量结果组 */
export interface GroupNode extends BaseNode {
  kind: 'group';
  childNodeIds: string[];
  primaryNodeId: string;
  expanded: boolean;
}

/** 判别联合：按 kind 自动收窄 */
export type CanvasNode =
  | SessionNode
  | ThoughtNode
  | TextNode
  | ImageNode
  | VideoNode
  | AudioNode
  | GenerationNode
  | GroupNode;

/** 5. 三类边 */
export interface CanvasEdge {
  edgeId: string;
  kind: EdgeKind;
  from: string;
  to: string;
  createdAt: IsoDate;
}

/** 4.8 分区（独立结构，不是节点：不参与连线、不参与上下文） */
export interface Region {
  groupId: string;
  title: string;
  bounds: { x: number; y: number; w: number; h: number };
  color: string | null;
  note: string | null;
}

/** 7.1 资产元数据（只存元数据，二进制在独立 asset store） */
export interface AssetMeta {
  assetId: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: IsoDate;
}

/** 3. workspace */
export interface Workspace {
  id: string;
  revision: number;
  title: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: { x: number; y: number; zoom: number };
  groups: Region[];
}

/** 2. 顶层文档 */
export interface CanvasDocument {
  format: typeof import('./constants.js').FORMAT;
  schemaVersion: number;
  updatedAt: IsoDate;
  workspaces: Workspace[];
  assets: AssetMeta[];
  idempotency: Record<string, unknown>;
  idempotencyFloor: number | null;
}
