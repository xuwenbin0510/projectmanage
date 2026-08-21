import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 临时测试配置（仅本次本地启动用，可删）。
 * 本机 safe-delete 会拦截 vite 预构建 commit 阶段的批量删除（>50 文件），
 * 导致 vite 在首次浏览器访问触发重优化时崩溃退出。
 * 故禁用 dev 预构建（optimizeDeps.disabled），改为运行时按需编译——
 * 不落盘 deps_temp，不再触发批量删除；首屏略慢但稳定。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: { noDiscovery: true, include: [] },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
