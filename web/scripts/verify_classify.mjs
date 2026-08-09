/**
 * verify_classify.mjs —— 项目分类规则真值表回归脚本（QA 独立验证，非产品代码）
 *
 * 背景：src/api/mock/rules.ts 使用 TS 路径别名（@/...），node 无法直接导入，
 *      因此把 classifyProject 的**当前源码逻辑逐字抄录**到本脚本（仅把
 *      CLASSIFY_AMOUNT_THRESHOLD 内联为 100，其余包括 reasons 文案完全一致）。
 *
 * 抄录基准：src/api/mock/rules.ts 第 43–110 行（classifyProject）
 * 基准常量：src/config/enums.ts 第 239 行 CLASSIFY_AMOUNT_THRESHOLD = 100
 *
 * 运行：node scripts/verify_classify.mjs     （退出码 0 = 全通过，1 = 有失败）
 */

/* ═══════════════ 1. 被测逻辑（逐字抄自 rules.ts） ═══════════════ */

const CLASSIFY_AMOUNT_THRESHOLD = 100;

function classifyProject(input) {
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
        `合同额 ${amount} 万元 ≥ ${CLASSIFY_AMOUNT_THRESHOLD} 万，仅作参考信号，不改变 C 类判定`,
      );
    }
    return { suggested: 'C', reasons };
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
        ? `合同额 ${amount} 万元 ≥ ${CLASSIFY_AMOUNT_THRESHOLD} 万，与 A 类判定一致（金额仅为参考信号）`
        : `合同额 ${amount} 万元 < ${CLASSIFY_AMOUNT_THRESHOLD} 万，但交付特征为硬规则 → 仍判定为 A 类（交付型）`,
    );
    return { suggested: 'A', reasons };
  }

  /* ── 3. B 类：产品型（自研迭代，优先于合同金额） ───── */
  if (input.isSelfIteration) {
    reasons.push('勾选「自研产品持续迭代」→ 判定为 B 类（产品型）');
    reasons.push('未勾选「包含硬件交付」「需要客户正式验收」「基础设施建设」，无交付 / 基建本质特征');
    if (bigAmount) {
      reasons.push(
        `提示：合同额 ${amount} 万元 ≥ ${CLASSIFY_AMOUNT_THRESHOLD} 万，但已按「自研产品持续迭代」判为 B 类（产品型）；` +
          '若该项目实际包含交付或客户验收环节，请确认分类，必要时手动改为 A 类并填写覆盖理由',
      );
    }
    return { suggested: 'B', reasons };
  }

  /* ── 4. 金额参考信号：无任何本质特征 + 大额 → 建议 A ─── */
  if (bigAmount) {
    reasons.push('未勾选硬件交付 / 客户验收 / 自研迭代 / 基础设施建设，无明确本质特征');
    reasons.push(
      `合同额 ${amount} 万元 ≥ ${CLASSIFY_AMOUNT_THRESHOLD} 万 → 建议按 A 类（交付型）管理`,
    );
    reasons.push('金额为参考信号而非硬性规则；若为纯自研或内部项目，可手动改为 B 类并填写覆盖理由');
    return { suggested: 'A', reasons };
  }

  /* ── 5. 默认：B 类（产品型） ─────────────────────── */
  reasons.push('未勾选硬件交付 / 客户验收 / 自研迭代 / 基础设施建设，无明确本质特征');
  reasons.push(
    `合同额 ${amount} 万元 < ${CLASSIFY_AMOUNT_THRESHOLD} 万，未触发大额参考信号 → 默认 B 类（产品型）`,
  );
  return { suggested: 'B', reasons };
}

/* ═══════════════ 2. 断言框架 ═══════════════ */

let passed = 0;
const failures = [];

const inp = (o) => ({
  contractAmount: 0,
  hasHardware: false,
  hasAcceptance: false,
  isSelfIteration: false,
  isInfrastructure: false,
  ...o,
});

const flag = (b) => (b ? 'T' : 'F');

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${detail}`);
  }
}

/* ═══════════════ 3. 主真值表（7 行） ═══════════════ */

const TRUTH_TABLE = [
  { n: 1, i: { isInfrastructure: true, contractAmount: 500 }, want: 'C', note: '基建 → C（最高优先）' },
  { n: 2, i: { hasHardware: true, contractAmount: 500 }, want: 'A', note: '硬件交付 → A' },
  { n: 3, i: { hasAcceptance: true, contractAmount: 500 }, want: 'A', note: '客户验收 → A' },
  { n: 4, i: { isSelfIteration: true, contractAmount: 50 }, want: 'B', note: '自研 + 小额 → B' },
  { n: 5, i: { isSelfIteration: true, contractAmount: 500 }, want: 'B', note: '★自研 + 大额 → B（核心修正，旧为 A）' },
  { n: 6, i: { contractAmount: 200 }, want: 'A', note: '无特征 + 大额 → A（参考信号）' },
  { n: 7, i: { contractAmount: 0 }, want: 'B', note: '无特征 + 无金额 → B（默认）' },
];

console.log('\n════ 真值表（7 行） ════');
console.log('  #  infra hw  acc self  amount   期望  实际');
for (const row of TRUTH_TABLE) {
  const input = inp(row.i);
  const got = classifyProject(input).suggested;
  const line =
    `  ${row.n}    ${flag(input.isInfrastructure)}    ${flag(input.hasHardware)}   ` +
    `${flag(input.hasAcceptance)}   ${flag(input.isSelfIteration)}  ` +
    `${String(input.contractAmount).padStart(5)}     ${row.want}     ${got}`;
  console.log(line);
  check(
    `#${row.n} ${row.note}`,
    got === row.want,
    `期望 suggested="${row.want}"，实际="${got}"；输入=${JSON.stringify(input)}`,
  );
}

