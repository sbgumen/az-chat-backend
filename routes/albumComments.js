const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { sendPush } = require('../utils/fcm');
const router = express.Router();

// 获取相册评论列表
router.get('/:albumId', auth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.albumId);
    const [[album]] = await pool.execute('SELECT id, user_id, visibility FROM photo_albums WHERE id = ?', [albumId]);
    if (!album) return res.json({ code: 404, message: '相册不存在' });

    // 权限检查
    if (album.user_id !== req.userId) {
      const [[contact]] = await pool.execute('SELECT id FROM contacts WHERE user_id = ? AND friend_id = ?', [req.userId, album.user_id]);
      const isFriend = !!contact;
      if (album.visibility === 'private') return res.json({ code: 403, message: '无权查看' });
      if (album.visibility === 'friends' && !isFriend) return res.json({ code: 403, message: '无权查看' });
    }

    const [comments] = await pool.execute(
      `SELECT c.id, c.album_id, c.user_id, c.content, c.reply_to, c.created_at,
        u.nickname, u.avatar,
        ru.nickname as reply_nickname
       FROM album_comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN album_comments rc ON rc.id = c.reply_to
       LEFT JOIN users ru ON ru.id = rc.user_id
       WHERE c.album_id = ? ORDER BY c.created_at ASC`,
      [albumId]
    );
    res.json({ code: 0, data: comments });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发表评论
router.post('/:albumId', auth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.albumId);
    const { content, replyTo } = req.body;
    if (!content || !content.trim()) return res.json({ code: 400, message: '评论内容不能为空' });
    if (content.trim().length > 200) return res.json({ code: 400, message: '评论不能超过200字' });

    const [[album]] = await pool.execute('SELECT id, user_id, visibility FROM photo_albums WHERE id = ?', [albumId]);
    if (!album) return res.json({ code: 404, message: '相册不存在' });

    // 权限检查
    if (album.user_id !== req.userId) {
      const [[contact]] = await pool.execute('SELECT id FROM contacts WHERE user_id = ? AND friend_id = ?', [req.userId, album.user_id]);
      const isFriend = !!contact;
      if (album.visibility === 'private') return res.json({ code: 403, message: '无权评论' });
      if (album.visibility === 'friends' && !isFriend) return res.json({ code: 403, message: '无权评论' });
    }

    const replyToId = replyTo ? parseInt(replyTo) : null;
    if (replyToId) {
      const [[replyComment]] = await pool.execute('SELECT id FROM album_comments WHERE id = ? AND album_id = ?', [replyToId, albumId]);
      if (!replyComment) return res.json({ code: 400, message: '被回复的评论不存在' });
    }

    const [result] = await pool.execute(
      'INSERT INTO album_comments (album_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)',
      [albumId, req.userId, content.trim(), replyToId]
    );

    const [[comment]] = await pool.execute(
      `SELECT c.id, c.album_id, c.user_id, c.content, c.reply_to, c.created_at,
        u.nickname, u.avatar,
        ru.nickname as reply_nickname
       FROM album_comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN album_comments rc ON rc.id = c.reply_to
       LEFT JOIN users ru ON ru.id = rc.user_id
       WHERE c.id = ?`,
      [result.insertId]
    );

    // 推送实时通知给相册主人（如果不是自己评论自己）
    if (album.user_id !== req.userId) {
      // 持久化未读通知（离线时也能收到）
      await pool.execute(
        'INSERT INTO album_notifications (owner_id, album_id, type) VALUES (?, ?, ?)',
        [album.user_id, albumId, 'comment']
      );
      const io = req.app.get('io');
      const onlineUsers = req.app.get('onlineUsers');
      const ownerSocketId = onlineUsers?.get(album.user_id);
      if (io && ownerSocketId) {
        io.to(ownerSocketId).emit('album:new_comment', { albumId, comment });
      } else {
        const [[u]] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
        const [[owner]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [album.user_id]);
        if (owner?.fcm_token) {
          await sendPush(owner.fcm_token, '相册评论', `${u?.nickname || '有人'} 评论了你的相册`, { type: 'album_comment', albumId: String(albumId) });
        }
      }
    }

    res.json({ code: 0, data: comment });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除评论（相册主人可删任意评论，评论者可删自己的）
router.delete('/:commentId', auth, async (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const [[comment]] = await pool.execute(
      'SELECT c.id, c.user_id, c.album_id, pa.user_id as album_owner_id FROM album_comments c JOIN photo_albums pa ON pa.id = c.album_id WHERE c.id = ?',
      [commentId]
    );
    if (!comment) return res.json({ code: 404, message: '评论不存在' });
    if (comment.user_id !== req.userId && comment.album_owner_id !== req.userId) {
      return res.json({ code: 403, message: '无权删除此评论' });
    }
    // 删除该评论及其子回复
    await pool.execute('DELETE FROM album_comments WHERE id = ? OR reply_to = ?', [commentId, commentId]);
    res.json({ code: 0, message: '已删除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
