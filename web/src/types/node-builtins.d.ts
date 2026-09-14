/**
 * Node 内建模块的最小类型声明。
 *
 * 本仓库**刻意不安装 `@types/node`**（避免把 Node 全局类型注入浏览器端类型环境，
 * 例如误用 `process` / `Buffer` 却不报错）。但 `vite.config.ts` 位于 tsconfig 的
 * `include` 内，需要读取 git 才能生成构建期版本号，故在此只声明真正用到的那一个子集。
 *
 * ⚠ 若将来安装了 `@types/node`，请删除本文件（重复声明会冲突）。
 */
declare module 'node:child_process' {
  /** execSync 的最小选项子集（本仓库仅用到这两项） */
  interface ExecSyncOptions {
    encoding: 'utf8';
    /**
     * 屏蔽 git 的 stderr —— 仓库无 tag / 非 git 仓库时 git 会打印 fatal 告警，
     * 属预期回落路径，不应污染构建日志。
     */
    stdio?: ['ignore', 'pipe', 'ignore'];
  }
  /** 同步执行命令并返回 stdout（本仓库仅以 `encoding: 'utf8'` 调用） */
  export function execSync(command: string, options: ExecSyncOptions): string;
}
