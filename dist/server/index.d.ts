/**
 * EV Canvas · 宿主侧入口（Cordis 插件注册）
 *
 * 来源参考：dsh-synapnova@3fd1d00 index.js（路由模式与 `MODULES` 白名单防穿越）
 *
 * 本文件只做一件事：把已经迁移完成的 `WorkspaceStore`（原子写 + digest + 锁 +
 * 幂等窗口）挂到宿主已有的 Web Server 上，让插件**能被真实加载**。
 * 它不实现任何画布功能——那在 `src/canvas/*`、`src/export/*` 与后续的 UI 层。
 *
 * 硬约束：
 *   - 宿主侧零 runtime 依赖（react 只进前端产物）
 *   - 不建第二监听端口，复用宿主 `webServer`
 *   - 路由 path 永不直接映射到文件系统（防目录穿越，沿用旧版 `MODULES` 白名单模式）
 *   - 不新增模型/凭证权威，不建第二调度器（D16）
 *
 * 数据权威边界（AGENTS §5.2）：DSH 拥有原生日志/目录/标题/归档/执行；
 * 本插件只拥有投影副本与画布元数据。任何路由都不写宿主会话日志。
 */
import { PLUGIN_META, ROUTE_PREFIX } from '../shared/meta.js';
import { WorkspaceStore } from './workspace-store.js';
/** 插件配置（来自 cordis.patch.yml） */
export interface PluginConfig {
    dataFile: string;
    autoProjection: boolean;
    projectionWorkspaceTitle: string;
    trustedHosts: string[];
}
export { PLUGIN_META, ROUTE_PREFIX };
/** Cordis 插件名（宿主用它标识注入的服务）。 */
export declare const name: "evcanvas";
/** 注入的宿主服务：只要 Web Server，不额外开端口/服务。 */
export declare const inject: readonly ["webServer"];
/**
 * 宿主注册入口。
 *
 * 与旧版骨架的差别：这里**不再抛 `not implemented`**。它实例化 `WorkspaceStore`
 * 并挂载路由；store 自身的原子写、锁、digest、幂等窗口全部沿用迁移实现。
 *
 * 尚未接的部分（如实标注，不冒充已实现）：
 *   - S0-5 会话投影订阅（`session/created`、`session/event`）—— 需要 `sessions` 服务，
 *     vNext 尚未决定订阅契约（`ready` 握手，ADR-0003 待写）
 *   - S0-3 媒体资产上传路由
 *   - 前端 UI：仍是骨架页
 */
export declare function apply(ctx: unknown, config: PluginConfig): void;
/** 测试与后续 S0-5 会用到的重导出（与旧版根入口保持同一公开面）。 */
export { WorkspaceStore };
export { apply as default };
