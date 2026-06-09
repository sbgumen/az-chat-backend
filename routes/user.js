const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { encrypt, safeDecrypt, deterministicEncrypt, hashSmsCode, deriveKey, encEmail: encE, decEmail: decE, encSensitive, decSensitive } = require('../utils/crypto');
function encEmail(e) { return encE(e, process.env.MASTER_KEY); }
function decEmail(e) { return decE(e, process.env.MASTER_KEY); }
const { getUserWallet, addCoins, addExp, decCoin } = require('../utils/wallet');
const auth = require('../middleware/auth');
let _pk=null; let _sk=null; let _sgk=null;
function gp(){if(!_pk)_pk=deriveKey(process.env.MASTER_KEY,'phone');return _pk;}
function gsk(){if(!_sk)_sk=deriveKey(process.env.MASTER_KEY,'sms');return _sk;}
function gsg(){if(!_sgk)_sgk=deriveKey(process.env.MASTER_KEY,'signature');return _sgk;}
function ep(p){if(!p||!process.env.MASTER_KEY)return p;return deterministicEncrypt(gp(),p);}
function dc(p){const k=process.env.MASTER_KEY?gsg():null;return k?safeDecrypt(k,p):p;}
function es(s){const k=process.env.MASTER_KEY?gsg():null;return k?encrypt(k,s):s;}
function hc(phone,code){return hashSmsCode(gsk(),phone,code);}
async function userExistsByPhone(phone) {
  const [rows] = await pool.execute('SELECT id FROM users WHERE phone = ?', [ep(phone)]);
  if (rows.length > 0) return true;
  const [plain] = await pool.execute('SELECT id FROM users WHERE phone = ?', [phone]);
  return plain.length > 0;
}
const multer = require('multer');
const path = require('path');
const { SYSTEM_BOT_ID, sendSystemNotify } = require('../utils/systemNotify');
const { sendPush } = require('../utils/fcm');
const router = express.Router();

// 允许的图片 MIME 类型
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const imageFilter = (req, file, cb) => {
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('仅支持 JPG/PNG/GIF/WebP 格式的图片'), false);
  }
};

