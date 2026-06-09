const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { sendPush } = require('../utils/fcm');
const router = express.Router();

// 收藏/取消收藏相册集
router.post('/toggle/:albumId', auth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.albumId);
    const [[album]] = await pool.execute('SELECT id, user_id, name FROM photo_albums WHERE id = ?', [albumId]);
    if (!album) return res.json({ code: 404, message: '相册不存在' });
    if (album.user_id === req.userId) return res.json({ code: 400, message: '不能收藏自己的相册' });

    const [[existing]] = await pool.execute('SELECT id FROM album_favorites WHERE user_id = ? AND album_id = ?', [req.userId, albumId]);
    if (existing) {
      await pool.execute('DELETE FROM album_favorites WHERE user_id = ? AND album_id = ?', [req.userId, albumId]);
      return res.json({ code: 0, data: { favorited: false } });
    }
    await pool.execute(
      'INSERT INTO album_favorites (user_id, album_id, album_owner_id, album_name) VALUES (?, ?, ?, ?)',
      [req.userId, albumId, album.user_id, album.name]
    );

    // 推送实时通知给相册主人
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const ownerSocketId = onlineUsers?.get(album.user_id);
    // 持久化未读通知
    await pool.execute(
      'INSERT INTO album_notifications (owner_id, album_id, type) VALUES (?, ?, ?)',
      [album.user_id, albumId, 'favorite']
    );
    if (io && ownerSocketId) {
      io.to(ownerSocketId).emit('album:new_favorite', { albumId });
    } else {
      const [[u]] = await pool.execute('SELECT fcm_token, nickname FROM users WHERE id = ?', [req.userId]);
      const [[owner]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [album.user_id]);
      if (owner?.fcm_token) {
        await sendPush(owner.fcm_token, '相册收藏', `${u?.nickname || '有人'} 收藏了你的相册「${album.name}」`, { type: 'album_favorite', albumId: String(albumId) });
      }
    }

    res.json({ code: 0, data: { favorited: true } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取我收藏的相册集列表
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT af.id, af.album_id, af.album_name, af.created_at,
        u.id as owner_id, u.nickname as owner_nickname, u.avatar as owner_avatar,
        pa.cover, pa.carousel_photos,
        (SELECT COUNT(*) FROM album_photos WHERE album_id = af.album_id) as photo_count
       FROM album_favorites af
       JOIN photo_albums pa ON pa.id = af.album_id
       JOIN users u ON u.id = af.album_owner_id
       WHERE af.user_id = ? ORDER BY af.created_at DESC`,
      [req.userId]
    );
    // 获取每个相册前3张预览图
    for (const row of rows) {
      const [photos] = await pool.execute(
        'SELECT url FROM album_photos WHERE album_id = ? ORDER BY created_at ASC LIMIT 3',
        [row.album_id]
      );
      row.preview_photos = photos.map(p => p.url);
    }
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 检查是否已收藏
router.get('/check/:albumId', auth, async (req, res) => {
  try {
    const [[row]] = await pool.execute('SELECT id FROM album_favorites WHERE user_id = ? AND album_id = ?', [req.userId, parseInt(req.params.albumId)]);
    res.json({ code: 0, data: { favorited: !!row } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
