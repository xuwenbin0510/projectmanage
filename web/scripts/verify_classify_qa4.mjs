/**
 * verify_classify_qa4.mjs —— 项目分类规则真值表回归脚本（QA-4 严过关 独立验证，非产品代码）
 *
 * 注：`scripts/verify_classify.mjs` 为多名 QA 共用路径、存在互相覆盖，
 *     本文件为 QA-4 的独立留档版本，内容与结论以本文件为准。
 *
 * 背景：src/api/mock/rules.ts 使用 TS 路径别名（@/...），node 无法直接导入。
 * 做法：把 classifyProject 的**当前源码逻辑逐字抄录**到本脚本（仅去掉 TS 类型标注、
 *       把 CLASSIFY_AMOUNT_THRESHOLD 内联为 100），字符串模板与中文文案一字不改，
 *       从而保证测的就是真实代码路径。
 *
 * 逐字比对基线：src/api/mock/rules.ts  L43-L110（classifyProject）
 *               src/config/enums.ts    L239（CLASSIFY_AMOUNT_THRESHOLD = 100）
 * 一致性证明（可复现）：
 *   sed -n '43,110p' src/api/mock/rules.ts > /tmp/a.txt
 *   awk '/^function classifyProject\(input\) \{/,/^\}$/' scripts/verify_classify_qa4.mjs > /tmp/b.txt
 *   diff /tmp/a.txt /tmp/b.txt   # 68 行中仅 2 行不同，且均为纯 TS 类型标注删除
 *
 * 运行：node scripts/verify_classify_qa4.mjs      （退出码 0 = 全部通过，1 = 有失败）
 */

/* ═══════════════════════════════════════════════════
 * 【SUT】以下为 rules.ts classifyProject 的逐字抄录
 * ═══════════════════════════════════════════════════ */

const CLASSIFY_AMOUNT_THRESHOLD = 100; // 内联自 config/enums.ts L239

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

/* ═══════════════════════════════════════════════════
 * 【测试框架】极简断言
 * ═══════════════════════════════════════════════════ */

let pass = 0;
const failures = [];

function record(ok, title, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${title}`);
  } else {
    failures.push({ title, detail });
    console.log(`  FAIL  ${title}`);
    console.log(`        ${detail}`);
  }
}

function inp(o) {
  return {
    contractAmount: o.amount,
    hasHardware: !!o.hw,
    hasAcceptance: !!o.acc,
    isSelfIteration: !!o.self,
    isInfrastructure: !!o.infra,
  };
}

/* ═══════════════════════════════════════════════════
 * 【用例 1】7 行真值表 —— 断言 suggested
 * ═══════════════════════════════════════════════════ */

const TRUTH_TABLE = [
  { n: 1, infra: true, hw: false, acc: false, self: false, amount: 500, want: 'C', note: '基建最高优先' },
  { n: 2, infra: false, hw: true, acc: false, self: false, amount: 500, want: 'A', note: '硬件交付' },
  { n: 3, infra: false, hw: false, acc: true, self: false, amount: 50, want: 'A', note: '客户验收' },
  { n: 4, infra: false, hw: false, acc: false, self: true, amount: 50, want: 'B', note: '自研小额' },
  { n: 5, infra: false, hw: false, acc: false, self: true, amount: 500, want: 'B', note: '★核心修正：自研+大额，旧实现误判 A' },
  { n: 6, infra: false, hw: false, acc: false, self: false, amount: 200, want: 'A', note: '无特征+大额→参考建议 A' },
  { n: 7, infra: false, hw: false, acc: false, self: false, amount: 0, want: 'B', note: '无特征+零额→默认 B' },
];

console.log('\n【真值表】classifyProject 7 行 suggested 断言');
console.log('─'.repeat(78));
console.log(' #  infra  hw   acc  self  amount   期望  实际  结果');

const results = {};
for (const row of TRUTH_TABLE) {
  const got = classifyProject(inp(row));
  results[row.n] = got;
  const ok = got.suggested === row.want;
  const b = (v) => (v ? ' T ' : ' F ');
  console.log(
    ` ${String(row.n).padEnd(2)} ${b(row.infra)}   ${b(row.hw)} ${b(row.acc)} ${b(row.self)}  ` +
      `${String(row.amount).padStart(5)}    ${row.want}     ${got.suggested}    ${ok ? 'PASS' : 'FAIL'}   ${row.note}`,
  );
  record(
    ok,
    `#${row.n} suggested === '${row.want}'`,
    `期望 '${row.want}'，实际 '${got.suggested}'；reasons=${JSON.stringify(got.reasons, null, 2)}`,
  );
}

/* ═══════════════════════════════════════════════════
 * 【用例 2】reasons 文案断言
 * ═══════════════════════════════════════════════════ */

console.log('\n【reasons 文案】');
console.log('─'.repeat(78));

function assertReason(caseName, res, needle) {
  const hit = res.reasons.some((r) => r.includes(needle));
  record(
    hit,
    `${caseName} reasons 含「${needle}」`,
    `未命中。实际 reasons = ${JSON.stringify(res.reasons, null, 2)}`,
  );
}