// 头像上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads/private/avatars')),
  filename: (req, file, cb) => cb(null, `avatar_${req.userId}_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFilter });

// 背景图上传配置
const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads/private/banners')),
  filename: (req, file, cb) => cb(null, `banner_${req.userId}_${Date.now()}${path.extname(file.originalname)}`)
});
const uploadBanner = multer({ storage: bannerStorage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: imageFilter });

// 获取其他用户的公开资料
router.get('/profile/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const targetId = parseInt(userId);
    const [users] = await pool.execute(
      'SELECT id, nickname, avatar, gender, weight, height, birthday, signature, tags, privacy, level, exp, banner_type, banner_preset, banner_image, lv30_style, chat_style, last_seen, hide_online_status FROM users WHERE id = ?',
      [targetId]
    );
    if (users.length === 0) return res.json({ code: 404, message: '用户不存在' });

    const user = users[0];
    const privacy = user.privacy ? JSON.parse(user.privacy) : {};

    // Get followers/following counts
    const [[{ fc }]] = await pool.execute('SELECT COUNT(*) as fc FROM follows WHERE following_id = ?', [targetId]);
    const [[{ fgc }]] = await pool.execute('SELECT COUNT(*) as fgc FROM follows WHERE follower_id = ?', [targetId]);

    // Check if current user follows this user
    const [followCheck] = await pool.execute('SELECT id FROM follows WHERE follower_id = ? AND following_id = ?', [req.userId, targetId]);

    // Check if friends
    const [friendCheck] = await pool.execute('SELECT id FROM contacts WHERE user_id = ? AND friend_id = ?', [req.userId, targetId]);

    const publicProfile = {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      signature: user.signature || '',
      tags: user.tags ? JSON.parse(user.tags) : [],
      level: decCoin(user.level),
      banner_type: user.banner_type || 'default',
      banner_preset: user.banner_preset || null,
      banner_image: user.banner_image || null,
      followers: fc || 0,
      following: fgc || 0,
      is_followed: followCheck.length > 0,
      is_friend: friendCheck.length > 0,
      allowDmFromStranger: privacy.allowDmFromStranger !== false,
      lv30_style: user.lv30_style || 'original',
      last_seen: user.hide_online_status ? null : user.last_seen,
    };

    if (privacy.gender !== false) publicProfile.gender = user.gender;
    if (privacy.weight !== false) publicProfile.weight = user.weight;
    if (privacy.height !== false) publicProfile.height = user.height;
    if (privacy.birthday !== false) publicProfile.birthday = user.birthday;
    if (publicProfile.signature !== undefined) publicProfile.signature = dc(publicProfile.signature);

    res.json({ code: 0, data: publicProfile });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取当前用户信息
router.get('/profile', auth, async (req, res) => {
  try {
    const [users] = await pool.execute('SELECT id, phone, email, nickname, avatar, gender, weight, height, birthday, coins, level, exp, followers, following, signature, tags, privacy, role, banner_type, banner_preset, banner_image, lv30_style, chat_style, last_seen, hide_online_status, password IS NOT NULL as has_password, email IS NOT NULL as has_email, created_at FROM users WHERE id = ?', [req.userId]);
    if (users.length === 0) return res.json({ code: 404, message: '用户不存在' });
    const profile = users[0];
    profile.phone = safeDecrypt(gp(), profile.phone) || profile.phone;
    profile.signature = dc(profile.signature);
    profile.email = decEmail(profile.email);
    const { decCoin } = require('../utils/wallet');
    profile.coins = decCoin(profile.coins);
    profile.exp = decCoin(profile.exp);
    profile.level = decCoin(profile.level);
    res.json({ code: 0, data: profile });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 根据ID或手机号搜索用户
router.get('/search', auth, async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword) return res.json({ code: 400, message: '请输入搜索内容' });
    const [users] = await pool.execute(
      'SELECT id, nickname, avatar, gender FROM users WHERE (id = ? OR phone = ? OR nickname LIKE ?) AND id != ? AND id != ?',
      [isNaN(parseInt(keyword)) ? 0 : parseInt(keyword), ep(keyword), `%${keyword}%`, req.userId, SYSTEM_BOT_ID]
    );
    res.json({ code: 0, data: users });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新用户信息
router.put('/profile', auth, async (req, res) => {
  try {
    const { nickname, gender, weight, height, birthday, signature, tags, privacy, hide_online_status, email } = req.body;
    const fields = [];
    const values = [];
    if (nickname !== undefined) { fields.push('nickname = ?'); values.push(nickname); }
    if (gender !== undefined) { fields.push('gender = ?'); values.push(gender); }
    if (weight !== undefined) { fields.push('weight = ?'); values.push(weight); }
    if (height !== undefined) { fields.push('height = ?'); values.push(height); }
    if (birthday !== undefined) { fields.push('birthday = ?'); values.push(birthday); }
    if (signature !== undefined) { fields.push('signature = ?'); values.push(es(signature)); }
    if (tags !== undefined) { fields.push('tags = ?'); values.push(typeof tags === 'string' ? tags : JSON.stringify(tags)); }
    if (privacy !== undefined) { fields.push('privacy = ?'); values.push(typeof privacy === 'string' ? privacy : JSON.stringify(privacy)); }
    if (hide_online_status !== undefined) { fields.push('hide_online_status = ?'); values.push(hide_online_status ? 1 : 0); }
    if (email !== undefined) { fields.push('email = ?'); values.push(encEmail(email)); }
    if (fields.length === 0) return res.json({ code: 400, message: '无更新内容' });
    values.push(req.userId);
    await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    // 隐身开关变更时广播状态
    if (hide_online_status !== undefined) {
      const io = req.app.get('io');
      const onlineUsers = req.app.get('onlineUsers');
      const isOnline = onlineUsers.has(req.userId);
      if (isOnline) {
        const [[{ friend_ids }]] = await pool.execute(
          'SELECT GROUP_CONCAT(friend_id) as friend_ids FROM contacts WHERE user_id = ?', [req.userId]
        );
        const status = hide_online_status ? 'offline' : 'online';
        if (friend_ids) {
          friend_ids.split(',').forEach(fid => {
            const sid = onlineUsers.get(parseInt(fid));
            if (sid) io.to(sid).emit('user:status', { userId: req.userId, status });
          });
        }
      }
    }
    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 上传头像
router.put('/avatar', auth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '请选择图片' });
    const avatarUrl = `/uploads/private/avatars/${req.file.filename}`;
    await pool.execute('UPDATE users SET avatar = ? WHERE id = ?', [avatarUrl, req.userId]);
    res.json({ code: 0, data: { avatar: avatarUrl } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 设置/修改密码（支持旧密码直接修改、验证码重置）
router.post('/password', auth, async (req, res) => {
  try {
    const { oldPassword, code, codeType, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.json({ code: 400, message: '密码至少6位' });
    if (newPassword.length > 128) return res.json({ code: 400, message: '密码过长' });

    const [[user]] = await pool.execute('SELECT phone, email, password FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.json({ code: 404, message: '用户不存在' });

    // 已有密码的修改：支持旧密码直接修改，或验证码重置
    if (user.password) {
      if (oldPassword) {
        // 路径1：旧密码直接修改
        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) return res.json({ code: 400, message: '旧密码错误' });
      } else if (code) {
        // 路径2：验证码重置（忘记密码），需指定 phone 或 email
        if (!codeType || !['phone','email'].includes(codeType)) return res.json({ code: 400, message: '请指定验证方式' });
        if (codeType === 'phone') {
          const plainPhone = safeDecrypt(gp(), user.phone) || user.phone;
          if (!plainPhone) return res.json({ code: 400, message: '未绑定手机号' });
          const [[{ cnt }]] = await pool.execute(
            'SELECT COUNT(*) as cnt FROM sms_codes WHERE phone = ? AND code = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
            [plainPhone, hc(plainPhone, code)]
          );
          if (cnt === 0) return res.json({ code: 400, message: '验证码错误或已过期' });
          await pool.execute('DELETE FROM sms_codes WHERE phone = ?', [plainPhone]);
        } else {
          if (!user.email) return res.json({ code: 400, message: '未绑定邮箱' });
          const { hashSmsCode, deriveKey } = require('../utils/crypto');
          const smsKey = deriveKey(process.env.MASTER_KEY, 'sms');
          const emailHash = hashSmsCode(smsKey, user.email, code);
          const [[{ cnt }]] = await pool.execute(
            'SELECT COUNT(*) as cnt FROM email_codes WHERE email = ? AND code = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
            [user.email, emailHash]
          );
          if (cnt === 0) return res.json({ code: 400, message: '验证码错误或已过期' });
          await pool.execute('DELETE FROM email_codes WHERE email = ?', [user.email]);
        }
      } else {
        return res.json({ code: 400, message: '请输入旧密码或验证码' });
      }
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.userId]);

    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    await sendSystemNotify(req.userId, '您的登录密码已成功修改。如非本人操作，请立即联系客服。', io, onlineUsers);
    res.json({ code: 0, message: '密码修改成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取密码修改选项（支持的验证方式 + 绑定状态）
router.get('/password-options', auth, async (req, res) => {
  try {
    const [[user]] = await pool.execute('SELECT phone, email, password FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.json({ code: 404, message: '用户不存在' });
    const plainPhone = safeDecrypt(gp(), user.phone) || user.phone || '';
    res.json({ code: 0, data: {
      hasPassword: !!user.password,
      hasPhone: !!plainPhone,
      hasEmail: !!decEmail(user.email),
      phone: plainPhone ? plainPhone.slice(0, 3) + '****' + plainPhone.slice(-4) : '',
      email: decEmail(user.email) || '',
    }});
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 换绑手机号
router.post('/rebind-phone', auth, async (req, res) => {
  try {
    const { newPhone, code } = req.body;
    if (!newPhone || !code) return res.json({ code: 400, message: '参数不完整' });
    if (!/^1[3-9]\d{9}$/.test(newPhone)) return res.json({ code: 400, message: '手机号格式不正确' });

    // 检查新手机号是否已被注册（兼容加密前后数据）
    const exists = await userExistsByPhone(newPhone);
    if (exists) return res.json({ code: 400, message: '该手机号已被其他账号绑定' });

    // 验证短信验证码
    const [[{ cnt }]] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM sms_codes WHERE phone = ? AND code = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
      [newPhone, hc(newPhone, code)]
    );
    if (cnt === 0) return res.json({ code: 400, message: '验证码错误或已过期' });

    // 更新手机号
    await pool.execute('UPDATE users SET phone = ? WHERE id = ?', [ep(newPhone), req.userId]);
    await pool.execute('DELETE FROM sms_codes WHERE phone = ?', [newPhone]);

    res.json({ code: 0, message: '手机号换绑成功', data: { phone: newPhone } });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 绑定手机号（无手机号用户首次绑定）
router.post('/bind-phone', auth, async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.json({ code: 400, message: '参数不完整' });
    if (!/^1[3-9]\d{9}$/.test(phone)) return res.json({ code: 400, message: '手机号格式不正确' });

    // 检查该手机号是否已被其他账号绑定
    const exists = await userExistsByPhone(phone);
    if (exists) return res.json({ code: 400, message: '该手机号已被其他账号绑定' });

    // 验证短信验证码
    const [[{ cnt }]] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM sms_codes WHERE phone = ? AND code = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
      [phone, hc(phone, code)]
    );
    if (cnt === 0) return res.json({ code: 400, message: '验证码错误或已过期' });

    // 更新手机号
    await pool.execute('UPDATE users SET phone = ? WHERE id = ?', [ep(phone), req.userId]);
    await pool.execute('DELETE FROM sms_codes WHERE phone = ?', [phone]);

    res.json({ code: 0, message: '手机号绑定成功', data: { phone } });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 绑定/换绑邮箱
router.post('/bind-email', auth, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.json({ code: 400, message: '参数不完整' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ code: 400, message: '邮箱格式不正确' });

    // 检查该邮箱是否已被其他账号绑定
    const [existRows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existRows.length > 0) return res.json({ code: 400, message: '该邮箱已被其他账号绑定' });

    // 验证邮箱验证码 (复用 sms key 的 HMAC)
    const { hashSmsCode, deriveKey } = require('../utils/crypto');
    const smsKey = deriveKey(process.env.MASTER_KEY, 'sms');
    const emailCodeHash = hashSmsCode(smsKey, email, code);
    const [[{ cnt }]] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM email_codes WHERE email = ? AND code = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
      [email, emailCodeHash]
    );
    if (cnt === 0) return res.json({ code: 400, message: '验证码错误或已过期' });

    // 更新邮箱
    await pool.execute('UPDATE users SET email = ? WHERE id = ?', [encEmail(email), req.userId]);
    await pool.execute('DELETE FROM email_codes WHERE email = ?', [email]);

    res.json({ code: 0, message: '邮箱绑定成功', data: { email } });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 每日签到
router.post('/sign-in', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [existing] = await pool.execute(
      'SELECT id FROM sign_in_records WHERE user_id = ? AND sign_date = ?',
      [req.userId, today]
    );
    if (existing.length > 0) return res.json({ code: 400, message: '今日已签到' });

    const [[cfg]] = await pool.execute("SELECT `value` FROM system_settings WHERE `key` = 'exp_signin'").catch(() => [[null]]);
    const expGain = cfg ? parseInt(cfg.value) : 50;

    await pool.execute('INSERT INTO sign_in_records (user_id, sign_date, exp_gained) VALUES (?, ?, ?)', [req.userId, today, expGain]);
    const expResult = await addExp(req.userId, expGain, 'signin', { date: today });
    const coinResult = await addCoins(req.userId, 1, 'signin', { date: today });

    const wallet = await getUserWallet(req.userId);
    res.json({
      code: 0, message: '签到成功',
      data: {
        exp: wallet.exp, level: wallet.level, expGain,
        coinsGained: 1 + (expResult.levelCoins || 0),
        coins: wallet.coins,
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 关注用户
router.post('/follow/:userId', auth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.userId);
    if (targetId === req.userId) return res.json({ code: 400, message: '不能关注自己' });

    const [result] = await pool.execute(
      'INSERT IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)',
      [req.userId, targetId]
    );
    // 如果 INSERT 成功（affectedRows > 0），发送通知
    if (result.affectedRows > 0) {
      // Update counts
      await pool.execute('UPDATE users SET following = (SELECT COUNT(*) FROM follows WHERE follower_id = ?) WHERE id = ?', [req.userId, req.userId]);
      await pool.execute('UPDATE users SET followers = (SELECT COUNT(*) FROM follows WHERE following_id = ?) WHERE id = ?', [targetId, targetId]);

      // 关注加经验（每天上限，防刷）
      const { getExpConfig } = require('../utils/wallet');
      getExpConfig().then(async cfg => {
        if (!cfg._enabled.exp_follow) return;
        const today = new Date().toISOString().split('T')[0];
        const [[sameday]] = await pool.execute(
          'SELECT id FROM follow_exp_records WHERE user_id = ? AND record_date = ?',
          [req.userId, today]
        );
        if (sameday) return;
        await pool.execute('INSERT INTO follow_exp_records (user_id, record_date, target_id) VALUES (?, ?, ?)', [req.userId, today, targetId]);
        addExp(req.userId, cfg.exp_follow, 'follow', { targetId });
      }).catch(() => {});

      // 写入通知 + 实时推送
      const [fromUser] = await pool.execute('SELECT nickname, avatar FROM users WHERE id = ?', [req.userId]);
      await pool.execute('INSERT INTO moment_notifications (owner_id, from_user_id, type) VALUES (?, ?, ?)', [targetId, req.userId, 'follow']);
      const io = req.app.get('io'), onlineUsers = req.app.get('onlineUsers');
      const targetSid = onlineUsers?.get(targetId);
      if (io && targetSid) {
        io.to(targetSid).emit('moment:notification', { type: 'follow', fromUserId: req.userId });
      } else {
        const [[u]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [targetId]);
        if (u?.fcm_token) {
          await sendPush(u.fcm_token, '新关注', `${fromUser[0]?.nickname || '有人'} 关注了你`, { type: 'follow' });
        }
      }
    }

    res.json({ code: 0, message: '关注成功' });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 取消关注
router.post('/unfollow/:userId', auth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.userId);
    await pool.execute('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [req.userId, targetId]);
    // Update counts
    await pool.execute('UPDATE users SET following = (SELECT COUNT(*) FROM follows WHERE follower_id = ?) WHERE id = ?', [req.userId, req.userId]);
    await pool.execute('UPDATE users SET followers = (SELECT COUNT(*) FROM follows WHERE following_id = ?) WHERE id = ?', [targetId, targetId]);

    res.json({ code: 0, message: '已取消关注' });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取关注列表
router.get('/following', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar, u.signature,
        1 as is_followed,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND following_id = ?) as follows_me
       FROM follows f
       JOIN users u ON u.id = f.following_id
       WHERE f.follower_id = ?`,
      [req.userId, req.userId]
    );
    const decRows = rows.map(r => ({ ...r, level: decCoin(r.level), signature: dc(r.signature) }));
    res.json({ code: 0, data: decRows });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取粉丝列表
