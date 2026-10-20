# EV Canvas

DSH 统一会话与多媒体创作工作台插件（vNext）。

> **当前状态：脚手架，无业务功能。**
> 46 项功能全部处于「未实现」，状态见 `Project Docs/1-需求/vnext功能.md`。
> 不要把这个 README 里描述的结构当成「已完成」的证据。

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | React 19 + TypeScript + Vite 6 | 由宿主侧栏以同源 iframe 加载 |
| 宿主 | Node ≥20 + Cordis 插件 | **零 runtime 依赖**，react 只进前端产物 |
| 测试 | Vitest 2 | 单线程池（Windows 沙箱下 fork 易 EPERM） |

---

## 目录结构

```
dsh-evcanvas/
├── cordis.patch.yml          插件注册（插入宿主 Web profile）
├── index.html                Vite 入口
├── src/
│   ├── shared/               ★ 共享契约（前端与宿主都用）
│   │   ├── constants.ts      FORMAT / 限额 / 缩放参数
│   │   ├── types.ts          八类节点 + 三类边 + 文档结构
│   │   ├── errors.ts         错误类型
│   │   └── session-id.ts     会话 ID 归一化（防旧版前缀陷阱）
│   ├── server/               宿主侧（Cordis 插件）
│   │   └── index.ts          注册入口（骨架）
│   ├── host/                 宿主桥接（原生操作、投影）
│   ├── canvas/               画布纯逻辑（模型、布局、命令）
│   ├── export/               导出（PNG / Markdown / CSV / JSON）
│   ├── ui/                   前端
│   │   ├── main.tsx          React 挂载
│   │   ├── App.tsx           骨架页
│   │   ├── canvas/           画布组件
│   │   ├── nodes/            节点渲染
│   │   └── settings/         设置面板
│   ├── i18n/                 中英双语字典
│   ├── data/                 内置数据（提示词模板等）
│   └── styles/               CSS 变量与基础样式
└── test/                     Vitest 测试
```

---

## 命令

```powershell
# 安装（首次）
pnpm install

# 类型检查
pnpm exec tsc --noEmit

# 测试
pnpm exec vitest run

# 构建前端产物（输出到 dist/ui/）
pnpm exec vite build

# 全量构建（类型检查 + 前端）
pnpm run build
```

> **Windows 注意**：`pnpm exec` 每次会触发一次依赖校验安装，可加
> `--config.verify-deps-before-run=false` 跳过，或直接调
> `node node_modules/vite/bin/vite.js`、`node node_modules/typescript/bin/tsc`。

---

## 设计文档

动手写任一部分之前先读：

| 文档 | 内容 |
|---|---|
| `Project Docs/2-设计/S0-1-统一节点schema设计.md` | 八类节点 + 三类边契约（**写节点代码前必读**） |
| `Project Docs/2-设计/vNext功能实现推敲.md` | 46 项功能的实现方式与依赖文件 |
| `Project Docs/2-设计/旧版代码迁移清单.md` | 旧仓库哪些代码可搬、怎么搬 |
| `Project Docs/2-设计/S1-9-平移缩放IC参考清单.md` | 平移缩放实测参数 |
| `Project Docs/1-需求/HANDOFF.md` | 需求权威（D/FR/AC） |

---

## 硬约束

1. **会话内容权威在 DSH** —— 插件只保存投影与布局，不伪造、不改写会话历史。
2. **凭证权威在 DSH** —— 前端类型里不定义 API Key 字段，生成请求走宿主代理。
3. **不建第二调度器** —— 禁止 `canvas-agent` / Codex 调度循环。
4. **媒体不进 JSON** —— 图片/视频/音频存独立 asset store，`workspaces.json` 只存 `assetId`。
5. **不建第二监听端口** —— 复用宿主服务。

---

## 许可

MIT。基于 [Synapse](https://github.com/liangmianya/dsh-synapse) 演进，参考 [ThoughtDAG](https://github.com/chenxiachan/thoughtdag) 与 [Infinite Canvas](https://github.com/basketikun/infinite-canvas)。
