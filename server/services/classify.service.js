/**
 * 项目分类判定服务（P0-01）
 *
 * ⚠ **逐字移植** `web/src/api/mock/rules.ts#classifyProject`。
 * 前端 Mock 是本项目的产品规格基线，后端判定结果（`suggested` + `reasons` 文案）
 * 必须与 Mock 一致，否则「Mock ↔ 真后端」切换时向导提示会漂移。
 *
 * 优先级链（硬规则，自上而下短路）：
 *   1. 基础设施建设            → C
 *   2. 硬件交付 / 客户验收     → A（优先于自研迭代）
 *   3. 自研产品持续迭代        → B（优先于合同金额）
 *   4. 无本质特征 + 大额       → A（金额仅参考信号）
 *   5. 默认                    → B
 */

const { CLASSIFY_AMOUNT_THRESHOLD, PROJECT_TYPES } = require('../config/enums');
const { AppError, ErrorCode } = require('../lib/errors');

/**
 * 归一化分类输入（缺字段一律给安全默认值，避免 undefined 参与判定）。
 * @param {object} raw 原始请求体
 * @returns {{contractAmount:number,hasHardware:boolean,hasAcceptance:boolean,isSelfIteration:boolean,isInfrastructure:boolean}}
 */
function normalizeInput(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const amount = Number(src.contractAmount);
  return {
    contractAmount: Number.isFinite(amount) ? amount : 0,
    hasHardware: !!src.hasHardware,
    hasAcceptance: !!src.hasAcceptance,
    isSelfIteration: !!src.isSelfIteration,
    isInfrastructure: !!src.isInfrastructure,
  };
}

/**
 * 分类判定。
 * @param {object} rawInput `ClassifyInput`
 * @returns {{suggested:'A'|'B'|'C', reasons:string[]}}
 */
function classifyProject(rawInput) {
  const input = normalizeInput(rawInput);
  const reasons = [];
  const amount = input.contractAmount;
  const bigAmount = amount >= CLASSIFY_AMOUNT_THRESHOLD;
  /** 交付本质特征：硬件交付 或 客户验收 */
  const hasDelivery = input.hasHardware || input.hasAcceptance;

  /* ── 1. C 类：基建型（最高优先硬规则） ───────────── */
  if (input.isInfrastructure) {
    reasons.push('勾选「基础设施建设」→ 判定为 C 类（基建型）');
    if (hasDelivery || input.isSelfIteration) {
      reasons.push('虽同时勾选了其他特征，但「基础设施建设」为最高优先硬规则，仍判定为 C 类');
    }
    if (bigAmount) {
      reasons.push(
        '合同额 ' + amount + ' 万元 ≥ ' + CLASSIFY_AMOUNT_THRESHOLD + ' 万，仅作参考信号，不改变 C 类判定',
      );
    }
    return { suggested: 'C', reasons: reasons };
  }

  /* ── 2. A 类：交付型（硬件 / 客户验收，优先级高于自研） ─── */
  if (hasDelivery) {
    if (input.hasHardware) reasons.push('勾选「包含硬件交付」→ 指向 A 类（交付型）');
    if (input.hasAcceptance) reasons.push('勾选「需要客户正式验收」→ 指向 A 类（交付型）');
    if (input.isSelfIteration) {
      reasons.push(
        '同时勾选「自研产品持续迭代」，但交付特征（硬件交付 / 客户验收）体现项目本质，优先级更高 → A 类优先',
      );
    }
    reasons.push(
      bigAmount
        ? '合同额 ' + amount + ' 万元 ≥ ' + CLASSIFY_AMOUNT_THRESHOLD + ' 万，与 A 类判定一致（金额仅为参考信号）'
        : '合同额 ' + amount + ' 万元 < ' + CLASSIFY_AMOUNT_THRESHOLD + ' 万，但交付特征为硬规则 → 仍判定为 A 类（交付型）',
    );
    return { suggested: 'A', reasons: reasons };
  }

  /* ── 3. B 类：产品型（自研迭代，优先于合同金额） ───── */
  if (input.isSelfIteration) {
    reasons.push('勾选「自研产品持续迭代」→ 判定为 B 类（产品型）');
    reasons.push('未勾选「包含硬件交付」「需要客户正式验收」「基础设施建设」，无交付 / 基建本质特征');
    if (bigAmount) {
      reasons.push(
        '提示：合同额 ' + amount + ' 万元 ≥ ' + CLASSIFY_AMOUNT_THRESHOLD +
          ' 万，但已按「自研产品持续迭代」判为 B 类（产品型）；' +
          '若该项目实际包含交付或客户验收环节，请确认分类，必要时手动改为 A 类并填写覆盖理由',
      );
    }
    return { suggested: 'B', reasons: reasons };
  }

  /* ── 4. 金额参考信号：无任何本质特征 + 大额 → 建议 A ─── */
  if (bigAmount) {
    reasons.push('未勾选硬件交付 / 客户验收 / 自研迭代 / 基础设施建设，无明确本质特征');
    reasons.push(
      '合同额 ' + amount + ' 万元 ≥ ' + CLASSIFY_AMOUNT_THRESHOLD + ' 万 → 建议按 A 类（交付型）管理',
    );
    reasons.push('金额为参考信号而非硬性规则；若为纯自研或内部项目，可手动改为 B 类并填写覆盖理由');
    return { suggested: 'A', reasons: reasons };
  }

  /* ── 5. 默认：B 类（产品型） ─────────────────────── */
  reasons.push('未勾选硬件交付 / 客户验收 / 自研迭代 / 基础设施建设，无明确本质特征');
  reasons.push(
    '合同额 ' + amount + ' 万元 < ' + CLASSIFY_AMOUNT_THRESHOLD + ' 万，未触发大额参考信号 → 默认 B 类（产品型）',
  );
  return { suggested: 'B', reasons: reasons };
}

/**
 * 校验「人工覆盖分类」是否合法（建项时用）。
 * 覆盖建议值时必须填写理由，否则 400 `E_CLASSIFY_REASON_REQUIRED`。
 *
 * @param {'A'|'B'|'C'} finalType 用户最终选定的类型
 * @param {'A'|'B'|'C'} suggested 系统建议类型
 * @param {string} overrideReason 覆盖理由
 * @throws {AppError}
 */
function assertOverrideReason(finalType, suggested, overrideReason) {
  if (PROJECT_TYPES.indexOf(finalType) < 0) {
    throw new AppError(ErrorCode.E_VALIDATION, '项目类型不合法', {
      fields: [{ field: 'type', message: '项目类型必须为 A / B / C / D 之一' }],
    });
  }
  if (finalType !== suggested && !String(overrideReason || '').trim()) {
    throw new AppError(
      ErrorCode.E_CLASSIFY_REASON_REQUIRED,
      undefined,
      { suggested: suggested, chosen: finalType },
    );
  }
}

module.exports = {
  normalizeInput,
  classifyProject,
  assertOverrideReason,
};
