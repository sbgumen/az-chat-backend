const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { encrypt, safeDecrypt, deterministicEncrypt, deriveKey, encEmail: encE, decEmail: decE, encSensitive, decSensitive } = require('../utils/crypto');
function encEmail(e) { return encE(e, process.env.MASTER_KEY); }
function decEmail(e) { return decE(e, process.env.MASTER_KEY); }
function encSP(e) { return encSensitive(e, process.env.MASTER_KEY); }
function decSP(e) { return decSensitive(e, process.env.MASTER_KEY); }
const { decCoin, encNum } = require('../utils/wallet');
const auth = require('../middleware/auth');
const { auditLog } = require('../utils/auditLog');
let _apk=null; let _asgk=null;
function ap(){if(!_apk)_apk=deriveKey(process.env.MASTER_KEY,'phone');return _apk;}
function asg(){if(!_asgk)_asgk=deriveKey(process.env.MASTER_KEY,'signature');return _asgk;}
function aep(p){if(!p||!process.env.MASTER_KEY)return p;return deterministicEncrypt(ap(),p);}
function aes(s){const k=process.env.MASTER_KEY?asg():null;return k?encrypt(k,s):s;}
let _mk=null; function getMomentKey(){if(!_mk)_mk=deriveKey(process.env.MASTER_KEY,'moment');return _mk;}
function decMomentContent(c){const k=process.env.MASTER_KEY?getMomentKey():null;return k?safeDecrypt(k,c):c;}
async function adminUserExistsByPhone(phone) {
  const [rows] = await pool.execute('SELECT id FROM users WHERE phone = ?', [aep(phone)]);
  if (rows.length > 0) return true;
  const [plain] = await pool.execute('SELECT id FROM users WHERE phone = ?', [phone]);
  return plain.length > 0;
}
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Admin 权限中间件
async function adminAuth(req, res, next) {
  try {
    const [rows] = await pool.execute('SELECT role FROM users WHERE id = ?', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') {
      return res.json({ code: 403, message: '无权限' });
    }
    next();
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
    filename: (req, file, cb) => cb(null, `logo_${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('只允许图片'));
  },
});

// Presets 上传配置（独立 uploads/private/banners/）
const presetUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads/private/banners')),
    filename: (req, file, cb) => cb(null, `preset_${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('只允许图片'));
  },
});

