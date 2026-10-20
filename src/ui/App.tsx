import { useEffect, useState } from 'react';
import { PLUGIN_META } from '../shared/meta.js';

/**
 * 骨架 App。**没有任何功能**，只证明：
 *   1. React 19 能挂载
 *   2. 前端能读到共享常量
 *   3. 宿主主题变量能接入（不硬编码颜色）
 */
export function App(): React.JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    // 跟随宿主主题；token 不全时用本地兜底（旧版已验证的策略）
    const root = document.documentElement;
    const read = (): void => {
      const attr = root.getAttribute('data-theme');
      setTheme(attr === 'dark' ? 'dark' : 'light');
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="evc-root" data-theme={theme}>
      <header className="evc-header">
        <span className="evc-title">EV Canvas</span>
        <span className="evc-badge">scaffolding</span>
      </header>
      <main className="evc-body">
        <p>骨架已就位。功能实现按 S0 → S3 推进。</p>
        <dl>
          <dt>插件 id</dt>
          <dd>{PLUGIN_META.id}</dd>
          <dt>文档格式</dt>
          <dd>{PLUGIN_META.format}</dd>
          <dt>schema 版本</dt>
          <dd>{PLUGIN_META.schemaVersion}</dd>
        </dl>
        <p className="evc-muted">
          当前无任何业务功能。功能状态见 Project Docs/1-需求/vnext功能.md
        </p>
      </main>
    </div>
  );
}
