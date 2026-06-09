const pool = require('../config/db');
const { sendPush } = require('./fcm');

const SYSTEM_BOT_ID = 9999;

/**
 * 向指定用户发送系统通知消息
 * @param {number} toUserId 接收用户ID
 * @param {string} content 消息内容
 * @param {object} [io] Socket.IO实例（可选，用于实时推送）
 * @param {Map} [onlineUsers] 在线用户Map（可选）
 */
async function sendSystemNotify(toUserId, content, io, onlineUsers) {
  try {
    const [result] = await pool.execute(
      'INSERT INTO messages (sender_id, receiver_id, content, type) VALUES (?, ?, ?, ?)',
      [SYSTEM_BOT_ID, toUserId, content, 'text']
    );
    if (io && onlineUsers) {
      const targetSid = onlineUsers.get(toUserId);
      console.log(`[SystemNotify] toUserId=${toUserId}(${typeof toUserId}) targetSid=${targetSid} onlineUsers.size=${onlineUsers.size}`);
      if (targetSid) {
        io.to(targetSid).emit('message:receive', {
          id: result.insertId,
          sender_id: SYSTEM_BOT_ID,
          receiver_id: toUserId,
          content,
          type: 'text',
          is_read: 0,
          is_recalled: 0,
          reply_to: null,
          created_at: new Date().toISOString(),
        });
      } else {
        // 用户离线，FCM 推送系统通知
        const [[u]] = await pool.execute('SELECT fcm_token FROM users WHERE id = ?', [toUserId]);
        if (u?.fcm_token) {
          await sendPush(u.fcm_token, '系统通知', content.slice(0, 100), { type: 'system' });
        }
      }
    }
  } catch (err) {
    console.error('[SystemNotify] 发送失败:', err.message);
  }
}

module.exports = { SYSTEM_BOT_ID, sendSystemNotify };
