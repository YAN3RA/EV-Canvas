// @ts-nocheck
/**
 * 客户端入口（`src/client/index.js`）的契约测试。
 *
 * 为什么值得测：这个文件**不是**普通 ESM 模块，宿主用
 * `window.__ModuleLoader__.load({ id, factory })` 装载它，React 从
 * `require('react')` 取宿主实例。这类「靠全局约定」的入口最容易在
 * 重构中断掉，而断了的表现是「侧栏什么都没有」，几乎不留报错。
 *
 * 这里用一个最小假的 `__ModuleLoader__` 与假 React 把 factory 跑起来，
 * 断言：注册了正确的 tab 类型、正文 key 与类型 id 一致、菜单项能打开地址。
 */

import { describe, expect, it, vi } from 'vitest';

/** 最小假 React：只实现本插件用到的那几个 API。 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
  };
}

/**
 * 装载客户端模块，返回它注册出来的东西。
 *
 * 每次调用都新建一套假 ctx，避免用例之间串味。
 */
async function loadClient() {
  /** 记录所有注册动作。 */
  const registered = { tabs: [], slots: [], effects: [] };
  const opened = [];

  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      registered.effects.push({ label, dispose });
      return () => {};
    },
    slots: {
      inject(_name, fn) {
        fn();
        return () => {};
      },
      register(options, component) {
        registered.slots.push({ options, component });
        return () => {};
      },
    },
    sidebarRightTabs: {
      register(definition) {
        registered.tabs.push(definition);
        return () => {};
      },
    },
    sidebarRight: {
      openResource(address) {
        opened.push(address);
      },
    },
  };

  const loader = {
    load({ id, factory }) {
      const module = factory(specifier => {
        if (specifier === 'react') return fakeReact();
        throw new Error(`unexpected require: ${specifier}`);
      });
      loader.captured = { id, module };
    },
  };

  globalThis.window = { __ModuleLoader__: loader };

  // 每次重新求值模块，保证 loader.load 被真实调用。
  // 用 `@/` 别名（与其他测试一致）：该文件是裸 ESM 写法、不走 TS 编译，
  // 相对路径在不同解析器下容易踩扩展名/根目录差异。
  vi.resetModules();
  await import('@/client/index.js');

  const plugin = loader.captured.module;
  plugin.apply(ctx);
  return { id: loader.captured.id, plugin, registered, opened };
}

