#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞书多维表格 -> pm.db 真实落库（方案A：整体替换导入相关表，保留系统账号与配置）
阶段由 MODE 控制：MODE=clear 仅清空并报告；MODE=import 执行插入；MODE=all 全做
"""
import sqlite3, csv, os, sys, json, datetime

PMDB = r"C:\Users\xuwen\WorkBuddy\AstrBytes\pm-app\pm.db"
CSV_DIR = r"C:\Users\xuwen\WorkBuddy\AstrBytes\pm-app\.cache\feishu_import\csv"
MODE = os.environ.get("MODE", "all")

def ck(path):
    return os.path.join(CSV_DIR, path)

def now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def week_of(date_str):
    """从日期算 ISO 周次 YYYY-Www"""
    if not date_str:
        return "", "", ""
    try:
        d = datetime.datetime.fromisoformat(date_str.replace("Z", "+00:00")).date()
    except Exception:
        return "", "", ""
    isocal = d.isocalendar()
    week = f"{isocal[0]}-W{isocal[1]:02d}"
    # 周一~周日
    mon = d - datetime.timedelta(days=d.weekday())
    sun = mon + datetime.timedelta(days=6)
    return week, mon.isoformat(), sun.isoformat()

con = sqlite3.connect(PMDB)
con.execute("PRAGMA foreign_keys=OFF")
cur = con.cursor()

# ---------- 阶段1：清空 ----------
# ⚠ 飞书源当前只有 users/projects/project_members/tasks/work_reports 五类 CSV，
# 没有里程碑(milestones)/质量门(quality_gates)/WBS(wbs_nodes) 的导出。
# 若在 CLEAR_TABLES 里包含这三张表，每次导入都会把它们清空且无法补回，
# 导致项目概览的"质量门设置"入口因无里程碑可挂而消失（2026-08-22 已踩坑）。
# 因此从清空列表移除，保留用户在 UI 手工设置的里程碑/门/WBS，不被导入冲掉。
CLEAR_TABLES = [
    "project_members", "project_documents", "work_reports", "tasks", "progress_snapshots",
    "changes", "reviews", "review_approvals", "gate_checklist_items",
    "review_steps", "audit_logs", "projects",
]
if MODE in ("clear", "all"):
    print("=== 清空阶段 ===")
    for t in CLEAR_TABLES:
        try:
            cur.execute(f'DELETE FROM "{t}"')
            print(f"  清空 {t}: 删 {cur.rowcount} 行")
        except Exception as e:
            print(f"  清空 {t}: 跳过 {e}")
    con.commit()
    print("  清空完成，已提交\n")

# ---------- 阶段2：插入 ----------
if MODE in ("import", "all"):
    print("=== 插入阶段 ===")
    # 2.1 users 占位（增量，跳过已存在 open_id）
    with open(ck("01_users_占位账号.csv"), encoding="utf-8-sig") as f:
        users = list(csv.DictReader(f))
    u_ins = 0
    for u in users:
        cur.execute("SELECT 1 FROM users WHERE open_id=?", (u["open_id"],))
        if cur.fetchone():
            continue
        cur.execute(
            "INSERT INTO users(open_id,employee_id,name,email,dept,global_role,status,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (u["open_id"], u["employee_id"] or None, u["name"], u["email"] or None,
             u["dept"] or None, u["global_role"], u["status"], now(), now()))
        u_ins += 1
    print(f"  users 新增: {u_ins} 条")

    # 2.2 projects
    with open(ck("02_projects.csv"), encoding="utf-8-sig") as f:
        projects = list(csv.DictReader(f))
    # 飞书 project_id(新) -> 系统 id；pm.db projects.id 用飞书新id直接落（TEXT主键）
    proj_sysid = {}
    for p in projects:
        sysid = p["project_id(新)"]
        proj_sysid[p["project_id(新)"]] = sysid
        goal_txt = p["目标"] or ""
        goal_json = json.dumps([goal_txt], ensure_ascii=False) if goal_txt else "[]"
        status_map = {"推进中": "进行中", "已完成": "已批准", "已批准": "已批准"}
        st = status_map.get(p["状态"], "进行中")
        cur.execute(
            "INSERT INTO projects(id,code,name,type,goal,status,health,contract_amount,approval_step,plan_end,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (sysid, sysid.upper(), p["项目名称"], "B", goal_json, st, "green", 0, -1,
             p["项目截止时间"] or None, now(), now()))
    print(f"  projects 插入: {len(projects)} 条")

    # 兜底项目：收纳飞书源无所属项目的周报
    UNLINKED = "proj_unlinked"
    cur.execute("SELECT 1 FROM projects WHERE id=?", (UNLINKED,))
    if not cur.fetchone():
        cur.execute(
            "INSERT INTO projects(id,code,name,type,goal,status,health,contract_amount,approval_step,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (UNLINKED, "PROJ_UNLINKED", "未关联项目（飞书源周报未挂项目）", "B",
             "[]", "进行中", "green", 0, -1, now(), now()))
        print(f"  兜底项目 {UNLINKED} 已建")

    # 2.3 project_members（总负责人 + 飞书成员字段）
    # 飞书 projects 有"成员"文本字段（空格分隔姓名），但无 open_id；只可靠加总负责人
    pm_ins = 0
    for p in projects:
        pid = proj_sysid[p["project_id(新)"]]
        oid = p["总负责人_open_id"]
        if oid:
            cur.execute(
                "INSERT INTO project_members(id,project_id,user_open_id,project_role,assigned_by,assigned_at) "
                "VALUES(?,?,?,?,?,?)",
                ("pm_" + pid + "_" + oid[-8:], pid, oid, "pm", oid, now()))
            pm_ins += 1
    print(f"  project_members 插入(总负责人): {pm_ins} 条")

    # 2.4 tasks（平级落，parent 信息保留；字段适配）
    with open(ck("03_tasks.csv"), encoding="utf-8-sig") as f:
        tasks = list(csv.DictReader(f))
    t_ins = 0
    for t in tasks:
        sys_pid = proj_sysid.get(t["project_id"])
        if not sys_pid:
            continue
        owner = t["执行人_open_id"] or None
        cur.execute(
            "INSERT INTO tasks(id,project_id,ms_id,code,owner,est,start,due,status,progress,created_at,name) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (t["task_id(新)"], sys_pid, None, t["task_id(新)"].upper(), owner,
             t["实际完成时间"] or None, t["开始时间"] or None, t["截止时间"] or None,
             t["状态"] or "待办", 0, now(), t["任务名"]))
        t_ins += 1
    print(f"  tasks 插入: {t_ins} 条")

    # 2.5 work_reports（字段适配）
    with open(ck("04_work_reports.csv"), encoding="utf-8-sig") as f:
        reports = list(csv.DictReader(f))
    r_ins = 0
    for r in reports:
        sys_pid = proj_sysid.get(r["project_id"]) or UNLINKED
        week, ws, we = week_of(r["日期"])
        plan = r["下周工作计划"]
        plan_json = json.dumps([plan], ensure_ascii=False) if plan else "[]"
        cur.execute(
            "INSERT INTO work_reports(id,project_id,week,week_start,week_end,author_open_id,author_name,status,done_note,plan_items,resource_note,submitted_at,created_at,updated_at,confirmed_by,confirmed_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (r["report_id(新)"], sys_pid, week or "", ws, we, r["汇报人_open_id"], r["汇报人_姓名"] or "",
             "已提交", r["进度内容"] or "", plan_json, r["当前风险与卡点"] or "",
             r["日期"] or None, now(), now(), None, None))
        r_ins += 1
    print(f"  work_reports 插入: {r_ins} 条")

    con.commit()
    print("  插入完成，已提交")

# ---------- 校验 ----------
print("\n=== 落库后校验 ===")
for t in ["users", "projects", "project_members", "tasks", "work_reports"]:
    cur.execute(f'SELECT COUNT(*) FROM "{t}"')
    print(f"  {t}: {cur.fetchone()[0]} 行")
con.close()
print("DONE")