// 2.1 #5 必须给出金额提示（B 类但提醒大额）
assertReason('#5(自研+500万→B)', results[5], '提示：合同额 500 万元 ≥ 100 万');

// 2.2 #2 变体：硬件 + 自研同勾 → A 类优先
const case2self = classifyProject(inp({ infra: false, hw: true, acc: false, self: true, amount: 500 }));
record(
  case2self.suggested === 'A',
  `#2+自研同勾 suggested === 'A'`,
  `期望 'A'，实际 '${case2self.suggested}'；reasons=${JSON.stringify(case2self.reasons, null, 2)}`,
);
assertReason('#2+自研同勾', case2self, 'A 类优先');

// 2.3 #6 金额为参考信号而非硬性规则
assertReason('#6(无特征+200万→A)', results[6], '金额为参考信号而非硬性规则');

/* ═══════════════════════════════════════════════════
 * 【用例 3】边界与不变量（QA-4 补充加固）
 * ═══════════════════════════════════════════════════ */

console.log('\n【边界 / 不变量】');
console.log('─'.repeat(78));

// 3.1 阈值边界：amount === 100 应视为「大额」（>= 语义）
const at100 = classifyProject(inp({ infra: false, hw: false, acc: false, self: false, amount: 100 }));
record(at100.suggested === 'A', `阈值边界 amount=100（>=100 视为大额）→ 'A'`, `实际 '${at100.suggested}'`);
const at99 = classifyProject(inp({ infra: false, hw: false, acc: false, self: false, amount: 99 }));
record(at99.suggested === 'B', `阈值边界 amount=99（<100）→ 'B'`, `实际 '${at99.suggested}'`);

// 3.2 reasons 在任一执行路径内不得重复（rules.ts 注释声明的不变量：曾被用作 React key）
const ALL_COMBOS = [];
for (const infra of [false, true])
  for (const hw of [false, true])
    for (const acc of [false, true])
      for (const self of [false, true])
        for (const amount of [0, 50, 99, 100, 200, 500]) ALL_COMBOS.push({ infra, hw, acc, self, amount });

const dupCases = [];
for (const c of ALL_COMBOS) {
  const r = classifyProject(inp(c)).reasons;
  if (new Set(r).size !== r.length) dupCases.push(c);
}
record(
  dupCases.length === 0,
  `全组合(${ALL_COMBOS.length} 例) reasons 无重复字符串`,
  `${dupCases.length} 例出现重复：${JSON.stringify(dupCases.slice(0, 3))}`,
);

// 3.3 全组合下 suggested 必为 A/B/C 之一，且 reasons 非空
const badShape = ALL_COMBOS.filter((c) => {
  const r = classifyProject(inp(c));
  return !['A', 'B', 'C'].includes(r.suggested) || !Array.isArray(r.reasons) || r.reasons.length === 0;
});
record(badShape.length === 0, `全组合返回结构合法（suggested ∈ {A,B,C} 且 reasons 非空）`, `异常 ${badShape.length} 例`);

// 3.4 优先级链不变量：isInfrastructure=true 时恒为 C（不受任何其他输入影响）
const infraNotC = ALL_COMBOS.filter((c) => c.infra && classifyProject(inp(c)).suggested !== 'C');
record(infraNotC.length === 0, `不变量：isInfrastructure=true 恒判 C（${ALL_COMBOS.length / 2} 例）`, `违例 ${infraNotC.length} 例`);

// 3.5 优先级链不变量：非基建 + (硬件|验收) 恒为 A
const delivNotA = ALL_COMBOS.filter(
  (c) => !c.infra && (c.hw || c.acc) && classifyProject(inp(c)).suggested !== 'A',
);
record(delivNotA.length === 0, `不变量：非基建 + (硬件|验收) 恒判 A`, `违例 ${delivNotA.length} 例`);

// 3.6 ★回归核心：非基建 + 无交付 + 自研 → 恒为 B（金额不得再翻转为 A）
const selfNotB = ALL_COMBOS.filter(
  (c) => !c.infra && !c.hw && !c.acc && c.self && classifyProject(inp(c)).suggested !== 'B',
);
record(
  selfNotB.length === 0,
  `★不变量：纯自研恒判 B，金额不翻转（覆盖 0/50/99/100/200/500 万）`,
  `违例 ${selfNotB.length} 例：${JSON.stringify(selfNotB)}`,
);

/* ═══════════════════════════════════════════════════
 * 汇总
 * ═══════════════════════════════════════════════════ */

console.log('\n' + '═'.repeat(78));
console.log(`总计 ${pass + failures.length} 项断言 · 通过 ${pass} · 失败 ${failures.length}`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.title}\n     ${f.detail}`));
  console.log('\n结论：FAIL —— 分类规则与预期不符，需路由至 Engineer 修复。');
  process.exit(1);
}
console.log('结论：PASS —— classifyProject 全部断言通过。');
process.exit(0);
