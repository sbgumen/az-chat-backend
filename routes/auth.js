const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const svgCaptcha = require('svg-captcha');
const pool = require('../config/db');
const { smsLimiter, smsHourlyLimiter, smsPhoneLimiter, loginLimiter } = require('../middleware/rateLimiter');
const { SYSTEM_BOT_ID, sendSystemNotify } = require('../utils/systemNotify');
const { encrypt, deterministicEncrypt, hashSmsCode, deriveKey, encEmail: encE, decEmail: decE, encSensitive, decSensitive } = require('../utils/crypto');
const decS = (v) => decSensitive(v, process.env.MASTER_KEY);
const router = express.Router();

let _phoneKey = null;
let _smsKey = null;
let _sigKey = null;
function getPhoneKey() { if (!_phoneKey) _phoneKey = deriveKey(process.env.MASTER_KEY, 'phone'); return _phoneKey; }
function getSmsKey() { if (!_smsKey) _smsKey = deriveKey(process.env.MASTER_KEY, 'sms'); return _smsKey; }
function getSigKey() { if (!_sigKey) _sigKey = deriveKey(process.env.MASTER_KEY, 'signature'); return _sigKey; }
function encPhone(p) { if (!p || !process.env.MASTER_KEY) return p; return deterministicEncrypt(getPhoneKey(), p); }
function hashCode(phone, code) { return hashSmsCode(getSmsKey(), phone, code); }
function encSignature(s) { return encrypt(getSigKey(), s); }
function encEmail(e) { return encE(e, process.env.MASTER_KEY); }
function decEmail(e) { return decE(e, process.env.MASTER_KEY); }

// 查询邮箱用户（兼容加密前明文数据）
async function getUserByEmail(email) {
  const ee = encEmail(email);
  const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [ee]);
  if (rows.length > 0) return rows;
  // 降级：搜索明文（未迁移的旧数据）
  const [plainRows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  return plainRows;
}

async function emailExists(email) {
  const ee = encEmail(email);
  const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [ee]);
  if (rows.length > 0) return true;
  const [plainRows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
  return plainRows.length > 0;
}

// 查询用户（兼容加密前明文数据）
async function getUserByPhone(phone) {
  const ep = encPhone(phone);
  const [rows] = await pool.execute('SELECT * FROM users WHERE phone = ?', [ep]);
  if (rows.length > 0) return rows;
  // 降级：搜索明文（未迁移的旧数据）
  const [plainRows] = await pool.execute('SELECT * FROM users WHERE phone = ?', [phone]);
  return plainRows;
}

async function userExistsByPhone(phone) {
  const ep = encPhone(phone);
  const [rows] = await pool.execute('SELECT id FROM users WHERE phone = ?', [ep]);
  if (rows.length > 0) return true;
  const [plainRows] = await pool.execute('SELECT id FROM users WHERE phone = ?', [phone]);
  return plainRows.length > 0;
}

// 生成双 Token
const crypto = require('crypto');
async function generateTokens(userId, res) {
  const accessToken = jwt.sign({ userId, type: 'access' }, process.env.JWT_SECRET, {
    issuer: 'az-chat-backend',
    expiresIn: '2h',
  });
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const family = crypto.randomBytes(16).toString('hex');
  await pool.execute(
    'INSERT INTO refresh_tokens (user_id, token_hash, family, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))',
    [userId, tokenHash, family]
  );
  // HTTPS → HttpOnly Secure Cookie，清缓存不丢失；HTTP → 靠前端 localStorage
  if (res && reqSecure(res.req || res)) {
    res.cookie('az_refresh', refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });
  }
  return { accessToken, refreshToken };
}
function reqSecure(req) {
  return !!(req && (req.secure || req.protocol === 'https' || req.headers?.['x-forwarded-proto'] === 'https'));
}
function getRefreshToken(req) {
  // 优先从 cookie 读取（HTTPS），否则从 body（HTTP/localStorage）
  return req.cookies?.az_refresh || req.body?.refreshToken;
}

// 验证码错误次数追踪（内存存储，生产环境建议用 Redis）
const codeAttempts = new Map();
const CODE_MAX_ATTEMPTS = 5;
const CODE_LOCK_DURATION = 30 * 60 * 1000; // 30分钟

