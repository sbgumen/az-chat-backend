/**
 * 加密工具模块 — AES-256-GCM
 * 所有敏感数据在落库前加密，读取时解密
 * 兼容明文旧数据（safeDecrypt 自动识别）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// ─── 公开 API ───────────────────────────────────────────────

/**
 * 加密
 * @param {Buffer} key 32字节密钥
 * @param {string} plaintext 明文
 * @returns {string} base64(IV || ciphertext || authTag)
 */
function encrypt(key, plaintext) {
  if (!plaintext) return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * 解密
 * @param {Buffer} key 32字节密钥
 * @param {string} ciphertext base64(IV || ciphertext || authTag)
 * @returns {string|null} 明文，失败返回 null
 */
function decrypt(key, ciphertext) {
  if (!ciphertext) return ciphertext;
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    // 最小长度: IV(12) + authTag(16) + 至少1字节密文 = 29
    if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) return null;
    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(buf.length - AUTH_TAG_LENGTH);
    const encrypted = buf.subarray(IV_LENGTH, buf.length - AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * 安全解密：自动处理已加密/未加密数据
 * 解密成功 → 返回明文
 * 解密失败 → 返回原始值（兼容旧明文数据）
 * @param {Buffer} key
 * @param {string|null} data
 * @returns {string}
 */
function safeDecrypt(key, data) {
  if (!data) return data || '';
  const result = decrypt(key, data);
  return result !== null ? result : data;
}

/**
 * 确定性加密（用于需要查询的字段如手机号）
 * IV = HMAC-SHA256(key, plaintext)[:12]
 * @param {Buffer} key
 * @param {string} plaintext
 * @returns {string} base64(IV || ciphertext || authTag)
 */
function deterministicEncrypt(key, plaintext) {
  if (!plaintext) return plaintext;
  const iv = crypto.createHmac('sha256', key).update(plaintext).digest().subarray(0, IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * SMS验证码哈希（仅比对不还原）
 * @param {Buffer} smsKey
 * @param {string} phone
 * @param {string} code
 * @returns {string} hex
 */
function hashSmsCode(smsKey, phone, code) {
  return crypto.createHmac('sha256', smsKey).update(phone + ':' + code).digest('hex');
}

// ─── 密钥管理 ───────────────────────────────────────────────

/**
 * 从主密钥派生子密钥
 * @param {string} masterHex 64位十六进制主密钥
 * @param {string} purpose 用途标识（如 "msg", "phone", "moment", "signature", "sms", "media"）
 * @returns {Buffer} 32字节子密钥
 */
function deriveKey(masterHex, purpose) {
  const master = Buffer.from(masterHex, 'hex');
  if (master.length !== 32) {
    throw new Error(`MASTER_KEY 必须是 64 位十六进制 (32 bytes), 当前: ${master.length * 2} hex`);
  }
  // HKDF-SHA256: 输入 + 空salt + info + 输出长度32
  return crypto.hkdfSync('sha256', master, '', purpose, 32);
}

/**
 * 生成随机主密钥
 * @returns {string} 64位十六进制
 */
function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── 启动自检 ───────────────────────────────────────────────

function selfTest(masterHex) {
  try {
    const key = deriveKey(masterHex, 'test');
    const plain = crypto.randomBytes(64).toString('hex');
    const enc = encrypt(key, plain);
    const dec = decrypt(key, enc);
    if (dec !== plain) throw new Error('加解密结果不一致');
    const det = deterministicEncrypt(key, plain);
    const detDec = decrypt(key, det);
    if (detDec !== plain) throw new Error('确定性加解密结果不一致');
    console.log('[Crypto] 密钥自检通过');
    return true;
  } catch (err) {
    console.error('[Crypto] 密钥自检失败:', err.message);
    console.error('[Crypto] 请检查 .env 中 MASTER_KEY 是否正确（64位十六进制）');
    process.exit(1);
  }
}

// ─── 渐进式数据迁移 ─────────────────────────────────────────

/**
 * 批量迁移表中的明文数据 → 密文
 * 每次启动自动执行，已加密的数据自动跳过
 *
 * @param {object} pool mysql2/promise 连接池
 * @param {string} table 表名
 * @param {string} idColumn 主键列名
 * @param {string} contentColumn 内容列名
 * @param {Buffer} key 加密密钥
 * @param {string} label 日志标签
 * @param {object} options
 * @param {string} options.where 额外 WHERE 条件（不含 WHERE 关键字）
 * @param {function} options.encryptFn 自定义加密函数，默认 encrypt
 * @param {boolean} options.isDetEncrypt 是否使用确定性加密
 */
async function migrateTable(pool, table, idColumn, contentColumn, key, label, options = {}) {
  const { where = '1=1', encryptFn, isDetEncrypt = false } = options;
  const enc = isDetEncrypt ? deterministicEncrypt : encryptFn || encrypt;
  const BATCH = 1000;
  const DELAY = 100;  // ms 间隔

  console.log(`[Crypto] 开始检查 ${label} (${table}.${contentColumn})...`);

  let lastId = 0;
  let totalChecked = 0;
  let totalEncrypted = 0;
  let batches = 0;

  while (true) {
    const [rows] = await pool.query(
      `SELECT ${idColumn}, ${contentColumn} FROM ${table}
       WHERE ${idColumn} > ? AND ${where} AND ${contentColumn} IS NOT NULL AND ${contentColumn} != ''
       ORDER BY ${idColumn} ASC LIMIT ${BATCH}`,
      [lastId]
    );

    if (rows.length === 0) break;
    batches++;

    for (const row of rows) {
      totalChecked++;
      if (totalChecked % 5000 === 0) {
        console.log(`[Crypto] ${label}: 已检查 ${totalChecked}, 已加密 ${totalEncrypted}...`);
      }

      // 尝试解密 → 成功说明已加密 → 跳过
      const decrypted = decrypt(key, row[contentColumn]);
      if (decrypted !== null) {
        lastId = row[idColumn];
        continue;
      }

      // 解密失败 → 明文数据 → 加密写回
      try {
        const encrypted = enc(key, row[contentColumn]);
        await pool.query(
          `UPDATE ${table} SET ${contentColumn} = ? WHERE ${idColumn} = ? AND ${contentColumn} = ?`,
          [encrypted, row[idColumn], row[contentColumn]]
        );
        totalEncrypted++;
      } catch (err) {
        console.error(`[Crypto] ${label} 迁移行 ${row[idColumn]} 失败:`, err.message);
      }

      lastId = row[idColumn];
    }

    if (rows.length < BATCH) break;
    await new Promise(r => setTimeout(r, DELAY));
  }

  if (batches > 0 || totalEncrypted > 0) {
    console.log(`[Crypto] ${label} 迁移完成: 检查 ${totalChecked} 条, 加密 ${totalEncrypted} 条`);
  } else {
    console.log(`[Crypto] ${label}: 无需迁移（无数据或全部已加密）`);
  }

  return { checked: totalChecked, encrypted: totalEncrypted };
}

/**
 * 检查并运行所有表的迁移（仅在首次需要时运行）
 * @param {object} pool
 * @param {string} masterHex 主密钥
 */
async function runMigrations(pool, masterHex) {
  const [settings] = await pool.query(
    'SELECT value FROM system_settings WHERE `key` = ?',
    ['encryption_version']
  );

  const currentVersion = settings.length > 0 ? parseInt(settings[0].value) : 0;
  if (currentVersion >= 2) {
    console.log(`[Crypto] 数据迁移已完成 (encryption_version=${currentVersion})，跳过`);
    return;
  }

  console.log('[Crypto] 开始渐进式数据迁移...');
  const start = Date.now();

  const msgKey = deriveKey(masterHex, 'msg');
  const phoneKey = deriveKey(masterHex, 'phone');
  const momentKey = deriveKey(masterHex, 'moment');
  const sigKey = deriveKey(masterHex, 'signature');
  const emailKey = deriveKey(masterHex, 'email');

  try {
    await migrateTable(pool, 'messages', 'id', 'content', msgKey, '消息');
    await migrateTable(pool, 'group_messages', 'id', 'content', msgKey, '群消息');
    await migrateTable(pool, 'moments', 'id', 'content', momentKey, '朋友圈');
    await migrateTable(pool, 'users', 'id', 'phone', phoneKey, '用户手机号', {
      isDetEncrypt: true,
      where: 'phone IS NOT NULL AND phone != \'\''
    });
    await migrateTable(pool, 'users', 'id', 'signature', sigKey, '用户签名', {
      where: 'signature IS NOT NULL AND signature != \'\''
    });
    // 邮箱加密迁移（v2）
    if (currentVersion < 2) {
      await migrateTable(pool, 'users', 'id', 'email', emailKey, '用户邮箱', {
        isDetEncrypt: true,
        where: 'email IS NOT NULL AND email != \'\''
      });
    }

    // sms_codes 单独处理：清空历史验证码（已过期且无迁移价值）
    await pool.query('DELETE FROM sms_codes WHERE expires_at < NOW()');
    console.log('[Crypto] 已清理过期验证码');

    // 标记迁移完成
    await pool.query(
      'INSERT INTO system_settings (`key`, `value`, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE `value` = ?, updated_at = NOW()',
      ['encryption_version', '2', '2']
    );

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[Crypto] 全部迁移完成，耗时 ${elapsed}s`);
  } catch (err) {
    console.error('[Crypto] 迁移失败:', err.message);
    // 不让迁移失败阻止启动
  }
}

module.exports = {
  encrypt,
  decrypt,
  safeDecrypt,
  deterministicEncrypt,
  hashSmsCode,
  deriveKey,
  generateKey,
  selfTest,
  migrateTable,
  runMigrations,
  // 邮箱加解密（确定性，支持精确查询）
  encEmail: (plain, masterHex) => {
    if (!plain || !masterHex) return plain;
    return deterministicEncrypt(deriveKey(masterHex, 'email'), plain);
  },
  decEmail: (cipher, masterHex) => {
    if (!cipher || !masterHex) return cipher;
    return safeDecrypt(deriveKey(masterHex, 'email'), cipher);
  },
  // 通用敏感字段加密（非确定性，用于授权码等无需查询的字段）
  encSensitive: (plain, masterHex) => {
    if (!plain || !masterHex) return plain || '';
    return encrypt(deriveKey(masterHex, 'general'), plain);
  },
  decSensitive: (cipher, masterHex) => {
    if (!cipher || !masterHex) return cipher || '';
    return safeDecrypt(deriveKey(masterHex, 'general'), cipher);
  },
};
