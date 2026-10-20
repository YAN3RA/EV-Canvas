/**
 * EV Canvas · 插件元信息（**前后端共享，零 IO 零 Node 依赖**）
 *
 * 为什么单独一个文件：坐标/契约里的 id、format、schemaVersion 前端也要用
 * （显示版本、拼路由前缀、校验导出格式）。若前端直接 `import { PLUGIN_META }
 * from '../server/index.js'`，Vite 会把整个服务端入口——连同 `node:fs`、
 * `node:crypto`、`workspace-store`——一起拉进浏览器构建，构建期就会报
 * `"randomUUID" is not exported by "__vite-browser-external"`。
 *
 * 所以：**服务端入口与前端都从这里取，谁都不许反向依赖对方的实现文件。**
 */
import { FORMAT, SCHEMA_VERSION } from './constants.js';
/** 插件元信息，供宿主与前端共享 */
export const PLUGIN_META = {
    id: 'evcanvas',
    name: 'dsh-evcanvas',
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
};
/** Cordis 插件名（宿主用它标识注入的服务）。 */
export const PLUGIN_NAME = PLUGIN_META.name;
/**
 * 路由前缀。
 *
 * D12（包名/id/路由是否改为 `EV Canvas`）尚未裁决，所以这里先用与
 * `PLUGIN_META.id` 一致的短前缀；D12 定稿后改这一处即可，
 * 路由表与前端请求全部由它派生。
 */
export const ROUTE_PREFIX = `/${PLUGIN_META.id}`;
//# sourceMappingURL=meta.js.map