/* ═══════════════ 4. 附加 reasons 断言 ═══════════════ */

console.log('\n════ reasons 附加断言 ════');

// 4.1 #5：自研 + 大额 → B，且 reasons 含大额提示（不能静默吞掉金额信号）
{
  const r = classifyProject(inp({ isSelfIteration: true, contractAmount: 500 }));
  const needle = '提示：合同额 500 万元 ≥ 100 万';
  check(
    '#5 reasons 含「提示：合同额 500 万元 ≥ 100 万」',
    r.reasons.some((x) => x.includes(needle)),
    `未找到子串「${needle}」；实际 reasons=${JSON.stringify(r.reasons, null, 2)}`,
  );
}

// 4.2 #2 + 自研同勾 → 仍 A，且 reasons 说明 A 类优先
{
  const r = classifyProject(inp({ hasHardware: true, isSelfIteration: true, contractAmount: 500 }));
  check(
    '#2+自研 同勾 → suggested=A',
    r.suggested === 'A',
    `期望 "A"，实际="${r.suggested}"`,
  );
  check(
    '#2+自研 同勾 → reasons 含「A 类优先」',
    r.reasons.some((x) => x.includes('A 类优先')),
    `未找到子串「A 类优先」；实际 reasons=${JSON.stringify(r.reasons, null, 2)}`,
  );
}

// 4.3 #6：金额触发 A，但必须声明金额只是参考信号
{
  const r = classifyProject(inp({ contractAmount: 200 }));
  const needle = '金额为参考信号而非硬性规则';
  check(
    `#6 reasons 含「${needle}」`,
    r.reasons.some((x) => x.includes(needle)),
    `未找到子串「${needle}」；实际 reasons=${JSON.stringify(r.reasons, null, 2)}`,
  );
}

/* ═══════════════ 5. 边界 / 健壮性补充断言（QA 自加） ═══════════════ */

console.log('\n════ 边界补充断言（QA 自加） ════');

// 5.1 阈值边界：恰好等于 100 应触发大额（>= 而非 >）
check(
  '边界 amount=100（无特征）→ A（阈值取 >=）',
  classifyProject(inp({ contractAmount: 100 })).suggested === 'A',
  `实际="${classifyProject(inp({ contractAmount: 100 })).suggested}"`,
);
check(
  '边界 amount=99.99（无特征）→ B',
  classifyProject(inp({ contractAmount: 99.99 })).suggested === 'B',
  `实际="${classifyProject(inp({ contractAmount: 99.99 })).suggested}"`,
);

// 5.2 基建优先级压过一切
check(
  '基建 + 硬件 + 验收 + 自研 + 大额 → 仍 C',
  classifyProject(
    inp({
      isInfrastructure: true,
      hasHardware: true,
      hasAcceptance: true,
      isSelfIteration: true,
      contractAmount: 9999,
    }),
  ).suggested === 'C',
  '基建硬规则被其他特征覆盖',
);

// 5.3 交付特征 + 小额 → 仍 A（交付为硬规则，金额不降级）
check(
  '硬件交付 + amount=0 → 仍 A',
  classifyProject(inp({ hasHardware: true, contractAmount: 0 })).suggested === 'A',
  `实际="${classifyProject(inp({ hasHardware: true, contractAmount: 0 })).suggested}"`,
);

// 5.4 reasons 在任一路径内不得出现重复字符串
//     （ProjectCreatePage.tsx 第 544 行把 reason 拼进 React key，重复会触发 key 冲突告警）
{
  const paths = [
    inp({ isInfrastructure: true, hasHardware: true, isSelfIteration: true, contractAmount: 500 }),
    inp({ isInfrastructure: true, contractAmount: 0 }),
    inp({ hasHardware: true, hasAcceptance: true, isSelfIteration: true, contractAmount: 500 }),
    inp({ hasAcceptance: true, contractAmount: 0 }),
    inp({ isSelfIteration: true, contractAmount: 500 }),
    inp({ isSelfIteration: true, contractAmount: 50 }),
    inp({ contractAmount: 200 }),
    inp({ contractAmount: 0 }),
  ];
  let dupPath = null;
  for (const p of paths) {
    const rs = classifyProject(p).reasons;
    if (new Set(rs).size !== rs.length) {
      dupPath = p;
      break;
    }
  }
  check(
    'reasons 全路径无重复字符串（React key 安全）',
    dupPath === null,
    `存在重复 reason 的输入=${JSON.stringify(dupPath)}`,
  );
}

// 5.5 每条路径 reasons 均非空（UI 分类建议区不得空白）
{
  const empty = [
    inp({ isInfrastructure: true }),
    inp({ hasHardware: true }),
    inp({ isSelfIteration: true }),
    inp({ contractAmount: 200 }),
    inp({}),
  ].find((p) => classifyProject(p).reasons.length === 0);
  check('全部 5 条执行路径 reasons 均非空', empty === undefined, `空 reasons 输入=${JSON.stringify(empty)}`);
}

/* ═══════════════ 6. 汇总 ═══════════════ */

const total = passed + failures.length;
console.log('\n════════════════════════════════════');
console.log(`总计 ${total} 条断言 · 通过 ${passed} · 失败 ${failures.length}`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}\n     ${f.detail}`));
  console.log('\n结果：FAIL');
  process.exit(1);
}
console.log('结果：ALL PASS');
process.exit(0);
