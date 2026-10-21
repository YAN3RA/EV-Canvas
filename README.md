# EV Canvas

DSH 统一会话与多媒体创作工作台插件（vNext）。

> **当前状态：投影与画布已有局部实现，完整 S0–S3 功能仍按逐项证据验收。**
> 本地测试、离线工具或包形态核验不代表真实宿主组合通过；当前新增工具的范围见下方「只读诊断工具」。
> 开发工作区的逐项状态由需求文档维护，安装包不包含私有项目文档。
> 不要把这个 README 里描述的结构当成「全部功能已完成」的证据。

---

## 安装

插件**不从 npm 安装**。`dist/`（编译产物）**已提交进仓库**，所以 `github:` 直装可用。

### 方式一：GitHub 直装（推荐）

DSH 安装插件时**不会替你跑构建**，因此编译产物必须随仓库一起发布。
本仓库的 `dist/` 已纳入版本控制（不含 sourcemap），安装文件集合以当前包清单为准，
与 `dsh-share`、`dsh-ops` 把 `lib/` 提交进仓库是同一做法。

```jsonc
// ~/.dsh/profiles/desktop/package.json，两处都要加
{
  "dependencies": { "dsh-evcanvas": "github:YAN3RA/EV-Canvas" },
  "dsh": { "profile": { "bundles": ["dsh-evcanvas"] } }
}
```

锁定版本（生产推荐）：`"github:YAN3RA/EV-Canvas#<完整提交SHA>"`，使用本次已核验目标的完整 SHA。

**注意**：只加 `dependencies` 不够，`bundles` 也必须加——否则包虽装进 `node_modules`，
插件却不会被加载（表现为路由 404）。改完在 profile 目录跑 `pnpm install` 并重启 DSH。

### 方式二：本地 tgz

```powershell
npm run pack:plugin     # 产出 release/dsh-evcanvas-<version>.tgz + .sha256
```

然后在「设置 → 插件」里选本地 tgz。

### 改完源码必须同步产物

`dist/` 进版本控制后，它就是**安装方直接使用的产物**。源码改了却忘记重建，
会得到一个「仓库里的产物比源码旧」的状态，而本地测试照样全绿。

```powershell
npm run check:dist   # 重建并逐文件与 HEAD 比对，不一致直接失败
```

### 方式三：写 profile 声明（本地）

编辑 `C:\Users\imyan\.dsh\profiles\desktop\package.json`，两处都要加：

```jsonc
{
  "dependencies": { "dsh-evcanvas": "file:C:\\path\\to\\dsh-evcanvas-0.0.1.tgz" },
  "dsh": { "profile": { "bundles": ["dsh-evcanvas"] } }
}
```

然后在 profile 目录执行 `pnpm install` 并重启 DSH。

> **产物交付要求**：本项目使用 TypeScript + Vite，安装方不应依赖现场构建。
> 当前 `dist/` 已随仓库交付；新改动必须重新构建并核验提交的产物，不能只更新源码。
> 更新已有 profile 前应确认包管理器与依赖树版本匹配，并备份清单、锁与当前插件；不要以全 profile 重装或仅替换 dist 代替单包更新核对。

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

## 只读诊断工具（S3 局部范围）

这些工具不修改画布或 DSH 会话，不执行模型请求，也不要求真实宿主在线。

### 卡片来源 CLI

```powershell
node scripts/why.mjs --file snapshot.json --workspace <workspaceId> --card <stableCardId>
# 包管理器注册 bin 后，也可运行 evcanvas-why；本轮没有执行安装。
```

输入必须是当前 `dsh-evcanvas`、`schemaVersion: 1`、带顶层 `workspaces` 的完整冻结快照。
它不猜默认目录，不自动读取 `DSH_HOME`，也不接受单工作区 HTTP 信封或旧格式。
卡片标识沿用画布模型（例如 `<threadId>:<0基提问序>`），不是 DSH 原生事件 seq。
输出 JSON 仅含 session/seq、父链、推断标记和快照覆盖声明，不输出问答正文。
缺失来源与覆盖声明明确保留未知，投影的 `historyComplete` 不代表原生日志已完整；歧义或未知卡片不会伪造结果。
这是 S3-8 的投影来源 CLI 子包，**尚不包含完整 why 图或 MCP**。

退出码：`0` 成功，`2` 参数错误，`3` 文件/JSON 读取错误，`4` 快照或目标拒绝，`5` 编译模块不可用。`--help` 提供参数说明。

### 宿主兼容静态检查

```powershell
node scripts/check-compatibility.mjs --host-version 0.2.1-rc.2 --json
node scripts/check-compatibility.mjs --package-root <candidatePackage> --host-version 0.2.1-rc.2
```

声明只由本工具所在包的 `compatibility.json` 提供，候选包不能更换检查白名单。
工具检查包入口、必要客户端服务、身份、字面 ESM 依赖和交付清单，不执行候选代码。
`pass-static` 仅表示该版本声明下的静态核验通过，**始终 `runtimeVerified=false`**；真实 GUI 组合仍须另行验收。
省略 `--host-version` 会明确显示 `not-checked`；未知版本为 `not-reviewed`，不能当兼容通过。
静态字面说明符检查不等于完整 JavaScript 语义分析，也不证明所有宿主版本都可运行。

开发源码仍需先 `npm run build`；GitHub / tgz 交付同时包含工具脚本、声明、CLI 注册与编译模型依赖。

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
