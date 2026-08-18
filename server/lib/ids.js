/**
 * ID 生成（对齐前端 Mock 的 `genId` 语义：前缀 + 短随机串）
 *
 * 要求：
 *  - 同进程内严格递增，避免同一毫秒内批量创建撞号
 *  - 结果可排序（时间前缀在前），便于 `compareMilestones` 的 id 兜底比较
 */

/** 同毫秒内的自增序号 */
let counter = 0;
/** 上一次取到的毫秒时间戳 */
let lastTs = 0;

/**
 * 生成带前缀的唯一 ID。
 * @param {string} [prefix=''] ID 前缀，例如 'P'
 * @returns {string}
 */
function genId(prefix) {
  const now = Date.now();
  if (now === lastTs) {
    counter += 1;
  } else {
    lastTs = now;
    counter = 0;
  }
  const ts = now.toString(36);
  const seq = counter.toString(36).padStart(2, '0');
  const rand = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
  return String(prefix || '') + ts + seq + rand;
}

/**
 * 项目展示编号（与 Mock 一致：`P-` + (1000 + seq * 3) 四位补零）。
 * @param {number} seq 序号（第几个项目，从 1 开始）
 * @returns {string}
 */
function projectCode(seq) {
  const n = Number.isFinite(seq) && seq > 0 ? seq : 1;
  return 'P-' + String(1000 + n * 3).padStart(4, '0');
}

module.exports = { genId, projectCode };
