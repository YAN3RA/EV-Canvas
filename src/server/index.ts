/**
 * EV Canvas · 宿主侧入口（Cordis 插件注册）
 *
 * ⚠️ 当前为**骨架**：只注册配置与最小路由，无任何业务功能。
 * 真实实现按 S0 顺序推进，见 Project Docs/2-设计/vNext功能实现推敲.md
 *
 * 硬约束：
 *   - 宿主侧零 runtime 依赖（react 只进前端产物）
 *   - 不建第二监听端口，复用宿主服务
 *   - 路由 path 永不直接映射到文件系统（防目录穿越，沿用旧版 MODULES 白名单模式）
 */

import { FORMAT, SCHEMA_VERSION } from '../shared/constants.js';

/** 插件配置（来自 cordis.patch.yml） */
export interface PluginConfig {
  dataFile: string;
  autoProjection: boolean;
  projectionWorkspaceTitle: string;
  trustedHosts: string[];
}

/** 插件元信息，供宿主与前端共享 */
export const PLUGIN_META = {
  id: 'evcanvas',
  name: 'dsh-evcanvas',
  format: FORMAT,
  schemaVersion: SCHEMA_VERSION,
} as const;

/**
 * 宿主注册入口。
 *
 * TODO(S0-4): 接入 workspace-store（原子写 + digest + 锁）
 * TODO(S0-5): 接入会话投影与原生操作
 * TODO(S0-3): 接入媒体资产存储
 *
 * 现在只做一件事：暴露一个健康检查，证明插件被宿主正确加载。
 * 这不是「功能已实现」，只是骨架可加载的最小证据。
 */
export function apply(ctx: unknown, config: PluginConfig): void {
  void ctx;
  void config;
  // TODO: 真实路由注册
  throw new Error('not implemented: host entry is scaffolding only');
}
