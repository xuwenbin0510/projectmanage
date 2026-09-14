import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

/**
 * 构建期版本信息 —— 供左下角展示，用来比对「本地应用」与「线上应用」是否同一份代码。
 * 结构须与 `web/src/vite-env.d.ts` 的 `__APP_VERSION__` 声明保持一致。
 */
export interface AppVersion {
  /** 产品版本：HEAD 可达的最近一个发布 tag（如 `v1.0.0`）；仓库无 tag 时为 null */
  version: string | null;
  /** 相对该 tag 领先的提交数；0 = 正好落在 tag 上 */
  commitsSinceTag: number;
  /** git 短 SHA；无 git 环境为 `'unknown'` */
  sha: string;
  /** git 完整 SHA（Tooltip 用） */
  fullSha: string;
  /**
   * **已跟踪文件**存在未提交改动时为 true。这点很关键：本地改完没提交直接构建时，
   * SHA 与线上可能完全相同但内容不同 —— 靠脏标记才能分辨。用 `--untracked-files=no`
   * 排除未跟踪文件（如本地 `pm-data/`），否则 ECS 上会永远显示脏。
   */
  dirty: boolean;
  /** 构建时刻 ISO 8601（UTC）——由浏览器按本地时区渲染，规避构建机时区差异 */
  buildTime: string;
}

/** 执行 git 命令；失败（无 git / 非仓库 / 无 tag）返回 null，绝不让构建失败 */
function tryGit(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * 版本号口径（2026-09-14 定稿）：**产品版本由 git tag 驱动**。
 *
 * 「打 tag」即「发布」，版本号从 tag 自动推导、不手工维护任何数字 —— 这样它永远不会
 * 像手填字段那样失真（此前 `package.json` 的 version 自建仓起就没 bump 过，故不采用）。
 * 呈现为 `v1.0.0+3` = 发布 v1.0.0 之后的第 3 个未发布提交；仓库无 tag 时回落「未发布」。
 *
 * 注：Docker 构建上下文已放开 `.git`（见 `.dockerignore`），且 `.dockerignore` 排除的路径
 *     均为 gitignore 项，故容器内探测与本地同语义。
 */
function resolveAppVersion(): AppVersion {
  const version = tryGit('git describe --tags --abbrev=0');
  const sha = tryGit('git rev-parse --short HEAD') ?? 'unknown';
  const dirty = (tryGit('git status --porcelain --untracked-files=no') ?? '').length > 0;
  return {
    version,
    commitsSinceTag: version ? Number(tryGit(`git rev-list --count ${version}..HEAD`)) || 0 : 0,
    sha,
    fullSha: tryGit('git rev-parse HEAD') ?? 'unknown',
    dirty,
    buildTime: new Date().toISOString(),
  };
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
