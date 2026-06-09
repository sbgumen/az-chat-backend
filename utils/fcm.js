const JPUSH_APP_KEY = process.env.JPUSH_APP_KEY || 'e937676841c4698bf801d812';
const JPUSH_MASTER_SECRET = process.env.JPUSH_MASTER_SECRET || '619cf735489463e11fb1cec6';
const SERVER_URL = process.env.SERVER_URL || process.env.PUBLIC_URL || 'http://171.80.10.243:5001';
const auth = Buffer.from(`${JPUSH_APP_KEY}:${JPUSH_MASTER_SECRET}`).toString('base64');

function fullUrl(path) {
  if (!path) return undefined;
  if (path.startsWith('http')) return path;
  return `${SERVER_URL}${path}`;
}

/**
 * 发送极光推送
 * @param {string} regId - 设备注册 ID
 * @param {string} title - 通知标题
 * @param {string} body - 通知内容
 * @param {object} extras - 附加数据（用于跳转），包含: type, senderId, groupId, momentId, userId, albumId 等
 * @param {string} [image] - 可选的大图 URL（通知栏显示图片）
 */
async function sendPush(regId, title, body, extras = {}, image) {
  if (!regId) return;
  try {
    const notification = {
      android: {
        alert: body,
        title,
        extras,
        channel_id: 'messages',
        builder_id: 1,
        alert_type: image ? 1 : -1, // -1=不显示图片, 0=显示alert中, 1=显示在通知栏
        big_pic_path: image || undefined,
        style: image ? 1 : 0, // 1=大图样式
      },
    };

    const payload = {
      platform: 'android',
      audience: { registration_id: [regId] },
      notification,
      options: { apns_production: false },
    };

    const resp = await fetch('https://api.jpush.cn/v3/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (!resp.ok) console.error('[JPush] 推送失败:', JSON.stringify(result));
  } catch (err) {
    console.error('[JPush] 推送失败:', err.message);
  }
}

module.exports = { sendPush, fullUrl };
