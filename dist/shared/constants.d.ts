/**
 * EV Canvas · 共享常量
 * 来源：dsh-synapnova@3fd1d00 shared/schema.js:26-31（沿用）+ S0-1 设计新增
 */
/** 顶层文档格式标识（D23：与旧版 dsh-synapnova 明确区分，旧版读到会拒绝而非误读） */
export declare const FORMAT: "dsh-evcanvas";
/** schema 版本（新格式从 1 起算；扩展节点类型时递增） */
export declare const SCHEMA_VERSION: 1;
/** 标题长度上限（workspace / node / region） */
export declare const MAX_TITLE_LENGTH = 120;
/** 旁注文本上限 */
export declare const MAX_NOTE_LENGTH = 4000;
/** 单条投影正文上限 */
export declare const MAX_PROJECTION_LENGTH = 8000;
/** 超长截断标记 */
export declare const PROJECTION_TRUNCATED_SUFFIX = "\n\u2014\u2014\u2026\uFF08\u8BE6\u60C5\u67E5\u770B\u5168\u6587\uFF09";
/** 单画布节点数上限（防渲染卡死） */
export declare const MAX_NODES_PER_WORKSPACE = 2000;
/** 单画布边数上限（节点数 × 3） */
export declare const MAX_EDGES_PER_WORKSPACE = 6000;
/** 单个媒体资产字节上限（50 MiB，与 DSH 上传限制一致） */
export declare const MAX_ASSET_BYTES: number;
/** 文本节点上限（S0-1 §10 待裁定项 1，暂定 2 MiB） */
export declare const MAX_TEXT_BYTES: number;
/** 节点 id 格式：小写、可预测、防注入 */
export declare const NODE_ID_PATTERN: RegExp;
/** 允许的媒体 MIME 白名单（明确排除 image/svg+xml：可含脚本） */
export declare const ALLOWED_ASSET_MIME: readonly ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm", "audio/mpeg", "audio/wav", "audio/ogg"];
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
export declare const MIN_ZOOM = 0.05;
export declare const MAX_ZOOM = 1;
/** 滚轮缩放因子基数：每 100px deltaY 缩放 10% */
export declare const WHEEL_ZOOM_BASE = 1.1;
export declare const WHEEL_ZOOM_DIVISOR = 100;
/** 滑杆范围（百分比），由 MIN/MAX_ZOOM 派生，不单独维护 */
export declare const ZOOM_SLIDER_MIN: number;
export declare const ZOOM_SLIDER_MAX: number;
export declare const ZOOM_SLIDER_STEP = 1;
