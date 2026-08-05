# QA 回归验证报告 — 项目创建四改动（A / B / C / D）+ 改动 B 下游修复

- **验证层级**：独立第二层（主理人齐活林接管；QA 多实例派发出现重复/失效，工具链直验 + 工程师修复后复验）
- **最终结论**：✅ **IS_PASS: YES**（改动 B 下游 2 处 P1 已修复并复验通过）
- **日期**：2026-08-05

---

##  Phase 1 — 四改动主体（分类 / 接线 / 三态）

### 1.1 分类优先级链真值表（`rules.ts:43-110`）
esbuild 打包真实 `rules.ts` 后 node 实跑 **48 组合**（2^4 特征 × 0/100/200 万金额）：
```json
{ "total": 48, "dupPaths": 0, "mismatchCount": 0 }
```
- `mismatchCount:0` — 48 组合与优先级链（C→A→B→金额参考→默认B）完全一致。
- `dupPaths:0` — 任一路径内 `reasons[]` 无重复串（直接作 React key，安全）。
- QA 另做 **64 组合穷举**（4 布尔 × 0/99/100/1e9）交叉比对：优先级链不符 0 处、reasons 重复 0 处、无空串；阈值 `>=100` 边界正确（99→B，100→A）。✅

### 1.2 接线核查（file:line）
| 改动 | 证据 | 状态 |
|------|------|------|
| A 合同额受控输入 | `ProjectCreatePage.tsx:448` `value={form.contractAmount \|\| ''}`；`:449` `Number(e.target.value)\|\|0`；`:452` helperText | ✅ |
| B&C 一人多角色复合键 | `:271/:305` 去重集 `${userOpenId}::${role}`；`:308/:316` 组合挑选；`:604` 行 key `${userOpenId}::${role}::${i}`；`:827` chip key `${userOpenId}-${m.role}` | ✅ |
| 里程碑第4步 | `:663` `renderMilestones()`；`:862` 调用 | ✅ |
| D 分类阈值 | `enums.ts:239` `CLASSIFY_AMOUNT_THRESHOLD=100`；`rules.ts:19/:43-110`；`:452` 文案 | ✅ |

### 1.3 里程碑三态语义（`mock/index.ts:539-608`）
`drafts = payload.milestones`（无归一）；`=== undefined`→模板；`else`→`drafts.forEach`（`[]` 遍历 0 次=显式清空）。无 `[]`→`undefined` 归一。E2E 实测 `[]` 落库 0 条且不回退模板。✅

**Phase 1 结论：四改动主体 PASS。**

---

##  Phase 2 — 改动 B 下游回归（QA 深 E2E 发现 P1 → 工程师修复 → 主理人复验）

QA（software-qa-engineer-3）33 项 E2E 断言全 PASS 后，识别出**改动 B 漏了 2 处下游「选人」下拉**，且正好在「一人多角色」演示路径上必现 → 初判 `IS_PASS: NO → Engineer`。

**根因**：改动 B 把成员唯一键从「人」改为「人+角色」（`db.members` 一行=一人一角色），但两个下拉仍按「一行=一人」渲染。

### 2.1 修复清单（工程师寇豆码，IS_PASS: YES）
| # | 文件:行 | 问题 | 修复 | 复验 |
|---|--------|------|------|------|
| P1-1 | `ReportsPage.tsx:99-102` + `:300` | 风险责任人下拉 `key/value={m.userOpenId}` 重复（同一人显示 3 次） | 新增 `ownerOptions` 按 `userOpenId` 去重后渲染 | ✅ 主理人读源码确认 |
| P1-2 | `WbsPage.tsx:91-99` | 任务负责人 `memberOptions` 未去重 → MUI Select 重复 value 同时命中多项 | `useMemo` 内先 `Map` 去重再 map | ✅ 读源码确认 |
| P2-2 | `ProjectCreatePage.tsx:212-217` | `msLoading` 泄漏：模板请求在途时 effect 早退 + cleanup 置 `alive=false` → `.finally` 的 `if(alive)` 不触发 → spinner 永久卡 + «重置为模板» 永久置灰 | `.finally` 无条件 `setMsLoading(false)`（保留 `then/catch` 的 `alive` 守卫） | ✅ 读源码确认 |
| P2-1 | `ProjectOverviewPage.tsx:472` | 「X 人」统计角色行数，一人兼三职显示「3 人」 | 改 `new Set(members.map(m=>m.userOpenId)).size` | ✅ 读源码确认 |

> P2-3（回跳步骤「最晚优先」潜伏项）：工程师评估当前累积式门禁下实际不可达、改动 A/C 交界有风险，**本轮不改**，留作独立清理项。

### 2.2 复验（主理人独立）
- 4 处编辑逐行读源码确认逻辑正确（见上表「复验」列）。
- `tsc --noEmit` → **EXIT 0**；`vite build` → **✓ 1535 modules / 4.81s / BUILD_EXIT=0**。
- 工程师 grep 全 `src/pages/projects`：除本次 4 处外无其他未去重「选人」下拉（QA 锁定的 2 处即为全部）。

**Phase 2 结论：IS_PASS: YES（改动 B 下游回归闭环，未引入 D / 里程碑 / A / C 回归）。**

---

##  Phase 3 — 质量门汇总
| 门 | Phase1 | Phase2 复验 |
|----|--------|------------|
| `tsc --noEmit` | 0 error | 0 error（EXIT 0） |
| `vite build` | 1535 模块通过 | 1535 模块 / 4.81s 通过 |
| 分类 48/64 组合 | 0 mismatch / 0 dup | 同左（未动 D） |
| 里程碑三态 | 全链路无损 | 同左（未动） |

---

## 遗留 / 非阻塞
1. **历史数据不回溯**：旧「金额≥100万→A」退化为「仅四项特征全空时生效」；已建项目类型/阶段不变。发版说明需向 PM 交代。
2. **制度 V1.0 飞书文档**仍为旧文案（「合同额>100万→A」），代码已同步修订；需 PM 贴入修订文案或由主理人代改（待授权）。
3. **P2-3** 回跳步骤「最早优先」潜伏项：当前不可达，留作独立清理。
4. **报告位置**：本文件为唯一真源（`pm-app/docs/`）。QA 曾误写一份到仓库外的 `AstrBytes/docs/qa_regression_report.md`，已删除避免混淆。

## 验证方法（可复现）
- 分类：esbuild 打包 `web/.qa_classify_scan.ts`（import 真实 `@/api/mock/rules`，`--alias:@=./src`，esbuild 在 `web/node_modules/.bin`）→ node 实跑 48 组合。脚本与产物验证后清除，未污染仓库。
- 下游下拉：源码静态核查 `Map(...).values()` 去重 + 构建门确认。
