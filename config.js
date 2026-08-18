// 运行时配置（Connect v1）
// 极简 .env 加载（避免额外依赖）。也可直接通过系统环境变量注入。
const fs = require('fs');

function loadEnv() {
  try {
    const text = fs.readFileSync('.env', 'utf8');
    text.split('\n').forEach(function (line) {
      const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        const v = m[2].replace(/^["']|["']$/g, '');
        process.env[m[1]] = v;
      }
    });
  } catch (e) { /* 没有 .env 就用系统环境变量 */ }
}
loadEnv();

/**
 * 解析布尔型环境变量。
 * @param {string|undefined} raw 原始值
 * @param {boolean} fallback 缺省值
 * @returns {boolean}
 */
function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/** 历史默认密钥：一旦仍在使用即视为「未配置」 */
const INSECURE_SESSION_SECRETS = ['dev-only-change-me', 'change-me', 'secret'];

const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();

// 决策 D-7：SESSION_SECRET 缺失或仍是默认值 → 直接退出，绝不静默降级。
// 静默使用弱密钥会让所有已签发 token 可被伪造，属于不可接受的生产事故。
if (!SESSION_SECRET || INSECURE_SESSION_SECRETS.indexOf(SESSION_SECRET) >= 0) {
  console.error('');
  console.error('[FATAL] SESSION_SECRET 未配置或仍为默认值，服务拒绝启动。');
  console.error('        会话令牌签名密钥必须是随机长字符串，否则任何人都能伪造登录态。');
  console.error('');
  console.error('  本地开发：在项目根目录 .env 写入');
  console.error('      SESSION_SECRET=<随机 32+ 位字符串>');
  console.error('    生成示例：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.error('  Render 部署：render.yaml 已配置 generateValue: true，由平台自动注入。');
  console.error('');
  process.exit(1);
}

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  // 飞书自建应用凭证（在飞书开放平台「凭证与基础信息」获取）
  FEISHU_APP_ID: FEISHU_APP_ID,
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || '',
  // 会话令牌签名密钥（已在上方做过硬校验）
  SESSION_SECRET: SESSION_SECRET,
  // SQLite 数据库文件路径
  DB_PATH: process.env.DB_PATH || './pm.db',
  // 任务附件磁盘根目录（C01）：上传文件按 projectId 分目录落盘，UUID 重命名防冲突
  ATTACHMENT_ROOT: process.env.ATTACHMENT_ROOT || './attachments',
  // 逗号分隔的 open_id 列表，这些用户首次登录即被授予管理员角色
  ADMIN_OPEN_IDS: (process.env.ADMIN_OPEN_IDS || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean),
  // 服务对外基址（可选，用于日志/回调）
  BASE_URL: process.env.BASE_URL || '',

  // 决策 D-8：开发登录由独立开关控制，不再「FEISHU_APP_ID 为空即开放」。
  // 缺省值保持向后兼容（没配飞书 → 默认开放开发登录），但可显式关闭/开启。
  // ⚠ 对外演示前务必设为 false。
  ALLOW_DEV_LOGIN: parseBool(process.env.ALLOW_DEV_LOGIN, !FEISHU_APP_ID),

  // 系统角色（用于审批链绑定与权限）。取值必须与 server/config/enums.js
  // 的 GLOBAL_ROLES 完全一致（前端 web/src/config/enums.ts 为唯一契约源）。
  ROLES: {
    admin: '管理员',
    management: '管理层',
    pmo: 'PMO',
    pm: '项目经理',
    tl: '技术负责人',
    qa: '质量负责人',
    cm: '配置管理员',
    po: '产品负责人',
    member: '普通成员'
  },

  // 审批模板：按项目类别配置「串行逐级」审批链。
  // key 必须与新契约的 ProjectType（A / B / C）一致；每项为有序角色数组。
  // 找不到类别时回退 _default。
  APPROVAL_TEMPLATES: {
    A: ['pmo', 'tl', 'management'],
    B: ['pm', 'tl'],
    C: ['pmo', 'tl', 'management'],
    _default: ['pm', 'tl']
  }
};
