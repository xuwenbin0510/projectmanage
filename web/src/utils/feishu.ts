/**
 * 飞书内嵌环境探测与免登取码
 * @prd P0-11
 * S1 原型阶段：mock 模式下不会真的取码，仅用于展示「免登中…」状态。
 */

/** 是否运行在飞书客户端内（PC / 移动 H5） */
export function isInFeishu(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('lark') || ua.includes('feishu');
}

/** JSSDK 是否已就绪 */
export function hasFeishuSdk(): boolean {
  return typeof window !== 'undefined' && typeof window.tt?.requestAuthCode === 'function';
}

/**
 * 取飞书免登 code。
 * @param appId 飞书 AppId
 * @returns code 字符串；环境不支持时 reject
 */
export function requestAuthCode(appId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!hasFeishuSdk()) {
      reject(new Error('当前环境不支持飞书免登（未检测到 JSSDK）'));
      return;
    }
    try {
      window.tt!.requestAuthCode!({
        appId,
        success: (res) => resolve(res.code),
        fail: (err) => reject(new Error(`飞书免登失败：${JSON.stringify(err)}`)),
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error('飞书免登异常'));
    }
  });
}

/** 等待 h5sdk ready（最多 timeout 毫秒） */
export function waitSdkReady(timeout = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!window.h5sdk) {
      resolve(hasFeishuSdk());
      return;
    }
    let done = false;
    const timer = window.setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, timeout);
    window.h5sdk.ready(() => {
      if (!done) {
        done = true;
        window.clearTimeout(timer);
        resolve(true);
      }
    });
  });
}
