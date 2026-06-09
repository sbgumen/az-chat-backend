/**
 * 管理员操作审计日志
 */
const pool = require('../config/db');

async function auditLog(adminId, action, targetType, targetId, detail, req) {
  try {
    await pool.execute(
      'INSERT INTO admin_logs (admin_id, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
      [adminId, action, targetType, String(targetId || ''), JSON.stringify(detail || {}), req?.ip || '']
    );
  } catch (err) {
    console.error('[Audit] 日志写入失败:', err.message);
  }
}

module.exports = { auditLog };
