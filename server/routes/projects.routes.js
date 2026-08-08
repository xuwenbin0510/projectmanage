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
const projectService = require('../services/project.service');
const classifyService = require('../services/classify.service');

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

/** P0-07 里程碑时间轴（一次带出门 + 检查项 + 关联任务统计） */
router.get(
  '/projects/:projectId/milestones',
  requireAuth,
  asyncHandler(async function listMilestones(req, res) {
    res.json(ok(projectService.listMilestones(db, req.params.projectId)));
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
 * 项目基本信息编辑。
 * 批次 1 暂不开放（编辑要连带审计 + 归档态拦截），显式 501 而不是静默 404。
 */
router.patch(
  '/projects/:id',
  requireAuth,
  asyncHandler(async function updateProject(req) {
    // TODO(批次3): 落地 updateProject（含 E_PROJECT_ARCHIVED 拦截与 audit diff）
    projectService.requireProjectRow(db, req.params.id);
    throw new AppError(ErrorCode.E_NOT_IMPLEMENTED, '项目编辑功能尚未上线', { route: 'PATCH /api/projects/:id' });
  }),
);

module.exports = router;