router.get('/followers', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar, u.signature,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND following_id = u.id) as is_followed,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND following_id = ?) as follows_me
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       WHERE f.following_id = ?`,
      [req.userId, req.userId, req.userId]
    );
    const decRows = rows.map(r => ({ ...r, signature: dc(r.signature) }));
    res.json({ code: 0, data: decRows });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 批量查询用户在线状态
router.get('/online-status', auth, async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) return res.json({ code: 400, message: '缺少ids参数' });
    const userIds = ids.split(',').map(Number).filter(n => n && n !== SYSTEM_BOT_ID);
    if (userIds.length === 0) return res.json({ code: 0, data: {} });
    const onlineUsers = req.app.get('onlineUsers');
    const result = {};
    // 批量查询隐身状态
    const [rows] = await pool.execute(
      `SELECT id, hide_online_status, last_seen FROM users WHERE id IN (${userIds.join(',')})`
    );
    for (const r of rows) {
      if (r.hide_online_status) {
        result[r.id] = { isHidden: true };
      } else if (onlineUsers.has(r.id)) {
        result[r.id] = { online: true };
      } else {
        result[r.id] = { online: false, lastSeen: r.last_seen };
      }
    }
    // 补充未查询到的用户（可能不存在）
    for (const id of userIds) {
      if (!result[id]) result[id] = { online: false };
    }
    res.json({ code: 0, data: result });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取指定用户的关注列表
router.get('/:userId/following', auth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.userId);
    // 隐私检查：自己看自己始终允许
    if (targetId !== req.userId) {
      const [[target]] = await pool.execute('SELECT privacy FROM users WHERE id = ?', [targetId]);
      const privacy = target?.privacy ? JSON.parse(target.privacy) : {};
      if (privacy.following === false) {
        return res.json({ code: 403, message: '对方设置了关注列表不可见' });
      }
    }
    const [rows] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar, u.signature,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND following_id = u.id) as is_followed,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND following_id = ?) as follows_me
       FROM follows f
       JOIN users u ON u.id = f.following_id
       WHERE f.follower_id = ?`,
      [req.userId, req.userId, targetId]
    );
    const decRows = rows.map(r => ({ ...r, signature: dc(r.signature) }));
    res.json({ code: 0, data: decRows });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取指定用户的粉丝列表
