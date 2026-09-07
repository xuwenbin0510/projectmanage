/**
 * 快照到点调度器（D03 · 到点快照架构）
 *
 * 职责：保证「每周一 00:10 对刚结束周做全项目全量快照」准时发生，
 * 以及服务停机跨过 Deadline 后的启动补偿。环比从此与周报提交解耦。
 *
 * 两层保障：
 *  1. 定时触发：距下个周一 00:10（服务器本地时区）setTimeout，触发后对
 *     `weekCode(昨天)`（= 刚结束的周日）全项目采集，source='scheduled'，
 *     然后续排下一周。周期 7 天 << setTimeout 上限（24.8 天），无需分段。
 *  2. 启动补偿：initSnapshotScheduler 时对「上周」与「前周」各执行一次
 *     ensureWeekSnapshots（仅补缺失项目，不覆盖已有数据），source='backfill'。
 *     补拍状态的 captured_at 晚于周界，环比面板据此标注「补拍基准」。
 *
 * 已知边界（诚实声明，非 bug）：
 *  - 停机跨过周一 00:10 且启动时才补拍 → 该周基准是启动时刻状态，非周末真值（有标注）；
 *  - 停机超过两周 → 只补上周/前周，更早缺口不回补（环比只看两周，更早周无消费方）；
 *  - 快照无法事后补真值：这是任何事后机制的物理上限，到点触发是唯一缩小误差的手段。
 *
 * 零外部依赖：不引入 cron 库，原生 setTimeout + 周期重排。
 */

const dates = require('../lib/dates');
const snapshotService = require('./snapshot.service');

/** 周一 = 1（Date.getDay: 0=周日） */
var TARGET_DOW = 1;
/** 当地时间 00:10 */
var TARGET_HOUR = 0;
var TARGET_MINUTE = 10;

/**
 * 计算距「下个周一 00:10」的毫秒数（服务器本地时区）。
 * 恰好是周一 00:10 之后的当周内，都排到下周一。
 * @param {Date} now
 * @returns {number}
 */
function msUntilNextMonday(now) {
  const t = new Date(now);
  let addDays = (TARGET_DOW - t.getDay() + 7) % 7;
  const target = new Date(t.getFullYear(), t.getMonth(), t.getDate() + addDays, TARGET_HOUR, TARGET_MINUTE, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 7);
  }
  return target.getTime() - now.getTime();
}

/**
 * 定时采集一轮：对刚结束的周（昨天所在 ISO 周）全项目快照。
 * @param {import('better-sqlite3').Database} db
 */
function runScheduledCapture(db) {
  const week = dates.weekCode(dates.addDays(dates.today(), -1)); // 周一拍昨天（周日）所在周
  try {
    const r = snapshotService.captureAllProjectsSnapshot(db, week, 'scheduled');
    console.log('[snapshot-scheduler] %s 到点快照完成：%d 项目 / %d 任务', week, r.projects, r.tasks);
  } catch (e) {
    console.error('[snapshot-scheduler] %s 到点快照失败：%s', week, e && e.message);
  }
}

/**
 * 启动补偿：上周与前周各补一次缺失项目的快照。
 * @param {import('better-sqlite3').Database} db
 */
function runBootBackfill(db) {
  [7, 14].forEach(function (daysAgo) {
    const week = dates.weekCode(dates.addDays(dates.today(), -daysAgo));
    try {
      const ids = snapshotService.ensureWeekSnapshots(db, week);
      if (ids.length) {
        console.log('[snapshot-scheduler] %s 启动补偿：补拍 %d 个缺失项目（backfill）', week, ids.length);
      }
    } catch (e) {
      console.error('[snapshot-scheduler] %s 启动补偿失败：%s', week, e && e.message);
    }
  });
}

/**
 * 初始化调度器（服务启动时调用一次）。
 * @param {import('better-sqlite3').Database} db
 * @returns {{stop: Function}} 句柄（测试/优雅退出用）
 */
function initSnapshotScheduler(db) {
  runBootBackfill(db);

  let timer = null;
  const scheduleNext = function () {
    const ms = msUntilNextMonday(new Date());
    const nextFire = new Date(Date.now() + ms);
    console.log(
      '[snapshot-scheduler] 下次到点快照：%s（约 %s 小时后）',
      nextFire.toLocaleString(),
      (ms / 3600000).toFixed(1),
    );
    timer = setTimeout(function onFire() {
      runScheduledCapture(db);
      scheduleNext(); // 周而复始
    }, ms);
    if (typeof timer.unref === 'function') timer.unref(); // 不阻止进程退出
  };
  scheduleNext();

  return {
    stop: function () {
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { initSnapshotScheduler, msUntilNextMonday };
