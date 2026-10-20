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
    expect(view.options.label()).toBe('EV Canvas');
    // order 必须大于编队的 30，排在它后面
    expect(view.options.order).toBeGreaterThan(30);
    // 正文渲染出来是画布
    const element = view.component();
    expect(element.type).toBe('iframe');
    expect(element.props.src).toBe('/evcanvas/');
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

  it('每处注册都包在 effect/inject 里，便于宿主卸载时回收', async () => {
    const { registered } = await loadClient();
    // 1 个右栏 tab 类型 + 3 个插槽（对话视图 / 右栏正文 / 新标签页菜单）
    expect(registered.tabs).toHaveLength(1);
    expect(registered.slots).toHaveLength(3);
    const names = registered.slots.map(item => item.options.name).sort();
    expect(names).toEqual(['conversation.view', 'sidebar.right.pane.tab', 'sidebar.right.tab.menu.item']);
    const labels = registered.effects.map(item => item.label);
    expect(labels.some(label => /tab type/.test(label))).toBe(true);
  });
});
