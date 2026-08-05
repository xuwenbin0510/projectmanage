import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite 配置
 * - alias `@` → src（用 import.meta.url 派生绝对路径，避免依赖 @types/node）
 * - dev proxy /api → Express :3000（S1 阶段用 mock 时不会命中）
 * - build outDir → web/dist（仅产出到 web 自身目录）
 *   注意：**不要**输出到 `../public`。`pm-app/public/index.html` 是旧系统单页
 *   （S2 后端重构期间唯一可运行的现有前端，已归档副本见 `pm-app/legacy/index.html`），
 *   一旦 outDir 指向 ../public 会被 emptyOutDir 清空并覆盖。
 *   S3 联调阶段如需 Express 托管新前端，应改由部署脚本从 web/dist 拷贝到独立目录。
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
  build: {
    outDir: 'dist',
    // 沙箱 safe-delete 会拦截 vite 默认的 emptyDir(dist)（删目录走回收站被拒），
    // 故关闭自动清空；改为由部署脚本/手动清理 dist。类型与源码正确性不受影响。
    emptyOutDir: false,
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
