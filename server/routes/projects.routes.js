/**
 * 项目主链路路由（P0-01 ~ P0-04 / P0-07）
 *
 * ⚠ **注册顺序硬约束**（§3.4）：静态段必须早于 `:id` 段，否则 `classify` 会被当成项目 id。
 *   POST /api/projects/classify        ← 必须早于 GET /api/projects/:id
 *
 * 本文件只放**批次 1 已实现**的接口；未实现域（WBS / 看板 / 周报 / 评审 / 变更 / 审计 /
 * 风险 / 文档 / close-check）集中在 `stubs.routes.js` 降级返回。
 *
 * 路由风格（§3.4）：
 *  - 按项目查询 / 创建 → 嵌套式 `/api/projects/:projectId/<sub>`
 *  - 已知 id 的单实体   → 顶层 `/api/<resource>/:id`
 *  - 全站禁用 PUT，改动一律 PATCH
 */

const express = require('express');

const db = require('../../db');
const { ok, asyncHandler, AppError, ErrorCode } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const projectService = require('../services/project.service');
const classifyService = require('../services/classify.service');
const memberService = require('../services/member.service');
const boardService = require('../services/board.service');
const projectFlowService = require('../services/project-flow.service');

const router = express.Router();

/* ── 静态段（必须早于 /:id） ─────────────────────────── */

/** P0-01 分类判定（纯计算，不落库） */
router.post(
  '/projects/classify',
  requireAuth,
  asyncHandler(async function classify(req, res) {
    res.json(ok(classifyService.classifyProject(req.body)));
  }),
);

/* ── 项目集合 ───────────────────────────────────────── */

/** P0-03 项目列表（**唯一分页接口之一**，返回 Paged<ProjectListItem>） */
router.get(
  '/projects',
  requireAuth,
  asyncHandler(async function listProjects(req, res) {
    const q = req.query || {};
    res.json(
      ok(
        projectService.listProjects(
          db,
          {
            keyword: q.keyword,
            type: q.type,
            status: q.status,
            health: q.health,
            pm: q.pm,
            onlyMine: q.onlyMine === 'true' || q.onlyMine === '1' || q.onlyMine === true,
            page: q.page,
            pageSize: q.pageSize,
          },
          req.user,
        ),
      ),
    );
  }),
);

/** P0-02 新建项目（事务：1 项目 + N 成员 + N 里程碑 [+ M 门 + K 检查项]） */
router.post(
  '/projects',
  requireAuth,
  asyncHandler(async function createProject(req, res) {
    res.json(ok(projectService.createProject(db, req.body, req.user), '项目创建成功'));
  }),
);

/* ── 项目子资源（嵌套式，静态段在 /:id 之前注册） ─────── */

/** 项目成员列表 */
router.get(
  '/projects/:projectId/members',
  requireAuth,
  asyncHandler(async function listMembers(req, res) {
    res.json(ok(projectService.listMembers(db, req.params.projectId)));
  }),
);

/** 添加项目成员（pm / tl 唯一性由 `assertRoleUnique` 守卫） */
router.post(
  '/projects/:projectId/members',
  requireAuth,
  asyncHandler(async function addMember(req, res) {
    const body = req.body || {};
    res.json(ok(memberService.addMember(db, req, req.params.projectId, body), '成员已添加'));
  }),
);

/** 移除项目成员（pm / tl 为必备角色，禁止移除） */
router.delete(
  '/projects/:projectId/members/:memberId',
  requireAuth,
  asyncHandler(async function removeMember(req, res) {
    res.json(ok(memberService.removeMember(db, req, req.params.projectId, req.params.memberId), '成员已移除'));
  }),
);

/** P0-07 里程碑时间轴（一次带出门 + 检查项 + 关联任务统计） */
router.get(
  '/projects/:projectId/milestones',
  requireAuth,
  asyncHandler(async function listMilestones(req, res) {
    res.json(ok(projectService.listMilestones(db, req.params.projectId)));
  }),
);

/**
 * 看板视图（四列 + WIP 限制）。
 *
 * 路由归属决策：`/projects/:id/board*` 与 `/projects/:id/members`、`/projects/:id/milestones`
 * 同域，故挂在本文件；`/wbs/*` 全部在 `wbs.routes.js`，避免两个文件争抢 `/projects/:id/*` 前缀。
 */
router.get(
  '/projects/:projectId/board',
  requireAuth,
  asyncHandler(async function getBoard(req, res) {
    res.json(ok(boardService.getBoard(db, req.params.projectId)));
  }),
);

/** 看板配置（WIP 上限）；返回 `BoardConfig`，不是 `BoardView` */
router.patch(
  '/projects/:projectId/board-config',
  requireAuth,
  asyncHandler(async function updateBoardConfig(req, res) {
    const body = req.body || {};
    res.json(ok(boardService.updateBoardConfig(db, req, req.params.projectId, body.wipLimits), '看板配置已更新'));
  }),
);

/** P0-17 项目状态机流转（B10 真实实现，替代 stubs 桩） */
router.post(
  '/projects/:id/transition',
  requireAuth,
  asyncHandler(async function transitionProject(req, res) {
    const body = req.body || {};
    const project = projectFlowService.transitionProject(db, req, req.params.id, body.to, body.comment);
    res.json(ok(project, '项目状态已更新'));
  }),
);

/** P0-17 结项前置检查（B10 真实实现：未过门 / 未达成碑 / 审批中评审 / 未关闭变更） */
router.get(
  '/projects/:projectId/close-check',
  requireAuth,
  asyncHandler(async function closeCheck(req, res) {
    rbac.loadProject(db, req.params.projectId);
    res.json(ok(projectFlowService.checkClose(db, req.params.projectId)));
  }),
);

/* ── 单实体（放最后，避免吞掉静态段） ─────────────────── */

/** P0-04 项目详情 */
router.get(
  '/projects/:id',
  requireAuth,
  asyncHandler(async function getProject(req, res) {
    res.json(ok(projectService.getProject(db, req.params.id)));
  }),
);

/**
 * 项目基本信息编辑（E1：管理员/项目负责人可改类型、成员等必要信息）。
 *
 * 仅更新基础字段（code/name/type/customer/contractAmount/background/goal/planStart/planEnd），
 * 不动状态机与审批链（流转走 `POST /projects/:id/transition`）。
 */
router.patch(
  '/projects/:id',
  requireAuth,
  asyncHandler(async function updateProject(req, res) {
    const updated = projectService.updateProjectBasic(db, req, req.params.id, req.body || {});
    res.json(ok(updated, '项目信息已更新'));
  }),
);

module.exports = router;
