/**
 * 变更单路由（D08 · 打通变更流程，替换 stubs 桩）
 *
 * 对齐 `web/src/api/contract.ts` ChangeApi：
 *  - POST   /changes/route                      路由判定预判
 *  - GET    /projects/:projectId/changes        项目变更单列表
 *  - GET    /changes/:id                        详情
 *  - POST   /projects/:projectId/changes        创建（草稿）
 *  - POST   /changes/:id/submit                 提交审批（ccb / pm_only → review 引擎）
 *  - POST   /changes/:id/apply                  实施（milestone_date → 改期生效）
 */

const { Router } = require('express');
const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const changeService = require('../services/change.service');

const router = Router();

/** 路由判定预判（实时提示审批链） */
router.post(
  '/changes/route',
  requireAuth,
  asyncHandler(async function routeChange(req, res) {
    res.json(ok(changeService.routeChange(db, req.body || {})));
  }),
);

/** 项目变更单列表 */
router.get(
  '/projects/:projectId/changes',
  requireAuth,
  asyncHandler(async function listChanges(req, res) {
    res.json(ok(changeService.listChanges(db, req.params.projectId)));
  }),
);

/** 变更单详情 */
router.get(
  '/changes/:id',
  requireAuth,
  asyncHandler(async function getChange(req, res) {
    res.json(ok(changeService.getChange(db, req.params.id)));
  }),
);

/** 创建变更单（草稿） */
router.post(
  '/projects/:projectId/changes',
  requireAuth,
  asyncHandler(async function createChange(req, res) {
    res.json(ok(changeService.createChange(db, req, req.params.projectId, req.body || {}), '变更单已创建'));
  }),
);

/** 提交审批 */
router.post(
  '/changes/:id/submit',
  requireAuth,
  asyncHandler(async function submitChange(req, res) {
    res.json(ok(changeService.submitChange(db, req, req.params.id), '变更已提交审批'));
  }),
);

/** 实施变更 */
router.post(
  '/changes/:id/apply',
  requireAuth,
  asyncHandler(async function applyChange(req, res) {
    res.json(ok(changeService.applyChange(db, req, req.params.id), '变更已实施'));
  }),
);

module.exports = router;
