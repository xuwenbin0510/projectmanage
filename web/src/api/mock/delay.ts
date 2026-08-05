/** Mock 网络延迟模拟（让加载态/骨架屏在原型里可见） */

const BASE_DELAY = 90;
const JITTER = 120;

export function delay(ms?: number): Promise<void> {
  const t = ms ?? BASE_DELAY + Math.random() * JITTER;
  return new Promise((resolve) => {
    setTimeout(resolve, t);
  });
}
