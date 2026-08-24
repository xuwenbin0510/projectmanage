/**
 * 密码哈希与校验（零依赖，Node 内置 scrypt）。
 *
 * 设计约束：
 *  - 不自研加密算法，使用 Node crypto.scrypt（内存困难型 KDF，优于简单哈希）。
 *  - 输出格式：`$scrypt$N=32768,r=8,p=1$<salt_base64>$<hash_base64>`，便于后续升级算法。
 *  - 密码为空时直接比较，避免在 must_change_pwd 场景下强制要求旧密码。
 */

const { scrypt, timingSafeEqual, randomBytes } = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(scrypt);

const ALGO = 'scrypt';
const N = 32768;
const r = 8;
const p = 1;
const KEYLEN = 64;
// Node scrypt 默认 maxmem=32MB，N=32768,r=8,p=1 需要约 32MB，留足余量。
const MAXMEM = 64 * 1024 * 1024;

/**
 * 对明文密码进行 scrypt 哈希。
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashPassword(password) {
  const salt = randomBytes(32);
  const derived = await scryptAsync(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  const encode = (buf) => buf.toString('base64').replace(/=+$/, '');
  return `$${ALGO}$N=${N},r=${r},p=${p}$${encode(salt)}$${encode(derived)}`;
}

/**
 * 校验明文密码是否与哈希匹配。
 * @param {string} password 明文密码
 * @param {string|undefined|null} hashed 已存储的哈希
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, hashed) {
  if (!hashed) return false;
  const parts = String(hashed).split('$');
  if (parts.length !== 5 || parts[1] !== ALGO) return false;

  const params = parts[2];
  const salt = Buffer.from(parts[3], 'base64');
  const expected = Buffer.from(parts[4], 'base64');

  const m = /N=(\d+),r=(\d+),p=(\d+)/.exec(params);
  if (!m) return false;

  const derived = await scryptAsync(
    password,
    salt,
    expected.length,
    { N: parseInt(m[1], 10), r: parseInt(m[2], 10), p: parseInt(m[3], 10), maxmem: MAXMEM },
  );

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
