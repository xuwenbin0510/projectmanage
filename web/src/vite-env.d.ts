/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_MOCK?: string;
  readonly VITE_API_BASE?: string;
  readonly VITE_APP_TITLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** 飞书 JSSDK 全局对象（内嵌环境下由 h5-js-sdk 注入） */
declare global {
  /**
   * 构建期注入的应用版本信息（`vite.config.ts` 用 `define` 静态替换）。
   * 用于左下角展示，便于比对「本地应用」与「线上应用」是否为同一份代码。
   */
  const __APP_VERSION__: {
    /** git 短 SHA；构建环境无 git 时为 'unknown' */
    readonly sha: string;
    /** 构建时是否存在未提交改动（线上镜像恒为 false，见 Dockerfile） */
    readonly dirty: boolean;
    /** 构建时刻，ISO 8601（UTC）——由浏览器按本地时区渲染，避免构建机时区差异 */
    readonly buildTime: string;
  };

  interface Window {
    tt?: {
      requestAuthCode?: (opts: {
        appId: string;
        success: (res: { code: string }) => void;
        fail: (err: unknown) => void;
      }) => void;
      [key: string]: unknown;
    };
    h5sdk?: {
      ready: (cb: () => void) => void;
      error: (cb: (err: unknown) => void) => void;
      [key: string]: unknown;
    };
  }
}

export {};
