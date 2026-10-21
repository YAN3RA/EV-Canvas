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
 * 因此直接作为客户端模块随包交付，不把宿主 React 打进 SPA。
 *
 * ## 入口位置
 *
 * 左侧栏主面板、对话视图和右栏标签共用同一画布与官方会话快照。
 * main 是 root 槽位；conversation.view 还提供标准 sessionId。
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
    /** 标准 root Hook 由 ui-session 提供；不缓存最后会话、不按列表顺序猜当前项。 */
    function useCanvasSession({ useSessions, sessionId } = {}) {
      if (typeof useSessions !== 'function') return undefined;
      return useSessions(snapshot => {
        if (snapshot?.byId === undefined) return undefined;
        // 严格会话入口以宿主传入的 sessionId 为准，缺失记录也不回退到别的会话。
        if (sessionId !== undefined) return snapshot.byId[sessionId] ?? null;
        const current = Object.values(snapshot.byId).filter(row => (row?.retainedBy?.mainView ?? 0) > 0);
        return current.length === 1 ? current[0] : null;
      });
    }

    /** 只把已确认的目录交给 iframe；没有身份时不加载默认工作区。 */
    function CanvasBody({ session } = {}) {
      const cwd = session?.cwd;
      if (typeof cwd !== 'string' || cwd === '') {
        const message = session === undefined ? '宿主会话信息尚未就绪。'
          : session === null ? '请先在 DSH 侧栏选择要查看的会话。'
            : '当前会话尚未提供工作目录。';
        return React.createElement('div', { role: 'status', style: { padding: 16 } }, message);
      }
      const src = PAGE_URL + '?cwd=' + encodeURIComponent(cwd);
      return React.createElement('iframe', {
        // 目录变化重建 iframe；同目录的会话卡片定位不由 cwd URL 冒充。
        key: src,
        src,
        title: DISPLAY_NAME,
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
    function CanvasPanel(props) {
      const session = useCanvasSession(props);
      return React.createElement(
        'div',
        { style: { display: 'flex', width: '100%', height: '100%', minHeight: 0 } },
        CanvasBody({ session }),
      );
    }

    /** 对话视图接收标准 sessionId；右栏无绑定时共用宿主 mainView 选择。 */
    function CanvasView(props) {
      return CanvasBody({ session: useCanvasSession(props) });
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
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, CanvasView),
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
