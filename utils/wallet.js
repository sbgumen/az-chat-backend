/**
 * 金币/等级加密模块（防微信余额级安全）
 * - coins/exp 使用 AES-256-GCM 加密存储
 * - 所有操作通过原子事务 + 审计日志
 * - 前端永远不接触加密数据
 */
const pool = require('../config/db');
const { encrypt, decrypt, deriveKey } = require('./crypto');

let _walletKey = null;
function getWalletKey() {
  if (_walletKey) return _walletKey;
  const mk = process.env.MASTER_KEY;
  if (mk && mk.length === 64) _walletKey = deriveKey(mk, 'wallet');
  return _walletKey;
}

/** 解密 coins/exp 字段（兼容明文旧数据） */
function decCoin(val) {
  if (val === null || val === undefined) return 0;
  const k = getWalletKey();
  if (!k) return parseInt(val) || 0;
  // 尝试解密，失败则返回原始数字（兼容未迁移数据）
  const raw = decrypt(k, String(val));
  return raw !== null ? parseInt(raw) || 0 : parseInt(val) || 0;
}

/** 加密数值 */
function encNum(val) {
  const k = getWalletKey();
  if (!k) return String(val);
  return encrypt(k, String(val));
}

/**
 * 读取用户钱包数据（解密 coins/exp）
 */
async function getUserWallet(userId) {
  const [[row]] = await pool.execute('SELECT coins, exp, level FROM users WHERE id = ?', [userId]);
  if (!row) return null;
  return {
    coins: decCoin(row.coins),
    exp: decCoin(row.exp),
    level: decCoin(row.level),
  };
}

/**
 * 原子增加金币（带审计记录）
 * @returns {Object} { success, newCoins, oldCoins }
 */
async function addCoins(userId, amount, reason, detail = {}) {
  if (amount <= 0) return { success: false, error: '金额必须大于0' };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.execute('SELECT coins FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!row) { await conn.rollback(); return { success: false, error: '用户不存在' }; }
    const oldCoins = decCoin(row.coins);
    const newCoins = oldCoins + amount;
    await conn.execute('UPDATE users SET coins = ? WHERE id = ?', [encNum(newCoins), userId]);
    await conn.execute(
      'INSERT INTO coin_transactions (user_id, amount, balance_before, balance_after, reason, detail) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, amount, oldCoins, newCoins, reason, JSON.stringify(detail)]
    );
    await conn.commit();
    return { success: true, oldCoins, newCoins, amount };
  } catch (err) {
    await conn.rollback();
    console.error('[Wallet] addCoins error:', err.message);
    return { success: false, error: err.message };
  } finally {
    conn.release();
  }
}

/**
 * 原子扣除金币
 */
async function deductCoins(userId, amount, reason, detail = {}) {
  if (amount <= 0) return { success: false, error: '金额必须大于0' };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.execute('SELECT coins FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!row) { await conn.rollback(); return { success: false, error: '用户不存在' }; }
    const oldCoins = decCoin(row.coins);
    if (oldCoins < amount) { await conn.rollback(); return { success: false, error: '余额不足', oldCoins }; }
    const newCoins = oldCoins - amount;
    await conn.execute('UPDATE users SET coins = ? WHERE id = ?', [encNum(newCoins), userId]);
    await conn.execute(
      'INSERT INTO coin_transactions (user_id, amount, balance_before, balance_after, reason, detail) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, -amount, oldCoins, newCoins, reason, JSON.stringify(detail)]
    );
    await conn.commit();
    return { success: true, oldCoins, newCoins, amount };
  } catch (err) {
    await conn.rollback();
    console.error('[Wallet] deductCoins error:', err.message);
    return { success: false, error: err.message };
  } finally {
    conn.release();
  }
}

/**
 * 原子增加经验（可能触发升级）
 */
async function addExp(userId, amount, reason, detail = {}) {
  if (amount <= 0) return { success: false };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.execute('SELECT exp, level FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!row) { await conn.rollback(); return { success: false }; }
    const oldExp = decCoin(row.exp);
    const oldLevel = decCoin(row.level);
    const newExp = oldExp + amount;
    const newLevel = Math.floor(newExp / 100) + 1;
    const levelUp = newLevel > oldLevel;
    const levelCoins = levelUp ? (newLevel - oldLevel) * 2 : 0;

    await conn.execute('UPDATE users SET exp = ?, level = ? WHERE id = ?', [encNum(newExp), encNum(newLevel), userId]);
    if (levelCoins > 0) {
      const [[cr]] = await conn.execute('SELECT coins FROM users WHERE id = ? FOR UPDATE', [userId]);
      const oldC = decCoin(cr.coins);
      const newC = oldC + levelCoins;
      await conn.execute('UPDATE users SET coins = ? WHERE id = ?', [encNum(newC), userId]);
      await conn.execute(
        'INSERT INTO coin_transactions (user_id, amount, balance_before, balance_after, reason, detail) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, levelCoins, oldC, newC, reason + '_levelup', JSON.stringify({ ...detail, oldLevel, newLevel })]
      );
    }
    await conn.commit();
    return { success: true, oldExp, newExp, oldLevel, newLevel, levelUp, levelCoins };
  } catch (err) {
    await conn.rollback();
    console.error('[Wallet] addExp error:', err.message);
    return { success: false };
  } finally {
    conn.release();
  }
}

/**
 * 迁移 coins/exp/level 字段到加密格式
 */
async function migrateWallet(pool) {
  const k = getWalletKey();
  if (!k) return;
  console.log('[Wallet] 开始迁移钱包数据...');
  let offset = 0, done = 0;
  while (true) {
    const [rows] = await pool.execute('SELECT id, coins, exp, level FROM users LIMIT 1000 OFFSET ?', [offset]);
    if (rows.length === 0) break;
    for (const r of rows) {
      // 尝试解密 — 成功说明已加密
      if (decrypt(k, String(r.coins)) !== null && decrypt(k, String(r.exp)) !== null) { done++; continue; }
      await pool.execute('UPDATE users SET coins = ?, exp = ?, level = ? WHERE id = ?',
        [encNum(decCoin(r.coins)), encNum(r.exp !== undefined ? decCoin(r.exp) : '0'), encNum(r.level || 1), r.id]);
      done++;
    }
    offset += 1000;
  }
  console.log(`[Wallet] 迁移完成: ${done} 条`);
}

/**
 * 读取经验配置（带缓存30秒）
 */
let _expCache = null; let _expCacheTime = 0;
async function getExpConfig() {
  const now = Date.now();
  if (_expCache && now - _expCacheTime < 30000) return _expCache;
  const [rows] = await pool.execute(
    "SELECT `key`, `value` FROM system_settings WHERE `key` LIKE 'exp_%'"
  ).catch(() => [[]]);
  const cfg = { exp_message: 2, exp_signin: 10, exp_moment: 5, exp_comment: 3, exp_follow: 3, exp_add_friend: 5, exp_message_daily_limit: 50 };
  const enabled = {};
  rows.forEach(r => {
    if (r.key.endsWith('_enabled')) enabled[r.key.replace('_enabled', '')] = r.value === '1';
    else if (!isNaN(parseInt(r.value))) cfg[r.key] = parseInt(r.value);
  });
  _expCache = { ...cfg, _enabled: enabled };
  _expCacheTime = now;
  return _expCache;
}

module.exports = { getUserWallet, addCoins, deductCoins, addExp, decCoin, encNum, migrateWallet, getExpConfig };
