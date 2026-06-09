const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { sendSystemNotify } = require('../utils/systemNotify');
const { sendPush } = require('../utils/fcm');
const { fullUrl } = require('../utils/fcm');
const { encrypt, deriveKey } = require('../utils/crypto');
const { addExp, getUserWallet, decCoin } = require('../utils/wallet');

let _msgKey = null;
function getMsgKey() {
  if (_msgKey) return _msgKey;
  const mk = process.env.MASTER_KEY;
  if (mk && mk.length === 64) _msgKey = deriveKey(mk, 'msg');
  return _msgKey;
}

// 原子性加经验（加密存储），每天上限50次
async function grantMessageExp(userId, socket, io, onlineUsers) {
  const today = new Date().toISOString().split('T')[0];
  const [cfgRows] = await pool.execute(
    "SELECT `key`, `value` FROM system_settings WHERE `key` IN ('exp_message', 'exp_message_daily_limit')"
  ).catch(() => [[]]);
  const cfg = { exp_message: 5, exp_message_daily_limit: 50 };
  cfgRows.forEach(r => { cfg[r.key] = parseInt(r.value); });

  const [res] = await pool.execute(
    `INSERT INTO message_exp_records (user_id, record_date, cnt) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE cnt = IF(cnt < ?, cnt + 1, cnt)`,
    [userId, today, cfg.exp_message_daily_limit]
  );
  if (res.affectedRows === 0) return;

  const result = await addExp(userId, cfg.exp_message, 'message', { date: today });
  if (!result.success) return;
  const wallet = await getUserWallet(userId);
  socket.emit('exp:gained', { expGain: cfg.exp_message, exp: wallet.exp, level: wallet.level, coins: wallet.coins });
  if (result.levelUp) {
    console.log(`[LevelUp] user=${userId} ${result.oldLevel}->${result.newLevel} +${result.levelCoins} coins`);
    await sendSystemNotify(userId, `恭喜你升级了！当前等级 LV${result.newLevel}，继续加油！`, io, onlineUsers);
  }
}

