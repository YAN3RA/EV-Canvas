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
    function CanvasBody() {
      return React.createElement('iframe', {
        src: PAGE_URL,
        title: 'EV Canvas',
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
     * 对话顶栏「视图」的正文：与右栏正文是同一个画布，只是挂的位置不同。
     *
     * 为什么两处都注册：用户既可以直接在会话顶栏切到画布（不离开会话），
     * 也可以把画布作为右栏标签页常驻。两者渲染同一份内容，不存在第二套状态。
     */
    function CanvasView() {
      return CanvasBody();
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        // ① 注册对话顶栏的「视图」入口：与「对话 / 轨迹 / 上下文 / 编队」同一排。
        //
        // 这是用户明确要求的入口位置。宿主把 `conversation.view` 渲染成
        // ConversationRoot 顶部那排 role="tab" 的按钮；`label` 决定按钮文字，
        // `order` 决定排在哪个位置（编队是 30，我们排它后面）。
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: VIEW_ID,
              order: 40,
              label: () => 'EV Canvas',
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
              title: () => 'EV Canvas',
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
                React.createElement('span', null, 'EV Canvas 画布'),
              ),
          ),
        );
      },
    };
  },
});
