# 诊断报告：项目概览"质量门设置"消失

> 时间：2026-08-22
> 结论：**代码未被覆盖，是数据层问题**——`milestones` 表被飞书导入脚本清空且未重建，导致质量门无可挂载对象，UI 入口随之隐藏。

## 一、现象
项目概览页中，原可"设置质量门"的入口消失；质量门卡片只剩空态文案。

## 二、排查结论（逐层验证）

### 1. 前端代码完好（未被覆盖）
`web/src/pages/projects/ProjectOverviewPage.tsx` 中质量门相关逻辑完整存在：
- `openSetGate` / `submitSetGate`（第 217–270 行）：给无门里程碑设置质量门
- "设置质量门"按钮（第 533–538 行）
- 编辑/删除门、检查项增删改（D05/D06/D07 全在）
- 后端接口 `POST /api/projects/:projectId/milestones/:milestoneId/gate`（`server/routes/milestones.routes.js` 第 111 行）存在，`api.setMilestoneGate` 对应

### 2. 按钮的显示条件
"设置质量门"按钮仅当 **`canEditGate && activeMs && !activeMs.done`** 才渲染：
- `canEditGate = can('milestone:edit') && !archived` —— `xuwenbin` 为 admin，恒 true，权限不是原因
- `activeMs` 来自 `milestones` store；**里程碑为空 → activeMs 为空 → 按钮不渲染**

### 3. 根因：milestones 表为空
当前 `pm.db`：
- `projects = 10`，`milestones = 0`，`quality_gates = 0`
- 飞书导入脚本 `load_db.py`：**清空列表 CLEAR_TABLES 含 `milestones`（第 39 行）**，但插入阶段只写了 users/projects/project_members/tasks/work_reports，**完全没有 milestones / quality_gates / wbs_nodes 的 INSERT 语句**（第 56–155 行）。

→ 每次执行 `load_db.py` 都会 `DELETE FROM milestones` 且不补回，里程碑永久归零。

### 4. 数据演变佐证
- `pm.db.bak-20260809`：milestones 246 / gates 63 / projects 100（最早全量）
- `pm.db.bak_20260821_224117`（8/21 22:41）：milestones 74 / gates 13 / projects 20
- 当前 `pm.db`（8/21 22:43）：milestones 0 / projects 10
- 两库项目 id **完全不重叠**（当前 10 个真实项目 vs 备份含 B3 冒烟测试项目）→ 备份不可直接整体覆盖

## 三、因果链
1. 早期库有里程碑+门，"设置质量门"可用；
2. 执行 `load_db.py`（飞书周报/任务导入）→ 清空 milestones 且不重建 → 里程碑归零；
3. 概览页无里程碑可渲染 → 质量门入口消失。

## 四、恢复 / 修复路径（待确认）

### 方案 A：修复导入脚本，补回 milestones + quality_gates + wbs_nodes 的写入
- 改动 `load_db.py`：插入阶段增加从飞书 CSV（里程碑表、质量门表）读取并写入
- 前提：需有里程碑/质量门对应的飞书源 CSV（目前 `03_tasks.csv` 存在，但无里程碑/门 CSV）
- 适合：希望用飞书单一数据源重建

### 方案 B：从备份恢复里程碑+门到当前库（按项目名匹配）
- 当前 10 个真实项目与备份项目 id 不重叠，需按 **项目名称** 做映射，把备份中同项目的 milestones/quality_gates/gate_checklist_items 迁移到当前库对应 project_id
- 风险：若备份中无对应真实项目（如"太空数舱案例定义和试验设计"），则无法迁移
- 适合：仅个别项目需要恢复门

### 方案 C：手动在 UI 重新设置
- 当前库 projects 完好，"设置质量门"逻辑可用；对每个需要门的里程碑，在概览页点"设置质量门"即可（从模板门库或空白新建）
- 适合：项目少、门少、可接受手工

## 五、建议
- 立即**修复 `load_db.py` 的清空/重建不对称缺陷**（至少把 milestones/quality_gates 从 CLEAR_TABLES 移出，或补 INSERT），否则下次导入会再次清空门。
- 恢复数据优先方案 B（按项目名迁移），失败项走方案 C 手工补。
