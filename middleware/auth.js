const jwt = require('jsonwebtoken');

// 启动时校验 JWT_SECRET
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.warn('[Security] 警告: JWT_SECRET 未设置或长度不足32位，请在 .env 中配置强密钥');
}

function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }

  const token = authHeader.slice(7);
  if (!token) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'az-chat-backend',
    });
    // 仅允许 access token（无 type 的旧 token 兼容放行）
    if (decoded.type && decoded.type !== 'access') {
      return res.status(401).json({ code: 401, message: 'token类型无效' });
    }
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ code: 401, message: 'token无效或已过期' });
  }
}

module.exports = auth;
