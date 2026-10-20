import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '../styles/base.css';

/**
 * 前端入口。由宿主侧栏以同源 iframe 加载。
 * 移动端 / 独立浏览器打开均不支持：必须有宿主提供的 boot 上下文。
 */
const container = document.getElementById('root');
if (!container) {
  throw new Error('EV Canvas: #root not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