router.get('/:userId/followers', auth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.userId);
    if (targetId !== req.userId) {
      const [[target]] = await pool.execute('SELECT privacy FROM users WHERE id = ?', [targetId]);
      const privacy = target?.privacy ? JSON.parse(target.privacy) : {};
      if (privacy.followers === false) {
        return res.json({ code: 403, message: '对方设置了粉丝列表不可见' });
      }
    }
    const [rows] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar, u.signature,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND following_id = u.id) as is_followed,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND following_id = ?) as follows_me
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       WHERE f.following_id = ?`,
      [req.userId, req.userId, targetId]
    );
    const decRows = rows.map(r => ({ ...r, signature: dc(r.signature) }));
    res.json({ code: 0, data: decRows });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取等级信息
router.get('/level', auth, async (req, res) => {
  try {
    const [users] = await pool.execute('SELECT level, exp FROM users WHERE id = ?', [req.userId]);
    if (users.length === 0) return res.json({ code: 404, message: '用户不存在' });

    const today = new Date().toISOString().split('T')[0];
    const [signRecord] = await pool.execute(
      'SELECT id FROM sign_in_records WHERE user_id = ? AND sign_date = ?',
      [req.userId, today]
    );

    // 今日消息经验进度
    const [[msgRec]] = await pool.execute(
      'SELECT COALESCE(cnt, 0) as cnt FROM message_exp_records WHERE user_id = ? AND record_date = ?',
      [req.userId, today]
    );

    // 读取配置
    const [cfgRows] = await pool.execute(
      "SELECT `key`, `value` FROM system_settings WHERE `key` IN ('exp_signin','exp_message','exp_add_friend','exp_message_daily_limit')"
    ).catch(() => [[]]);
    const cfg = { exp_signin: 50, exp_message: 2, exp_add_friend: 30, exp_message_daily_limit: 50 };
    cfgRows.forEach(r => { cfg[r.key] = parseInt(r.value); });

    const { decCoin } = require('../utils/wallet');
    const exp = decCoin(users[0].exp);
    const lv = decCoin(users[0].level) || (Math.floor(exp / 100) + 1);
    res.json({ code: 0, data: {
      level: lv, exp,
      nextLevelExp: lv * 100,
      signedToday: signRecord.length > 0,
      msgTodayCnt: msgRec ? msgRec.cnt : 0,
      cfg,
    }});
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 推荐用户（随机3个高等级，排除自己和已是好友的）
router.get('/recommend/users', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar, u.level FROM users u
       WHERE u.id != ?
         AND u.id NOT IN (SELECT friend_id FROM contacts WHERE user_id = ?)
       ORDER BY RAND() LIMIT 3`,
      [req.userId, req.userId]
    );
    const decRows = rows.map(r => ({ ...r, level: decCoin(r.level) }));
    res.json({ code: 0, data: decRows });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 推荐群聊（随机3个人数最多的）