describe('客户端入口', () => {
  it('通过 window.__ModuleLoader__ 装载，id 与包名一致', async () => {
    const { id } = await loadClient();
    expect(id).toBe('dsh-evcanvas');
  });

  it('声明注入 slots 与 sidebarRightTabs，不凭空假设服务存在', async () => {
    const { plugin } = await loadClient();
    expect(plugin.inject).toContain('slots');
    expect(plugin.inject).toContain('sidebarRightTabs');
  });

  it('在对话顶栏的视图位注册入口（与对话/轨迹/上下文/编队同一排）', async () => {
    const { registered } = await loadClient();
    const view = registered.slots.find(item => item.options.name === 'conversation.view');
    expect(view, '缺少 conversation.view 注册：用户点不到入口').toBeDefined();
    expect(view.options.id).toBe('evcanvas');
    // label 是函数（宿主延迟求值，便于切语言）
    expect(typeof view.options.label).toBe('function');
    expect(view.options.label()).toBe('无限画布');
    // order 必须大于编队的 30，排在它后面
    expect(view.options.order).toBeGreaterThan(30);
    // 正文渲染出来是画布
    const element = view.component();
    expect(element.type).toBe('iframe');
    expect(element.props.src).toBe('/evcanvas/');
  });

  it('对话视图将 cwd 安全编码为单个查询参数，并以 URL 作 iframe key', async () => {
    const { registered } = await loadClient();
    const view = registered.slots.find(item => item.options.name === 'conversation.view');
    const cwd = 'C:/项目 A/#草稿?x=1&y=2';
    const element = view.component({ scope: { sessionId: 'session-a', cwd } });
    expect(element.props.src).toBe('/evcanvas/?cwd=' + encodeURIComponent(cwd));
    expect(new URL(element.props.src, 'https://host.invalid').searchParams.get('cwd')).toBe(cwd);
    expect(element.props.key).toBe(element.props.src);
    expect(element.props.src).not.toContain('session-a');
  });

  it('不同 cwd 产生不同 iframe key，避免复用上一目录画面', async () => {
    const { registered } = await loadClient();
    const view = registered.slots.find(item => item.options.name === 'conversation.view');
    const a = view.component({ scope: { sessionId: 'a', cwd: 'C:/work/a' } });
    const b = view.component({ scope: { sessionId: 'b', cwd: 'C:/work/b' } });
    expect(a.props.src).not.toBe(b.props.src);
    expect(a.props.key).not.toBe(b.props.key);
  });

  it('同 cwd 切换 sessionId 不改变当前 URL（尚未接会话定位）', async () => {
    const { registered } = await loadClient();
    const view = registered.slots.find(item => item.options.name === 'conversation.view');
    const a = view.component({ scope: { sessionId: 'a', cwd: 'C:/work' } });
    const b = view.component({ scope: { sessionId: 'b', cwd: 'C:/work' } });
    expect(a.props.src).toBe(b.props.src);
    expect(a.props.key).toBe(b.props.key);
  });

  it('缺省、空或非字符串 cwd 回退入口页，不生成无效查询参数', async () => {
    const { registered } = await loadClient();
    const view = registered.slots.find(item => item.options.name === 'conversation.view');
    for (const props of [undefined, {}, { scope: null }, { scope: {} }, { scope: { cwd: '' } }, { scope: { cwd: 42 } }]) {
      const element = view.component(props);
      expect(element.type).toBe('iframe');
      expect(element.props.src).toBe('/evcanvas/');
      expect(element.props.key).toBe('/evcanvas/');
    }
  });

  it('当前主面板没有透传 scope：不能用对话视图用例代替主面板验收', async () => {
    const { registered } = await loadClient();
    const main = registered.slots.find(item => item.options.name === 'main');
    const view = registered.slots.find(item => item.options.name === 'conversation.view');
    const props = { scope: { sessionId: 'a', cwd: 'C:/work' } };
    const panel = main.component(props);
    expect(panel.children[0].props.src).toBe('/evcanvas/');
    expect(view.component(props).props.src).toBe('/evcanvas/?cwd=C%3A%2Fwork');
  });

  it('注册右栏标签类型，只认领自己的地址前缀', async () => {
    const { registered } = await loadClient();
    expect(registered.tabs).toHaveLength(1);
    const definition = registered.tabs[0];
    expect(definition.kind).toBe('evcanvas');
    expect(definition.patterns).toEqual(['dsh-resource://evcanvas/**']);
    expect(definition.canOpen('dsh-resource://evcanvas/canvas')).toBe(true);
    // 别人的地址绝不能被认领，否则会把宿主的 tab 抢过来
    expect(definition.canOpen('dsh-resource://changes-review/1/2')).toBe(false);
    expect(definition.canOpen('dsh-resource://file/anything')).toBe(false);
    expect(definition.canOpen(undefined)).toBe(false);
    expect(definition.canOpen(42)).toBe(false);
  });

  it('正文注册的 key 与标签类型 id 一致（不一致就渲染不出来）', async () => {
    const { registered } = await loadClient();
    const body = registered.slots.find(item => item.options.name === 'sidebar.right.pane.tab');
    expect(body).toBeDefined();
    expect(body.options.key).toBe(registered.tabs[0].id);
  });

  it('正文用 iframe 指向已构建的画布页，并占满容器', async () => {
    const { registered } = await loadClient();
    const body = registered.slots.find(item => item.options.name === 'sidebar.right.pane.tab');
    const element = body.component();
    expect(element.type).toBe('iframe');
    expect(element.props.src).toBe('/evcanvas/');
    expect(element.props.style.width).toBe('100%');
    expect(element.props.style.height).toBe('100%');
  });

  it('新标签页菜单项被注册，点击后打开自己的地址', async () => {
    const { registered, opened } = await loadClient();
    const menu = registered.slots.find(item => item.options.name === 'sidebar.right.tab.menu.item');
    expect(menu).toBeDefined();
    const button = menu.component();
    expect(button.type).toBe('button');
    button.props.onClick();
    expect(opened).toEqual(['dsh-resource://evcanvas/canvas']);
  });

  it('左侧栏导航项注册在 sidebar.panellist，排在三个内置项之后', async () => {
    const { registered } = await loadClient();
    const entry = registered.slots.find(item => item.options.name === 'sidebar.panellist');
    expect(entry, '缺少 sidebar.panellist：左栏不会出现入口').toBeDefined();
    // 内置三项是 0 / 10 / 20，我们必须更大才排在后面
    expect(entry.options.order).toBeGreaterThan(20);
    expect(typeof entry.options.label).toBe('function');
    expect(entry.options.label()).toBe('无限画布');
    // 图标位渲染出 svg，不是空白
    const icon = entry.component();
    expect(icon.type).toBe('span');
    expect(icon.children[0].type).toBe('svg');
  });

  it('主面板 key 与左栏导航项 id 一致（不一致点了就是空白）', async () => {
    const { registered } = await loadClient();
    const entry = registered.slots.find(item => item.options.name === 'sidebar.panellist');
    const main = registered.slots.find(item => item.options.name === 'main');
    expect(main, '缺少 main 注册：点左栏会切到空白面板').toBeDefined();
    expect(main.options.key).toBe(entry.options.id);
    const panel = main.component();
    expect(panel.type).toBe('div');
    expect(panel.props.style.width).toBe('100%');
  });

  it('每处注册都包在 effect/inject 里，便于宿主卸载时回收', async () => {
    const { registered } = await loadClient();
    // 1 个右栏 tab 类型 + 5 个插槽（左栏导航 / 主面板 / 对话视图 / 右栏正文 / 新标签页菜单）
    expect(registered.tabs).toHaveLength(1);
    expect(registered.slots).toHaveLength(5);
    const names = registered.slots.map(item => item.options.name).sort();
    expect(names).toEqual([
      'conversation.view',
      'main',
      'sidebar.panellist',
      'sidebar.right.pane.tab',
      'sidebar.right.tab.menu.item',
    ]);
    const labels = registered.effects.map(item => item.label);
    expect(labels.some(label => /tab type/.test(label))).toBe(true);
  });
});
