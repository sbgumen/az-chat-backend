const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const fs = require('fs').promises;
const { safeDecrypt, deriveKey } = require('../utils/crypto');
const router = express.Router();

let _msgKey = null;
function getMsgKey() {
  if (_msgKey) return _msgKey;
  const mk = process.env.MASTER_KEY;
  if (mk && mk.length === 64) _msgKey = deriveKey(mk, 'msg');
  return _msgKey;
}

/** 对消息列表批量解密 content 字段 */
function decryptMessages(msgs, key) {
  if (!key || !msgs) return msgs;
  return msgs.map(m => {
    if (m.content !== undefined) m.content = safeDecrypt(key, m.content);
    if (m.last_message !== undefined) m.last_message = safeDecrypt(key, m.last_message);
    return m;
  });
}

// 允许的文件类型
const ALLOWED_MSG_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm', 'audio/3gpp',
  'video/mp4', 'video/quicktime',
];

const msgFileFilter = (req, file, cb) => {
  if (ALLOWED_MSG_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('不支持的文件类型'), false);
  }
};

// 文件上传配置（图片 + 音频）
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads/private/messages')),
  filename: (req, file, cb) => cb(null, `msg_${req.userId}_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: msgFileFilter });

// 获取会话列表（含未读数和最后一条消息）
router.get('/conversations', auth, async (req, res) => {
  try {
    const [conversations] = await pool.execute(`
      SELECT
        u.id as user_id, u.nickname, u.avatar, u.gender,
        m.content as last_message, m.type as last_message_type, m.is_recalled as last_is_recalled, m.reply_to as last_reply_to, m.created_at as last_time,
        (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = ? AND is_read = 0) as unread_count,
        COALESCE(cs.is_pinned, 0) as is_pinned,
        COALESCE(cs.is_muted, 0) as is_muted
      FROM (
        SELECT DISTINCT
          CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as contact_id
        FROM messages WHERE sender_id = ? OR receiver_id = ?
      ) conv
      JOIN users u ON u.id = conv.contact_id
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages
        WHERE (sender_id = ? AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = ?)
        ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN conversation_settings cs ON cs.user_id = ? AND cs.target_id = u.id AND cs.type = 'private'
      ORDER BY m.created_at DESC
    `, [req.userId, req.userId, req.userId, req.userId, req.userId, req.userId, req.userId]);

    res.json({ code: 0, data: decryptMessages(conversations, getMsgKey()) });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取群聊会话列表（含未读数）
router.get('/group-conversations', auth, async (req, res) => {
  try {
    const [groups] = await pool.execute(`
      SELECT g.id as group_id, g.name as group_name, g.avatar as group_avatar,
        COALESCE(g.is_system, 0) as is_system, g.system_mode,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
        gm2.content as last_message, gm2.type as last_message_type, gm2.created_at as last_time,
        COALESCE(
          (SELECT COUNT(*) FROM group_messages gm3
           WHERE gm3.group_id = g.id AND gm3.id > COALESCE(gm.last_read_msg_id, 0) AND gm3.type != 'system'),
          0
        ) as unread_count,
        COALESCE(cs.is_pinned, 0) as is_pinned,
        COALESCE(cs.is_muted, 0) as is_muted
      FROM group_members gm
      JOIN \`groups\` g ON g.id = gm.group_id
      LEFT JOIN group_messages gm2 ON gm2.id = (
        SELECT id FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN conversation_settings cs ON cs.user_id = ? AND cs.target_id = g.id AND cs.type = 'group'
      WHERE gm.user_id = ?
      ORDER BY gm2.created_at DESC
    `, [req.userId, req.userId]);

    const result = decryptMessages(groups.map(g => ({ ...g, is_group: true })), getMsgKey());
    res.json({ code: 0, data: result });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取与某人的聊天记录