router.get('/recommend/groups', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT g.id, g.name, g.avatar,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
       FROM \`groups\` g
       WHERE g.id NOT IN (SELECT group_id FROM group_members WHERE user_id = ?)
       ORDER BY member_count DESC, RAND() LIMIT 3`,
      [req.userId]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 好友等级排名
router.get('/level/ranking', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar, u.level, COALESCE(u.exp, 0) as exp_raw
       FROM contacts c JOIN users u ON c.friend_id = u.id
       WHERE c.user_id = ? AND u.id != 9999
       ORDER BY u.level DESC, u.exp DESC LIMIT 20`,
      [req.userId]
    );
    const [me] = await pool.execute('SELECT id, nickname, avatar, level, exp FROM users WHERE id = ?', [req.userId]);
    const decRows = rows.map(r => ({ ...r, level: decCoin(r.level), exp: decCoin(r.exp_raw || r.exp) })).sort((a, b) => b.level - a.level || b.exp - a.exp);
    const decMe = me[0] ? { ...me[0], level: decCoin(me[0].level), exp: decCoin(me[0].exp) } : null;
    res.json({ code: 0, data: decRows, me: decMe });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 世界等级排名（全站）
router.get('/level/ranking/global', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, nickname, avatar, GREATEST(COALESCE(level, 1), 1) as level, COALESCE(exp, 0) as exp
       FROM users WHERE id != 9999 AND id != ?
       ORDER BY level DESC, exp DESC LIMIT 50`,
      [req.userId]
    );
    const [me] = await pool.execute('SELECT id, nickname, avatar, level, exp FROM users WHERE id = ?', [req.userId]);
    const decRows = rows.map(r => ({ ...r, level: decCoin(r.level), exp: decCoin(r.exp_raw || r.exp) })).sort((a, b) => b.level - a.level || b.exp - a.exp);
    const decMe = me[0] ? { ...me[0], level: decCoin(me[0].level), exp: decCoin(me[0].exp) } : null;
    res.json({ code: 0, data: decRows, me: decMe });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 人气排行榜 — 好友榜
router.get('/ranking/popular', auth, async (req, res) => {
  try {
    const [list] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar, u.level, u.followers
       FROM contacts c JOIN users u ON c.friend_id = u.id
       WHERE c.user_id = ? AND u.id != 9999
       ORDER BY u.followers DESC LIMIT 20`,
      [req.userId]
    );
    const [meRows] = await pool.execute('SELECT id, nickname, avatar, level, followers FROM users WHERE id = ?', [req.userId]);
    res.json({ code: 0, data: list, me: meRows[0] || null });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 人气排行榜 — 世界榜（全站）
router.get('/ranking/popular/global', auth, async (req, res) => {
  try {
    const [list] = await pool.execute(
      'SELECT id, nickname, avatar, level, followers FROM users WHERE id != 9999 AND id != ? ORDER BY followers DESC LIMIT 50',
      [req.userId]
    );
    const [meRows] = await pool.execute('SELECT id, nickname, avatar, level, followers FROM users WHERE id = ?', [req.userId]);
    res.json({ code: 0, data: list, me: meRows[0] || null });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发消息加经验（每条+N，每日上限从配置读取）
router.post('/exp/message', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // 读取配置
    const [cfgRows] = await pool.execute(
      "SELECT `key`, `value` FROM system_settings WHERE `key` IN ('exp_message', 'exp_message_daily_limit')"
    );
    const cfg = { exp_message: 2, exp_message_daily_limit: 50 };
    cfgRows.forEach(r => { cfg[r.key] = parseInt(r.value); });

    // 检查今日已获经验次数
    const [[rec]] = await pool.execute(
      'SELECT COALESCE(cnt, 0) as cnt FROM message_exp_records WHERE user_id = ? AND record_date = ?',
      [req.userId, today]
    );
    const todayCnt = rec ? rec.cnt : 0;
    if (todayCnt >= cfg.exp_message_daily_limit) {
      return res.json({ code: 0, data: { limited: true, todayCnt, dailyLimit: cfg.exp_message_daily_limit } });
    }

    // 原子更新计数
    const [insRes] = await pool.execute(
      'INSERT INTO message_exp_records (user_id, record_date, cnt) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE cnt = IF(cnt < ?, cnt + 1, cnt)',
      [req.userId, today, cfg.exp_message_daily_limit]
    );
    if (insRes.affectedRows === 0) {
      return res.json({ code: 0, data: { limited: true, dailyLimit: cfg.exp_message_daily_limit } });
    }

    const result = await addExp(req.userId, cfg.exp_message, 'message_rest', { date: today });
    const wallet = await getUserWallet(req.userId);
    res.json({ code: 0, data: { limited: false, exp: wallet.exp, level: wallet.level, expGain: cfg.exp_message, dailyLimit: cfg.exp_message_daily_limit, coins: wallet.coins } });
  } catch (err) {
    console.error('[Exp] message error:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 保存 FCM device token
router.post('/fcm-token', auth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.json({ code: 400, message: '参数错误' });
  await pool.execute('UPDATE users SET fcm_token = ? WHERE id = ?', [token, req.userId]);
  res.json({ code: 0 });
});

// 上传背景图
router.post('/banner', auth, uploadBanner.single('banner'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '请选择图片' });
    const bannerUrl = `/uploads/private/banners/${req.file.filename}`;
    res.json({ code: 0, data: { url: bannerUrl } });
  } catch (err) {
    res.json({ code: 500, message: '上传失败' });
  }
});

// 保存背景图设置
router.put('/banner-settings', auth, async (req, res) => {
  try {
    const { banner_type, banner_preset, banner_image } = req.body;
    if (!banner_type || !['default', 'preset', 'custom'].includes(banner_type)) {
      return res.json({ code: 400, message: '参数错误' });
    }
    await pool.execute(
      'UPDATE users SET banner_type = ?, banner_preset = ?, banner_image = ? WHERE id = ?',
      [banner_type, banner_preset || null, banner_image || null, req.userId]
    );
    res.json({ code: 0, message: '背景设置已更新' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取/保存自定义背景图URL列表
router.get('/banner-custom-urls', auth, async (req, res) => {
  try {
    const [[user]] = await pool.execute('SELECT banner_custom_urls FROM users WHERE id = ?', [req.userId]);
    const urls = user?.banner_custom_urls ? JSON.parse(user.banner_custom_urls) : [];
    res.json({ code: 0, data: urls });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/banner-custom-urls', auth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.json({ code: 400, message: '参数错误' });
    const [[user]] = await pool.execute('SELECT banner_custom_urls FROM users WHERE id = ?', [req.userId]);
    const urls = user?.banner_custom_urls ? JSON.parse(user.banner_custom_urls) : [];
    // 去重，新URL放最前，最多保留5个
    const filtered = urls.filter((u) => u !== url);
    filtered.unshift(url);
    const saved = JSON.stringify(filtered.slice(0, 5));
    await pool.execute('UPDATE users SET banner_custom_urls = ? WHERE id = ?', [saved, req.userId]);
    res.json({ code: 0, data: filtered.slice(0, 5) });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/banner-custom-urls', auth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.json({ code: 400, message: '参数错误' });
    const [[user]] = await pool.execute('SELECT banner_custom_urls FROM users WHERE id = ?', [req.userId]);
    const urls = user?.banner_custom_urls ? JSON.parse(user.banner_custom_urls) : [];
    const filtered = urls.filter((u) => u !== url);
    await pool.execute('UPDATE users SET banner_custom_urls = ? WHERE id = ?', [JSON.stringify(filtered), req.userId]);
    res.json({ code: 0, data: filtered });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取/设置 LV30 主页风格
router.get('/lv30-style', auth, async (req, res) => {
  try {
    const [[user]] = await pool.execute('SELECT lv30_style FROM users WHERE id = ?', [req.userId]);
    res.json({ code: 0, data: { style: user?.lv30_style || 'crystal' } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/lv30-style', auth, async (req, res) => {
  try {
    const { style } = req.body;
    const valid = ['original', 'golden', 'sakura', 'crystal', 'aurora', 'neon'];
    if (!valid.includes(style)) return res.json({ code: 400, message: '无效的风格' });
    await pool.execute('UPDATE users SET lv30_style = ? WHERE id = ?', [style, req.userId]);
    res.json({ code: 0, message: '风格已更新' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ====== 聊天风格设置 ======
router.get('/chat-style', auth, async (req, res) => {
  try {
    const [[user]] = await pool.execute('SELECT chat_style FROM users WHERE id = ?', [req.userId]);
    res.json({ code: 0, data: { style: user?.chat_style || 'latte' } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/chat-style', auth, async (req, res) => {
  try {
    const { style } = req.body;
    const valid = ['latte', 'mocha', 'morning', 'linen', 'qq', 'wechat'];
    if (!valid.includes(style)) return res.json({ code: 400, message: '无效的风格' });
    await pool.execute('UPDATE users SET chat_style = ? WHERE id = ?', [style, req.userId]);
    res.json({ code: 0, message: '风格已更新' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ====== 关注动态未读数 ======
router.get('/follow-feed-unread', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT unread_count FROM follow_feed_unread WHERE user_id = ?', [req.userId]);
    res.json({ code: 0, data: { count: rows.length > 0 ? rows[0].unread_count : 0 } });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

router.post('/follow-feed-unread/clear', auth, async (req, res) => {
  try {
    await pool.execute('INSERT INTO follow_feed_unread (user_id, unread_count) VALUES (?, 0) ON DUPLICATE KEY UPDATE unread_count = 0', [req.userId]);
    res.json({ code: 0 });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// 获取所有活跃的Banner预设
router.get('/presets', async (req, res) => {
  try {
    const [presets] = await pool.execute(
      'SELECT * FROM banner_presets WHERE is_active = 1 ORDER BY sort_order'
    );
    res.json({ code: 0, data: presets });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取等级规则和经验配置
router.get('/level-rules', async (req, res) => {
  try {
    const [levelConfig] = await pool.execute('SELECT * FROM level_config ORDER BY level');
    const [cfgRows] = await pool.execute(
      `SELECT \`key\`, \`value\` FROM system_settings WHERE \`key\` IN (
        'exp_signin', 'exp_message', 'exp_group_message', 'exp_moment',
        'exp_comment', 'exp_like', 'exp_follow', 'exp_add_friend',
        'exp_message_daily_limit', 'exp_interaction_daily_limit'
      ) OR \`key\` IN (
        'exp_signin_enabled', 'exp_message_enabled', 'exp_group_message_enabled',
        'exp_moment_enabled', 'exp_comment_enabled', 'exp_like_enabled',
        'exp_follow_enabled', 'exp_add_friend_enabled'
      )`
    );
    const expConfig = {};
    cfgRows.forEach(row => {
      expConfig[row.key] = parseInt(row.value);
    });
    res.json({ code: 0, data: { rules: levelConfig, exp_config: expConfig } });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
