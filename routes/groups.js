const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const fs = require('fs').promises;
const { SYSTEM_BOT_ID, sendSystemNotify } = require('../utils/systemNotify');
const { encrypt, safeDecrypt, deriveKey } = require('../utils/crypto');
const { decCoin } = require('../utils/wallet');
const router = express.Router();

let _msgKey = null;
function getMsgKey() {
  if (_msgKey) return _msgKey;
  const mk = process.env.MASTER_KEY;
  if (mk && mk.length === 64) _msgKey = deriveKey(mk, 'msg');
  return _msgKey;
}
function encSysMsg(content) {
  const k = getMsgKey();
  return k ? encrypt(k, content) : content;
}
function decryptMessages(msgs) {
  const k = getMsgKey();
  if (!k || !msgs) return msgs;
  return msgs.map(m => { m.content = safeDecrypt(k, m.content); return m; });
}

// 允许的文件类型
const ALLOWED_FILE_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm', 'audio/3gpp',
  'video/mp4', 'video/quicktime',
];

const fileFilter = (req, file, cb) => {
  if (ALLOWED_FILE_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('不支持的文件类型'), false);
  }
};

async function generateGroupId() {
  let id, exists = true;
  while (exists) {
    id = Math.floor(1000000 + Math.random() * 9000000);
    const [rows] = await pool.execute('SELECT id FROM `groups` WHERE id = ?', [id]);
    exists = rows.length > 0;
  }
  return id;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads/private/groups')),
  filename: (req, file, cb) => cb(null, `group_${req.userId}_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter });

/** 检查当前用户是否为系统管理员 */
async function isSystemAdmin(userId) {
  const [rows] = await pool.execute('SELECT role FROM users WHERE id = ?', [userId]);
  return rows.length > 0 && rows[0].role === 'admin';
}

// POST /:groupId/clear-mention — 清除@提及标记
router.post('/:groupId/clear-mention', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    await pool.execute(
      'UPDATE group_mentions SET is_cleared = 1 WHERE group_id = ? AND user_id = ?',
      [groupId, req.userId]
    );
    res.json({ code: 0 });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /create
router.post('/create', auth, async (req, res) => {
  try {
    const { name, memberIds } = req.body;
    if (!name || !name.trim()) return res.json({ code: 400, message: '请输入群名称' });
    const groupId = await generateGroupId();
    await pool.execute('INSERT INTO `groups` (id, name, owner_id) VALUES (?, ?, ?)', [groupId, name.trim(), req.userId]);
    await pool.execute('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [groupId, req.userId, 'owner']);
    if (memberIds && memberIds.length > 0) {
      for (const uid of memberIds) {
        if (uid === SYSTEM_BOT_ID) continue; // 机器人不可拉群
        await pool.execute('INSERT IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [groupId, uid, 'member']);
      }
    }
    const [ownerRows] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
    const ownerName = ownerRows[0]?.nickname || '未知用户';
    await pool.execute('INSERT INTO group_messages (group_id, sender_id, content, type) VALUES (?, ?, ?, ?)', [groupId, req.userId, encSysMsg(`${ownerName} 创建了群聊`), 'system']);
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    if (memberIds && memberIds.length > 0) {
      memberIds.forEach(uid => {
        const sid = onlineUsers.get(uid);
        if (sid) {
          io.to(sid).emit('group:join', { groupId, groupName: name.trim() });
          const targetSocket = io.sockets.sockets.get(sid);
          if (targetSocket) targetSocket.join(`group:${groupId}`);
        }
      });
    }
    res.json({ code: 0, data: { groupId, name: name.trim() } });
  } catch (err) {
    console.error('[Groups] 创建群聊失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /create-system — 创建系统群聊（仅系统管理员）
router.post('/create-system', auth, async (req, res) => {
  try {
    if (!await isSystemAdmin(req.userId)) return res.json({ code: 403, message: '仅系统管理员可创建系统群聊' });
    const { name, systemMode, memberIds } = req.body;
    if (!name || !name.trim()) return res.json({ code: 400, message: '请输入群名称' });
    if (!['all', 'selected'].includes(systemMode)) return res.json({ code: 400, message: 'systemMode 必须为 all 或 selected' });
    const groupId = await generateGroupId();
    await pool.execute(
      'INSERT INTO `groups` (id, name, owner_id, is_system, system_mode) VALUES (?, ?, ?, 1, ?)',
      [groupId, name.trim(), req.userId, systemMode]
    );
    await pool.execute('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [groupId, req.userId, 'owner']);
    if (systemMode === 'all') {
      await pool.execute(
        'INSERT IGNORE INTO group_members (group_id, user_id, role) SELECT ?, id, \'member\' FROM users WHERE id != ? AND id != ?',
        [groupId, req.userId, SYSTEM_BOT_ID]
      );
    } else if (memberIds && memberIds.length > 0) {
      for (const uid of memberIds) {
        if (uid === SYSTEM_BOT_ID) continue;
        await pool.execute('INSERT IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [groupId, uid, 'member']);
      }
    }
    const [ownerRows] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
    const ownerName = ownerRows[0]?.nickname || '系统管理员';
    await pool.execute('INSERT INTO group_messages (group_id, sender_id, content, type) VALUES (?, ?, ?, ?)',
      [groupId, req.userId, encSysMsg(`${ownerName} 创建了系统群聊`), 'system']);
    res.json({ code: 0, data: { groupId, name: name.trim(), is_system: 1, system_mode: systemMode } });
  } catch (err) {
    console.error('[Groups] 创建系统群聊失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// GET /my
router.get('/my', auth, async (req, res) => {
  try {
    const [groups] = await pool.execute(`
      SELECT g.id, g.name, g.avatar, g.owner_id, gm.role,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
      FROM group_members gm
      JOIN \`groups\` g ON g.id = gm.group_id
      WHERE gm.user_id = ?
      ORDER BY g.created_at DESC
    `, [req.userId]);
    res.json({ code: 0, data: groups });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// GET /search
router.get('/search', auth, async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword) return res.json({ code: 400, message: '请输入搜索内容' });
    const [groups] = await pool.execute(
      'SELECT id, name, avatar, owner_id, is_system, system_mode, (SELECT COUNT(*) FROM group_members WHERE group_id = `groups`.id) as member_count FROM `groups` WHERE (id = ? OR name LIKE ?) AND is_system = 0',
      [keyword, `%${keyword}%`]
    );
    res.json({ code: 0, data: groups });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// GET /requests — 获取我管理的群的申请列表
router.get('/requests', auth, async (req, res) => {
  try {
    const [requests] = await pool.execute(`
      SELECT gr.id, gr.group_id, gr.user_id, gr.message, gr.status, gr.created_at,
        g.name as group_name, g.avatar as group_avatar,
        u.nickname, u.avatar as user_avatar
      FROM group_requests gr
      JOIN \`groups\` g ON g.id = gr.group_id
      JOIN users u ON u.id = gr.user_id
      JOIN group_members gm ON gm.group_id = gr.group_id AND gm.user_id = ?
      WHERE gm.role IN ('owner', 'admin')
      ORDER BY gr.created_at DESC
    `, [req.userId]);
    res.json({ code: 0, data: requests });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// GET /my-requests — 我发出的群申请
router.get('/my-requests', auth, async (req, res) => {
  try {
    const [requests] = await pool.execute(`
      SELECT gr.id, gr.group_id, gr.message, gr.status, gr.created_at,
        g.name as group_name, g.avatar as group_avatar
      FROM group_requests gr
      JOIN \`groups\` g ON g.id = gr.group_id
      WHERE gr.user_id = ?
      ORDER BY gr.created_at DESC
    `, [req.userId]);
    res.json({ code: 0, data: requests });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /request — 申请入群
router.post('/request', auth, async (req, res) => {
  try {
    const { groupId, message } = req.body;
    if (!groupId) return res.json({ code: 400, message: '缺少群ID' });
    const [existing] = await pool.execute('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    if (existing.length > 0) return res.json({ code: 400, message: '你已是群成员' });

    // 检查群的加入方式
    const [groupRows] = await pool.execute('SELECT join_type, name FROM `groups` WHERE id = ?', [groupId]);
    if (groupRows.length === 0) return res.json({ code: 404, message: '群不存在' });
    const { join_type, name: groupName } = groupRows[0];

    if (join_type === 0) {
      // 直接加入
      await pool.execute('INSERT IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [groupId, req.userId, 'member']);
      const [userRows] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
      await pool.execute('INSERT INTO group_messages (group_id, sender_id, content, type) VALUES (?, ?, ?, ?)',
        [groupId, req.userId, encSysMsg(`${userRows[0]?.nickname || '新成员'} 加入了群聊`), 'system']);
      const io = req.app.get('io');
      const onlineUsers = req.app.get('onlineUsers');
      const sid = onlineUsers.get(req.userId);
      if (sid) {
        io.to(sid).emit('group:join', { groupId, groupName });
        const targetSocket = io.sockets.sockets.get(sid);
        if (targetSocket) targetSocket.join(`group:${groupId}`);
      }
      return res.json({ code: 0, message: '已加入群聊', data: { joined: true } });
    }

    // 需要审批
    const [pendingReq] = await pool.execute('SELECT id FROM group_requests WHERE group_id = ? AND user_id = ? AND status = 0', [groupId, req.userId]);
    if (pendingReq.length > 0) return res.json({ code: 400, message: '已有待处理的申请' });
    await pool.execute('INSERT INTO group_requests (group_id, user_id, message) VALUES (?, ?, ?)', [groupId, req.userId, message || '']);

    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const [admins] = await pool.execute('SELECT user_id FROM group_members WHERE group_id = ? AND role IN (?, ?)', [groupId, 'owner', 'admin']);
    const [applicantRows] = await pool.execute('SELECT nickname, avatar FROM users WHERE id = ?', [req.userId]);
    admins.forEach(a => {
      const sid = onlineUsers.get(a.user_id);
      if (sid) io.to(sid).emit('group:request', {
        groupId, userId: req.userId,
        nickname: applicantRows[0]?.nickname,
        avatar: applicantRows[0]?.avatar,
        groupName
      });
    });
    // 系统通知：通知群管理员有新申请
    for (const a of admins) {
      await sendSystemNotify(a.user_id, applicantRows[0]?.nickname + " 申请加入群聊「" + groupName + "」，请前往联系人页面处理。", io, onlineUsers);
    }
    res.json({ code: 0, message: '申请已发送', data: { joined: false } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /requests/:reqId/accept
router.post('/requests/:reqId/accept', auth, async (req, res) => {
  try {
    const reqId = parseInt(req.params.reqId);
    const [rows] = await pool.execute('SELECT group_id, user_id FROM group_requests WHERE id = ? AND status = 0', [reqId]);
    if (rows.length === 0) return res.json({ code: 404, message: '申请不存在' });
    const { group_id, user_id } = rows[0];
    const [roleCheck] = await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [group_id, req.userId]);
    if (roleCheck.length === 0 || !['owner', 'admin'].includes(roleCheck[0].role)) return res.json({ code: 403, message: '无权操作' });
    await pool.execute('UPDATE group_requests SET status = 1 WHERE id = ?', [reqId]);
    await pool.execute('INSERT IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [group_id, user_id, 'member']);
    const [userRows] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [user_id]);
    await pool.execute('INSERT INTO group_messages (group_id, sender_id, content, type) VALUES (?, ?, ?, ?)',
      [group_id, user_id, encSysMsg(`${userRows[0]?.nickname || '新成员'} 加入了群聊`), 'system']);
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const sid = onlineUsers.get(user_id);
    if (sid) {
      io.to(sid).emit('group:join', { groupId: group_id });
      const targetSocket = io.sockets.sockets.get(sid);
      if (targetSocket) targetSocket.join(`group:${group_id}`);
    }
    const [groupInfo] = await pool.execute('SELECT name FROM `groups` WHERE id = ?', [group_id]);
    await sendSystemNotify(user_id, `你的入群申请已通过，已成功加入群聊「${groupInfo[0]?.name || ''}」。`, io, onlineUsers);
    res.json({ code: 0, message: '已同意' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /requests/:reqId/reject
router.post('/requests/:reqId/reject', auth, async (req, res) => {
  try {
    const reqId = parseInt(req.params.reqId);
    const [rows] = await pool.execute('SELECT group_id, user_id from group_requests WHERE id = ? AND status = 0', [reqId]);
    if (rows.length === 0) return res.json({ code: 404, message: '申请不存在' });
    const { group_id, user_id } = rows[0];
    const [roleCheck] = await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [group_id, req.userId]);
    if (roleCheck.length === 0 || !['owner', 'admin'].includes(roleCheck[0].role)) return res.json({ code: 403, message: '无权操作' });
    await pool.execute('UPDATE group_requests SET status = 2 WHERE id = ?', [reqId]);
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const [groupInfo] = await pool.execute('SELECT name FROM `groups` WHERE id = ?', [group_id]);
    await sendSystemNotify(user_id, `你申请加入群聊「${groupInfo[0]?.name || ''}」已被拒绝。`, io, onlineUsers);
    res.json({ code: 0, message: '已拒绝' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// GET /:groupId
router.get('/:groupId', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const [groups] = await pool.execute('SELECT * FROM `groups` WHERE id = ?', [groupId]);
    if (groups.length === 0) return res.json({ code: 404, message: '群不存在' });
    const [members] = await pool.execute(`
      SELECT gm.user_id as id, gm.role, gm.nickname as group_nickname, gm.joined_at,
        u.nickname, u.avatar, u.gender, u.level
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?
      ORDER BY FIELD(gm.role, 'owner', 'admin', 'member'), gm.joined_at
    `, [groupId]);
    const myMember = members.find(m => m.id === req.userId);
    const decMembers = members.map(m => ({ ...m, level: decCoin(m.level) }));
    res.json({ code: 0, data: { ...groups[0], members: decMembers, my_role: myMember?.role || null } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// PUT /:groupId
router.put('/:groupId', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { name, notice, avatar, description, tags, join_type } = req.body;
    const [roleCheck] = await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    if (roleCheck.length === 0 || !['owner', 'admin'].includes(roleCheck[0].role)) return res.json({ code: 403, message: '无权操作' });
    const fields = [], values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (notice !== undefined) { fields.push('notice = ?'); values.push(notice); }
    if (avatar !== undefined) { fields.push('avatar = ?'); values.push(avatar); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(tags)); }
    if (join_type !== undefined) { fields.push('join_type = ?'); values.push(join_type); }
    if (fields.length === 0) return res.json({ code: 400, message: '无更新内容' });
    values.push(groupId);
    await pool.execute(`UPDATE \`groups\` SET ${fields.join(', ')} WHERE id = ?`, values);

    // 广播群信息更新
    const io = req.app.get('io');
    io.to(`group:${groupId}`).emit('group:info:update', { groupId });

    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /:groupId/set-admin — 设置/取消管理员（仅群主）
router.post('/:groupId/set-admin', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { userId, isAdmin } = req.body;
    const [roleCheck] = await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    if (roleCheck.length === 0 || roleCheck[0].role !== 'owner') return res.json({ code: 403, message: '只有群主可以设置管理员' });
    const newRole = isAdmin ? 'admin' : 'member';
    await pool.execute('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', [newRole, groupId, userId]);
    const io = req.app.get('io');
    io.to(`group:${groupId}`).emit('group:info:update', { groupId });
    res.json({ code: 0, message: isAdmin ? '已设为管理员' : '已取消管理员' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /:groupId/invite
router.post('/:groupId/invite', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { userIds } = req.body;
    if (!userIds || userIds.length === 0) return res.json({ code: 400, message: '请选择成员' });
    const [memberCheck] = await pool.execute('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    if (memberCheck.length === 0) return res.json({ code: 403, message: '你不是群成员' });
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const [inviterRows] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
    const [groupRows] = await pool.execute('SELECT name FROM `groups` WHERE id = ?', [groupId]);
    for (const uid of userIds) {
      if (uid === SYSTEM_BOT_ID) continue; // 机器人不可拉群
      await pool.execute('INSERT IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [groupId, uid, 'member']);
      const sid = onlineUsers.get(uid);
      if (sid) {
        io.to(sid).emit('group:join', { groupId, groupName: groupRows[0]?.name });
        const targetSocket = io.sockets.sockets.get(sid);
        if (targetSocket) targetSocket.join(`group:${groupId}`);
      }
    }
    const [newUsers] = await pool.execute(`SELECT nickname FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`, userIds);
    const names = newUsers.map(u => u.nickname).join('、');
    await pool.execute('INSERT INTO group_messages (group_id, sender_id, content, type) VALUES (?, ?, ?, ?)',
      [groupId, req.userId, encSysMsg(`${inviterRows[0]?.nickname} 邀请了 ${names} 加入群聊`), 'system']);
    res.json({ code: 0, message: '邀请成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /:groupId/kick
router.post('/:groupId/kick', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { userId } = req.body;
    const [sysCheck] = await pool.execute('SELECT is_system FROM `groups` WHERE id = ?', [groupId]);
    if (sysCheck.length > 0 && sysCheck[0].is_system === 1) return res.json({ code: 400, message: '系统群聊不可踢人' });
    const [roleCheck] = await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    if (roleCheck.length === 0 || !['owner', 'admin'].includes(roleCheck[0].role)) return res.json({ code: 403, message: '无权操作' });
    await pool.execute('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const sid = onlineUsers.get(userId);
    if (sid) {
      io.to(sid).emit('group:leave', { groupId, kicked: true });
      const targetSocket = io.sockets.sockets.get(sid);
      if (targetSocket) targetSocket.leave(`group:${groupId}`);
    }
    res.json({ code: 0, message: '已移除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /:groupId/leave
router.post('/:groupId/leave', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const [sysCheck] = await pool.execute('SELECT is_system FROM `groups` WHERE id = ?', [groupId]);
    if (sysCheck.length > 0 && sysCheck[0].is_system === 1) return res.json({ code: 400, message: '系统群聊不可退出' });
    const [roleCheck] = await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    if (roleCheck.length > 0 && roleCheck[0].role === 'owner') return res.json({ code: 400, message: '群主不能退出，请先转让或解散群聊' });
    await pool.execute('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    const [userRows] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
    await pool.execute('INSERT INTO group_messages (group_id, sender_id, content, type) VALUES (?, ?, ?, ?)',
      [groupId, req.userId, encSysMsg(`${userRows[0]?.nickname || '成员'} 退出了群聊`), 'system']);
    res.json({ code: 0, message: '已退出' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /:groupId/dismiss
router.post('/:groupId/dismiss', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const [sysCheck] = await pool.execute('SELECT is_system, owner_id FROM `groups` WHERE id = ?', [groupId]);
    if (sysCheck.length === 0) return res.json({ code: 404, message: '群不存在' });
    if (sysCheck[0].is_system === 1) return res.json({ code: 400, message: '系统群聊不可解散，请在管理后台操作' });
    if (sysCheck[0].owner_id !== req.userId) return res.json({ code: 403, message: '只有群主可以解散' });
    const io = req.app.get('io');
    io.to(`group:${groupId}`).emit('group:leave', { groupId, dismissed: true });
    await pool.execute('DELETE FROM group_members WHERE group_id = ?', [groupId]);
    await pool.execute('DELETE FROM group_messages WHERE group_id = ?', [groupId]);
    await pool.execute('DELETE FROM group_requests WHERE group_id = ?', [groupId]);
    await pool.execute('DELETE FROM `groups` WHERE id = ?', [groupId]);
    res.json({ code: 0, message: '群已解散' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// GET /:groupId/messages
router.get('/:groupId/messages', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const [messages] = await pool.query(`
      SELECT gm.id, gm.group_id, gm.sender_id, gm.content, gm.type, gm.is_recalled, gm.reply_to, gm.created_at,
        u.nickname as sender_nickname, u.avatar as sender_avatar
      FROM group_messages gm
      LEFT JOIN users u ON u.id = gm.sender_id
      WHERE gm.group_id = ?
      ORDER BY gm.created_at DESC
      LIMIT ? OFFSET ?
    `, [groupId, limit, offset]);

    // 更新已读位置
    if (messages.length > 0) {
      const maxId = Math.max(...messages.map(m => m.id));
      await pool.execute(
        'UPDATE group_members SET last_read_msg_id = GREATEST(last_read_msg_id, ?) WHERE group_id = ? AND user_id = ?',
        [maxId, groupId, req.userId]
      );
    }

    res.json({ code: 0, data: decryptMessages(messages.reverse()) });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /:groupId/read — 标记群消息已读
router.post('/:groupId/read', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const [lastMsg] = await pool.execute('SELECT MAX(id) as max_id FROM group_messages WHERE group_id = ?', [groupId]);
    const maxId = lastMsg[0]?.max_id || 0;
    await pool.execute(
      'UPDATE group_members SET last_read_msg_id = ? WHERE group_id = ? AND user_id = ?',
      [maxId, groupId, req.userId]
    );
    res.json({ code: 0 });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

/** 压缩上传的图片（GIF 跳过） */
async function compressUploadedImage(filePath, mimeType) {
  if (mimeType === 'image/gif') return;
  try {
    let pipeline = sharp(filePath).resize(1920, 1920, { fit: 'inside', withoutEnlargement: true });
    if (mimeType === 'image/png') {
      pipeline = pipeline.png({ quality: 80, compressionLevel: 9 });
    } else if (mimeType === 'image/webp') {
      pipeline = pipeline.webp({ quality: 80 });
    } else {
      pipeline = pipeline.jpeg({ quality: 80, mozjpeg: true });
    }
    const buffer = await pipeline.toBuffer();
    await fs.writeFile(filePath, buffer);
  } catch { /* 压缩失败不阻塞上传 */ }
}

// POST /upload
router.post('/upload', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '请选择图片' });
    await compressUploadedImage(req.file.path, req.file.mimetype);
    res.json({ code: 0, data: { url: `/uploads/private/groups/${req.file.filename}` } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /upload-audio
router.post('/upload-audio', auth, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '请选择音频' });
    res.json({ code: 0, data: { url: `/uploads/private/groups/${req.file.filename}` } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /upload-avatar — 上传群头像
router.post('/upload-avatar', auth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '请选择图片' });
    res.json({ code: 0, data: { url: `/uploads/private/groups/${req.file.filename}` } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /recall/:msgId — 撤回群消息
router.post('/recall/:msgId', auth, async (req, res) => {
  try {
    const msgId = parseInt(req.params.msgId);
    const [rows] = await pool.execute('SELECT sender_id, group_id, created_at FROM group_messages WHERE id = ?', [msgId]);
    if (rows.length === 0) return res.json({ code: 404, message: '消息不存在' });
    const msg = rows[0];

    // 自己发的消息：群主随时可撤，其他人2分钟内
    if (msg.sender_id === req.userId) {
      const [ownRole] = await pool.execute(
        'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
        [msg.group_id, req.userId]
      );
      const isOwner = ownRole.length > 0 && ownRole[0].role === 'owner';
      if (!isOwner && (Date.now() - new Date(msg.created_at).getTime()) > 120000) {
        return res.json({ code: 400, message: '超过2分钟无法撤回' });
      }
    } else {
      // 非自己发的消息：检查管理权限
      const [myRole] = await pool.execute(
        'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
        [msg.group_id, req.userId]
      );
      if (myRole.length === 0) return res.json({ code: 403, message: '你不是群成员' });

      const myR = myRole[0].role;
      if (myR === 'member') return res.json({ code: 403, message: '你无权撤回他人消息' });

      // 查询发送者的角色
      const [senderRole] = await pool.execute(
        'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
        [msg.group_id, msg.sender_id]
      );
      const senderR = senderRole.length > 0 ? senderRole[0].role : 'member';

      // 管理员只能撤回普通成员的消息，群主可以撤回所有人
      if (myR === 'admin') {
        if (senderR !== 'member') return res.json({ code: 403, message: '管理员只能撤回普通成员的消息' });
      }
      // owner 可以撤回任何人
    }

    await pool.execute('UPDATE group_messages SET is_recalled = 1 WHERE id = ?', [msgId]);
    const io = req.app.get('io');
    io.to(`group:${msg.group_id}`).emit('group:message:recalled', { msgId, groupId: msg.group_id });
    res.json({ code: 0 });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// GET /:groupId/notices — 获取群公告列表
router.get('/:groupId/notices', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const [notices] = await pool.execute(`
      SELECT n.id, n.title, n.content, n.images, n.is_broadcast, n.created_at,
        u.nickname as author_name, u.avatar as author_avatar,
        (SELECT COUNT(*) FROM group_notice_reads WHERE notice_id = n.id) as read_count,
        (SELECT COUNT(*) FROM group_members WHERE group_id = n.group_id) as member_count,
        (SELECT COUNT(*) FROM group_notice_reads WHERE notice_id = n.id AND user_id = ?) as is_read
      FROM group_notices n
      JOIN users u ON u.id = n.author_id
      WHERE n.group_id = ?
      ORDER BY n.created_at DESC
    `, [req.userId, groupId]);
    res.json({ code: 0, data: notices });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /:groupId/notices — 发布群公告
router.post('/:groupId/notices', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { title, content, images } = req.body;
    if (!content?.trim()) return res.json({ code: 400, message: '公告内容不能为空' });
    const [roleCheck] = await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    if (roleCheck.length === 0 || !['owner', 'admin'].includes(roleCheck[0].role)) return res.json({ code: 403, message: '无权发布公告' });
    const imgStr = Array.isArray(images) && images.length > 0 ? JSON.stringify(images.slice(0, 9)) : null;
    const [result] = await pool.execute('INSERT INTO group_notices (group_id, author_id, title, content, images) VALUES (?, ?, ?, ?, ?)', [groupId, req.userId, (title || '').trim().slice(0, 200), content.trim(), imgStr]);
    const io = req.app.get('io');
    io.to(`group:${groupId}`).emit('group:notice_new', { groupId, noticeId: result.insertId });
    res.json({ code: 0, data: { id: result.insertId } });
  } catch (err) {
    console.error('[POST notices]', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 上传公告图片
router.post('/:groupId/notices/upload', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '请选择图片' });
    const url = `/uploads/private/groups/${req.file.filename}`;
    res.json({ code: 0, data: { url } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 编辑公告
router.put('/:groupId/notices/:noticeId', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const noticeId = parseInt(req.params.noticeId);
    const { title, content, images } = req.body;
    const [roleCheck] = await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    if (roleCheck.length === 0 || !['owner', 'admin'].includes(roleCheck[0].role)) return res.json({ code: 403, message: '无权编辑公告' });
    if (!content?.trim()) return res.json({ code: 400, message: '公告内容不能为空' });
    const imgStr = Array.isArray(images) && images.length > 0 ? JSON.stringify(images.slice(0, 9)) : null;
    await pool.execute('UPDATE group_notices SET title = ?, content = ?, images = ? WHERE id = ? AND group_id = ?', [(title || '').trim().slice(0, 200), content.trim(), imgStr, noticeId, groupId]);
    // 若编辑的是播报公告，实时推送更新
    const [[checkRow]] = await pool.execute('SELECT is_broadcast FROM group_notices WHERE id = ?', [noticeId]);
    if (checkRow?.is_broadcast === 1) {
      const [[notice]] = await pool.execute('SELECT id, title, content, images, author_id, created_at FROM group_notices WHERE id = ?', [noticeId]);
      const [[author]] = await pool.execute('SELECT nickname, avatar FROM users WHERE id = ?', [notice.author_id]);
      const io = req.app.get('io');
      io.to(`group:${groupId}`).emit('group:broadcast', { groupId, notice: { ...notice, author_nickname: author?.nickname, author_avatar: author?.avatar } });
    }
    res.json({ code: 0, message: '已更新' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// PUT /:groupId/notices/:noticeId/broadcast — 设置/取消播报
router.put('/:groupId/notices/:noticeId/broadcast', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const noticeId = parseInt(req.params.noticeId);
    const { is_broadcast } = req.body;
    const [roleCheck] = await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    if (roleCheck.length === 0 || !['owner', 'admin'].includes(roleCheck[0].role)) return res.json({ code: 403, message: '无权操作' });
    // 先取消该群所有播报
    if (is_broadcast) await pool.execute('UPDATE group_notices SET is_broadcast = 0 WHERE group_id = ?', [groupId]);
    await pool.execute('UPDATE group_notices SET is_broadcast = ? WHERE id = ? AND group_id = ?', [is_broadcast ? 1 : 0, noticeId, groupId]);
    // 实时推送播报
    if (is_broadcast) {
      const [[notice]] = await pool.execute('SELECT id, title, content, images, author_id, created_at FROM group_notices WHERE id = ?', [noticeId]);
      const [[author]] = await pool.execute('SELECT nickname, avatar FROM users WHERE id = ?', [req.userId]);
      const io = req.app.get('io');
      io.to(`group:${groupId}`).emit('group:broadcast', { groupId, notice: { ...notice, author_nickname: author?.nickname, author_avatar: author?.avatar } });
    }
    res.json({ code: 0 });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /:groupId/notices/:noticeId/read — 标记已读
router.post('/:groupId/notices/:noticeId/read', auth, async (req, res) => {
  try {
    const noticeId = parseInt(req.params.noticeId);
    const [result] = await pool.execute('INSERT IGNORE INTO group_notice_reads (notice_id, user_id) VALUES (?, ?)', [noticeId, req.userId]);
    // 只有真正插入新记录时才递增 read_count
    if (result.affectedRows > 0) {
      await pool.execute('UPDATE group_notices SET read_count = read_count + 1 WHERE id = ?', [noticeId]);
    }
    res.json({ code: 0 });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// GET /:groupId/notices/broadcast — 获取当前播报公告（进入群聊时调用）
router.get('/:groupId/notices/broadcast', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const [rows] = await pool.execute(`
      SELECT n.id, n.title, n.content, n.images, n.created_at,
        u.nickname as author_name, u.avatar as author_avatar,
        (SELECT COUNT(*) FROM group_notice_reads WHERE notice_id = n.id AND user_id = ?) as is_read
      FROM group_notices n
      JOIN users u ON u.id = n.author_id
      WHERE n.group_id = ? AND n.is_broadcast = 1
      LIMIT 1
    `, [req.userId, groupId]);
    res.json({ code: 0, data: rows[0] || null });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// DELETE /:groupId/notices/:noticeId — 删除群公告
router.delete('/:groupId/notices/:noticeId', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const noticeId = parseInt(req.params.noticeId);
    const [roleCheck] = await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.userId]);
    if (roleCheck.length === 0 || !['owner', 'admin'].includes(roleCheck[0].role)) return res.json({ code: 403, message: '无权删除公告' });
    // 删除前检查是否为播报公告
    const [[noticeRow]] = await pool.execute('SELECT is_broadcast FROM group_notices WHERE id = ? AND group_id = ?', [noticeId, groupId]);
    await pool.execute('DELETE FROM group_notice_reads WHERE notice_id = ?', [noticeId]);
    await pool.execute('DELETE FROM group_notices WHERE id = ? AND group_id = ?', [noticeId, groupId]);
    // 若删除的是播报公告，通知群成员清除播报弹窗
    if (noticeRow?.is_broadcast === 1) {
      const io = req.app.get('io');
      io.to(`group:${groupId}`).emit('group:broadcast', { groupId, notice: null });
    }
    res.json({ code: 0 });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 群成员禁言 API =====

// 检查用户在当前群的角色（复用函数）
async function getMemberRole(groupId, userId) {
  const [[member]] = await pool.execute(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return member ? member.role : null;
}

// POST /:groupId/mute — 禁言成员
router.post('/:groupId/mute', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { userId, duration } = req.body; // duration: 分钟数, 0=永久
    if (!userId) return res.json({ code: 400, message: '缺少参数' });

    const myRole = await getMemberRole(groupId, req.userId);
    if (!myRole || myRole === 'member') return res.json({ code: 403, message: '无权限操作' });

    const targetRole = await getMemberRole(groupId, userId);
    if (!targetRole) return res.json({ code: 404, message: '该用户不在群中' });
    if (myRole === 'admin' && targetRole !== 'member') return res.json({ code: 403, message: '管理员只能禁言普通成员' });
    if (targetRole === 'owner') return res.json({ code: 403, message: '不能禁言群主' });

    const mutedUntil = duration > 0
      ? new Date(Date.now() + duration * 60000).toISOString().slice(0, 19).replace('T', ' ')
      : null;

    await pool.execute(
      'INSERT INTO group_member_mutes (group_id, user_id, muted_by, muted_until) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE muted_by = VALUES(muted_by), muted_until = VALUES(muted_until)',
      [groupId, userId, req.userId, mutedUntil]
    );

    // 实时通知被禁言用户
    const io = req.app.get('io');
    io.to(`group:${groupId}`).emit('group:member_muted', { groupId, userId, mutedUntil });

    res.json({ code: 0, message: '禁言成功', data: { userId, mutedUntil } });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// POST /:groupId/unmute — 解除禁言
router.post('/:groupId/unmute', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { userId } = req.body;
    if (!userId) return res.json({ code: 400, message: '缺少参数' });

    const myRole = await getMemberRole(groupId, req.userId);
    if (!myRole || myRole === 'member') return res.json({ code: 403, message: '无权限操作' });

    await pool.execute('DELETE FROM group_member_mutes WHERE group_id = ? AND user_id = ?', [groupId, userId]);

    const io = req.app.get('io');
    io.to(`group:${groupId}`).emit('group:member_unmuted', { groupId, userId });

    res.json({ code: 0, message: '已解除禁言' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// GET /:groupId/mutes — 获取禁言列表
router.get('/:groupId/mutes', auth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const [mutes] = await pool.execute(
      'SELECT m.id, m.user_id, m.muted_by, m.muted_until, m.created_at, u.nickname, u.avatar FROM group_member_mutes m JOIN users u ON m.user_id = u.id WHERE m.group_id = ?',
      [groupId]
    );
    res.json({ code: 0, data: mutes });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
