/**
 * EV Canvas · 客户端（浏览器侧）入口
 *
 * ## 为什么这个文件不是普通 ESM 模块
 *
 * DSH 的客户端插件由宿主的 `window.__ModuleLoader__` 装载，格式固定为：
 *
 * ```js
 * window.__ModuleLoader__.load({ id, factory(require) { ... return 插件对象 } })
 * ```
 *
 * React 等共享依赖由 `require('react')` 从宿主取，**不能自己打包一份**——
 * 否则会拿到第二个 React 实例，hooks 直接报错。因此本文件由
 * `scripts/build-client.mjs` 单独产出，不走 Vite 的 SPA 构建。
 *
 * ## 入口位置
 *
 * 画布挂在**右侧栏标签页**（`sidebar.right.pane.tab`），不是对话顶栏那排
 * 视图切换器：顶栏那四个（对话/轨迹/上下文/编队）切的是「当前会话怎么呈现」，
 * 而画布是跨会话的工作台，语义不同；且顶栏没有开放给插件的注入位。
 *
 * ## 与宿主侧的分工
 *
 * 客户端只负责注册插槽与渲染壳；数据仍走 `/evcanvas/api/*`（宿主侧已实现）。
 * 不在此处新增任何会话/凭证权威。
 */

window.__ModuleLoader__.load({
  id: 'dsh-evcanvas',
  factory(require) {
    const React = require('react');

    /** 本插件右栏标签的类型 id（layout 记录里的身份）。 */
    const TAB_ID = 'evcanvas.canvas';
    /** 资源地址 scheme 段；DSH 只认 `dsh-resource://`。 */
    const TAB_KIND = 'evcanvas';
    /** 资源地址前缀。 */
    const ADDRESS_PREFIX = `dsh-resource://${TAB_KIND}/`;
    /** 对话顶栏视图的 id（与「对话/轨迹/上下文/编队」并列的那个）。 */
    const VIEW_ID = 'evcanvas';
    /** 左侧栏导航项与主面板共用的 id（`sidebar.panellist` 与 `main` 的 key 必须是它）。 */
    const PANEL_ID = 'evcanvas';

    /**
     * 用户可见的显示名。
     *
     * 只影响 UI 文案，**不改任何 id**：`PANEL_ID` / `TAB_ID` / 地址前缀都已写进
     * 宿主的面板选择记录与右栏布局，改名会让人已打开的标签失效。D12 定稿前
     * 内部标识一律保持 `evcanvas`。
     */
    const DISPLAY_NAME = '无限画布';

    /** 画布页面地址（同源，由宿主侧静态路由提供）。 */
    const PAGE_URL = '/evcanvas/';

    /**
     * 画布正文：用 iframe 承载已经构建好的 SPA。
     *
     * 为什么用 iframe 而不是把整个前端搬进客户端包：
     *   1. 前端已经是一套独立的 React SPA（有自己的路由与样式作用域）；
     *   2. 客户端包跑在宿主页面里，样式会互相污染；iframe 天然隔离；
     *   3. 画布要能独立重载，iframe 的 reload 就是最直接的手段。
     *
     * 代价是 iframe 与宿主之间不能直接共享状态——数据都走 HTTP，
     * 这本来就符合「不新增第二权威」的约束。
     */
    /**
     * 画布正文：用 iframe 承载已经构建好的 SPA。
     *
     * ## 焦点会话透传（UI-D19）
     *
     * 宿主在 `conversation.view` 槽位里会给组件传一个 `scope`：
     * `{ sessionId, cwd }`（见宿主 `SessionScope` 契约）。这就是用户此刻在
     * 左侧栏选中的那个会话。
     *
     * 把它拼进 iframe URL 后，画布可以**自动定位到该会话所在的工作区**，
     * 于是顶栏那排目录按钮就不需要了——用户说的是「直接用宿主栏的对话即可」。
     *
     * 为什么用 URL 而不是 postMessage：iframe 与宿主之间还没有桥接通道
     * （ADR-0003 只是规格，未实现）。URL 查询参数是最小可行方案，且天然
     * 支持刷新后恢复、支持用户手改地址排错。
     *
     * `cwd` 而非 `sessionId` 作键：画布的工作区就是目录，服务端列表接口
     * 已经带 `cwd`，前端可直接匹配，不需要新接口。
     */
    function CanvasBody({ scope } = {}) {
      const cwd = scope !== null && typeof scope === 'object' ? scope.cwd : undefined;
      const src =
        typeof cwd === 'string' && cwd !== ''
          ? PAGE_URL + '?cwd=' + encodeURIComponent(cwd)
          : PAGE_URL;
      return React.createElement('iframe', {
        // key 让 cwd 变化时重建 iframe：换会话时不应残留上一个会话的视图状态。
        key: src,
        src,
        title: DISPLAY_NAME,
        // 占满右栏；样式走内联，避免向宿主页面注入全局 CSS
        style: {
          display: 'block',
          width: '100%',
          height: '100%',
          border: '0',
          background: 'transparent',
        },
      });
    }

    /** 解析本插件自己的地址；不认识的一律返回 undefined（契约要求）。 */
    function parseAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(ADDRESS_PREFIX)) return undefined;
      return { kind: TAB_KIND };
    }

    /**
     * 左侧栏导航项 + 主面板的图标。
     *
     * 红框里那组（插件 / 自动化任务 / 上下文洞察）就是 `sidebar.panellist`：
     * 每个条目是一个图标按钮，点击后 `ctx.layout.selectPanel(id)` 把主面板
     * 切到对应 key 的 `main` 槽位。所以入口的正文不在这里，而在 `main`。
     */
    function CanvasPanelIcon() {
      return React.createElement(
        'span',
        {
          'aria-hidden': true,
          style: { display: 'inline-flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
        },
        React.createElement(
          'svg',
          { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
          // 一个四格画布意象
          React.createElement('rect', { x: 3, y: 4, width: 8, height: 7, rx: 1.5 }),
          React.createElement('rect', { x: 13, y: 4, width: 8, height: 7, rx: 1.5 }),
          React.createElement('rect', { x: 3, y: 13, width: 8, height: 7, rx: 1.5 }),
          React.createElement('rect', { x: 13, y: 13, width: 8, height: 7, rx: 1.5 }),
        ),
      );
    }

    /** 主面板正文：占满面板区。 */
    function CanvasPanel() {
      return React.createElement(
        'div',
        { style: { display: 'flex', width: '100%', height: '100%', minHeight: 0 } },
        CanvasBody(),
      );
    }

    /**
     * 对话顶栏「视图」的正文：与主面板同一个画布，但**能拿到 scope**。
     *
     * 这是 UI-D19 的关键入口：`conversation.view` 由宿主在会话上下文中渲染，
     * 会把 `scope = { sessionId, cwd }` 传进来。有这个 cwd 才能把画布自动定位
     * 到用户正在看的那个会话，从而去掉顶栏那排目录按钮。
     *
     * 左侧栏主面板（`CanvasPanel`）没有 scope —— 它不属于任何会话，所以只显示
     * 一个默认工作区。这是宿主槽位语义决定的，不是本插件能改的。
     *
     * **`scope` 必须给默认值**：`CanvasBody` 里对它做对象解构，宿主在部分渲染
     * 路径下（以及测试里）不传参，缺默认值会直接抛
     * `Cannot destructure property 'scope' of 'undefined'` —— 那是整块白屏，
     * 不是降级。默认 `{}` 让画布退回默认工作区，仍然可用。
     */
    function CanvasView({ scope } = {}) {
      return CanvasBody({ scope });
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        // ① 左侧栏导航项：这是用户指定的位置（插件 / 自动化任务 / 上下文洞察那一组）。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              // 三个内置项分别是 0 / 10 / 20；排 30 落在最后
              order: 30,
              label: () => DISPLAY_NAME,
            },
            CanvasPanelIcon,
          ),
        );

        // ② 主面板正文：`main` 是 keyed 槽位，key 必须等于上面的 panel id。
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, CanvasPanel),
        );

        // ③ 对话顶栏的视图位（保留：不离开会话也能切到画布）
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: VIEW_ID,
              order: 40,
              label: () => DISPLAY_NAME,
            },
            CanvasView,
          ),
        );

        // ② 注册右栏 tab 类型：告诉右栏「这个地址归我管」
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              patterns: [`dsh-resource://${TAB_KIND}/**`],
              priority: 'plugin',
              canOpen: address => parseAddress(address) !== undefined,
              title: () => DISPLAY_NAME,
            }),
          'evcanvas: right-pane tab type',
        );

        // ③ 注册正文：key 必须与上面定义的 id 一致，否则渲染不出来
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, CanvasBody),
        );

        // ④ 「新标签页」菜单里加一项，让用户从右栏也能找到入口
        ctx.slots.inject('sidebar.right.tab.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.menu.item',
              id: 'evcanvas-open',
              order: 40,
            },
            () =>
              React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    // 打开本插件地址；openResource 读 this，必须直接调用不拆包
                    ctx.sidebarRight.openResource(`${ADDRESS_PREFIX}canvas`);
                  },
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 10px',
                    border: 0,
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                  },
                },
                React.createElement('span', { 'aria-hidden': true }, '◫'),
                React.createElement('span', null, DISPLAY_NAME),
              ),
          ),
        );
      },
    };
  },
});
