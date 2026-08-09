// 数据库连接（Connect v1）
//
// 职责收敛为三件事：建连接 → 跑迁移 → 跑种子。
// 所有 DDL 已迁到 server/dal/migrations.js（版本化、幂等、事务化），
// 这里**不再出现任何 CREATE TABLE / ALTER TABLE**。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');
const migrations = require('./server/dal/migrations');
const seed = require('./server/dal/seed');

// DB_PATH 可能指向挂载盘（如 Render 的 /data/pm.db），父目录不存在时先建出来
const dir = path.dirname(path.resolve(cfg.DB_PATH));
try {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
} catch (e) {
  console.error('[db] 无法创建数据目录 %s：%s', dir, e.message);
  process.exit(1);
}

const db = new Database(cfg.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

migrations.run(db);
seed.run(db);

console.log('[db] ready at %s (schema v%d)', cfg.DB_PATH, migrations.currentVersion(db));

module.exports = db;