function isPhoneLocked(phone) {
  const record = codeAttempts.get(phone);
  if (!record) return false;
  if (record.attempts >= CODE_MAX_ATTEMPTS) {
    if (Date.now() - record.lastAttempt < CODE_LOCK_DURATION) return true;
    codeAttempts.delete(phone);
    return false;
  }
  return false;
}

function recordFailedAttempt(phone) {
  const record = codeAttempts.get(phone) || { attempts: 0, lastAttempt: 0 };
  record.attempts += 1;
  record.lastAttempt = Date.now();
  codeAttempts.set(phone, record);
}

function clearAttempts(phone) {
  codeAttempts.delete(phone);
}

// 检查手机号是否已注册
router.get('/check-phone', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone || !/^1\d{10}$/.test(phone)) {
      return res.json({ code: 400, message: '手机号格式错误' });
    }
    const exists = await userExistsByPhone(phone);
    res.json({ code: 0, data: { exists } });
  } catch (err) {
    console.error('[Auth] 检查手机号失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取图形验证码
router.get('/captcha', async (req, res) => {
  try {
    // 读取动态配置
    let captchaLength = 4;
    let captchaIncludeAlpha = '0';
    let captchaType = 'text';
    try {
      const [[row]] = await pool.execute('SELECT `value` FROM system_settings WHERE `key` = ?', ['captcha_length']);
      if (row) captchaLength = Math.min(6, Math.max(3, parseInt(row.value) || 4));
      const [[row2]] = await pool.execute('SELECT `value` FROM system_settings WHERE `key` = ?', ['captcha_include_alpha']);
      if (row2) captchaIncludeAlpha = row2.value;
      const [[row3]] = await pool.execute('SELECT `value` FROM system_settings WHERE `key` = ?', ['captcha_type']);
      if (row3) captchaType = row3.value;
    } catch {}

    let captcha;
    if (captchaType === 'math') {
      // 算数验证码
      captcha = svgCaptcha.createMathExpr({
        noise: 2,
        color: true,
        background: '#fdfaf6',
        width: 140,
        height: 50,
        fontSize: 36,
      });
    } else {
      // 文本验证码
      const ignoreChars = captchaIncludeAlpha === '1'
        ? '0o1il'
        : '0o1ilabcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
      captcha = svgCaptcha.create({
        size: captchaLength,
        ignoreChars,
        noise: 2,
        color: true,
        background: '#fdfaf6',
        width: 140,
        height: 50,
        fontSize: 40,
      });
    }
    const token = jwt.sign({ answer: captcha.text.toLowerCase() }, process.env.JWT_SECRET, { expiresIn: '2m' });
    const svgBase64 = Buffer.from(captcha.data).toString('base64');
    res.json({ code: 0, data: { token, svg: `data:image/svg+xml;base64,${svgBase64}` } });
  } catch (err) {
    console.error('[Captcha] 生成失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发送验证码 — 三层速率限制保护 + 人机验证
router.post('/send-code', async (req, res) => {
  try {
    const { phone, captchaToken, captchaAnswer } = req.body;
    if (!phone || !/^1\d{10}$/.test(phone)) {
      return res.json({ code: 400, message: '手机号格式错误' });
    }

    // 人机验证（必须在限流之前，错误不计入限流）
    if (!captchaToken || !captchaAnswer) {
      return res.json({ code: 400, message: '请完成人机验证' });
    }
    try {
      const decoded = jwt.verify(captchaToken, process.env.JWT_SECRET);
      if (String(captchaAnswer).toLowerCase() !== decoded.answer) {
        return res.json({ code: 400, message: '验证码错误' });
      }
    } catch {
      return res.json({ code: 400, message: '验证已过期，请重新验证' });
    }

    // 限流检查（验证码通过后才计入）
    await new Promise((resolve, reject) => {
      smsPhoneLimiter(req, res, (err) => err ? reject(err) : resolve());
    }).catch(() => { if (!res.headersSent) return res.json({ code: 429, message: '该手机号请求太频繁，请1分钟后再试' }); });
    if (res.headersSent) return;
    await new Promise((resolve, reject) => {
      smsLimiter(req, res, (err) => err ? reject(err) : resolve());
    }).catch(() => { if (!res.headersSent) return res.json({ code: 429, message: '请求太频繁，请稍后再试' }); });
    if (res.headersSent) return;
    await new Promise((resolve, reject) => {
      smsHourlyLimiter(req, res, (err) => err ? reject(err) : resolve());
    }).catch(() => { if (!res.headersSent) return res.json({ code: 429, message: '请求次数过多，请稍后再试' }); });
    if (res.headersSent) return;

    if (isPhoneLocked(phone)) {
      return res.json({ code: 429, message: '验证码错误次数过多，请30分钟后再试' });
    }

    // 生成验证码（长度和有效期由后台配置）
    const codeLen = Math.min(6, Math.max(4, parseInt(await getSetting('sms_code_length') || '6')));
    const codeExpire = Math.min(600, Math.max(30, parseInt(await getSetting('sms_code_expire') || '300')));
    const min = Math.pow(10, codeLen - 1);
    const max = Math.pow(10, codeLen) - 1;
    const code = String(Math.floor(min + Math.random() * (max - min + 1)));
    const expiresAt = new Date(Date.now() + codeExpire * 1000);

    // 存入数据库
    await pool.execute(
      'INSERT INTO sms_codes (phone, code, expires_at) VALUES (?, ?, ?)',
      [phone, hashCode(phone, code), expiresAt]
    );

    // 调用推送助手发送验证码
    // 优先使用管理后台配置的模板，否则用 .env 默认配置
    const templateId = decS(await getSetting('sms_template_id'), process.env.MASTER_KEY);
    const smsNumber = Math.max(1, Math.round(codeExpire / 60));
    let smsUrl;
    if (templateId) {
      smsUrl = `https://push.spug.cc/send/${templateId}?code=${code}&number=${smsNumber}&targets=${phone}`;
    } else {
      smsUrl = `${process.env.SMS_URL}?code=${code}&number=1&targets=${phone}`;
    }
    const response = await fetch(smsUrl);
    const result = await response.text();

    // 生产环境不打印验证码明文
    if (process.env.NODE_ENV === 'development') {
      console.log(`[SMS] 发送验证码到 ${phone}: ${code}`);
    } else {
      console.log(`[SMS] 验证码已发送到 ${phone.slice(0, 3)}****${phone.slice(-4)}`);
    }

    res.json({ code: 0, message: '验证码已发送' });
  } catch (err) {
    console.error('[SMS] 发送失败:', err.message);
    res.json({ code: 500, message: '发送失败' });
  }
});

// 手机号登录（自动注册）
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.json({ code: 400, message: '参数缺失' });
    }

    if (isPhoneLocked(phone)) {
      return res.json({ code: 429, message: '验证码错误次数过多，请30分钟后再试' });
    }

    // 验证验证码
    const [codes] = await pool.execute(
      'SELECT * FROM sms_codes WHERE phone = ? AND code = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
      [phone, hashCode(phone, code)]
    );

    if (codes.length === 0) {
      recordFailedAttempt(phone);
      return res.json({ code: 400, message: '验证码错误或已过期' });
    }

    // 验证成功，清除错误计数
    clearAttempts(phone);

    // 删除已使用的验证码
    await pool.execute('DELETE FROM sms_codes WHERE phone = ? AND id <= ?', [phone, codes[0].id]);

    // 查找或创建用户
    let users = await getUserByPhone(phone);
    let user;
    let isNew = false;
    const { nickname } = req.body;

    if (users.length === 0) {
      // 新用户：提供了昵称则直接注册，否则返回 needRegister
      if (nickname && nickname.trim()) {
        const trimmedNickname = nickname.trim().slice(0, 20);
        const defaultSignature = '这个人很懒，什么都没写~';
        const [result] = await pool.execute(
          'INSERT INTO users (phone, nickname, signature, level, exp, coins) VALUES (?, ?, ?, 1, 0, 0)',
          [encPhone(phone), trimmedNickname, encSignature(defaultSignature)]
        );
        user = { id: result.insertId, phone, nickname: trimmedNickname, avatar: '/default-avatar.png', gender: 0, coins: 0, signature: defaultSignature };
        isNew = true;
        // 新用户自动添加系统通知机器人为好友
        try {
          await pool.execute('INSERT IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)', [result.insertId, SYSTEM_BOT_ID]);
          await pool.execute('INSERT IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)', [SYSTEM_BOT_ID, result.insertId]);
          await sendSystemNotify(result.insertId, `欢迎加入 AZ-Chat！我是系统通知助手，好友申请、群聊通知、等级变化等系统消息都会在这里告知您。`);
        } catch(e) {}
        // 新用户自动加入所有全员系统群
        try {
          await pool.execute(
            'INSERT IGNORE INTO group_members (group_id, user_id, role) SELECT id, ?, \'member\' FROM `groups` WHERE is_system = 1 AND system_mode = \'all\'',
            [result.insertId]
          );
        } catch(e) {}
      } else {
        // 新用户但没有昵称：返回临时 token 要求设置昵称
        const tempToken = jwt.sign({ phone, action: 'register' }, process.env.JWT_SECRET, { expiresIn: '5m' });
        return res.json({
          code: 200,
          message: '请设置昵称',
          data: { needRegister: true, tempToken }
        });
      }
    } else {
      user = users[0];
      if (user.is_banned) return res.json({ code: 403, message: '账号已被封禁，请联系管理员' });
    }

    // 更新最后登录时间
    await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    // 生成双 Token
    const { accessToken, refreshToken } = await generateTokens(user.id, res);

    res.json({
      code: 0,
      message: isNew ? '注册成功' : '登录成功',
      data: {
        token: accessToken,  // 兼容旧字段
        accessToken,
        refreshToken,
        user: { id: user.id, phone: user.phone, nickname: user.nickname, avatar: user.avatar, gender: user.gender, coins: require('../utils/wallet').decCoin(user.coins) }
      }
    });
  } catch (err) {
    console.error('[Auth] 登录失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 使用临时 token 完成注册（设置昵称）
router.post('/register', loginLimiter, async (req, res) => {
  try {
    const { tempToken, nickname } = req.body;
    if (!tempToken || !nickname || !nickname.trim()) {
      return res.json({ code: 400, message: '参数缺失' });
    }

    // 验证临时 token
    let decoded;
    try {
      decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
    } catch {
      return res.json({ code: 400, message: '验证已过期，请重新获取验证码' });
    }

    if (decoded.action !== 'register') {
      return res.json({ code: 400, message: '无效的注册凭证' });
    }

    const email = decoded.email;
    const phone = decoded.phone;
    if (!phone && !email) {
      return res.json({ code: 400, message: '无效的注册凭证' });
    }

    const trimmedNickname = nickname.trim().slice(0, 20);
    const defaultSignature = '这个人很懒，什么都没写~';

    // 检查是否已被注册
    if (phone) {
      const exists = await userExistsByPhone(phone);
      if (exists) return res.json({ code: 400, message: '该手机号已注册，请直接登录' });
    } else if (email) {
      const [existRows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
      if (existRows.length > 0) return res.json({ code: 400, message: '该邮箱已注册，请直接登录' });
    }

    // 创建用户（phone/email 为空时插入 NULL，避免唯一键冲突）
    const phoneVal = phone ? encPhone(phone) : null;
    const emailVal = email ? encEmail(email) : null;
    const [result] = await pool.execute(
      'INSERT INTO users (phone, email, nickname, signature, level, exp, coins) VALUES (?, ?, ?, ?, 1, 0, 0)',
      [phoneVal, emailVal, trimmedNickname, encSignature(defaultSignature)]
    );

    const user = {
      id: result.insertId, phone: phone || '', email: email || '', nickname: trimmedNickname,
      avatar: '/default-avatar.png', gender: 0, coins: 0, signature: defaultSignature
    };

    // 自动添加系统通知机器人为好友
    try {
      await pool.execute('INSERT IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)', [result.insertId, SYSTEM_BOT_ID]);
      await pool.execute('INSERT IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)', [SYSTEM_BOT_ID, result.insertId]);
      await sendSystemNotify(result.insertId, `欢迎加入 AZ-Chat！我是系统通知助手，好友申请、群聊通知、等级变化等系统消息都会在这里告知您。`);
    } catch(e) {}
    // 新用户自动加入所有全员系统群
    try {
      await pool.execute(
        'INSERT IGNORE INTO group_members (group_id, user_id, role) SELECT id, ?, \'member\' FROM `groups` WHERE is_system = 1 AND system_mode = \'all\'',
        [result.insertId]
      );
    } catch(e) {}

    // 更新最后登录时间
    await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    const { accessToken, refreshToken } = await generateTokens(user.id, res);

    res.json({
      code: 0, message: '注册成功',
      data: {
        token: accessToken,
        accessToken,
        refreshToken,
        user: { id: user.id, phone: user.phone, nickname: user.nickname, avatar: user.avatar, gender: user.gender, coins: require('../utils/wallet').decCoin(user.coins) }
      }
    });
  } catch (err) {
    console.error('[Auth] 注册失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 账号ID/手机号/邮箱 + 密码登录
router.post('/login-id', loginLimiter, async (req, res) => {
  try {
    const { userId, password, captchaToken, captchaAnswer } = req.body;
    if (!userId || !password) return res.json({ code: 400, message: '参数缺失' });
    if (password.length > 128) return res.json({ code: 400, message: '密码格式错误' });

    // 图形验证码校验
    if (!captchaToken || !captchaAnswer) return res.json({ code: 400, message: '请完成图形验证' });
    try {
      const decoded = jwt.verify(captchaToken, process.env.JWT_SECRET);
      if (String(captchaAnswer).toLowerCase() !== decoded.answer) {
        return res.json({ code: 400, message: '图形验证码错误' });
      }
    } catch { return res.json({ code: 400, message: '图形验证已过期，请重新验证' }); }

    // 支持 邮箱/手机号/ID 登录：按类型依次查询
    const numId = parseInt(userId);
    let users = [];
    // 含@ → 邮箱查询
    if (String(userId).includes('@')) {
      users = await getUserByEmail(String(userId));
    } else if (!isNaN(numId)) {
      // 纯数字 → ID查询
      [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [numId]);
    }
    if (users.length === 0) {
      // 按手机号查（兼容加密前后）
      users = await getUserByPhone(String(userId));
    }
    if (users.length === 0) return res.json({ code: 400, message: '账号不存在' });

    const user = users[0];
    if (user.is_banned) return res.json({ code: 403, message: '账号已被封禁，请联系管理员' });
    if (!user.password) return res.json({ code: 400, message: '该账号未设置密码，请使用验证码登录' });

    // 使用 bcrypt 比较密码
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.json({ code: 400, message: '密码错误' });

    // 更新最后登录时间
    await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    const { accessToken, refreshToken } = await generateTokens(user.id, res);
    res.json({
      code: 0, message: '登录成功',
      data: {
        token: accessToken,
        accessToken,
        refreshToken,
        user: { id: user.id, phone: user.phone, nickname: user.nickname, avatar: user.avatar, gender: user.gender, coins: require('../utils/wallet').decCoin(user.coins) }
      }
    });
  } catch (err) {
    console.error('[Auth] 密码登录失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 刷新 Token
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = getRefreshToken(req);
    if (!refreshToken) return res.json({ code: 400, message: '缺少 refreshToken' });
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const [rows] = await pool.execute(
      'SELECT id, user_id, family, expires_at FROM refresh_tokens WHERE token_hash = ? AND expires_at > NOW()',
      [tokenHash]
    );
    if (rows.length === 0) return res.json({ code: 401, message: 'refreshToken无效或已过期' });
    const record = rows[0];

    // 同一 family 全部作废 → 防重放
    await pool.execute('DELETE FROM refresh_tokens WHERE family = ?', [record.family]);

    // 检查用户状态
    const [[user]] = await pool.execute('SELECT id, phone, nickname, avatar, gender, coins, role, is_banned FROM users WHERE id = ?', [record.user_id]);
    const { decCoin: decC } = require('../utils/wallet');
    user.coins = decC(user.coins);
    if (!user || user.is_banned) {
      await pool.execute('DELETE FROM refresh_tokens WHERE user_id = ?', [record.user_id]);
      return res.json({ code: 403, message: '账号异常' });
    }

    // 生成新 Token
    const { accessToken, refreshToken: newRefresh } = await generateTokens(record.user_id, res);

    res.json({
      code: 0,
      data: {
        accessToken,
        refreshToken: newRefresh,
        user: { id: user.id, phone: user.phone, nickname: user.nickname, avatar: user.avatar, gender: user.gender, coins: require('../utils/wallet').decCoin(user.coins), role: user.role }
      }
    });
  } catch (err) {
    console.error('[Auth] Token刷新失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 登出
const auth = require('../middleware/auth');
router.post('/logout', auth, async (req, res) => {
  try {
    await pool.execute('DELETE FROM refresh_tokens WHERE user_id = ?', [req.userId]);
    res.clearCookie('az_refresh', { path: '/' });
    res.json({ code: 0, message: '已登出' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 检查邮箱是否已注册
router.get('/check-email', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.json({ code: 400, message: '邮箱格式错误' });
    }
    const exists = await emailExists(email);
    res.json({ code: 0, data: { exists } });
  } catch (err) {
    console.error('[Auth] 检查邮箱失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发送邮箱验证码
router.post('/send-email-code', async (req, res) => {
  try {
    const { email, captchaToken, captchaAnswer } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.json({ code: 400, message: '邮箱格式错误' });
    }

    // 人机验证
    if (!captchaToken || !captchaAnswer) {
      return res.json({ code: 400, message: '请完成人机验证' });
    }
    try {
      const decoded = jwt.verify(captchaToken, process.env.JWT_SECRET);
      if (String(captchaAnswer).toLowerCase() !== decoded.answer) {
        return res.json({ code: 400, message: '验证码错误' });
      }
    } catch {
      return res.json({ code: 400, message: '验证已过期，请重新验证' });
    }

    // 生成6位验证码
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // 存入数据库 (SMTP key 复用 smsKey 做 HMAC 哈希)
    const emailCodeHash = hashSmsCode(getSmsKey(), email, code);
    await pool.execute(
      'INSERT INTO email_codes (email, code, expires_at) VALUES (?, ?, ?)',
      [email, emailCodeHash, expiresAt]
    );

    // 发送邮件
    const smtpHost = await getSetting('smtp_host');
    const smtpPort = await getSetting('smtp_port');
    const smtpUser = await getSetting('smtp_user');
    const smtpPass = decS(await getSetting('smtp_pass'));
    const smtpFrom = await getSetting('smtp_from');

    if (smtpHost && smtpUser && smtpPass) {
      try {
        // 使用 SMTP 发送邮件 (nodemailer 可选依赖)
        let nodemailer;
        try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }
        if (!nodemailer) {
          console.log(`[Email] nodemailer 未安装，验证码(无SMTP) 发送到 ${email}: ${code}`);
        } else {
          const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(smtpPort) || 587,
            secure: parseInt(smtpPort) === 465,
            auth: { user: smtpUser, pass: smtpPass },
          });
          const sysName = await getSetting('system_name') || 'AZ-Chat';
          await transporter.sendMail({
            from: smtpUser,
            to: email,
            subject: `${sysName} 邮箱验证码`,
            text: `您的验证码是：${code}，有效期5分钟。`,
            html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px"><h2 style="color:#5D4E37">${sysName}</h2><p>您的邮箱验证码是：</p><div style="font-size:28px;font-weight:bold;color:#C8956C;letter-spacing:6px;padding:12px 20px;background:#FDFAF6;border-radius:8px;text-align:center">${code}</div><p style="color:#B0A090;font-size:13px">有效期5分钟。</p></div>`,
          });
        }
      } catch (mailErr) {
        console.error('[Email] SMTP 发送失败:', mailErr.message);
        await pool.execute('DELETE FROM email_codes WHERE email = ? AND code = ?', [email, emailCodeHash]);
        return res.json({ code: 500, message: '邮件发送失败，请检查邮箱配置' });
      }
    } else {
      // 无 SMTP 配置，仅打印验证码（开发模式）
      console.log(`[Email] 验证码(无SMTP) 发送到 ${email}: ${code}`);
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`[Email] 验证码发送到 ${email}: ${code}`);
    }

    res.json({ code: 0, message: '验证码已发送' });
  } catch (err) {
    console.error('[Email] 发送失败:', err.message);
    res.json({ code: 500, message: '发送失败' });
  }
});

// 邮箱验证码登录（自动注册）
router.post('/login-email', loginLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.json({ code: 400, message: '参数缺失' });
    }

    // 验证验证码
    const emailCodeHash = hashSmsCode(getSmsKey(), email, code);
    const [codes] = await pool.execute(
      'SELECT * FROM email_codes WHERE email = ? AND code = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
      [email, emailCodeHash]
    );

    if (codes.length === 0) {
      return res.json({ code: 400, message: '验证码错误或已过期' });
    }

    // 删除已使用的验证码
    await pool.execute('DELETE FROM email_codes WHERE email = ? AND id <= ?', [email, codes[0].id]);

    // 查找或创建用户（兼容加密前后数据）
    const users = await getUserByEmail(email);
    let user;

    if (users.length === 0) {
      // 新用户：返回临时 token 要求设置昵称
      const tempToken = jwt.sign({ email, action: 'register' }, process.env.JWT_SECRET, { expiresIn: '5m' });
      return res.json({
        code: 200,
        message: '请设置昵称',
        data: { needRegister: true, tempToken }
      });
    } else {
      user = users[0];
      if (user.is_banned) return res.json({ code: 403, message: '账号已被封禁，请联系管理员' });
    }

    await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    const { accessToken, refreshToken } = await generateTokens(user.id, res);

    res.json({
      code: 0,
      message: '登录成功',
      data: {
        token: accessToken,
        accessToken,
        refreshToken,
        user: { id: user.id, email: user.email, phone: user.phone, nickname: user.nickname, avatar: user.avatar, gender: user.gender, coins: require('../utils/wallet').decCoin(user.coins) }
      }
    });
  } catch (err) {
    console.error('[Auth] 邮箱登录失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 纯密码注册
router.post('/register-password', loginLimiter, async (req, res) => {
  try {
    const { nickname, password, captchaToken, captchaAnswer } = req.body;
    if (!nickname || !nickname.trim() || !password) {
      return res.json({ code: 400, message: '参数缺失' });
    }
    if (password.length < 6) {
      return res.json({ code: 400, message: '密码至少6位' });
    }
    if (password.length > 128) {
      return res.json({ code: 400, message: '密码过长' });
    }

    // 人机验证
    if (!captchaToken || !captchaAnswer) {
      return res.json({ code: 400, message: '请完成人机验证' });
    }
    try {
      const decoded = jwt.verify(captchaToken, process.env.JWT_SECRET);
      if (String(captchaAnswer).toLowerCase() !== decoded.answer) {
        return res.json({ code: 400, message: '验证码错误' });
      }
    } catch {
      return res.json({ code: 400, message: '验证已过期，请重新验证' });
    }

    const trimmedNickname = nickname.trim().slice(0, 20);
    const hashedPassword = await bcrypt.hash(password, 10);
    const defaultSignature = '这个人很懒，什么都没写~';

    const [result] = await pool.execute(
      'INSERT INTO users (phone, email, nickname, password, signature, level, exp, coins) VALUES (NULL, NULL, ?, ?, ?, 1, 0, 0)',
      [trimmedNickname, hashedPassword, encSignature(defaultSignature)]
    );

    const user = {
      id: result.insertId,
      nickname: trimmedNickname,
      avatar: '/default-avatar.png',
      gender: 0,
      coins: 0,
      signature: defaultSignature
    };

    // 新用户自动添加系统通知机器人
    try {
      await pool.execute('INSERT IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)', [result.insertId, SYSTEM_BOT_ID]);
      await pool.execute('INSERT IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)', [SYSTEM_BOT_ID, result.insertId]);
      await sendSystemNotify(result.insertId, `欢迎加入！您的账号 ID 是 ${result.insertId}，请妥善保管。`);
    } catch(e) {}
    try {
      await pool.execute(
        'INSERT IGNORE INTO group_members (group_id, user_id, role) SELECT id, ?, \'member\' FROM `groups` WHERE is_system = 1 AND system_mode = \'all\'',
        [result.insertId]
      );
    } catch(e) {}

    await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    const { accessToken, refreshToken } = await generateTokens(user.id, res);

    res.json({
      code: 0,
      message: '注册成功',
      data: {
        token: accessToken,
        accessToken,
        refreshToken,
        user: { id: user.id, nickname: user.nickname, avatar: user.avatar, gender: user.gender, coins: user.coins }
      }
    });
  } catch (err) {
    console.error('[Auth] 密码注册失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 辅助函数：读取 system_settings
async function getSetting(key) {
  try {
    const [[row]] = await pool.execute('SELECT `value` FROM system_settings WHERE `key` = ?', [key]);
    return row ? row.value : '';
  } catch { return ''; }
}

module.exports = router;
