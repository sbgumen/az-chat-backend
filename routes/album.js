const express = require('express');
const multer = require('multer');
const path = require('path');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const router = express.Router();

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => cb(null, `album_${req.userId}_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持 JPG/PNG/GIF/WebP 格式'), false);
  }
});

// 获取我的相册未读通知数（按相册分组）
router.get('/my/unread', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT album_id, type, COUNT(*) as cnt FROM album_notifications WHERE owner_id = ? GROUP BY album_id, type',
      [req.userId]
    );
    const result = {};
    for (const r of rows) {
      if (!result[r.album_id]) result[r.album_id] = { comments: 0, favorites: 0 };
      if (r.type === 'comment') result[r.album_id].comments = r.cnt;
      else if (r.type === 'favorite') result[r.album_id].favorites = r.cnt;
    }
    res.json({ code: 0, data: result });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清除某相册的未读通知
router.delete('/my/unread/:albumId', auth, async (req, res) => {
  try {
    await pool.execute(
      'DELETE FROM album_notifications WHERE owner_id = ? AND album_id = ?',
      [req.userId, parseInt(req.params.albumId)]
    );
    res.json({ code: 0 });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取我的相册集列表
router.get('/my', auth, async (req, res) => {
  try {
    const [albums] = await pool.execute(
      `SELECT a.id, a.name, a.cover, a.visibility, a.created_at,
        (SELECT COUNT(*) FROM album_photos WHERE album_id = a.id) as photo_count,
        (SELECT COUNT(*) FROM album_favorites WHERE album_id = a.id) as favorite_count,
        (SELECT MIN(created_at) FROM album_photos WHERE album_id = a.id) as date_from,
        (SELECT MAX(created_at) FROM album_photos WHERE album_id = a.id) as date_to
       FROM photo_albums a WHERE a.user_id = ? ORDER BY a.created_at DESC`,
      [req.userId]
    );
    for (const album of albums) {
      const [photos] = await pool.execute(
        'SELECT url FROM album_photos WHERE album_id = ? ORDER BY created_at ASC LIMIT 3',
        [album.id]
      );
      album.preview_photos = photos.map(p => p.url);
    }
    res.json({ code: 0, data: albums });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取他人相册集列表（根据权限过滤）
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.userId);
    const viewerId = req.userId;

    // 判断是否为好友
    let isFriend = false;
    if (viewerId !== targetId) {
      const [[contact]] = await pool.execute(
        'SELECT id FROM contacts WHERE user_id = ? AND friend_id = ?',
        [viewerId, targetId]
      );
      isFriend = !!contact;
    }

    let visibilityFilter;
    if (viewerId === targetId) {
      visibilityFilter = "1=1"; // 自己看全部
    } else if (isFriend) {
      visibilityFilter = "a.visibility IN ('public','friends')";
    } else {
      visibilityFilter = "a.visibility = 'public'";
    }

    const [albums] = await pool.execute(
      `SELECT a.id, a.name, a.cover, a.visibility, a.created_at,
        (SELECT COUNT(*) FROM album_photos WHERE album_id = a.id) as photo_count,
        (SELECT COUNT(*) FROM album_favorites WHERE album_id = a.id) as favorite_count,
        (SELECT MIN(created_at) FROM album_photos WHERE album_id = a.id) as date_from,
        (SELECT MAX(created_at) FROM album_photos WHERE album_id = a.id) as date_to
       FROM photo_albums a WHERE a.user_id = ? AND ${visibilityFilter} ORDER BY a.created_at DESC`,
      [targetId]
    );
    for (const album of albums) {
      const [photos] = await pool.execute(
        'SELECT url FROM album_photos WHERE album_id = ? ORDER BY created_at ASC LIMIT 3',
        [album.id]
      );
      album.preview_photos = photos.map(p => p.url);
    }
    res.json({ code: 0, data: albums });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取相册内照片
router.get('/:albumId/photos', auth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.albumId);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = parseInt(req.query.limit) || 0; // 0 = 不分页（兼容旧版）
    const offset = limit > 0 ? (page - 1) * limit : 0;

    const [[album]] = await pool.execute(
      'SELECT id, user_id, name, carousel_photos, visibility FROM photo_albums WHERE id = ?',
      [albumId]
    );
    if (!album) return res.json({ code: 404, message: '相册不存在' });

    // 权限检查
    if (album.user_id !== req.userId) {
      const [[contact]] = await pool.execute(
        'SELECT id FROM contacts WHERE user_id = ? AND friend_id = ?',
        [req.userId, album.user_id]
      );
      const isFriend = !!contact;
      if (album.visibility === 'private') return res.json({ code: 403, message: '该相册仅自己可见' });
      if (album.visibility === 'friends' && !isFriend) return res.json({ code: 403, message: '该相册仅好友可见' });
    }

    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM album_photos WHERE album_id = ?',
      [albumId]
    );

    let photos;
    if (limit > 0) {
      [photos] = await pool.execute(
        'SELECT id, url, caption, created_at FROM album_photos WHERE album_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [albumId, limit, offset]
      );
    } else {
      [photos] = await pool.execute(
        'SELECT id, url, caption, created_at FROM album_photos WHERE album_id = ? ORDER BY created_at ASC',
        [albumId]
      );
    }
    const carouselIds = album.carousel_photos ? JSON.parse(album.carousel_photos) : [];
    const [[{ favorite_count }]] = await pool.execute(
      'SELECT COUNT(*) as favorite_count FROM album_favorites WHERE album_id = ?',
      [albumId]
    );
    res.json({
      code: 0,
      data: {
        album: { ...album, carousel_photos: carouselIds, favorite_count },
        photos,
        pagination: limit > 0 ? { page, limit, total, hasMore: offset + limit < total } : undefined
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 创建相册集
router.post('/', auth, async (req, res) => {
  try {
    const { name, visibility = 'public' } = req.body;
    if (!name || !name.trim()) return res.json({ code: 400, message: '请输入相册名称' });
    const safeVisibility = ['public', 'friends', 'private'].includes(visibility) ? visibility : 'public';
    const [result] = await pool.execute(
      'INSERT INTO photo_albums (user_id, name, visibility) VALUES (?, ?, ?)',
      [req.userId, name.trim().slice(0, 30), safeVisibility]
    );
    res.json({ code: 0, data: { id: result.insertId, name: name.trim(), visibility: safeVisibility } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 上传照片到相册
router.post('/:albumId/photos', auth, upload.single('photo'), async (req, res) => {
  try {
    const albumId = parseInt(req.params.albumId);
    const [[album]] = await pool.execute('SELECT id, user_id, cover FROM photo_albums WHERE id = ? AND user_id = ?', [albumId, req.userId]);
    if (!album) return res.json({ code: 403, message: '无权操作此相册' });

    if (!req.file) return res.json({ code: 400, message: '请选择图片' });
    const url = `/uploads/${req.file.filename}`;
    const caption = (req.body.caption || '').slice(0, 100);
    const [result] = await pool.execute(
      'INSERT INTO album_photos (album_id, user_id, url, caption) VALUES (?, ?, ?, ?)',
      [albumId, req.userId, url, caption]
    );
    // 如果相册还没有封面，设为第一张照片
    if (!album.cover) {
      await pool.execute('UPDATE photo_albums SET cover = ? WHERE id = ?', [url, albumId]);
    }
    res.json({ code: 0, data: { id: result.insertId, url, caption } });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改相册名称
router.put('/:albumId/name', auth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.albumId);
    const { name } = req.body;
    if (!name || !name.trim()) return res.json({ code: 400, message: '名称不能为空' });
    const [[album]] = await pool.execute('SELECT id FROM photo_albums WHERE id = ? AND user_id = ?', [albumId, req.userId]);
    if (!album) return res.json({ code: 403, message: '无权操作' });
    await pool.execute('UPDATE photo_albums SET name = ? WHERE id = ?', [name.trim().slice(0, 30), albumId]);
    res.json({ code: 0, message: '已更新' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 设置相册权限
router.put('/:albumId/visibility', auth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.albumId);
    const { visibility } = req.body;
    if (!['public', 'friends', 'private'].includes(visibility)) return res.json({ code: 400, message: '无效的权限值' });
    const [[album]] = await pool.execute('SELECT id FROM photo_albums WHERE id = ? AND user_id = ?', [albumId, req.userId]);
    if (!album) return res.json({ code: 403, message: '无权操作' });
    await pool.execute('UPDATE photo_albums SET visibility = ? WHERE id = ?', [visibility, albumId]);
    res.json({ code: 0, message: '已更新' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 设置相册轮播照片（最多3张）
router.put('/:albumId/carousel', auth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.albumId);
    const [[album]] = await pool.execute('SELECT id FROM photo_albums WHERE id = ? AND user_id = ?', [albumId, req.userId]);
    if (!album) return res.json({ code: 403, message: '无权操作' });
    const { photoIds } = req.body;
    if (!Array.isArray(photoIds) || photoIds.length > 3) return res.json({ code: 400, message: '最多选3张轮播照片' });
    await pool.execute('UPDATE photo_albums SET carousel_photos = ? WHERE id = ?', [JSON.stringify(photoIds), albumId]);
    res.json({ code: 0, message: '已更新' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除照片
router.delete('/photos/:photoId', auth, async (req, res) => {
  try {
    const photoId = parseInt(req.params.photoId);
    const [[photo]] = await pool.execute('SELECT id, album_id FROM album_photos WHERE id = ? AND user_id = ?', [photoId, req.userId]);
    if (!photo) return res.json({ code: 403, message: '无权操作' });
    await pool.execute('DELETE FROM album_photos WHERE id = ?', [photoId]);
    const [[first]] = await pool.execute('SELECT url FROM album_photos WHERE album_id = ? ORDER BY created_at ASC LIMIT 1', [photo.album_id]);
    await pool.execute('UPDATE photo_albums SET cover = ? WHERE id = ?', [first ? first.url : null, photo.album_id]);
    res.json({ code: 0, message: '已删除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除相册集
router.delete('/:albumId', auth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.albumId);
    const [[album]] = await pool.execute('SELECT id FROM photo_albums WHERE id = ? AND user_id = ?', [albumId, req.userId]);
    if (!album) return res.json({ code: 403, message: '无权操作' });
    await pool.execute('DELETE FROM album_photos WHERE album_id = ?', [albumId]);
    await pool.execute('DELETE FROM album_favorites WHERE album_id = ?', [albumId]);
    await pool.execute('DELETE FROM album_comments WHERE album_id = ?', [albumId]);
    await pool.execute('DELETE FROM photo_albums WHERE id = ?', [albumId]);
    res.json({ code: 0, message: '已删除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
