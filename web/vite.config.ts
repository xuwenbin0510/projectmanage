import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

/**
 * 构建期版本信息 —— 供左下角展示，用来比对「本地应用」与「线上应用」是否同一份代码。
 *
 * - `sha`：`git rev-parse --short HEAD`；构建环境无 git（例如只解压源码）时回落 `'unknown'`。
 * - `dirty`：**已跟踪文件**存在未提交改动时为 true。这点很关键：本地改完没提交直接构建时，
 *   SHA 与线上可能完全相同，但内容不同 —— 靠脏标记才能分辨。用 `--untracked-files=no`
 *   排除未跟踪文件（如本地 `pm-data/`），否则 ECS 上会永远显示脏。
 * - `buildTime`：ISO(UTC) 绝对时刻，由浏览器按本地时区渲染，规避构建机时区差异。
 *
 * 注：Docker 构建上下文已放开 `.git`（见 `.dockerignore`），且 `.dockerignore` 排除的路径
 *     均为 gitignore 项，故容器内 dirty 探测与本地同语义。
 */
function resolveAppVersion(): { sha: string; dirty: boolean; buildTime: string } {
  let sha = 'unknown';
  let dirty = false;
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() || 'unknown';
    dirty = execSync('git status --porcelain --untracked-files=no', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    /* 无 git 环境：版本退化为 unknown，不允许影响构建 */
  }
  return { sha, dirty, buildTime: new Date().toISOString() };
}

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
  /* 构建期常量：编译时静态替换，无运行时开销、无额外请求 */
  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion()),
  },
  resolve: {
    alias: {
      // 项目位于含非 ASCII（中文）字符的目录时，URL.pathname 返回百分号编码路径，
      // 会导致 Vite 解析 @ 别名下的文件 ENOENT。用 decodeURIComponent 还原真实路径。
      '@': decodeURIComponent(new URL('./src', import.meta.url).pathname),
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
