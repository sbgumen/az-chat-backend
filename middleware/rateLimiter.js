const rateLimit = require('express-rate-limit');

// 短信发送限制：同一 IP 每分钟 3 次
const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  handler: (req, res) => {
    res.json({ code: 429, message: '请求过于频繁，请稍后再试' });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// 短信发送限制：同一 IP 每小时 20 次
const smsHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  handler: (req, res) => {
    res.json({ code: 429, message: '发送次数过多，请1小时后再试' });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// 短信发送限制：同一手机号每分钟 1 次（按手机号限流）
const smsPhoneLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1,
  keyGenerator: (req) => `phone:${req.body.phone || 'unknown'}`,
  handler: (req, res) => {
    res.json({ code: 429, message: '验证码已发送，请60秒后再试' });
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { ip: false },
});

// 登录限制：同一 IP 每 15 分钟 10 次
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: (req, res) => {
    res.json({ code: 429, message: '登录尝试过多，请15分钟后再试' });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// 全局 API 限制：同一 IP 每分钟 600 次
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  handler: (req, res) => {
    res.json({ code: 429, message: '请求过于频繁' });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  smsLimiter,
  smsHourlyLimiter,
  smsPhoneLimiter,
  loginLimiter,
  globalLimiter,
};
