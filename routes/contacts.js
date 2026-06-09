const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { sendSystemNotify } = require('../utils/systemNotify');
const { sendPush } = require('../utils/fcm');
const { addExp, getExpConfig } = require('../utils/wallet');
const router = express.Router();

// 获取好友列表
router.get('/', auth, async (req, res) => {
  try {
    const [friends] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar, u.gender, u.phone
       FROM contacts c JOIN users u ON c.friend_id = u.id
       WHERE c.user_id = ? AND u.id != 9999 ORDER BY u.nickname`,
      [req.userId]
    );
    res.json({ code: 0, data: friends });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发送好友申请
router.post('/request', auth, async (req, res) => {
  try {
    const { toUserId, message } = req.body;
    if (!toUserId) return res.json({ code: 400, message: '参数缺失' });
    if (toUserId === req.userId) return res.json({ code: 400, message: '不能添加自己' });
    const safeMessage = (message || '').slice(0, 200);

    const [existing] = await pool.execute(
      'SELECT id FROM contacts WHERE user_id = ? AND friend_id = ?',
      [req.userId, toUserId]
    );
    if (existing.length > 0) return res.json({ code: 400, message: '已经是好友了' });

    const [pending] = await pool.execute(
      'SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 0',
      [req.userId, toUserId]
    );
    if (pending.length > 0) return res.json({ code: 400, message: '已发送过申请，等待对方处理' });

    const [result] = await pool.execute(
      'INSERT INTO friend_requests (from_user_id, to_user_id, message) VALUES (?, ?, ?)',
      [req.userId, toUserId, safeMessage]
    );

    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const [fromUser] = await pool.execute('SELECT id, nickname, avatar FROM users WHERE id = ?', [req.userId]);
    const targetSocketId = onlineUsers?.get(toUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('friend:request', { id: result.insertId, fromUser: fromUser[0], message: safeMessage });
    } else {
      const [[u]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [toUserId]);
      if (u?.fcm_token) {
        await sendPush(u.fcm_token, '好友申请', `${fromUser[0]?.nickname} 向你发送了好友申请`, { type: 'friend_request' });
      }
    }
    await sendSystemNotify(toUserId, `${fromUser[0]?.nickname} 向你发送了好友申请${safeMessage ? `：「${safeMessage}」` : ''}，请前往联系人页面处理。`, io, onlineUsers);

    res.json({ code: 0, message: '申请已发送' });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取收到的好友申请
router.get('/requests', auth, async (req, res) => {
  try {
    const [requests] = await pool.execute(
      `SELECT fr.id, fr.message, fr.status, fr.created_at, u.id as from_user_id, u.nickname, u.avatar
       FROM friend_requests fr JOIN users u ON fr.from_user_id = u.id
       WHERE fr.to_user_id = ? ORDER BY fr.created_at DESC`,
      [req.userId]
    );
    res.json({ code: 0, data: requests });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 通过好友申请
router.post('/accept/:requestId', auth, async (req, res) => {
  try {
    const { requestId } = req.params;
    const [requests] = await pool.execute(
      'SELECT * FROM friend_requests WHERE id = ? AND to_user_id = ? AND status = 0',
      [requestId, req.userId]
    );
    if (requests.length === 0) return res.json({ code: 400, message: '申请不存在或已处理' });

    const request = requests[0];
    await pool.execute('UPDATE friend_requests SET status = 1 WHERE id = ?', [requestId]);
    await pool.execute('INSERT IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)', [req.userId, request.from_user_id]);
    await pool.execute('INSERT IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)', [request.from_user_id, req.userId]);

    // 双方加经验（从配置读取，检查是否启用）
    getExpConfig().then(cfg => {
      if (cfg._enabled.exp_add_friend) {
        for (const uid of [req.userId, request.from_user_id]) {
          addExp(uid, cfg.exp_add_friend, 'friend', { friendId: uid === req.userId ? request.from_user_id : req.userId });
        }
      }
    }).catch(() => {});

    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const targetSocketId = onlineUsers?.get(request.from_user_id);
    if (targetSocketId) {
      const [acceptUser] = await pool.execute('SELECT id, nickname, avatar FROM users WHERE id = ?', [req.userId]);
      io.to(targetSocketId).emit('friend:accepted', { user: acceptUser[0] });
    }

    const [acceptUser] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
    const [fromUser] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [request.from_user_id]);
    await sendSystemNotify(req.userId, `你已通过 ${fromUser[0]?.nickname} 的好友申请，现在可以开始聊天了。`, io, onlineUsers);
    await sendSystemNotify(request.from_user_id, `${acceptUser[0]?.nickname} 通过了你的好友申请，现在可以开始聊天了。`, io, onlineUsers);

    res.json({ code: 0, message: '已通过' });
  } catch (err) {
    console.error(err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 拒绝好友申请
router.post('/reject/:requestId', auth, async (req, res) => {
  try {
    const { requestId } = req.params;
    const [requests] = await pool.execute(
      'SELECT * FROM friend_requests WHERE id = ? AND to_user_id = ? AND status = 0',
      [requestId, req.userId]
    );
    if (requests.length === 0) return res.json({ code: 0, message: '已拒绝' });
    await pool.execute(
      'UPDATE friend_requests SET status = 2 WHERE id = ? AND to_user_id = ? AND status = 0',
      [requestId, req.userId]
    );
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    const [rejecter] = await pool.execute('SELECT nickname FROM users WHERE id = ?', [req.userId]);
    await sendSystemNotify(requests[0].from_user_id, `${rejecter[0]?.nickname} 拒绝了你的好友申请。`, io, onlineUsers);
    res.json({ code: 0, message: '已拒绝' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取我发出的好友申请
router.get('/my-requests', auth, async (req, res) => {
  try {
    const [requests] = await pool.execute(
      `SELECT fr.id, fr.message, fr.status, fr.created_at, u.id as to_user_id, u.nickname, u.avatar
       FROM friend_requests fr JOIN users u ON fr.to_user_id = u.id
       WHERE fr.from_user_id = ? ORDER BY fr.created_at DESC`,
      [req.userId]
    );
    res.json({ code: 0, data: requests });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除好友
router.delete('/:friendId', auth, async (req, res) => {
  try {
    const { friendId } = req.params;
    if (parseInt(friendId) === 9999) return res.json({ code: 400, message: '系统通知不可删除' });
    await pool.execute('DELETE FROM contacts WHERE user_id = ? AND friend_id = ?', [req.userId, parseInt(friendId)]);
    await pool.execute('DELETE FROM contacts WHERE user_id = ? AND friend_id = ?', [parseInt(friendId), req.userId]);
    res.json({ code: 0, message: '已删除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
