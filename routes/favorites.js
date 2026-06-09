const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const router = express.Router();

// 收藏/取消收藏消息
router.post('/toggle', auth, async (req, res) => {
  try {
    const { msgId, msgType } = req.body; // msgType: 'private' | 'group'
    if (!msgId || !msgType) return res.json({ code: 400, message: '参数缺失' });

    const [existing] = await pool.execute(
      'SELECT id FROM favorites WHERE user_id = ? AND msg_id = ? AND msg_type = ?',
      [req.userId, msgId, msgType]
    );

    if (existing.length > 0) {
      await pool.execute('DELETE FROM favorites WHERE user_id = ? AND msg_id = ? AND msg_type = ?', [req.userId, msgId, msgType]);
      return res.json({ code: 0, data: { favorited: false } });
    }

    // 获取消息详情
    let msgRow;
    let sourceName = '';
    if (msgType === 'private') {
      const [rows] = await pool.execute(
        `SELECT m.id, m.sender_id, m.content, m.type, m.created_at,
          u.nickname as sender_nickname, u.avatar as sender_avatar
         FROM messages m JOIN users u ON m.sender_id = u.id
         WHERE m.id = ? AND m.is_recalled = 0`,
        [msgId]
      );
      msgRow = rows[0];
      // 来源：对方昵称（非自己的那一方）
      if (msgRow) {
        const otherId = msgRow.sender_id === req.userId ? null : msgRow.sender_id;
        if (otherId) {
          const [rows2] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [otherId]);
          sourceName = rows2[0]?.nickname || '';
        } else {
          // 自己发的消息，找接收方
          const [rows3] = await pool.execute('SELECT receiver_id FROM messages WHERE id = ?', [msgId]);
          if (rows3[0]) {
            const [rows4] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [rows3[0].receiver_id]);
            sourceName = rows4[0]?.nickname || '';
          }
        }
      }
    } else {
      const [rows] = await pool.execute(
        `SELECT m.id, m.sender_id, m.content, m.type, m.created_at,
          u.nickname as sender_nickname, u.avatar as sender_avatar,
          m.group_id
         FROM group_messages m JOIN users u ON m.sender_id = u.id
         WHERE m.id = ? AND m.is_recalled = 0`,
        [msgId]
      );
      msgRow = rows[0];
      if (msgRow) {
        const [gRows] = await pool.execute('SELECT name FROM `groups` WHERE id = ?', [msgRow.group_id]);
        sourceName = gRows[0]?.name || '';
      }
    }
    if (!msgRow) return res.json({ code: 404, message: '消息不存在' });

    await pool.execute(
      `INSERT INTO favorites (user_id, msg_id, msg_type, sender_id, sender_nickname, sender_avatar, content, content_type, msg_created_at, source_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.userId, msgId, msgType, msgRow.sender_id, msgRow.sender_nickname, msgRow.sender_avatar, msgRow.content, msgRow.type, msgRow.created_at, sourceName]
    );
    res.json({ code: 0, data: { favorited: true } });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 检查是否已收藏
router.get('/check', auth, async (req, res) => {
  try {
    const { msgId, msgType } = req.query;
    const [rows] = await pool.execute(
      'SELECT id FROM favorites WHERE user_id = ? AND msg_id = ? AND msg_type = ?',
      [req.userId, msgId, msgType]
    );
    res.json({ code: 0, data: { favorited: rows.length > 0 } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取收藏列表
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, msg_id, msg_type, sender_id, sender_nickname, sender_avatar,
        content, content_type, msg_created_at, source_name, created_at
       FROM favorites WHERE user_id = ? ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