function setupSocket(io, onlineUsers) {
  io.on('connection', (socket) => {
    console.log(`[Socket] 新连接: ${socket.id}`);

    socket.on('user:online', async (token) => {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;
        socket.userId = userId;
        // 消息频率限制
        socket._msgRate = { count: 0, resetAt: Date.now() + 60000 };
        onlineUsers.set(userId, socket.id);
        const [[self]] = await pool.execute('SELECT hide_online_status FROM users WHERE id = ?', [userId]);
        if (!self?.hide_online_status) {
          const [friends] = await pool.execute('SELECT friend_id FROM contacts WHERE user_id = ?', [userId]);
          friends.forEach(f => {
            const sid = onlineUsers.get(f.friend_id);
            if (sid) io.to(sid).emit('user:status', { userId, status: 'online' });
          });
        }
        // 加入所有群聊 room
        const [groups] = await pool.execute('SELECT group_id FROM group_members WHERE user_id = ?', [userId]);
        groups.forEach(g => { socket.join(`group:${g.group_id}`); });
        // 推送离线期间未读的@提及
        const [mentions] = await pool.execute(
          'SELECT DISTINCT group_id FROM group_mentions WHERE user_id = ? AND is_cleared = 0',
          [userId]
        );
        mentions.forEach(m => {
          socket.emit('group:mentioned', { groupId: m.group_id, msgId: null, senderNickname: '' });
        });
      } catch (err) {
        console.error('[Socket] 认证失败:', err.message);
      }
    });

    socket.on('message:send', async (data) => {
      try {
        const { receiverId, content, type, replyTo } = data;
        if (!socket.userId || !receiverId || !content) return;
        // 输入验证
        if (typeof content !== 'string' || content.length > 5000) return;
        if (type && !['text', 'image', 'audio', 'video'].includes(type)) return;

        // 频率限制
        const now = Date.now();
        if (!socket._msgRate) socket._msgRate = { count: 0, resetAt: now + 60000 };
        if (now > socket._msgRate.resetAt) socket._msgRate = { count: 0, resetAt: now + 60000 };
        if (++socket._msgRate.count > 30) return socket.emit('message:error', { message: '消息发送过快，请稍后' });

        const [friendCheck] = await pool.execute(
          'SELECT id FROM contacts WHERE user_id = ? AND friend_id = ?',
          [socket.userId, receiverId]
        );
        if (friendCheck.length === 0) {
          const [receiverRows] = await pool.execute('SELECT privacy FROM users WHERE id = ?', [receiverId]);
          const privacy = receiverRows[0]?.privacy ? JSON.parse(receiverRows[0].privacy) : {};
          if (privacy.allowDmFromStranger === false) {
            socket.emit('message:error', { message: '对方不接受非好友消息' });
            return;
          }
        }

        const msgKey = getMsgKey();
        const dbContent = msgKey ? encrypt(msgKey, content) : content;

        const [result] = await pool.execute(
          'INSERT INTO messages (sender_id, receiver_id, content, type, reply_to) VALUES (?, ?, ?, ?, ?)',
          [socket.userId, receiverId, dbContent, type || 'text', replyTo || null]
        );
        const [senderRows] = await pool.execute('SELECT nickname, avatar FROM users WHERE id = ?', [socket.userId]);
        const sender = senderRows[0] || {};

        const message = {
          id: result.insertId,
          sender_id: socket.userId,
          receiver_id: receiverId,
          content,
          type: type || 'text',
          is_read: 0,
          is_recalled: 0,
          reply_to: replyTo || null,
          created_at: new Date().toISOString(),
          sender_nickname: sender.nickname || '',
          sender_avatar: sender.avatar || '/default-avatar.png',
        };

        const targetSocketId = onlineUsers.get(receiverId);
        if (targetSocketId) {
          io.to(targetSocketId).emit('message:receive', message);
        } else {
          // 接收方离线，走 FCM 推送
          const [[receiver]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [receiverId]);
          if (receiver?.fcm_token) {
            const preview = type === 'text' ? content.slice(0, 50) : type === 'image' ? '[图片]' : type === 'audio' ? '[语音]' : '[视频]';
            const imageUrl = type === 'image' ? fullUrl(content) : undefined;
            await sendPush(receiver.fcm_token, sender.nickname || '新消息', preview, { type: 'private', senderId: String(socket.userId) }, imageUrl);
          }
        }
        socket.emit('message:sent', message);

        // 发消息加经验（每天上限50条）
        try { await grantMessageExp(socket.userId, socket, io, onlineUsers); }
        catch (expErr) { console.error('[Socket] 经验处理失败:', expErr); }
      } catch (err) {
        console.error('[Socket] 发送消息失败:', err);
      }
    });

    socket.on('message:read', async (data) => {
      try {
        const { fromUserId } = data;
        if (!socket.userId || !fromUserId) return;
        await pool.execute(
          'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
          [fromUserId, socket.userId]
        );
        const targetSocketId = onlineUsers.get(fromUserId);
        if (targetSocketId) io.to(targetSocketId).emit('message:read', { userId: socket.userId });
        socket.emit('message:read', { userId: fromUserId });
      } catch (err) {
        console.error('[Socket] 标记已读失败:', err);
      }
    });

    // 群聊消息
    socket.on('group:message:send', async (data) => {
      try {
        const { groupId, content, type, replyTo } = data;
        if (!socket.userId || !groupId || !content) return;
        // 输入验证
        if (typeof content !== 'string' || content.length > 5000) return;
        if (type && !['text', 'image', 'audio', 'video', 'system'].includes(type)) return;

        // 频率限制
        const now2 = Date.now();
        if (!socket._msgRate) socket._msgRate = { count: 0, resetAt: now2 + 60000 };
        if (now2 > socket._msgRate.resetAt) socket._msgRate = { count: 0, resetAt: now2 + 60000 };
        if (++socket._msgRate.count > 30) return socket.emit('message:error', { message: '消息发送过快，请稍后' });

        // 验证是群成员
        const [memberCheck] = await pool.execute(
          'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
          [groupId, socket.userId]
        );
        if (memberCheck.length === 0) {
          socket.emit('message:error', { message: '你不是该群成员' });
          return;
        }

        // 检查群是否被封禁
        const [[groupRow]] = await pool.execute('SELECT is_banned FROM `groups` WHERE id = ?', [groupId]);
        if (!groupRow || groupRow.is_banned) {
          socket.emit('message:error', { message: '该群聊已被封禁' });
          return;
        }

        // 检查用户是否被禁言
        const [[muteRec]] = await pool.execute(
          'SELECT muted_until FROM group_member_mutes WHERE group_id = ? AND user_id = ? AND (muted_until IS NULL OR muted_until > NOW())',
          [groupId, socket.userId]
        );
        if (muteRec) {
          const msg = muteRec.muted_until
            ? `你已被禁言至 ${new Date(muteRec.muted_until).toLocaleString('zh-CN')}`
            : '你已被永久禁言';
          socket.emit('message:error', { message: msg });
          return;
        }

        const msgKey = getMsgKey();
        const dbContent = msgKey ? encrypt(msgKey, content) : content;

        const [result] = await pool.execute(
          'INSERT INTO group_messages (group_id, sender_id, content, type, reply_to) VALUES (?, ?, ?, ?, ?)',
          [groupId, socket.userId, dbContent, type || 'text', replyTo || null]
        );
        const [senderRows] = await pool.execute('SELECT nickname, avatar FROM users WHERE id = ?', [socket.userId]);
        const sender = senderRows[0] || {};

        const message = {
          id: result.insertId,
          group_id: groupId,
          sender_id: socket.userId,
          content,
          type: type || 'text',
          is_recalled: 0,
          reply_to: replyTo || null,
          created_at: new Date().toISOString(),
          sender_nickname: sender.nickname || '',
          sender_avatar: sender.avatar || '/default-avatar.png',
        };

        // 广播给群内所有人（包括自己）
        io.to(`group:${groupId}`).emit('group:message:receive', message);

        // 对离线群成员推送 FCM
        const [members] = await pool.execute(
          'SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?',
          [groupId, socket.userId]
        );
        const [[groupInfo]] = await pool.execute('SELECT name FROM `groups` WHERE id = ?', [groupId]);
        for (const m of members) {
          if (!onlineUsers.has(m.user_id)) {
            const [[u]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [m.user_id]);
            if (u?.fcm_token) {
              const preview = (type === 'text' || !type) ? content.slice(0, 50) : type === 'image' ? '[图片]' : type === 'audio' ? '[语音]' : '[视频]';
              const imageUrl = type === 'image' ? fullUrl(content) : undefined;
              await sendPush(u.fcm_token, groupInfo?.name || '群消息', `${sender.nickname}: ${preview}`, { type: 'group', groupId: String(groupId) }, imageUrl);
            }
          }
        }

        // 群聊发消息加经验（每天上限50条，与私聊共享计数）
        // 群聊发消息加经验（每天上限50条，与私聊共享计数）
        try { await grantMessageExp(socket.userId, socket, io, onlineUsers); }
        catch (expErr) { console.error('[Socket] 群聊经验处理失败:', expErr); }

        // 解析@提及，推送通知给被@的成员（在线推送+离线持久化）
        if (type === 'text' || !type) {
          const mentionPattern = /@\[(\d+)\]/g;
          let match;
          const notified = new Set();
          const hasMentionAll = /\s*@\[0\]/.test(content);
          while ((match = mentionPattern.exec(content)) !== null) {
            const mentionedId = parseInt(match[1]);
            if (mentionedId === 0) continue; // @all handled separately
            if (mentionedId !== socket.userId && !notified.has(mentionedId)) {
              notified.add(mentionedId);
              // 持久化@记录（无论在线与否）
              await pool.execute(
                'INSERT IGNORE INTO group_mentions (group_id, user_id, msg_id) VALUES (?, ?, ?)',
                [groupId, mentionedId, result.insertId]
              );
              const targetSid = onlineUsers.get(mentionedId);
              if (targetSid) {
                io.to(targetSid).emit('group:mentioned', {
                  groupId,
                  msgId: result.insertId,
                  senderNickname: sender.nickname || '',
                });
              } else {
                // 离线用户，FCM 推送@提及
                const [[u]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [mentionedId]);
                if (u?.fcm_token) {
                  await sendPush(u.fcm_token, groupInfo?.name || '群消息', `${sender.nickname} @了你`, { type: 'group_mention', groupId: String(groupId) });
                }
              }
            }
          }
          // @全体成员 通知所有群成员
          if (hasMentionAll) {
            const [allMembers] = await pool.execute(
              'SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?',
              [groupId, socket.userId]
            );
            for (const m of allMembers) {
              await pool.execute(
                'INSERT IGNORE INTO group_mentions (group_id, user_id, msg_id) VALUES (?, ?, ?)',
                [groupId, m.user_id, result.insertId]
              );
              const sid = onlineUsers.get(m.user_id);
              if (sid) {
                io.to(sid).emit('group:mentioned', {
                  groupId,
                  msgId: result.insertId,
                  senderNickname: sender.nickname || '',
                });
              } else {
                const [[u]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [m.user_id]);
                if (u?.fcm_token) {
                  await sendPush(u.fcm_token, groupInfo?.name || '群消息', `${sender.nickname} @了全体成员`, { type: 'group_mention', groupId: String(groupId) });
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[Socket] 群消息发送失败:', err);
      }
    });

    // 群聊消息已读
    socket.on('group:message:read', async (data) => {
      try {
        const { groupId } = data;
        if (!socket.userId || !groupId) return;
        const [lastMsg] = await pool.execute('SELECT MAX(id) as max_id FROM group_messages WHERE group_id = ?', [groupId]);
        const maxId = lastMsg[0]?.max_id || 0;
        await pool.execute(
          'UPDATE group_members SET last_read_msg_id = ? WHERE group_id = ? AND user_id = ?',
          [maxId, groupId, socket.userId]
        );
      } catch (err) {
        console.error('[Socket] 群消息已读失败:', err);
      }
    });

    // ====== 动态模块实时事件 ======
    socket.on('moment:publish', async (data) => {
      try {
        if (!socket.userId) return;
        const { momentId } = data;
        if (!momentId) return;
        const [momentData] = await pool.execute(
          `SELECT m.*, u.nickname, u.avatar, u.level FROM moments m JOIN users u ON m.user_id = u.id WHERE m.id = ?`, [momentId]);
        if (!momentData.length) return;
        const momentKey = process.env.MASTER_KEY ? require('../utils/crypto').deriveKey(process.env.MASTER_KEY, 'moment') : null;
        const moment = momentData[0];
        const payload = {
          id: moment.id, user_id: moment.user_id, content: safeDecrypt(momentKey, moment.content),
          images: JSON.parse(moment.images || '[]'), audio_url: moment.audio_url, audio_duration: moment.audio_duration,
          location: moment.location, visibility: moment.visibility, topic_name: moment.topic_name,
          created_at: moment.created_at,
          user_nickname: moment.nickname, user_avatar: moment.avatar, user_level: decCoin(moment.level),
          like_count: 0, comment_count: 0
        };
        // 推送给在线粉丝 + 增加未读数
        const [followers] = await pool.execute('SELECT follower_id FROM follows WHERE following_id = ?', [socket.userId]);
        for (const f of followers) {
          const sid = onlineUsers.get(f.follower_id);
          if (sid) io.to(sid).emit('moment:new', payload);
          // 增加关注动态未读数（持久化）
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
        socket.emit('moment:published', { momentId: moment.id });
      } catch (err) { console.error('[Socket] moment:publish error:', err); }
    });

    socket.on('disconnect', async () => {
      if (socket.userId) {
        onlineUsers.delete(socket.userId);
        await pool.execute('UPDATE users SET last_seen = NOW() WHERE id = ?', [socket.userId]);
        const [[self]] = await pool.execute('SELECT hide_online_status FROM users WHERE id = ?', [socket.userId]);
        if (!self?.hide_online_status) {
          const [friends] = await pool.execute('SELECT friend_id FROM contacts WHERE user_id = ?', [socket.userId]);
          friends.forEach(f => {
            const sid = onlineUsers.get(f.friend_id);
            if (sid) io.to(sid).emit('user:status', { userId: socket.userId, status: 'offline' });
          });
        }
      }
    });
  });
}

module.exports = setupSocket;