// ── 仪表盘统计 ──────────────────────────────────────────────
router.get('/dashboard', auth, adminAuth, async (req, res) => {
  try {
    const [
      [[{ totalUsers }]],
      [[{ todayUsers }]],
      [[{ totalMessages }]],
      [[{ todayMessages }]],
      [[{ totalGroupMessages }]],
      [[{ todayGroupMessages }]],
      [[{ totalMoments }]],
      [[{ todayMoments }]],
      [[{ totalGroups }]],
      [recentLogins],
    ] = await Promise.all([
      pool.execute('SELECT COUNT(*) as totalUsers FROM users WHERE id != 9999'),
      pool.execute('SELECT COUNT(*) as todayUsers FROM users WHERE id != 9999 AND DATE(created_at) = CURDATE()'),
      pool.execute('SELECT COUNT(*) as totalMessages FROM messages'),
      pool.execute('SELECT COUNT(*) as todayMessages FROM messages WHERE DATE(created_at) = CURDATE()'),
      pool.execute('SELECT COUNT(*) as totalGroupMessages FROM group_messages'),
      pool.execute('SELECT COUNT(*) as todayGroupMessages FROM group_messages WHERE DATE(created_at) = CURDATE()'),
      pool.execute('SELECT COUNT(*) as totalMoments FROM moments'),
      pool.execute('SELECT COUNT(*) as todayMoments FROM moments WHERE DATE(created_at) = CURDATE()'),
      pool.execute('SELECT COUNT(*) as totalGroups FROM `groups`'),
      pool.execute('SELECT id, nickname, avatar, level, last_login FROM users WHERE id != 9999 AND last_login IS NOT NULL ORDER BY last_login DESC LIMIT 10'),
    ]);

    const onlineUsers = req.app.get('onlineUsers');
    const onlineCount = onlineUsers ? onlineUsers.size : 0;
    const decLogins = recentLogins.map(r => ({ ...r, level: decCoin(r.level) }));

    res.json({
      code: 0,
      data: {
        totalUsers,
        todayUsers,
        totalMessages,
        todayMessages,
        totalGroupMessages,
        todayGroupMessages,
        totalMoments,
        todayMoments,
        totalGroups,
        onlineCount,
        recentLogins: decLogins,
      },
    });
  } catch (e) {
    console.error('[Admin] GET /dashboard error:', e.message, e.stack);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 基础设置 ──────────────────────────────────────────────
router.get('/settings', auth, adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT `key`, `value` FROM system_settings');
    const settings = {};
    const sensitiveKeys = ['sms_template_id', 'smtp_pass'];
    rows.forEach(r => {
      if (sensitiveKeys.includes(r.key)) {
        // 不回显敏感值，仅标记是否已配置
        settings[r.key + '_set'] = r.value ? '1' : '0';
      } else {
        settings[r.key] = r.value;
      }
    });
    res.json({ code: 0, data: settings });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/settings', auth, adminAuth, async (req, res) => {
  try {
    const {
      system_name,
      reg_enabled,
      maintenance_msg,
      default_avatar,
      default_group_avatar,
      login_method_password,
      login_method_phone,
      login_method_email,
      sms_template_id,
      sms_template_url,
      sms_code_length,
      sms_code_expire,
      smtp_host,
      smtp_port,
      smtp_user,
      smtp_pass,
      smtp_from,
    } = req.body;

    const updates = {};

    if (system_name !== undefined) {
      if (typeof system_name !== 'string' || system_name.length > 30) {
        return res.json({ code: 400, message: '系统名称不合法' });
      }
      updates.system_name = system_name;
    }
    if (reg_enabled !== undefined) {
      updates.reg_enabled = reg_enabled ? '1' : '0';
    }
    if (maintenance_msg !== undefined) {
      if (typeof maintenance_msg !== 'string' || maintenance_msg.length > 200) {
        return res.json({ code: 400, message: '维护消息过长' });
      }
      updates.maintenance_msg = maintenance_msg;
    }
    if (default_avatar !== undefined) {
      if (typeof default_avatar !== 'string' || default_avatar.length > 500) {
        return res.json({ code: 400, message: '默认头像路径不合法' });
      }
      updates.default_avatar = default_avatar;
    }
    if (default_group_avatar !== undefined) {
      if (typeof default_group_avatar !== 'string' || default_group_avatar.length > 500) {
        return res.json({ code: 400, message: '默认群头像路径不合法' });
      }
      updates.default_group_avatar = default_group_avatar;
    }
    // 多登录方式字段
    if (login_method_password !== undefined) updates.login_method_password = login_method_password && login_method_password !== '0' ? '1' : '0';
    if (login_method_phone !== undefined) updates.login_method_phone = login_method_phone && login_method_phone !== '0' ? '1' : '0';
    if (login_method_email !== undefined) updates.login_method_email = login_method_email && login_method_email !== '0' ? '1' : '0';
    if (sms_template_id !== undefined && sms_template_id !== '') {
      if (typeof sms_template_id !== 'string' || sms_template_id.length > 100) {
        return res.json({ code: 400, message: '模板ID过长' });
      }
      updates.sms_template_id = encSP(sms_template_id);  // 加密存储
    }
    if (sms_template_url !== undefined) {
      if (typeof sms_template_url !== 'string' || sms_template_url.length > 500) {
        return res.json({ code: 400, message: '短信模板地址过长' });
      }
      updates.sms_template_url = sms_template_url;
    }
    if (sms_code_length !== undefined) updates.sms_code_length = String(sms_code_length);
    if (sms_code_expire !== undefined) updates.sms_code_expire = String(sms_code_expire);
    if (smtp_host !== undefined) {
      if (typeof smtp_host !== 'string' || smtp_host.length > 200) {
        return res.json({ code: 400, message: 'SMTP地址过长' });
      }
      updates.smtp_host = smtp_host;
    }
    if (smtp_port !== undefined) updates.smtp_port = String(smtp_port);
    if (smtp_user !== undefined) {
      if (typeof smtp_user !== 'string' || smtp_user.length > 200) {
        return res.json({ code: 400, message: 'SMTP用户名过长' });
      }
      updates.smtp_user = smtp_user;
    }
    if (smtp_pass !== undefined && smtp_pass !== '') updates.smtp_pass = encSP(smtp_pass);  // 加密存储，空值不覆盖
    if (smtp_from !== undefined) {
      if (typeof smtp_from !== 'string' || smtp_from.length > 200) {
        return res.json({ code: 400, message: '发件人地址过长' });
      }
      updates.smtp_from = smtp_from;
    }

    // 校验至少开启一种登录方式
    const finalPwd = updates.login_method_password !== undefined ? updates.login_method_password : (await _getSetting('login_method_password') || '1');
    const finalPhone = updates.login_method_phone !== undefined ? updates.login_method_phone : (await _getSetting('login_method_phone') || '0');
    const finalEmail = updates.login_method_email !== undefined ? updates.login_method_email : (await _getSetting('login_method_email') || '0');
    if (finalPwd === '0' && finalPhone === '0' && finalEmail === '0') {
      return res.json({ code: 400, message: '至少需开启一种登录方式' });
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.json({ code: 400, message: '无修改内容' });

    for (const key of keys) {
      await pool.execute(
        'INSERT INTO system_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
        [key, updates[key], updates[key]]
      );
    }

    await auditLog(req.userId, 'update_settings', 'settings', '', updates, req);

    res.json({ code: 0, message: '保存成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/settings/logo', auth, adminAuth, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '未上传文件' });
    // 服务器端压缩：限制 512px，有透明通道保留 PNG，否则转 JPEG
    const sharp = require('sharp');
    const metadata = await sharp(req.file.path).metadata();
    const hasAlpha = metadata.hasAlpha;
    const ext = hasAlpha ? '.png' : '.jpg';
    const tmpPath = req.file.path + '.tmp' + ext;
    const pipeline = sharp(req.file.path).resize(512, 512, { fit: 'inside', withoutEnlargement: true });
    if (hasAlpha) {
      await pipeline.png({ quality: 85, compressionLevel: 9 }).toFile(tmpPath);
    } else {
      await pipeline.jpeg({ quality: 85 }).toFile(tmpPath);
    }
    try { fs.unlinkSync(req.file.path); } catch {}
    const newFilename = req.file.filename.replace(/\.[^.]+$/, ext);
    const newPath = path.join(path.dirname(req.file.path), newFilename);
    fs.renameSync(tmpPath, newPath);
    const logoUrl = `/uploads/${newFilename}`;
    await pool.execute(
      'INSERT INTO system_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      ['system_logo', logoUrl, logoUrl]
    );
    res.json({ code: 0, data: { logo: logoUrl } });
  } catch (e) {
    console.error('[Admin] Logo上传失败:', e.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 用户管理 ──────────────────────────────────────────────
router.get('/users', auth, adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const keyword = req.query.keyword ? `%${req.query.keyword}%` : null;

    let sql = 'SELECT id, phone, email, nickname, avatar, gender, level, exp, coins, role, COALESCE(is_banned, 0) as is_banned, created_at FROM users WHERE id != 9999';
    const params = [];
    if (keyword) {
      const kw = req.query.keyword.trim();
      if (/^1\d{10}$/.test(kw)) {
        sql += ' AND (nickname LIKE ? OR phone = ?)';
        params.push(`%${kw}%`, aep(kw));
      } else {
        sql += ' AND nickname LIKE ?';
        params.push(keyword);
      }
    }
    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await pool.query(sql, params);
    const countParams = keyword ? [keyword, keyword] : [];
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM users WHERE id != 9999${keyword ? ' AND (nickname LIKE ? OR phone LIKE ?)' : ''}`,
      countParams
    );
    const list = rows.map(r => ({ ...r, coins: decCoin(r.coins), exp: decCoin(r.exp), level: decCoin(r.level), email: decEmail(r.email), phone: safeDecrypt(ap(), r.phone) || r.phone }));
    res.json({ code: 0, data: { list, total, page, limit } });
  } catch (e) {
    console.error('[Admin] GET /users error:', e.message, e.stack);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/users', auth, adminAuth, async (req, res) => {
  try {
    const { phone, nickname, password } = req.body;
    // 支持昵称+密码创建（无手机号），也兼容旧手机号方式
    const hasPhone = phone && /^1\d{10}$/.test(phone);
    if (!hasPhone && !nickname) return res.json({ code: 400, message: '请填写昵称或手机号' });
    if (hasPhone) {
      const exists = await adminUserExistsByPhone(phone);
      if (exists) return res.json({ code: 400, message: '该手机号已注册' });
    }
    const finalNickname = (nickname && nickname.trim()) ? nickname.trim().slice(0, 20) : `用户${hasPhone ? phone.slice(-4) : ''}`;
    let hashedPassword = null;
    if (password) {
      const bcrypt = require('bcryptjs');
      hashedPassword = await bcrypt.hash(String(password), 10);
    }
    const [result] = await pool.execute(
      'INSERT INTO users (phone, email, nickname, signature, level, exp, coins, password) VALUES (?, \'\', ?, ?, 1, 0, 0, ?)',
      [hasPhone ? aep(phone) : '', finalNickname, aes('这个人很懒，什么都没写~'), hashedPassword]
    // 注意：创建时不传邮箱，如需添加请用编辑接口
    );
    res.json({ code: 0, message: '创建成功', data: { id: result.insertId, nickname: finalNickname } });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/users/:id', auth, adminAuth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === 9999) return res.json({ code: 403, message: '不可修改系统账号' });
    const [[target]] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (!target) return res.json({ code: 404, message: '用户不存在' });
    const { nickname, gender, level, coins, signature, role, password, email, phone } = req.body;
    const fields = [];
    const vals = [];
    if (nickname !== undefined) { fields.push('nickname = ?'); vals.push(String(nickname).slice(0, 50)); }
    if (phone !== undefined && String(phone).trim()) {
      const p = String(phone).trim();
      if (/^1\d{10}$/.test(p)) {
        const exists = await adminUserExistsByPhone(p);
        if (!exists || exists.id === targetId) { fields.push('phone = ?'); vals.push(aep(p)); }
      }
    }
    if (gender !== undefined) { fields.push('gender = ?'); vals.push(Number(gender)); }
    if (level !== undefined) {
      const lv = Math.max(1, Math.min(99, parseInt(level)));
      const exp = (lv - 1) * 100;
      fields.push('level = ?', 'exp = ?'); vals.push(encNum(lv), encNum(exp));
    }
    if (coins !== undefined) { fields.push('coins = ?'); vals.push(encNum(Math.max(0, parseInt(coins)))); }
    if (signature !== undefined) { fields.push('signature = ?'); vals.push(aes(String(signature).slice(0, 200))); }
    if (email !== undefined && String(email).trim()) { fields.push('email = ?'); vals.push(encEmail(String(email).trim().slice(0, 255))); }
    if (role !== undefined && ['admin', 'user'].includes(role) && targetId !== req.userId) { fields.push('role = ?'); vals.push(role); }
    if (password !== undefined && String(password).length >= 6) {
      const bcrypt = require('bcryptjs');
      fields.push('password = ?'); vals.push(await bcrypt.hash(String(password), 10));
    }
    if (!fields.length) return res.json({ code: 400, message: '无修改内容' });
    vals.push(targetId);
    await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, vals);
    res.json({ code: 0, message: '修改成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/users/:id/ban', auth, adminAuth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === 9999 || targetId === 10000) return res.json({ code: 403, message: '不可封禁该账号' });
    if (targetId === req.userId) return res.json({ code: 403, message: '不能封禁自己' });
    const [[target]] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target?.role === 'admin') return res.json({ code: 403, message: '不能封禁其他管理员' });
    const { is_banned } = req.body;
    await pool.execute('UPDATE users SET is_banned = ? WHERE id = ?', [is_banned ? 1 : 0, targetId]);
    res.json({ code: 0, message: is_banned ? '已封禁' : '已解封' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/users/:id', auth, adminAuth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === 9999 || targetId === 10000) return res.json({ code: 403, message: '不可删除该账号' });
    if (targetId === req.userId) return res.json({ code: 403, message: '不能删除自己' });
    const [[target]] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target?.role === 'admin') return res.json({ code: 403, message: '不能删除其他管理员' });
    await pool.execute('DELETE FROM users WHERE id = ?', [targetId]);
    res.json({ code: 0, message: '删除成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 群聊管理 ──────────────────────────────────────────────
router.get('/groups', auth, adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const keyword = req.query.keyword ? `%${req.query.keyword}%` : null;

    let sql = `SELECT g.id, g.name, g.avatar, g.owner_id, g.notice, g.max_members, COALESCE(g.is_banned, 0) as is_banned, COALESCE(g.is_system, 0) as is_system, g.system_mode, g.created_at,
      u.nickname as owner_name,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as member_count
      FROM \`groups\` g LEFT JOIN users u ON g.owner_id = u.id`;
    const params = [];
    const systemType = req.query.systemType;
    const conditions = [];
    if (keyword) { conditions.push('g.name LIKE ?'); params.push(keyword); }
    if (systemType === 'system') { conditions.push('COALESCE(g.is_system, 0) = 1'); }
    else if (systemType === 'normal') { conditions.push('COALESCE(g.is_system, 0) = 0'); }
    if (conditions.length > 0) { sql += ' WHERE ' + conditions.join(' AND '); }
    sql += ' ORDER BY g.id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await pool.query(sql, params);
    let countSql = 'SELECT COUNT(*) as total FROM `groups`';
    const countParams = [];
    const countConds = [];
    if (keyword) { countConds.push('name LIKE ?'); countParams.push(keyword); }
    if (systemType === 'system') { countConds.push('COALESCE(is_system, 0) = 1'); }
    else if (systemType === 'normal') { countConds.push('COALESCE(is_system, 0) = 0'); }
    if (countConds.length > 0) { countSql += ' WHERE ' + countConds.join(' AND '); }
    const [[{ total }]] = await pool.query(countSql, countParams);
    res.json({ code: 0, data: { list: rows, total, page, limit } });
  } catch (e) {
    console.error('[Admin] GET /groups error:', e.message, e.stack);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/groups/:id', auth, adminAuth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { name, notice, owner_id, max_members } = req.body;
    const fields = [];
    const vals = [];
    if (name !== undefined) { fields.push('name = ?'); vals.push(String(name).slice(0, 50)); }
    if (notice !== undefined) { fields.push('notice = ?'); vals.push(String(notice).slice(0, 500)); }
    if (owner_id !== undefined) {
      const [[mem]] = await pool.execute('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, owner_id]);
      if (!mem) return res.json({ code: 400, message: '新群主不是群成员' });
      fields.push('owner_id = ?'); vals.push(parseInt(owner_id));
      await pool.execute("UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?", [groupId, owner_id]);
      await pool.execute("UPDATE group_members SET role = 'member' WHERE group_id = ? AND user_id != ? AND role = 'owner'", [groupId, owner_id]);
    }
    if (max_members !== undefined) { fields.push('max_members = ?'); vals.push(Math.max(10, Math.min(500, parseInt(max_members)))); }
    if (!fields.length) return res.json({ code: 400, message: '无修改内容' });
    vals.push(groupId);
    await pool.execute(`UPDATE \`groups\` SET ${fields.join(', ')} WHERE id = ?`, vals);
    res.json({ code: 0, message: '修改成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/groups/:id/ban', auth, adminAuth, async (req, res) => {
  try {
    const { is_banned } = req.body;
    await pool.execute('UPDATE `groups` SET is_banned = ? WHERE id = ?', [is_banned ? 1 : 0, parseInt(req.params.id)]);
    res.json({ code: 0, message: is_banned ? '已封禁' : '已解封' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/groups/:id', auth, adminAuth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    await pool.execute('DELETE FROM `groups` WHERE id = ?', [groupId]);
    await pool.execute('DELETE FROM group_members WHERE group_id = ?', [groupId]);
    res.json({ code: 0, message: '删除成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /groups/:id/members — 给指定用户系统群添加成员
router.post('/groups/:id/members', auth, adminAuth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { userIds } = req.body;
    if (!userIds || !userIds.length) return res.json({ code: 400, message: '请选择成员' });
    const [grp] = await pool.execute('SELECT is_system, system_mode FROM `groups` WHERE id = ?', [groupId]);
    if (grp.length === 0) return res.json({ code: 404, message: '群不存在' });
    if (!grp[0].is_system || grp[0].system_mode !== 'selected') return res.json({ code: 400, message: '仅指定用户系统群可管理成员' });
    for (const uid of userIds) {
      await pool.execute('INSERT IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [groupId, uid, 'member']);
    }
    res.json({ code: 0, message: '添加成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// DELETE /groups/:id/members/:userId — 从指定用户系统群移除成员
router.delete('/groups/:id/members/:userId', auth, adminAuth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const userId = parseInt(req.params.userId);
    const [grp] = await pool.execute('SELECT is_system, system_mode, owner_id FROM `groups` WHERE id = ?', [groupId]);
    if (grp.length === 0) return res.json({ code: 404, message: '群不存在' });
    if (!grp[0].is_system || grp[0].system_mode !== 'selected') return res.json({ code: 400, message: '仅指定用户系统群可管理成员' });
    if (grp[0].owner_id === userId) return res.json({ code: 400, message: '不能移除群主' });
    await pool.execute('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    res.json({ code: 0, message: '移除成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 等级配置（经验获取配置）──────────────────────────────────
router.get('/level-config', auth, adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT `key`, `value` FROM system_settings WHERE `key` IN (" +
      "'exp_signin','exp_message','exp_group_message','exp_moment','exp_comment','exp_like','exp_follow','exp_add_friend','exp_message_daily_limit','exp_interaction_daily_limit'," +
      "'exp_signin_enabled','exp_message_enabled','exp_group_message_enabled','exp_moment_enabled','exp_comment_enabled','exp_like_enabled','exp_follow_enabled','exp_add_friend_enabled')"
    );
    const cfg = {
      exp_signin: 10, exp_message: 2, exp_group_message: 2, exp_moment: 5,
      exp_comment: 3, exp_like: 1, exp_follow: 3, exp_add_friend: 5,
      exp_message_daily_limit: 50, exp_interaction_daily_limit: 50,
      exp_signin_enabled: 1, exp_message_enabled: 1, exp_group_message_enabled: 1,
      exp_moment_enabled: 1, exp_comment_enabled: 1, exp_like_enabled: 1,
      exp_follow_enabled: 1, exp_add_friend_enabled: 1,
    };
    rows.forEach(r => {
      if (r.key.endsWith('_enabled')) {
        cfg[r.key] = parseInt(r.value);
      } else {
        cfg[r.key] = parseInt(r.value);
      }
    });
    res.json({ code: 0, data: cfg });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/level-config', auth, adminAuth, async (req, res) => {
  try {
    const allowed = [
      'exp_signin','exp_message','exp_group_message','exp_moment','exp_comment','exp_like','exp_follow','exp_add_friend',
      'exp_message_daily_limit','exp_interaction_daily_limit',
      'exp_signin_enabled','exp_message_enabled','exp_group_message_enabled','exp_moment_enabled','exp_comment_enabled','exp_like_enabled','exp_follow_enabled','exp_add_friend_enabled',
    ];
    const changes = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        let val;
        if (key.endsWith('_enabled')) {
          // '0' 字符串在 JS 中是 truthy，必须显式判断
          const v = req.body[key];
          val = (v === 0 || v === '0' || v === false) ? '0' : '1';
        } else {
          val = String(Math.max(0, Math.min(999, parseInt(req.body[key]) || 0)));
        }
        await pool.execute(
          'INSERT INTO system_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
          [key, val, val]
        );
        changes[key] = val;
      }
    }
    if (Object.keys(changes).length > 0) {
      await auditLog(req.userId, 'update_level_config', 'level_config', '', changes, req);
    }
    res.json({ code: 0, message: '保存成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 等级规则（每级配置）─────────────────────────────────────
router.get('/level-rules', auth, adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM level_config ORDER BY level');
    res.json({ code: 0, data: rows });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/level-rules/:level', auth, adminAuth, async (req, res) => {
  try {
    const level = parseInt(req.params.level);
    if (isNaN(level) || level < 1 || level > 99) {
      return res.json({ code: 400, message: '等级范围1-99' });
    }
    const { name, exp_required, coin_reward } = req.body;
    const fields = [];
    const vals = [];

    if (name !== undefined) { fields.push('name = ?'); vals.push(String(name).slice(0, 20)); }
    if (exp_required !== undefined) { fields.push('exp_required = ?'); vals.push(Math.max(10, Math.min(99999, parseInt(exp_required)))); }
    if (coin_reward !== undefined) { fields.push('coin_reward = ?'); vals.push(Math.max(0, Math.min(9999, parseInt(coin_reward)))); }

    if (fields.length === 0) return res.json({ code: 400, message: '无修改内容' });

    vals.push(level);
    await pool.execute(`UPDATE level_config SET ${fields.join(', ')} WHERE level = ?`, vals);

    await auditLog(req.userId, 'update_level_rule', 'level_config', String(level), { name, exp_required, coin_reward }, req);

    res.json({ code: 0, message: '保存成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/level-rules/batch', auth, adminAuth, async (req, res) => {
  try {
    const { startLevel, endLevel, exp_required, coin_reward } = req.body;
    const start = Math.max(1, Math.min(99, parseInt(startLevel) || 1));
    const end = Math.max(start, Math.min(99, parseInt(endLevel) || 99));

    const exp = exp_required !== undefined ? Math.max(10, Math.min(99999, parseInt(exp_required) || 100)) : undefined;
    const coin = coin_reward !== undefined ? Math.max(0, Math.min(9999, parseInt(coin_reward) || 2)) : undefined;

    for (let lv = start; lv <= end; lv++) {
      const setClauses = [];
      const vals = [];
      if (exp !== undefined) { setClauses.push('exp_required = VALUES(exp_required)'); }
      if (coin !== undefined) { setClauses.push('coin_reward = VALUES(coin_reward)'); }
      if (setClauses.length === 0) break;

      await pool.execute(
        `INSERT INTO level_config (level, exp_required, coin_reward) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE ${setClauses.join(', ')}`,
        [lv, exp !== undefined ? exp : 100, coin !== undefined ? coin : 2]
      );
    }

    await auditLog(req.userId, 'batch_update_level_rules', 'level_config', `${start}-${end}`, { exp_required: exp, coin_reward: coin }, req);

    res.json({ code: 0, message: `已批量更新 ${start}~${end} 级` });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 签到统计 ───────────────────────────────────────────────
router.get('/signin-stats', auth, adminAuth, async (req, res) => {
  try {
    // Monday of current week
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    const mondayStr = monday.toISOString().split('T')[0];

    const [[{ today }]] = await pool.execute(
      'SELECT COUNT(DISTINCT user_id) as today FROM sign_in_records WHERE sign_date = CURDATE()'
    );
    const [[{ yesterday }]] = await pool.execute(
      'SELECT COUNT(DISTINCT user_id) as yesterday FROM sign_in_records WHERE sign_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)'
    );
    const [[{ week }]] = await pool.execute(
      'SELECT COUNT(DISTINCT user_id) as week FROM sign_in_records WHERE sign_date >= ?',
      [mondayStr]
    );

    res.json({ code: 0, data: { today, yesterday, week } });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 签到配置 ────────────────────────────────────────────────
router.get('/signin-config', auth, adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM signin_config ORDER BY streak_days');
    res.json({ code: 0, data: rows });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/signin-config', auth, adminAuth, async (req, res) => {
  try {
    const { config } = req.body;
    if (!Array.isArray(config)) return res.json({ code: 400, message: 'config 必须是数组' });

    await pool.execute('DELETE FROM signin_config');

    for (const item of config) {
      const sd = Math.max(1, parseInt(item.streak_days) || 1);
      const bc = Math.max(0, parseInt(item.bonus_coins) || 0);
      await pool.execute(
        'INSERT INTO signin_config (streak_days, bonus_coins) VALUES (?, ?)',
        [sd, bc]
      );
    }

    await auditLog(req.userId, 'update_signin_config', 'signin_config', '', { items: config.length }, req);

    res.json({ code: 0, message: '保存成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 验证码配置 ────────────────────────────────────────────
router.get('/captcha-config', auth, adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT `key`, `value` FROM system_settings WHERE `key` IN ('captcha_length','captcha_include_alpha','captcha_type')");
    const cfg = { captcha_length: 4, captcha_include_alpha: false, captcha_type: 'text' };
    rows.forEach(r => {
      if (r.key === 'captcha_length') cfg.captcha_length = parseInt(r.value);
      if (r.key === 'captcha_include_alpha') cfg.captcha_include_alpha = r.value === '1';
      if (r.key === 'captcha_type') cfg.captcha_type = r.value;
    });
    res.json({ code: 0, data: cfg });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/captcha-config', auth, adminAuth, async (req, res) => {
  try {
    const { captcha_length, captcha_include_alpha, captcha_type } = req.body;
    if (captcha_length !== undefined) {
      const len = Math.max(3, Math.min(6, parseInt(captcha_length)));
      await pool.execute(
        'INSERT INTO system_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
        ['captcha_length', String(len), String(len)]
      );
    }
    if (captcha_include_alpha !== undefined) {
      const val = captcha_include_alpha ? '1' : '0';
      await pool.execute(
        'INSERT INTO system_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
        ['captcha_include_alpha', val, val]
      );
    }
    if (captcha_type !== undefined) {
      if (!['text', 'math'].includes(captcha_type)) return res.json({ code: 400, message: '验证码类型不合法' });
      await pool.execute(
        'INSERT INTO system_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
        ['captcha_type', captcha_type, captcha_type]
      );
    }
    res.json({ code: 0, message: '保存成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 动态管理 ────────────────────────────────────────────────
router.get('/moments', auth, adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const keyword = req.query.keyword ? `%${req.query.keyword}%` : null;
    const userId = req.query.userId ? parseInt(req.query.userId) : null;

    // keyword 搜索只能应用层过滤（内容已加密）
    let whereClause = '1=1';
    const params = [];
    if (userId) {
      whereClause += ' AND m.user_id = ?';
      params.push(userId);
    }

    const countParams = [...params];
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM moments m WHERE ${whereClause}`,
      countParams
    );

    // 取稍多记录用于解密后过滤
    const fetchLimit = keyword ? Math.min(200, limit * 5) : limit;
    const [rows] = await pool.execute(
      `SELECT m.*, u.nickname, u.avatar
       FROM moments m
       JOIN users u ON m.user_id = u.id
       WHERE ${whereClause}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, fetchLimit, offset]
    );

    // 解密 + 可选的 keyword 过滤
    let decRows = rows.map(r => ({
      ...r,
      content: r.visibility === 'private' ? '[私密]' : decMomentContent(r.content || ''),
    }));
    if (keyword) {
      const kw = req.query.keyword.trim().toLowerCase();
      decRows = decRows.filter(r => r.content.toLowerCase().includes(kw));
    }
    const pagedRows = decRows.slice(0, limit);

    const list = pagedRows.map(r => ({
      id: r.id,
      user_id: r.user_id,
      user_nickname: r.nickname,
      user_avatar: r.avatar,
      content: r.content,
      images: JSON.parse(r.images || '[]'),
      audio_url: r.audio_url,
      audio_duration: r.audio_duration,
      location: r.location,
      visibility: r.visibility,
      topic_name: r.topic_name,
      created_at: r.created_at,
    }));

    const finalTotal = keyword ? decRows.length : total;
    res.json({
      code: 0,
      data: {
        list,
        pagination: { page, limit, total: finalTotal, hasMore: offset + limit < finalTotal },
      },
    });
  } catch (e) {
    console.error('[Admin] GET /moments error:', e.message, e.stack);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/moments/:id', auth, adminAuth, async (req, res) => {
  try {
    const momentId = parseInt(req.params.id);
    const [[m]] = await pool.execute('SELECT id, user_id FROM moments WHERE id = ?', [momentId]);
    if (!m) return res.json({ code: 404, message: '动态不存在' });

    // Update content to indicate admin deletion, then delete
    await pool.execute("UPDATE moments SET content = ? WHERE id = ?", ['[已被管理员删除]', momentId]);

    // Clean up related data
    await pool.execute('DELETE FROM moment_likes WHERE moment_id = ?', [momentId]);
    await pool.execute('DELETE FROM moment_comments WHERE moment_id = ?', [momentId]);
    await pool.execute('DELETE FROM moment_favorites WHERE moment_id = ?', [momentId]);
    await pool.execute('DELETE FROM moment_notifications WHERE moment_id = ?', [momentId]);
    await pool.execute('DELETE FROM moments WHERE id = ?', [momentId]);

    await auditLog(req.userId, 'delete_moment', 'moment', String(momentId), { user_id: m.user_id }, req);

    res.json({ code: 0, message: '已删除' });
  } catch (e) {
    console.error('[Admin] DELETE /moments/:id error:', e.message, e.stack);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── Banner 预设管理 ─────────────────────────────────────────
router.get('/presets', auth, adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM banner_presets ORDER BY sort_order');
    res.json({ code: 0, data: rows });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/presets', auth, adminAuth, presetUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '未上传图片' });
    const { name, animation_type } = req.body;
    if (!name) return res.json({ code: 400, message: '名称不能为空' });

    const imageUrl = `/uploads/${req.file.filename}`;
    const safeName = String(name).slice(0, 30);
    const safeAnim = (animation_type && String(animation_type).slice(0, 20)) || 'default';

    const [result] = await pool.execute(
      'INSERT INTO banner_presets (name, image_url, animation_type, is_active, sort_order) VALUES (?, ?, ?, 1, 0)',
      [safeName, imageUrl, safeAnim]
    );

    await auditLog(req.userId, 'create_preset', 'banner_presets', String(result.insertId), { name: safeName, animation_type: safeAnim }, req);

    res.json({ code: 0, data: { id: result.insertId, name: safeName, image_url: imageUrl, animation_type: safeAnim } });
  } catch (e) {
    console.error('[Admin] POST /presets error:', e.message, e.stack);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/presets/:id', auth, adminAuth, async (req, res) => {
  try {
    const presetId = parseInt(req.params.id);
    const [[preset]] = await pool.execute('SELECT id FROM banner_presets WHERE id = ?', [presetId]);
    if (!preset) return res.json({ code: 404, message: '预设不存在' });

    const { name, animation_type, is_active, sort_order } = req.body;
    const fields = [];
    const vals = [];

    if (name !== undefined) { fields.push('name = ?'); vals.push(String(name).slice(0, 30)); }
    if (animation_type !== undefined) { fields.push('animation_type = ?'); vals.push(String(animation_type).slice(0, 20)); }
    if (is_active !== undefined) { fields.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); vals.push(Math.max(0, parseInt(sort_order) || 0)); }

    if (fields.length === 0) return res.json({ code: 400, message: '无修改内容' });

    vals.push(presetId);
    await pool.execute(`UPDATE banner_presets SET ${fields.join(', ')} WHERE id = ?`, vals);

    await auditLog(req.userId, 'update_preset', 'banner_presets', String(presetId), { name, animation_type, is_active, sort_order }, req);

    res.json({ code: 0, message: '保存成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/presets/:id', auth, adminAuth, async (req, res) => {
  try {
    const presetId = parseInt(req.params.id);
    const [[preset]] = await pool.execute('SELECT id FROM banner_presets WHERE id = ?', [presetId]);
    if (!preset) return res.json({ code: 404, message: '预设不存在' });

    await pool.execute('DELETE FROM banner_presets WHERE id = ?', [presetId]);

    await auditLog(req.userId, 'delete_preset', 'banner_presets', String(presetId), {}, req);

    res.json({ code: 0, message: '已删除' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 话题管理 ────────────────────────────────────────────────
router.get('/topics', auth, adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const keyword = req.query.keyword ? `%${req.query.keyword}%` : null;

    let whereClause = '1=1';
    const params = [];
    if (keyword) {
      whereClause = 'name LIKE ?';
      params.push(keyword);
    }

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM moment_topics WHERE ${whereClause}`,
      params
    );

    const [rows] = await pool.execute(
      `SELECT * FROM moment_topics WHERE ${whereClause} ORDER BY usage_count DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      code: 0,
      data: {
        list: rows,
        pagination: { page, limit, total, hasMore: offset + limit < total },
      },
    });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/topics/:id', auth, adminAuth, async (req, res) => {
  try {
    const topicId = parseInt(req.params.id);
    const [[topic]] = await pool.execute('SELECT id, name FROM moment_topics WHERE id = ?', [topicId]);
    if (!topic) return res.json({ code: 404, message: '话题不存在' });

    const { name, description, status, cover_image } = req.body;
    const fields = [];
    const vals = [];

    if (name !== undefined) { fields.push('name = ?'); vals.push(String(name).slice(0, 50)); }
    if (description !== undefined) { fields.push('description = ?'); vals.push(String(description).slice(0, 500)); }
    if (status !== undefined && ['new', 'active', 'hot'].includes(status)) { fields.push('status = ?'); vals.push(status); }
    if (cover_image !== undefined) { fields.push('cover_image = ?'); vals.push(String(cover_image).slice(0, 255)); }

    if (fields.length === 0) return res.json({ code: 400, message: '无修改内容' });

    vals.push(topicId);
    await pool.execute(`UPDATE moment_topics SET ${fields.join(', ')} WHERE id = ?`, vals);

    await auditLog(req.userId, 'update_topic', 'moment_topics', String(topicId), { name, description, status, cover_image }, req);

    res.json({ code: 0, message: '保存成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/topics/:id', auth, adminAuth, async (req, res) => {
  try {
    const topicId = parseInt(req.params.id);
    const [[topic]] = await pool.execute('SELECT id, name FROM moment_topics WHERE id = ?', [topicId]);
    if (!topic) return res.json({ code: 404, message: '话题不存在' });

    const topicName = topic.name;

    await pool.execute('DELETE FROM moment_topics WHERE id = ?', [topicId]);
    await pool.execute('UPDATE moments SET topic_name = ? WHERE topic_name = ?', ['', topicName]);

    await auditLog(req.userId, 'delete_topic', 'moment_topics', String(topicId), { name: topicName }, req);

    res.json({ code: 0, message: '已删除' });
  } catch (e) {
    console.error('[Admin] DELETE /topics/:id error:', e.message, e.stack);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 公开接口：获取系统设置（前端同步名称/logo）────────────
router.get('/public-settings', async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT `key`, `value` FROM system_settings WHERE `key` IN ('system_name','system_logo','login_method_password','login_method_phone','login_method_email')");
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ code: 0, data: settings });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ── 测试短信发送 ────────────
router.post('/test-sms', auth, adminAuth, async (req, res) => {
  try {
    const { phone, template_id } = req.body;
    if (!phone || !/^1\d{10}$/.test(phone)) return res.json({ code: 400, message: '请输入正确的测试手机号' });
    const tid = template_id || decSP(await _getSetting('sms_template_id'));
    if (!tid) return res.json({ code: 400, message: '请先填写并保存模板ID' });

    const codeLen = Math.min(6, Math.max(4, parseInt(await _getSetting('sms_code_length') || '6')));
    const codeExpire = parseInt(await _getSetting('sms_code_expire') || '300');
    const code = String(Math.floor(Math.pow(10, codeLen - 1) + Math.random() * 9 * Math.pow(10, codeLen - 1)));
    const smsNumber = Math.max(1, Math.round(codeExpire / 60));
    const url = `https://push.spug.cc/send/${tid}?code=${code}&number=${smsNumber}&targets=${phone}`;

    const resp = await fetch(url);
    const text = await resp.text();
    console.log(`[TestSMS] ${phone} -> HTTP ${resp.status}: ${text}`);
    if (!resp.ok) {
      return res.json({ code: 500, message: `发送失败 (HTTP ${resp.status})：${text.slice(0, 80)}` });
    }
    // 推送助手响应通常包含 "success" 或 "ok"
    const lower = text.toLowerCase();
    if (lower.includes('error') || lower.includes('fail') || lower.includes('失败')) {
      return res.json({ code: 500, message: `推送助手返回错误：${text.slice(0, 80)}` });
    }
    res.json({ code: 0, message: `测试短信发送成功 (验证码: ${code})` });
  } catch (e) {
    console.error('[TestSMS] error:', e.message);
    res.json({ code: 500, message: '网络错误：' + e.message });
  }
});

// ── 测试邮件发送 ────────────
router.post('/test-email', auth, adminAuth, async (req, res) => {
  try {
    const { email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from } = req.body;
    if (!email) return res.json({ code: 400, message: '请输入测试邮箱地址' });

    // 优先用请求参数，回退已存储配置
    const host = smtp_host || await _getSetting('smtp_host');
    const port = smtp_port || await _getSetting('smtp_port') || '587';
    const user = smtp_user || await _getSetting('smtp_user');
    const pass = decSP(smtp_pass || await _getSetting('smtp_pass'));
    if (!host || !user || !pass) return res.json({ code: 400, message: '请先配置 SMTP 信息' });

    let nodemailer;
    try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }
    if (!nodemailer) return res.json({ code: 500, message: 'nodemailer 未安装，请在后端目录执行 npm install nodemailer' });

    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(port) || 587,
      secure: parseInt(port) === 465,
      auth: { user, pass },
    });

    // from 必须等于 authorized user，忽略自定义 from
    await transporter.sendMail({
      from: user,
      to: email,
      subject: 'AZ-Chat 测试邮件',
      text: '这是一封测试邮件，如果您收到此邮件，说明 SMTP 配置正确。',
    });

    res.json({ code: 0, message: '测试邮件发送成功' });
  } catch (e) {
    console.error('[TestEmail] error:', e.message);
    res.json({ code: 500, message: '发送失败: ' + e.message });
  }
});

async function _getSetting(key) {
  try {
    const [[row]] = await pool.execute('SELECT `value` FROM system_settings WHERE `key` = ?', [key]);
    return row ? row.value : '';
  } catch { return ''; }
}

// ── 应用配置信息 ────────────
router.get('/app-config', auth, async (req, res) => {
  try {
    const pkg = require('../package.json');
    const dbRows = await pool.execute("SELECT `key`, `value` FROM system_settings WHERE `key` IN ('system_name','system_logo','reg_enabled')");
    const dbSettings = {};
    (dbRows[0] || []).forEach(r => { dbSettings[r.key] = r.value; });
    res.json({ code: 0, data: {
      version: pkg.version,
      appName: dbSettings.system_name || 'AZ Chat',
      logo: dbSettings.system_logo || '',
      regEnabled: dbSettings.reg_enabled !== '0',
    }});
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
