/**
 * EV Canvas · 共享常量
 * 来源：dsh-synapnova@3fd1d00 shared/schema.js:26-31（沿用）+ S0-1 设计新增
 */

/** 顶层文档格式标识（D23：与旧版 dsh-synapnova 明确区分，旧版读到会拒绝而非误读） */
export const FORMAT = 'dsh-evcanvas' as const;

/** schema 版本（新格式从 1 起算；扩展节点类型时递增） */
export const SCHEMA_VERSION = 1 as const;

/** 标题长度上限（workspace / node / region） */
export const MAX_TITLE_LENGTH = 120;

/** 旁注文本上限 */
export const MAX_NOTE_LENGTH = 4_000;

/** 单条投影正文上限 */
export const MAX_PROJECTION_LENGTH = 8_000;

/** 超长截断标记 */
export const PROJECTION_TRUNCATED_SUFFIX = '\n——…（详情查看全文）';

/** 单画布节点数上限（防渲染卡死） */
export const MAX_NODES_PER_WORKSPACE = 2_000;

/** 单画布边数上限（节点数 × 3） */
export const MAX_EDGES_PER_WORKSPACE = 6_000;

/** 单个媒体资产字节上限（50 MiB，与 DSH 上传限制一致） */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

/** 文本节点上限（S0-1 §10 待裁定项 1，暂定 2 MiB） */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** 节点 id 格式：小写、可预测、防注入 */
export const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 允许的媒体 MIME 白名单（明确排除 image/svg+xml：可含脚本） */
export const ALLOWED_ASSET_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
] as const;

/**
 * 缩放钳制范围。
 *
 * **上限 1.0（100%）**：用户 2026-10-21 明确要求「最大放大到 100%，不要 500%」。
 * 原先的 `MAX_ZOOM = 5` 来自 S1-9 参考清单（对齐 Infinite Canvas 的 `5–500%`），
 * 但本项目画布内容以会话卡片为主，放大超过 100% 只会让视野变窄、没有信息收益。
 * 下限保留 0.05：缩到 5% 才能纵览几十张卡片，这是实际需要的。
 *
 * 与滑杆 min/max **必须严格一致**，否则滑杆拖到端点会被 clamp 弹回（S1-9 已记录该坑）。
 */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 1;

/** 滚轮缩放因子基数：每 100px deltaY 缩放 10% */
export const WHEEL_ZOOM_BASE = 1.1;
export const WHEEL_ZOOM_DIVISOR = 100;

/** 滑杆范围（百分比），由 MIN/MAX_ZOOM 派生，不单独维护 */
export const ZOOM_SLIDER_MIN = Math.round(MIN_ZOOM * 100);
export const ZOOM_SLIDER_MAX = Math.round(MAX_ZOOM * 100);
export const ZOOM_SLIDER_STEP = 1;
