const express = require('express');
const multer = require('multer');
const path = require('path');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { ipToLocation } = require('../utils/ipLocation');
const { sendPush } = require('../utils/fcm');
const { encrypt, safeDecrypt, deriveKey } = require('../utils/crypto');
const { decCoin, addExp, getExpConfig } = require('../utils/wallet');
const router = express.Router();

let _momentKey = null;
function getMomentKey() {
  if (_momentKey) return _momentKey;
  const mk = process.env.MASTER_KEY;
  if (mk && mk.length === 64) _momentKey = deriveKey(mk, 'moment');
  return _momentKey;
}
function encContent(c) { const k = getMomentKey(); return k ? encrypt(k, c) : c; }
function decContent(c) { const k = getMomentKey(); return k ? safeDecrypt(k, c) : c; }
function decMoments(list) {
  if (!list) return list;
  const k = getMomentKey();
  if (!k) return list;
  return list.map(m => {
    if (m.content !== undefined) m.content = safeDecrypt(k, m.content);
    if (m.moment_content !== undefined) m.moment_content = safeDecrypt(k, m.moment_content);
    return m;
  });
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/ogg'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads/private/moments')),
  filename: (req, file, cb) => cb(null, `moment_${req.userId}_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isImage = ALLOWED_IMAGE_TYPES.includes(file.mimetype);
    const isAudio = ALLOWED_AUDIO_TYPES.includes(file.mimetype);
    if (isImage || isAudio) cb(null, true);
    else cb(new Error('不支持的文件格式'), false);
  }
});

// ====== 上传图片 ======
router.post('/upload', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '请选择图片' });
    res.json({ code: 0, data: { url: `/uploads/private/moments/${req.file.filename}` } });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 上传语音 ======
router.post('/upload-audio', auth, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: '请选择音频文件' });
    res.json({ code: 0, data: { url: `/uploads/private/moments/${req.file.filename}` } });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== Feed 流 ======
router.get('/feed', auth, async (req, res) => {
  try {
    const tab = req.query.tab || 'recommend';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 15));
    const offset = (page - 1) * limit;
    const viewerId = req.userId;

    let whereClause, params;
    if (tab === 'follow') {
      whereClause = `m.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)`;
      params = [viewerId, limit, offset];
    } else {
      whereClause = `(m.visibility = 'public' OR (m.visibility = 'friends' AND m.user_id IN (SELECT friend_id FROM contacts WHERE user_id = ?)) OR m.user_id = ?)`;
      params = [viewerId, viewerId, limit, offset];
    }

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM moments m WHERE ${whereClause}`,
      params.slice(0, -2)
    );

    const [moments] = await pool.execute(
      `SELECT m.*, u.nickname, u.avatar, u.level,
        (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count,
        (SELECT COUNT(*) FROM moment_comments WHERE moment_id = m.id) as comment_count,
        (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id AND user_id = ?) as is_liked,
        (SELECT COUNT(*) FROM moment_favorites WHERE moment_id = m.id AND user_id = ?) as is_favorited
       FROM moments m JOIN users u ON m.user_id = u.id
       WHERE ${whereClause}
       ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      [...params.slice(0, -2), viewerId, viewerId, limit, offset]
    );

    res.json({
      code: 0,
      data: {
        list: moments.map(m => ({
          id: m.id, user_id: m.user_id, user_nickname: m.nickname, user_avatar: m.avatar, user_level: decCoin(m.level),
          content: decContent(m.content), images: JSON.parse(m.images || '[]'), audio_url: m.audio_url, audio_duration: m.audio_duration,
          location: m.location, visibility: m.visibility, topic_name: m.topic_name,
          like_count: m.like_count, comment_count: m.comment_count,
          is_liked: m.is_liked > 0, is_favorited: m.is_favorited > 0, created_at: m.created_at
        })),
        pagination: { page, limit, total, hasMore: offset + limit < total }
      }
    });
  } catch (err) { console.error('[Moments] Feed:', err); res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 通知列表 ======
router.get('/notifications', auth, async (req, res) => {
  try {
    const type = req.query.type || 'all';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    let typeCondition = "1=1";
    const typeParams = [];
    if (type !== 'all' && ['like', 'comment', 'follow', 'mention', 'favorite'].includes(type)) {
      typeCondition = "mn.type = ?"; typeParams.push(type);
    }
    const params = [req.userId, ...typeParams, limit, offset];
    const countParams = [req.userId, ...typeParams];
    const [[{ total }]] = await pool.execute(`SELECT COUNT(*) as total FROM moment_notifications mn WHERE mn.owner_id = ? AND ${typeCondition}`, countParams);
    const [notifications] = await pool.execute(
      `SELECT mn.*, u.nickname as from_nickname, u.avatar as from_avatar, u.level as from_level,
        m.content as moment_content, m.images as moment_images,
        mc.content as comment_content
       FROM moment_notifications mn JOIN users u ON mn.from_user_id = u.id
       LEFT JOIN moments m ON mn.moment_id = m.id
       LEFT JOIN moment_comments mc ON mn.comment_id = mc.id
       WHERE mn.owner_id = ? AND ${typeCondition} ORDER BY mn.created_at DESC LIMIT ? OFFSET ?`, params);
    res.json({
      code: 0, data: {
        list: notifications.map(n => ({
          id: n.id, type: n.type, is_read: n.is_read, created_at: n.created_at,
          from_user: { id: n.from_user_id, nickname: n.from_nickname, avatar: n.from_avatar, level: n.from_level },
          moment: n.moment_id ? { id: n.moment_id, content: decContent(n.moment_content || '').slice(0, 100), image: n.moment_images ? JSON.parse(n.moment_images || '[]')[0] : null } : null,
          comment_content: n.comment_content || null,
        })),
        pagination: { page, limit, total, hasMore: offset + limit < total }
      }
    });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 未读通知数（按分类） ======
router.get('/notifications/unread-count', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT type, COUNT(*) as cnt FROM moment_notifications WHERE owner_id = ? AND is_read = 0 GROUP BY type`,
      [req.userId]
    );
    const counts = { like: 0, comment: 0, follow: 0, mention: 0 };
    let total = 0;
    for (const r of rows) { if (counts.hasOwnProperty(r.type)) { counts[r.type] = r.cnt; total += r.cnt; } }
    res.json({ code: 0, data: { total, ...counts } });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 按类型标记已读 ======
