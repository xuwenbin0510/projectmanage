// 极简 .env 加载（避免额外依赖）。也可直接通过系统环境变量注入。
const fs = require('fs');
function loadEnv() {
  try {
    const text = fs.readFileSync('.env', 'utf8');
    text.split('\n').forEach(function (line) {
      const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        let v = m[2].replace(/^["']|["']$/g, '');
        process.env[m[1]] = v;
      }
    });
  } catch (e) { /* 没有 .env 就用系统环境变量 */ }
}
loadEnv();

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  // 飞书自建应用凭证（在飞书开放平台「凭证与基础信息」获取）
  FEISHU_APP_ID: process.env.FEISHU_APP_ID || '',
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || '',
  // 会话令牌签名密钥，生产环境务必改成随机长字符串
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-only-change-me',
  // SQLite 数据库文件路径
  DB_PATH: process.env.DB_PATH || './pm.db',
  // 逗号分隔的 open_id 列表，这些用户首次登录即被授予管理员角色
  ADMIN_OPEN_IDS: (process.env.ADMIN_OPEN_IDS || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean),
  // 服务对外基址（可选，用于日志/回调）
  BASE_URL: process.env.BASE_URL || '',

  // 系统角色（用于审批链绑定与权限）。生产环境由管理员在用户管理里分配，
  // 开发模式可在开发登录时自选角色。
  ROLES: {
    admin: '系统管理员',
    pm: '项目经理',
    tl: '技术负责人',
    qa: '质量负责人',
    pmo: 'PMO',
    management: '管理层',
    member: '普通成员'
  },
  // 审批模板：按项目类别配置「串行逐级」审批链。
  // key 必须与前端 TYPES 完全一致；每项为有序角色数组，逐级审批。
  // 找不到类别时回退 _default。
  APPROVAL_TEMPLATES: {
    'A类（交付类）': ['pmo', 'tl', 'management'],
    'C类（基建类）': ['pmo', 'tl', 'management'],
    'B类（产品迭代）': ['pm', 'tl'],
    '_default': ['pm', 'tl']
  }
};