router.get('/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const [messages] = await pool.query(`
      SELECT id, sender_id, receiver_id, content, type, is_read, is_recalled, reply_to, created_at
      FROM messages
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [req.userId, parseInt(userId), parseInt(userId), req.userId, limit, offset]);

    const [friendCheck] = await pool.execute(
      'SELECT id FROM contacts WHERE user_id = ? AND friend_id = ?',
      [req.userId, parseInt(userId)]
    );
    const is_friend = friendCheck.length > 0;

    res.json({ code: 0, data: decryptMessages(messages.reverse(), getMsgKey()), is_friend });
  } catch (err) {
    console.error('[Messages] 获取聊天记录失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 标记已读
router.post('/read/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    await pool.execute(
      'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
      [parseInt(userId), req.userId]
    );
    res.json({ code: 0, message: '已标记已读' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 撤回消息
router.post('/recall/:msgId', auth, async (req, res) => {
  try {
    const msgId = parseInt(req.params.msgId);
    const [rows] = await pool.execute(
      'SELECT sender_id, receiver_id, created_at FROM messages WHERE id = ?', [msgId]
    );
    if (rows.length === 0) return res.json({ code: 404, message: '消息不存在' });
    const msg = rows[0];
    if (msg.sender_id !== req.userId) return res.json({ code: 403, message: '只能撤回自己的消息' });
    const age = (Date.now() - new Date(msg.created_at).getTime()) / 1000;
    if (age > 120) return res.json({ code: 400, message: '超过2分钟无法撤回' });

    await pool.execute('UPDATE messages SET is_recalled = 1 WHERE id = ?', [msgId]);

    // 通过 socket 通知双方
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const payload = { msgId, recallerId: req.userId };
    [msg.sender_id, msg.receiver_id].forEach(uid => {
      const sid = onlineUsers.get(uid);
      if (sid) io.to(sid).emit('message:recalled', payload);
    });

    res.json({ code: 0 });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

/** 压缩上传的图片（GIF 跳过，避免破坏动画） */
async function compressUploadedImage(filePath, mimeType) {
  if (mimeType === 'image/gif') return; // 不动 GIF
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

// 上传图片消息
router.post('/upload', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '请选择图片' });
    await compressUploadedImage(req.file.path, req.file.mimetype);
    const imageUrl = `/uploads/private/messages/${req.file.filename}`;
    res.json({ code: 0, data: { url: imageUrl } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 上传语音消息
router.post('/upload-audio', auth, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '请选择音频' });
    const audioUrl = `/uploads/private/messages/${req.file.filename}`;
    res.json({ code: 0, data: { url: audioUrl } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 搜索私聊聊天记录
router.get('/search/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const keyword = (req.query.keyword || '').trim().toLowerCase();
    if (!keyword) return res.json({ code: 0, data: [] });

    const [messages] = await pool.execute(`
      SELECT id, sender_id, receiver_id, content, type, is_recalled, created_at
      FROM messages
      WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
        AND is_recalled = 0 AND type = 'text'
      ORDER BY created_at DESC
      LIMIT 200
    `, [req.userId, parseInt(userId), parseInt(userId), req.userId]);

    const msgKey = getMsgKey();
    const filtered = messages
      .map(m => ({ ...m, content: msgKey ? safeDecrypt(msgKey, m.content) : m.content }))
      .filter(m => m.content && m.content.toLowerCase().includes(keyword))
      .slice(0, 50);

    res.json({ code: 0, data: filtered });
  } catch (err) {
    console.error('[Messages] 搜索聊天记录失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 搜索群聊聊天记录
router.get('/group-search/:groupId', auth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const keyword = (req.query.keyword || '').trim().toLowerCase();
    if (!keyword) return res.json({ code: 0, data: [] });

    const [messages] = await pool.execute(`
      SELECT gm.id, gm.group_id, gm.sender_id, gm.content, gm.type, gm.created_at,
             u.nickname as sender_nickname, u.avatar as sender_avatar
      FROM group_messages gm
      LEFT JOIN users u ON u.id = gm.sender_id
      WHERE gm.group_id = ? AND gm.is_recalled = 0 AND gm.type = 'text'
      ORDER BY gm.created_at DESC
      LIMIT 200
    `, [parseInt(groupId)]);

    const msgKey = getMsgKey();
    const filtered = messages
      .map(m => ({ ...m, content: msgKey ? safeDecrypt(msgKey, m.content) : m.content }))
      .filter(m => m.content && m.content.toLowerCase().includes(keyword))
      .slice(0, 50);

    res.json({ code: 0, data: filtered });
  } catch (err) {
    console.error('[Messages] 搜索群聊记录失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取会话设置
router.get('/settings/:targetId', auth, async (req, res) => {
  try {
    const { targetId } = req.params;
    const type = req.query.type || 'private';
    const [rows] = await pool.execute(
      'SELECT is_pinned, is_muted FROM conversation_settings WHERE user_id = ? AND target_id = ? AND type = ?',
      [req.userId, parseInt(targetId), type]
    );
    res.json({ code: 0, data: rows[0] || { is_pinned: 0, is_muted: 0 } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新会话设置（置顶/免打扰）
router.post('/settings/:targetId', auth, async (req, res) => {
  try {
    const { targetId } = req.params;
    const { type = 'private', is_pinned, is_muted } = req.body;
    const pinnedAt = is_pinned ? new Date() : null;

    await pool.execute(`
      INSERT INTO conversation_settings (user_id, target_id, type, is_pinned, is_muted, pinned_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        is_pinned = VALUES(is_pinned),
        is_muted = VALUES(is_muted),
        pinned_at = CASE WHEN VALUES(is_pinned) = 1 AND is_pinned = 0 THEN NOW() WHEN VALUES(is_pinned) = 0 THEN NULL ELSE pinned_at END
    `, [req.userId, parseInt(targetId), type, is_pinned ?? 0, is_muted ?? 0, pinnedAt]);

    res.json({ code: 0, message: '设置已更新' });
  } catch (err) {
    console.error('[Messages] 更新会话设置失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取所有置顶会话
router.get('/pinned/list', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT target_id, type FROM conversation_settings WHERE user_id = ? AND is_pinned = 1',
      [req.userId]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取所有免打扰会话
router.get('/muted/list', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT target_id, type FROM conversation_settings WHERE user_id = ? AND is_muted = 1',
      [req.userId]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
