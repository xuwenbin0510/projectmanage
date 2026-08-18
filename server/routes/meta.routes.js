/**
 * 元数据路由
 *
 *  GET /api/meta                  → MetaData {templates, reviewTemplates, wipDefault}
 *  GET /api/meta/templates/:type  → LifecycleTemplate | null（**缺失返回 null，不抛 404**）
 *
 * `/api/meta` 取代旧的 `/api/approval-config`。
 * 注册顺序：静态段 `/meta` 与 `/meta/templates/:type` 无冲突，但仍按「静态在前」书写。
 */

const express = require('express');

const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const { REVIEW_TEMPLATES, DEFAULT_WIP_LIMIT } = require('../config/enums');
const projectService = require('../services/project.service');

const router = express.Router();

/**
 * 评审模板精简视图（契约 `MetaData.reviewTemplates`：只要 key/label/mode/chain）。
 * @returns {Array<{key:string,label:string,mode:string,chain:string[]}>}
 */
function reviewTemplateSummaries() {
  return Object.keys(REVIEW_TEMPLATES).map(function (k) {
    const t = REVIEW_TEMPLATES[k];
    return { key: t.key, label: t.label, mode: t.mode, chain: t.chain.slice() };
  });
}

router.get(
  '/meta',
  requireAuth,
  asyncHandler(async function getMeta(req, res) {
    res.json(
      ok({
        templates: projectService.listTemplates(db),
        reviewTemplates: reviewTemplateSummaries(),
        wipDefault: DEFAULT_WIP_LIMIT,
      }),
    );
  }),
);

router.get(
  '/meta/templates/:type',
  requireAuth,
  asyncHandler(async function getLifecycleTemplate(req, res) {
    /* 契约明确：模板缺失返回 null，不抛 404（向导需要能优雅降级为「手工填里程碑」） */
    res.json(ok(projectService.getLifecycleTemplate(db, String(req.params.type || ''))));
  }),
);

module.exports = router;
