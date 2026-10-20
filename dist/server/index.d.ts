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
    /**
     * 媒体资产根目录（可选）。缺省时取 `dataFile` 同级的 `assets/`，
     * 让备份/迁移/回滚能当作一个整体处理。
     */
    assetsDir?: string;
}
export { PLUGIN_META, ROUTE_PREFIX };
/**
 * Cordis 插件名。
 *
 * 必须与**包名**一致（`dsh-evcanvas`），而不是 `PLUGIN_META.id`（`evcanvas`）。
 * Loader 行按 `name:` 解析到包，名字对不上时既加载不到、也不会给出明显报错。
 * `PLUGIN_META.id` 是插件在自身数据/路由里用的短标识，两者不是一回事。
 */
export declare const name: "dsh-evcanvas";
/**
 * 注入的宿主服务。
 *
 * `sessions` 是会话投影（S0-5）的**唯一**内容来源：DSH 拥有会话日志，插件只做
 * 投影副本。不注入它就没有任何合法途径读到会话事件——旧版同一位置也是这两个
 * （`dsh-synapnova@3fd1d00` `index.js:24`），属于已在真实宿主跑通的契约。
 */
export declare const inject: readonly ["webServer", "sessions"];
/**
 * 宿主注册入口。
 *
 * 与旧版骨架的差别：这里**不再抛 `not implemented`**。它实例化 `WorkspaceStore`
 * 并挂载路由；store 自身的原子写、锁、digest、幂等窗口全部沿用迁移实现。
 *
 * 已接：路由、静态产物、会话投影订阅（S0-5，`session/created` + `session/event`）。
 * 尚未接的部分（如实标注，不冒充已实现）：
 *   - S0-3 媒体资产上传路由（`assets.ts` 已实现且有测试，缺 HTTP 层）
 *   - S0-6 历史回填的 HTTP 入口（store 侧 `syncHistory` 已就绪）
 */
export declare function apply(ctx: unknown, config: PluginConfig): void;
/**
 * 测试与后续 S0-5 会用到的重导出。
 *
 * **不要在这里加 `export { apply as default }`**：Cordis 的 Loader 行按
 * *具名导出* 找插件（`apply` + `name` + `inject`），与已装插件一致的做法是
 * 只有具名导出。多一个 `default` 会让模块同时具备两种插件形态，加载器取哪个
 * 取决于内部判断，属于不必要的歧义。已装插件（`dsh-share` 等）实测都只有
 * `apply` / `name`，没有 `default`。
 */
export { WorkspaceStore };
