import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * vNext 是 DSH 插件，不是独立站点：
 * - 前端产物由宿主侧栏以同源 iframe 加载
 * - 宿主进程仍为 Node/Cordis，零 runtime 依赖（react 只进前端产物）
 */
export default defineConfig({
  plugins: [react()],
  /**
   * 产物由宿主在 `/evcanvas/` 下提供，不是站点根。
   *
   * 必须设 `base`：Vite 默认产出 `/app.js`、`/assets/...` 这类**根绝对路径**，
   * 而插件静态路由挂在 `/evcanvas/` 前缀下，于是 index.html 打得开、脚本全 404。
   * 表现是「页面空白 / 浏览器弹出下载」，从「路由 200」上完全看不出来——
   * 这是本项目反复记的那条教训：路由 200 不等于前端被提供。
   */
  base: '/evcanvas/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
    // 插件内嵌 iframe，宿主不保证支持最新语法
    target: 'chrome120',
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Windows 沙箱下多线程池易 EPERM，用单线程
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