router.post('/notifications/read-by-type', auth, async (req, res) => {
  try {
    const { type } = req.body;
    if (!type || !['like', 'comment', 'follow', 'mention', 'favorite'].includes(type)) {
      return res.json({ code: 400, message: '无效的类型' });
    }
    await pool.execute('UPDATE moment_notifications SET is_read = 1 WHERE owner_id = ? AND type = ?', [req.userId, type]);
    res.json({ code: 0 });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 全部标已读 ======
router.post('/notifications/read-all', auth, async (req, res) => {
  try {
    await pool.execute('UPDATE moment_notifications SET is_read = 1 WHERE owner_id = ?', [req.userId]);
    res.json({ code: 0, message: '已读' });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 推荐用户 ======
router.get('/recommend-users', auth, async (req, res) => {
  try {
    const [users] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar, u.level, u.signature FROM users u
       WHERE u.id != ? AND u.id NOT IN (SELECT friend_id FROM contacts WHERE user_id = ?)
       AND u.role != 'admin' AND u.is_banned = 0
       ORDER BY u.id DESC, u.followers DESC LIMIT 10`,
      [req.userId, req.userId]);
    res.json({ code: 0, data: users });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 我的动态 ======
router.get('/mine', auth, async (req, res) => {
  try {
    const tab = req.query.tab || 'published';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = parseInt(req.query.limit) || 15;
    const offset = (page - 1) * limit;
    const userId = req.userId;
    let moments, total = 0;

    // 获取用户的汇总统计数据
    const [[publishedCount]] = await pool.execute('SELECT COUNT(*) as cnt FROM moments WHERE user_id = ?', [userId]);
    const [[likeReceived]] = await pool.execute(
      'SELECT COALESCE(SUM((SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id)), 0) as cnt FROM moments m WHERE m.user_id = ?',
      [userId]);
    const [[{ favCnt }]] = await pool.execute('SELECT COUNT(*) as favCnt FROM moment_favorites WHERE user_id = ?', [userId]);
    const [[{ likedCnt }]] = await pool.execute('SELECT COUNT(*) as likedCnt FROM moment_likes WHERE user_id = ?', [userId]);

    if (tab === 'published') {
      const [[{ t }]] = await pool.execute('SELECT COUNT(*) as t FROM moments WHERE user_id = ?', [userId]);
      total = t;
      [moments] = await pool.execute(
        `SELECT m.*,
          (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count,
          (SELECT COUNT(*) FROM moment_comments WHERE moment_id = m.id) as comment_count,
          (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id AND user_id = ?) as is_liked
         FROM moments m WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT ? OFFSET ?`, [userId, userId, limit, offset]);
    } else if (tab === 'favorited') {
      const [[{ t }]] = await pool.execute('SELECT COUNT(*) as t FROM moment_favorites WHERE user_id = ?', [userId]);
      total = t;
      [moments] = await pool.execute(
        `SELECT m.*, u.nickname, u.avatar, u.level,
          (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count,
          (SELECT COUNT(*) FROM moment_comments WHERE moment_id = m.id) as comment_count
         FROM moment_favorites mf JOIN moments m ON mf.moment_id = m.id JOIN users u ON m.user_id = u.id
         WHERE mf.user_id = ? ORDER BY mf.created_at DESC LIMIT ? OFFSET ?`, [userId, limit, offset]);
    } else if (tab === 'liked') {
      const [[{ t }]] = await pool.execute('SELECT COUNT(*) as t FROM moment_likes WHERE user_id = ?', [userId]);
      total = t;
      [moments] = await pool.execute(
        `SELECT m.*, u.nickname, u.avatar, u.level,
          (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count,
          (SELECT COUNT(*) FROM moment_comments WHERE moment_id = m.id) as comment_count
         FROM moment_likes ml JOIN moments m ON ml.moment_id = m.id JOIN users u ON m.user_id = u.id
         WHERE ml.user_id = ? ORDER BY ml.created_at DESC LIMIT ? OFFSET ?`, [userId, limit, offset]);
    }

    res.json({ code: 0, data: {
      list: (moments || []).map(m => ({
        id: m.id, user_id: m.user_id || userId, user_nickname: m.nickname, user_avatar: m.avatar, user_level: decCoin(m.level),
        content: decContent(m.content), images: JSON.parse(m.images || '[]'), audio_url: m.audio_url, audio_duration: m.audio_duration,
        location: m.location, visibility: m.visibility, topic_name: m.topic_name,
        like_count: m.like_count || 0, comment_count: m.comment_count || 0, created_at: m.created_at,
        is_liked: (m.is_liked || 0) > 0
      })),
      pagination: { page, limit, total, hasMore: offset + limit < total },
      published_count: publishedCount.cnt || 0,
      like_received: likeReceived.cnt || 0,
      favorite_count: favCnt || 0,
      liked_count: likedCnt || 0
    }});
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 热门话题 TOP 4 ======
router.get('/topics/hot', auth, async (req, res) => {
  try {
    const [topics] = await pool.execute(
      `SELECT t.*, m.user_nicknames, m.user_avatars FROM moment_topics t
       LEFT JOIN (
         SELECT topic_name,
           GROUP_CONCAT(DISTINCT u.nickname ORDER BY m2.created_at DESC SEPARATOR '||') as user_nicknames,
           GROUP_CONCAT(DISTINCT u.avatar ORDER BY m2.created_at DESC SEPARATOR '||') as user_avatars
         FROM moments m2 JOIN users u ON m2.user_id = u.id
         WHERE m2.topic_name != '' AND m2.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
         GROUP BY m2.topic_name
       ) m ON t.name = m.topic_name
       WHERE t.status IN ('active', 'hot')
       ORDER BY t.usage_count DESC LIMIT 4`);
    const result = topics.map(t => {
      const nicknames = (t.user_nicknames || '').split('||').filter(Boolean).slice(0, 5);
      const avatars = (t.user_avatars || '').split('||').filter(Boolean).slice(0, 5);
      return { ...t, active_users: nicknames.map((n, i) => ({ nickname: n, avatar: avatars[i] || '/default-avatar.png' })) };
    });
    res.json({ code: 0, data: result });
  } catch (err) { console.error(err); res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 活跃话题列表（磁贴池） ======
router.get('/topics/active', auth, async (req, res) => {
  try {
    const [topics] = await pool.execute('SELECT * FROM moment_topics WHERE status IN (?,?) ORDER BY usage_count DESC LIMIT 20', ['active', 'hot']);
    res.json({ code: 0, data: topics });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 话题详情 ======
router.get('/topics/:topicName', auth, async (req, res) => {
  try {
    const topicName = decodeURIComponent(req.params.topicName);
    const [topics] = await pool.execute('SELECT * FROM moment_topics WHERE name = ?', [topicName]);
    if (topics.length === 0) return res.json({ code: 404, message: '话题不存在' });
    const topic = topics[0];
    const [[{ total }]] = await pool.execute('SELECT COUNT(*) as total FROM moments WHERE topic_name = ?', [topicName]);
    topic.moment_count = total;
    res.json({ code: 0, data: topic });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 话题下动态流 ======
router.get('/topics/:topicName/feed', auth, async (req, res) => {
  try {
    const topicName = decodeURIComponent(req.params.topicName);
    const sort = req.query.sort || 'hot';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 15);
    const offset = (page - 1) * limit;
    const viewerId = req.userId;
    const orderBy = sort === 'latest' ? 'm.created_at DESC' : 'like_count DESC, m.created_at DESC';

    const [[{ total }]] = await pool.execute('SELECT COUNT(*) as total FROM moments WHERE topic_name = ?', [topicName]);
    const [moments] = await pool.execute(
      `SELECT m.*, u.nickname, u.avatar, u.level,
        (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count,
        (SELECT COUNT(*) FROM moment_comments WHERE moment_id = m.id) as comment_count,
        (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id AND user_id = ?) as is_liked
       FROM moments m JOIN users u ON m.user_id = u.id
       WHERE m.topic_name = ? ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [viewerId, topicName, limit, offset]);
    res.json({ code: 0, data: {
      list: moments.map(m => ({
        id: m.id, user_id: m.user_id, user_nickname: m.nickname, user_avatar: m.avatar, user_level: decCoin(m.level),
        content: decContent(m.content), images: JSON.parse(m.images || '[]'), audio_url: m.audio_url, audio_duration: m.audio_duration,
        location: m.location, like_count: m.like_count, comment_count: m.comment_count, is_liked: m.is_liked > 0, created_at: m.created_at
      })),
      pagination: { page, limit, total, hasMore: offset + limit < total }
    }});
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 发布动态 ======
router.post('/', auth, async (req, res) => {
  try {
    const { content = '', images = '[]', audio_url, audio_duration, location = '', visibility = 'public', topic_name = '', mentioned_user_ids = [] } = req.body;
    const safeContent = (content || '').trim().slice(0, 500);
    const safeVisibility = ['public', 'friends', 'private'].includes(visibility) ? visibility : 'public';
    const safeTopic = (topic_name || '').trim().slice(0, 50);
    if (!safeContent && (!images || images === '[]') && !audio_url) {
      return res.json({ code: 400, message: '请填写内容或添加图片/语音' });
    }
    let parsedImages = [];
    try { parsedImages = typeof images === 'string' ? JSON.parse(images) : images; } catch (e) {}
    if (!Array.isArray(parsedImages) || parsedImages.length > 9) return res.json({ code: 400, message: '图片最多9张' });

    const [result] = await pool.execute(
      'INSERT INTO moments (user_id, content, images, audio_url, audio_duration, location, visibility, topic_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.userId, encContent(safeContent), JSON.stringify(parsedImages), audio_url || null, parseInt(audio_duration) || 0, (location || '').trim().slice(0, 100), safeVisibility, safeTopic]);

    // 话题处理
    if (safeTopic) {
      const [existingTopics] = await pool.execute('SELECT id, usage_count FROM moment_topics WHERE name = ?', [safeTopic]);
      if (existingTopics.length > 0) {
        const newCount = existingTopics[0].usage_count + 1;
        let newStatus = 'new';
        if (newCount >= 10) newStatus = 'active';
        if (newCount >= 100) newStatus = 'hot';
        await pool.execute('UPDATE moment_topics SET usage_count = ?, status = ? WHERE name = ?', [newCount, newStatus, safeTopic]);
      } else {
        const keywordMap = { '咖啡': 'coffee-shop', '探店': 'coffee-shop', '奶茶': 'coffee-shop', '餐厅': 'coffee-shop', '穿搭': 'fashion', '美妆': 'fashion', 'OOTD': 'fashion', '服饰': 'fashion', '电影': 'movie', '追剧': 'movie', '影视': 'movie', '影院': 'movie', '读书': 'books', '学习': 'books', '书籍': 'books', '备考': 'books', '音乐': 'music', '歌': 'music', '乐器': 'music', '演出': 'music', '美食': 'food', '料理': 'food', '做饭': 'food', '甜品': 'food', '旅行': 'travel', '风景': 'travel', '打卡': 'travel', '户外': 'travel', '运动': 'sports', '健身': 'sports', '跑步': 'sports', '瑜伽': 'sports' };
        let matched = 'default';
        for (const [kw, cover] of Object.entries(keywordMap)) { if (safeTopic.includes(kw)) { matched = cover; break; } }
        await pool.execute('INSERT IGNORE INTO moment_topics (name, cover_image, description, usage_count, status) VALUES (?, ?, ?, 1, ?)', [safeTopic, `/uploads/topic-covers/${matched}.jpg`, `#${safeTopic} 话题`, 'new']);
      }
    }

    // @提及通知：为每个被@的用户写入通知 + Socket 推送
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const [fromUser] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
    const fromNickname = fromUser[0]?.nickname || '';

    if (Array.isArray(mentioned_user_ids) && mentioned_user_ids.length > 0) {
      for (const mentionedId of mentioned_user_ids) {
        if (mentionedId === req.userId) continue;
        await pool.execute(
          'INSERT INTO moment_notifications (owner_id, from_user_id, type, moment_id) VALUES (?, ?, ?, ?)',
          [mentionedId, req.userId, 'mention', result.insertId]
        );
        // Socket 实时推送
        const sid = onlineUsers?.get(mentionedId);
        if (io && sid) {
          io.to(sid).emit('moment:notification', {
            type: 'mention', momentId: result.insertId, fromUserId: req.userId,
          });
        } else {
          // 离线 FCM 推送
          const [[u]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [mentionedId]);
          if (u?.fcm_token) {
            await sendPush(u.fcm_token, '动态提及', `${fromNickname} @了你`, {
              type: 'moment_mention', momentId: String(result.insertId),
            });
          }
        }
      }
    }

    // Socket 推送给粉丝
    const [momentData] = await pool.execute(
      'SELECT m.*, u.nickname, u.avatar, u.level FROM moments m JOIN users u ON m.user_id = u.id WHERE m.id = ?', [result.insertId]);
    const moment = momentData[0];
    const [followers] = await pool.execute('SELECT follower_id FROM follows WHERE following_id = ?', [req.userId]);
    if (io) {
      for (const f of followers) {
        const sid = onlineUsers?.get(f.follower_id);
        if (sid) {
          io.to(sid).emit('moment:new', {
            id: moment.id, user_id: moment.user_id, content: decContent(moment.content),
            images: JSON.parse(moment.images || '[]'), audio_url: moment.audio_url, audio_duration: moment.audio_duration,
            location: moment.location, visibility: moment.visibility, topic_name: moment.topic_name,
            created_at: moment.created_at, user_nickname: moment.nickname, user_avatar: moment.avatar, user_level: decCoin(moment.level),
            like_count: 0, comment_count: 0
          });
        }
        // 所有粉丝（含离线）增加关注动态未读数
        await pool.execute(
          'INSERT INTO follow_feed_unread (user_id, unread_count) VALUES (?, 1) ON DUPLICATE KEY UPDATE unread_count = unread_count + 1',
          [f.follower_id]
        );
        // 推送最新未读数
        if (sid) {
          const [[{ unread_count }]] = await pool.execute('SELECT unread_count FROM follow_feed_unread WHERE user_id = ?', [f.follower_id]);
          io.to(sid).emit('follow_feed_unread_update', { count: unread_count || 0 });
        }
      }
    }
    // 发动态加经验（异步，不阻塞响应）
    getExpConfig().then(cfg => {
      if (cfg._enabled.exp_moment) addExp(req.userId, cfg.exp_moment, 'moment', { momentId: result.insertId });
    }).catch(() => {});
    res.json({ code: 0, data: { id: result.insertId } });
  } catch (err) { console.error('[Moments] 发布失败:', err); res.json({ code: 500, message: '服务器错误' }); }
});

// ====== GPS 反向地理编码 ======
router.post('/location/geo', async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.json({ code: 400, message: '坐标参数无效' });
    }
    const amapKey = process.env.AMAP_WEB_KEY;
    if (!amapKey) {
      // 无高德 key 时回退到 ip2region IP 定位
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().replace('::ffff:', '').split(',')[0].trim();
      const location = ipToLocation(ip);
      return res.json({ code: 0, data: { city: location } });
    }
    const resp = await fetch(
      `https://restapi.amap.com/v3/geocode/regeo?key=${amapKey}&location=${longitude},${latitude}&extensions=base&lang=zh_cn`
    );
    const data = await resp.json();
    if (data.status === '1' && data.regeocode) {
      const addr = data.regeocode.addressComponent;
      const city = addr.city || addr.province || '';
      const district = addr.district || '';
      const result = city ? `${city}${district ? ' · ' + district : ''}` : '';
      res.json({ code: 0, data: { city: result } });
    } else {
      res.json({ code: 0, data: { city: '' } });
    }
  } catch (err) {
    res.json({ code: 0, data: { city: '' } });
  }
});

// ====== 位置服务（客户端IP归属地查询） ======
function isPrivateIp(ip) {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|::1$)/.test(ip);
}

router.get('/location', async (req, res) => {
  try {
    var ip = (req.query.ip || '').toString().trim();
    if (!ip) {
      // 从 x-forwarded-for 中拿客户端真实 IP：取第一个非内网 IP（跳过代理的内网 IP）
      var fwd = (req.headers['x-forwarded-for'] || '').toString();
      var fwdIps = fwd.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      for (var i = 0; i < fwdIps.length; i++) {
        if (!isPrivateIp(fwdIps[i].replace('::ffff:', ''))) {
          ip = fwdIps[i].replace('::ffff:', '');
          break;
        }
      }
      // x-forwarded-for 中全是内网 IP 或没有，尝试 remoteAddress
      if (!ip) {
        ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
      }
    }
    ip = ip.replace('::ffff:', '');
    // 如果最终 IP 仍是内网地址，说明确实无法获取客户端公网 IP，返回空（不回退到服务器 IP，避免误导）
    if (!ip || isPrivateIp(ip)) {
      return res.json({ code: 0, data: { city: '' } });
    }

    // 使用 ip2region 离线数据库查询
    const location = ipToLocation(ip);
    res.json({ code: 0, data: { city: location } });
  } catch (err) {
    res.json({ code: 0, data: { city: '' } });
  }
});

// ====== 搜索（必须在 /:id 之前）======
router.get('/search', auth, async (req, res) => {
  try {
    const keyword = (req.query.keyword || '').trim();
    const type = req.query.type || 'moment';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(30, parseInt(req.query.limit) || 15);
    const offset = (page - 1) * limit;
    const targetUserId = req.query.userId ? parseInt(req.query.userId) : null;
    if (!keyword) return res.json({ code: 0, data: { list: [], pagination: { page, limit, total: 0, hasMore: false } } });

    if (type === 'topic') {
      // 搜索话题本身
      const [[{ total }]] = await pool.execute('SELECT COUNT(*) as total FROM moment_topics WHERE name LIKE ?', [`%${keyword}%`]);
      const [topics] = await pool.execute('SELECT * FROM moment_topics WHERE name LIKE ? ORDER BY usage_count DESC LIMIT ? OFFSET ?', [`%${keyword}%`, limit, offset]);
      // 同时搜索相关动态
      const [moments] = await pool.execute(
        `SELECT m.*, u.nickname, u.avatar, u.level,
          (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count,
          (SELECT COUNT(*) FROM moment_comments WHERE moment_id = m.id) as comment_count
         FROM moments m JOIN users u ON m.user_id = u.id
         WHERE m.topic_name LIKE ? AND (m.visibility = 'public' OR m.user_id = ?)
         ORDER BY m.created_at DESC LIMIT 6`,
        [`%${keyword}%`, req.userId]
      );
      const momentList = moments.map(m => ({
        id: m.id, user_id: m.user_id, user_nickname: m.nickname, user_avatar: m.avatar, user_level: decCoin(m.level),
        content: decContent(m.content), images: JSON.parse(m.images || '[]'),
        topic_name: m.topic_name,
        like_count: m.like_count, comment_count: m.comment_count, created_at: m.created_at,
      }));
      return res.json({ code: 0, data: { list: topics, moments: momentList, pagination: { page, limit, total, hasMore: offset + limit < total } } });
    }

    if (type === 'user') {
      const [[{ total }]] = await pool.execute('SELECT COUNT(*) as total FROM users WHERE nickname LIKE ? AND id != 9999 AND is_banned = 0', [`%${keyword}%`]);
      const [users] = await pool.execute('SELECT id, nickname, avatar, level, signature FROM users WHERE nickname LIKE ? AND id != 9999 AND is_banned = 0 ORDER BY level DESC LIMIT ? OFFSET ?', [`%${keyword}%`, limit, offset]);
      return res.json({ code: 0, data: { list: users, pagination: { page, limit, total, hasMore: offset + limit < total } } });
    }

    // type=moment: 搜索 content 和 topic_name
    const viewerId = req.userId;
    const likeKeyword = `%${keyword}%`;
    let total, moments;
    if (targetUserId) {
      const [[totalRow]] = await pool.execute(
        `SELECT COUNT(*) as total FROM moments m WHERE (m.content LIKE ? OR m.topic_name LIKE ?) AND m.user_id = ? AND (m.visibility = 'public' OR (m.visibility = 'friends' AND m.user_id IN (SELECT friend_id FROM contacts WHERE user_id = ?)) OR m.user_id = ?)`,
        [likeKeyword, likeKeyword, targetUserId, viewerId, viewerId]
      );
      total = totalRow.total;
      const [rows] = await pool.execute(
        `SELECT m.*, u.nickname, u.avatar, u.level, (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count, (SELECT COUNT(*) FROM moment_comments WHERE moment_id = m.id) as comment_count FROM moments m JOIN users u ON m.user_id = u.id WHERE (m.content LIKE ? OR m.topic_name LIKE ?) AND m.user_id = ? AND (m.visibility = 'public' OR (m.visibility = 'friends' AND m.user_id IN (SELECT friend_id FROM contacts WHERE user_id = ?)) OR m.user_id = ?) ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
        [likeKeyword, likeKeyword, targetUserId, viewerId, viewerId, limit, offset]
      );
      moments = rows;
    } else {
      const [[totalRow]] = await pool.execute(
        `SELECT COUNT(*) as total FROM moments m WHERE (m.content LIKE ? OR m.topic_name LIKE ?) AND (m.visibility = 'public' OR (m.visibility = 'friends' AND m.user_id IN (SELECT friend_id FROM contacts WHERE user_id = ?)) OR m.user_id = ?)`,
        [likeKeyword, likeKeyword, viewerId, viewerId]
      );
      total = totalRow.total;
      const [rows] = await pool.execute(
        `SELECT m.*, u.nickname, u.avatar, u.level, (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count, (SELECT COUNT(*) FROM moment_comments WHERE moment_id = m.id) as comment_count FROM moments m JOIN users u ON m.user_id = u.id WHERE (m.content LIKE ? OR m.topic_name LIKE ?) AND (m.visibility = 'public' OR (m.visibility = 'friends' AND m.user_id IN (SELECT friend_id FROM contacts WHERE user_id = ?)) OR m.user_id = ?) ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
        [likeKeyword, likeKeyword, viewerId, viewerId, limit, offset]
      );
      moments = rows;
    }
    res.json({ code: 0, data: {
      list: moments.map(m => ({
        id: m.id, user_id: m.user_id, user_nickname: m.nickname, user_avatar: m.avatar, user_level: decCoin(m.level),
        content: decContent(m.content), images: JSON.parse(m.images || '[]'),
        topic_name: m.topic_name,
        like_count: m.like_count, comment_count: m.comment_count, created_at: m.created_at,
      })),
      pagination: { page, limit, total, hasMore: offset + limit < total }
    }});
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 动态详情 ======
router.get('/:id', auth, async (req, res) => {
  try {
    const momentId = parseInt(req.params.id);
    if (isNaN(momentId)) return res.json({ code: 400, message: '无效ID' });
    const viewerId = req.userId;
    const [[m]] = await pool.execute(
      `SELECT m.*, u.nickname, u.avatar, u.level,
        (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count,
        (SELECT COUNT(*) FROM moment_comments WHERE moment_id = m.id) as comment_count,
        (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id AND user_id = ?) as is_liked,
        (SELECT COUNT(*) FROM moment_favorites WHERE moment_id = m.id AND user_id = ?) as is_favorited
       FROM moments m JOIN users u ON m.user_id = u.id WHERE m.id = ?`, [viewerId, viewerId, momentId]);
    if (!m) return res.json({ code: 404, message: '动态不存在' });
    const [likers] = await pool.execute(
      'SELECT u.id, u.nickname, u.avatar FROM moment_likes ml JOIN users u ON ml.user_id = u.id WHERE ml.moment_id = ? ORDER BY ml.created_at DESC LIMIT 20', [momentId]);
    res.json({ code: 0, data: {
      id: m.id, user_id: m.user_id, user_nickname: m.nickname, user_avatar: m.avatar, user_level: decCoin(m.level),
      content: decContent(m.content), images: JSON.parse(m.images || '[]'), audio_url: m.audio_url, audio_duration: m.audio_duration,
      location: m.location, visibility: m.visibility, topic_name: m.topic_name,
      like_count: m.like_count, comment_count: m.comment_count,
      is_liked: m.is_liked > 0, is_favorited: m.is_favorited > 0, created_at: m.created_at, likers
    }});
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 删除动态 ======
router.delete('/:id', auth, async (req, res) => {
  try {
    const momentId = parseInt(req.params.id);
    const [[m]] = await pool.execute('SELECT id, user_id FROM moments WHERE id = ?', [momentId]);
    if (!m) return res.json({ code: 404, message: '动态不存在' });
    if (m.user_id !== req.userId) return res.json({ code: 403, message: '无权操作' });
    await pool.execute('DELETE FROM moment_likes WHERE moment_id = ?', [momentId]);
    await pool.execute('DELETE FROM moment_comments WHERE moment_id = ?', [momentId]);
    await pool.execute('DELETE FROM moment_favorites WHERE moment_id = ?', [momentId]);
    await pool.execute('DELETE FROM moment_notifications WHERE moment_id = ?', [momentId]);
    await pool.execute('DELETE FROM moments WHERE id = ?', [momentId]);
    res.json({ code: 0, message: '已删除' });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 点赞/取消点赞 ======
router.post('/:id/like', auth, async (req, res) => {
  try {
    const momentId = parseInt(req.params.id);
    const [[m]] = await pool.execute('SELECT id, user_id FROM moments WHERE id = ?', [momentId]);
    if (!m) return res.json({ code: 404, message: '动态不存在' });
    const [[existing]] = await pool.execute('SELECT id FROM moment_likes WHERE moment_id = ? AND user_id = ?', [momentId, req.userId]);
    const io = req.app.get('io'), onlineUsers = req.app.get('onlineUsers');
    if (existing) {
      await pool.execute('DELETE FROM moment_likes WHERE moment_id = ? AND user_id = ?', [momentId, req.userId]);
      res.json({ code: 0, data: { liked: false } });
    } else {
      await pool.execute('INSERT INTO moment_likes (moment_id, user_id) VALUES (?, ?)', [momentId, req.userId]);
      if (m.user_id !== req.userId) {
        await pool.execute('INSERT INTO moment_notifications (owner_id, from_user_id, type, moment_id) VALUES (?, ?, ?, ?)', [m.user_id, req.userId, 'like', momentId]);
        const sid = onlineUsers?.get(m.user_id);
        if (io && sid) {
          io.to(sid).emit('moment:notification', { type: 'like', momentId, fromUserId: req.userId });
        } else {
          // 离线 FCM 推送
          const [[u]] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
          const [[owner]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [m.user_id]);
          if (owner?.fcm_token) {
            await sendPush(owner.fcm_token, '动态互动', `${u?.nickname || '有人'} 赞了你的动态`, { type: 'moment_like', momentId: String(momentId) });
          }
        }
      }
      res.json({ code: 0, data: { liked: true } });
    }
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 评论列表 ======
router.get('/:id/comments', auth, async (req, res) => {
  try {
    const momentId = parseInt(req.params.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const [[{ total }]] = await pool.execute('SELECT COUNT(*) as total FROM moment_comments WHERE moment_id = ?', [momentId]);
    const [comments] = await pool.execute(
      `SELECT mc.*, u.nickname, u.avatar, u.level FROM moment_comments mc JOIN users u ON mc.user_id = u.id
       WHERE mc.moment_id = ? ORDER BY mc.created_at ASC LIMIT ? OFFSET ?`, [momentId, limit, offset]);
    const topLevel = [], replyMap = {};
    for (const c of comments) {
      const item = { id: c.id, user_id: c.user_id, nickname: c.nickname, avatar: c.avatar, level: decCoin(c.level), content: c.content, reply_to: c.reply_to, created_at: c.created_at, replies: [] };
      if (!c.reply_to) topLevel.push(item);
      else { if (!replyMap[c.reply_to]) replyMap[c.reply_to] = []; replyMap[c.reply_to].push(item); }
    }
    for (const c of topLevel) { if (replyMap[c.id]) c.replies = replyMap[c.id]; }
    res.json({ code: 0, data: { list: topLevel, pagination: { page, limit, total, hasMore: offset + limit < total } } });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 发表评论/回复 ======
router.post('/:id/comments', auth, async (req, res) => {
  try {
    const momentId = parseInt(req.params.id);
    const { content, replyTo } = req.body;
    if (!content || !content.trim()) return res.json({ code: 400, message: '请输入评论内容' });
    const safeContent = content.trim().slice(0, 200);
    const [[m]] = await pool.execute('SELECT id, user_id FROM moments WHERE id = ?', [momentId]);
    if (!m) return res.json({ code: 404, message: '动态不存在' });
    const [result] = await pool.execute('INSERT INTO moment_comments (moment_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)', [momentId, req.userId, safeContent, replyTo ? parseInt(replyTo) : null]);
    const [userRows] = await pool.execute('SELECT nickname, avatar, level FROM users WHERE id = ?', [req.userId]);
    const user = userRows[0] || {};
    const io = req.app.get('io'), onlineUsers = req.app.get('onlineUsers');
    if (m.user_id !== req.userId) {
      await pool.execute('INSERT INTO moment_notifications (owner_id, from_user_id, type, moment_id, comment_id) VALUES (?, ?, ?, ?, ?)', [m.user_id, req.userId, 'comment', momentId, result.insertId]);
      if (io && onlineUsers?.get(m.user_id)) io.to(onlineUsers.get(m.user_id)).emit('moment:notification', { type: 'comment', momentId, fromUserId: req.userId });
      else {
        const [[owner]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [m.user_id]);
        if (owner?.fcm_token) {
          await sendPush(owner.fcm_token, '动态评论', `${user.nickname || '有人'} 评论了你的动态`, { type: 'moment_comment', momentId: String(momentId) });
        }
      }
    }
    if (replyTo) {
      const [[parent]] = await pool.execute('SELECT user_id FROM moment_comments WHERE id = ?', [parseInt(replyTo)]);
      if (parent && parent.user_id !== req.userId && parent.user_id !== m.user_id) {
        await pool.execute('INSERT INTO moment_notifications (owner_id, from_user_id, type, moment_id, comment_id) VALUES (?, ?, ?, ?, ?)', [parent.user_id, req.userId, 'comment', momentId, result.insertId]);
        if (io && onlineUsers?.get(parent.user_id)) io.to(onlineUsers.get(parent.user_id)).emit('moment:notification', { type: 'comment', momentId, fromUserId: req.userId });
      }
    }
    getExpConfig().then(cfg => { if (cfg._enabled.exp_comment) addExp(req.userId, cfg.exp_comment, 'comment', { momentId }); }).catch(() => {});
    res.json({ code: 0, data: { id: result.insertId, user_id: req.userId, nickname: user.nickname, avatar: user.avatar, level: decCoin(user.level), content: safeContent, reply_to: replyTo ? parseInt(replyTo) : null, created_at: new Date().toISOString(), replies: [] } });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 删除评论 ======
router.delete('/:id/comments/:commentId', auth, async (req, res) => {
  try {
    const momentId = parseInt(req.params.id), commentId = parseInt(req.params.commentId);
    const [[c]] = await pool.execute('SELECT id, user_id FROM moment_comments WHERE id = ? AND moment_id = ?', [commentId, momentId]);
    if (!c) return res.json({ code: 404, message: '评论不存在' });
    const [[m]] = await pool.execute('SELECT user_id FROM moments WHERE id = ?', [momentId]);
    if (c.user_id !== req.userId && m.user_id !== req.userId) return res.json({ code: 403, message: '无权操作' });
    await pool.execute('DELETE FROM moment_comments WHERE id = ? AND moment_id = ?', [commentId, momentId]);
    res.json({ code: 0, message: '已删除' });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 收藏/取消收藏 ======
router.post('/:id/favorite', auth, async (req, res) => {
  try {
    const momentId = parseInt(req.params.id);
    const [[existing]] = await pool.execute('SELECT id FROM moment_favorites WHERE moment_id = ? AND user_id = ?', [momentId, req.userId]);
    if (existing) {
      await pool.execute('DELETE FROM moment_favorites WHERE moment_id = ? AND user_id = ?', [momentId, req.userId]);
      res.json({ code: 0, data: { favorited: false } });
    } else {
      await pool.execute('INSERT INTO moment_favorites (moment_id, user_id) VALUES (?, ?)', [momentId, req.userId]);
      const [[m]] = await pool.execute('SELECT user_id FROM moments WHERE id = ?', [momentId]);
      if (m && m.user_id !== req.userId) {
        await pool.execute('INSERT INTO moment_notifications (owner_id, from_user_id, type, moment_id) VALUES (?, ?, ?, ?)', [m.user_id, req.userId, 'favorite', momentId]);
        const io = req.app.get('io'), onlineUsers = req.app.get('onlineUsers');
        const sid = onlineUsers?.get(m.user_id);
        if (io && sid) {
          io.to(sid).emit('moment:notification', { type: 'favorite', momentId, fromUserId: req.userId });
        } else {
          const [[u]] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
          const [[owner]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [m.user_id]);
          if (owner?.fcm_token) {
            await sendPush(owner.fcm_token, '动态收藏', `${u?.nickname || '有人'} 收藏了你的动态`, { type: 'moment_favorite', momentId: String(momentId) });
          }
        }
      }
      res.json({ code: 0, data: { favorited: true } });
    }
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 编辑动态 ======
router.put('/:id', auth, async (req, res) => {
  try {
    const momentId = parseInt(req.params.id);
    const [[m]] = await pool.execute('SELECT id, user_id FROM moments WHERE id = ?', [momentId]);
    if (!m) return res.json({ code: 404, message: '动态不存在' });
    if (m.user_id !== req.userId) return res.json({ code: 403, message: '无权操作' });

    const { content, images, location, visibility, topic_name, audio_url, audio_duration } = req.body;
    const fields = [], vals = [];
    if (content !== undefined) { fields.push('content = ?'); vals.push(encContent(content.trim().slice(0, 500))); }
    if (images !== undefined) { fields.push('images = ?'); vals.push(JSON.stringify(images)); }
    if (location !== undefined) { fields.push('location = ?'); vals.push(location); }
    if (visibility !== undefined) { fields.push('visibility = ?'); vals.push(['public','friends','private'].includes(visibility) ? visibility : 'public'); }
    if (topic_name !== undefined) { fields.push('topic_name = ?'); vals.push(topic_name); }
    if (audio_url !== undefined) { fields.push('audio_url = ?'); vals.push(audio_url || null); }
    if (audio_duration !== undefined) { fields.push('audio_duration = ?'); vals.push(parseInt(audio_duration) || 0); }
    if (!fields.length) return res.json({ code: 400, message: '无修改内容' });
    vals.push(momentId);
    await pool.execute(`UPDATE moments SET ${fields.join(', ')} WHERE id = ?`, vals);
    res.json({ code: 0, message: '已更新' });
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

// ====== 查看他人动态 ======
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.userId);
    const viewerId = req.userId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(30, parseInt(req.query.limit) || 15);
    const offset = (page - 1) * limit;

    let isFriend = false;
    if (viewerId !== targetId) {
      const [[contact]] = await pool.execute('SELECT id FROM contacts WHERE user_id = ? AND friend_id = ?', [viewerId, targetId]);
      isFriend = !!contact;
    }

    const visibilityFilter = viewerId === targetId
      ? "1=1"
      : (isFriend ? "m.visibility IN ('public','friends')" : "m.visibility = 'public'");

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM moments m WHERE m.user_id = ? AND ${visibilityFilter}`, [targetId]);

    const [moments] = await pool.execute(
      `SELECT m.*, u.nickname, u.avatar, u.level,
        (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id) as like_count,
        (SELECT COUNT(*) FROM moment_comments WHERE moment_id = m.id) as comment_count,
        (SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id AND user_id = ?) as is_liked
       FROM moments m JOIN users u ON m.user_id = u.id
       WHERE m.user_id = ? AND ${visibilityFilter}
       ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      [viewerId, targetId, limit, offset]
    );

    // 用户统计
    const [[{ fc }]] = await pool.execute('SELECT COUNT(*) as fc FROM follows WHERE following_id = ?', [targetId]);
    const [[{ fgc }]] = await pool.execute('SELECT COUNT(*) as fgc FROM follows WHERE follower_id = ?', [targetId]);
    const [[likeStats]] = await pool.execute(
      'SELECT COALESCE(SUM((SELECT COUNT(*) FROM moment_likes WHERE moment_id = m.id)), 0) as total_likes FROM moments m WHERE m.user_id = ?',
      [targetId]);

    res.json({ code: 0, data: {
      list: moments.map(m => ({
        id: m.id, user_id: m.user_id, user_nickname: m.nickname, user_avatar: m.avatar, user_level: decCoin(m.level),
        content: decContent(m.content), images: JSON.parse(m.images || '[]'), audio_url: m.audio_url, audio_duration: m.audio_duration,
        location: m.location, visibility: m.visibility, topic_name: m.topic_name,
        like_count: m.like_count, comment_count: m.comment_count, is_liked: (m.is_liked || 0) > 0, created_at: m.created_at,
      })),
      pagination: { page, limit, total, hasMore: offset + limit < total },
      stats: { moment_count: total, followers: fc, following: fgc, likes_received: likeStats.total_likes || 0 },
    }});
  } catch (err) { res.json({ code: 500, message: '服务器错误' }); }
});

module.exports = router;
