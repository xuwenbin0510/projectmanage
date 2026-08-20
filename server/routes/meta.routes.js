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
 * 阶段二：DB 优先（scope='business' 且 active=1）→ 回落 enums.REVIEW_TEMPLATES。
 * 项目类（scope='project'，如 project:A/B/C/_default）不进 meta——立项链由建项流程自动选择，
 * 前端发起评审弹窗仍只展示业务类模板（与旧行为一致，零前端改动）。
 * @returns {Array<{key:string,label:string,mode:string,chain:string[]}>}
 */
function reviewTemplateSummaries() {
  try {
    const rows = db
      .prepare("SELECT key, label, mode, chain FROM review_templates WHERE scope = 'business' AND active = 1 ORDER BY key ASC")
      .all();
    if (rows.length) {
      return rows.map(function (r) {
        return { key: r.key, label: r.label, mode: r.mode, chain: JSON.parse(r.chain || '[]') };
      });
    }
  } catch (e) {
    /* 表不存在（老库未迁移）→ 回落旧配置 */
  }
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
