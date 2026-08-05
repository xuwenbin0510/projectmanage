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
