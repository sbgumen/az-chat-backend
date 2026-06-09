# AZ-Chat 安全加固设计文档

**日期**: 2026-06-05
**版本**: v1.0
**目标**: 安全评分从 55/100 提升至 91/100

---

## 1. 概述

### 1.1 背景

安全审计发现 AZ-Chat 存在 10 个严重漏洞、6 个高危漏洞、7 个中危漏洞。综合安全评分 55/100。核心问题：

- 全 HTTP 明文传输，无 HTTPS
- 聊天消息、手机号、验证码等敏感数据全部明文存储
- JWT Token 30天有效，无吊销机制
- CORS 配置 Bug，允许任意跨域
- Debug 接口无认证
- 密钥硬编码在源码中

### 1.2 约束条件

- 部署环境无域名、无备案，短期内无法上 HTTPS
- 不得破坏已有 API 的请求/响应结构
- 不得修改已有数据库表结构（仅新增表和列）
- 不得修改 Socket 事件名称和格式

### 1.3 目标

| 维度 | 改造前 | 改造后 | 提升 |
|------|--------|--------|------|
| 加密存储 | 30 | 95 | +65 |
| 传输安全 | 10 | 15 | +5 |
| 认证安全 | 40 | 90 | +50 |
| 输入防护 | 45 | 85 | +40 |
| 配置安全 | 20 | 95 | +75 |
| **综合** | **55** | **91** | **+36** |

---

## 2. 加密工具模块

### 2.1 文件

`utils/crypto.js` — 新建

### 2.2 密钥体系

```
MASTER_KEY (env, 64 hex = 32 bytes)
    │
    ├── HKDF-SHA256(master, "msg")       → msgKey
    ├── HKDF-SHA256(master, "phone")     → phoneKey
    ├── HKDF-SHA256(master, "moment")    → momentKey
    ├── HKDF-SHA256(master, "signature") → sigKey
    └── HKDF-SHA256(master, "sms")       → smsKey
```

### 2.3 加密算法

AES-256-GCM（认证加密），输出格式：

```
base64( IV(12 bytes) || ciphertext || authTag(16 bytes) )
```

### 2.4 确定性加密（仅手机号）

手机号需要 `WHERE phone = ?` 查询：

```javascript
IV = HMAC-SHA256(phoneKey, phone).slice(0, 12)
ciphertext = AES-256-GCM(phoneKey, IV, phone)
```

### 2.5 启动自检

```javascript
const testPlain = crypto.randomBytes(32).toString('hex')
const testEnc = encrypt(KEY, testPlain)
const testDec = decrypt(KEY, testEnc)
if (testDec !== testPlain) {
  console.error('[Crypto] 密钥自检失败，服务器拒绝启动')
  process.exit(1)
}
```

### 2.6 公开 API

```javascript
const { encrypt, decrypt, generateKey } = require('./utils/crypto')
const encrypted = encrypt(msgKey, plaintext)   // → base64
const decrypted = decrypt(msgKey, encrypted)   // → plaintext (失败返回 null)
```

---

## 3. 数据库加密范围

### 3.1 加密字段

| 字段 | 表 | 密钥 | 加密方式 |
|------|-----|------|---------|
| `content` | messages | msgKey | AES-256-GCM 随机IV |
| `content` | group_messages | msgKey | AES-256-GCM 随机IV |
| `content` | moments | momentKey | AES-256-GCM 随机IV |
| `phone` | users | phoneKey | AES-256-GCM 确定性 |
| `code` | sms_codes | smsKey | SHA256(smsKey + code) |
| `signature` | users | sigKey | AES-256-GCM 随机IV |

### 3.2 不加密字段

ID、时间戳、头像URL、好友关系、点赞数、昵称（展示高频）、fcm_token（已加密存储无额外价值）

### 3.3 读路径兼容

```javascript
function safeDecrypt(key, ciphertext) {
  if (!ciphertext) return ''
  const decoded = decrypt(key, ciphertext)    // 尝试解密
  if (decoded !== null) return decoded        // 密文 → 解密成功
  return ciphertext                           // 明文 → 直接返回
}
```

### 3.4 渐进式迁移

服务启动时：

```
1. 查询 system_settings WHERE key = 'encryption_version'
2. version < 1 或不存在 → 启动后台迁移
3. 迁移：每批1000条，间隔500ms，按 id 升序
4. 每条：safeDecrypt 成功 → 跳过；失败 → encrypt 写回
5. 完成：更新 system_settings.encryption_version = '1'
6. 新数据：全部 encrypt 后写入
```

迁移优先级：messages → group_messages → moments → users.phone → users.signature

---

## 4. JWT 认证强化

### 4.1 Token 结构

| Token 类型 | 有效期 | 存储位置 | 内容 |
|-----------|--------|---------|------|
| Access Token | 2小时 | 前端内存 | `{ userId, type:"access", iat, exp, iss }` |
| Refresh Token | 7天 | 前端 localStorage + 后端表 | `{ userId, hash, family, expiresAt }` |

### 4.2 新增数据库表

```sql
CREATE TABLE refresh_tokens (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  family VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT NOW(),
  INDEX idx_user (user_id),
  INDEX idx_family (family),
  INDEX idx_expires (expires_at)
);
```

### 4.3 Token 轮换流程

```
POST /api/auth/refresh { refreshToken }
  → SHA256(refreshToken) 查库
  → 检查 expires_at 未过期
  → 生成新 accessToken + 新 refreshToken
  → 删除旧记录，标记同一 family 全部作废
  → 返回 { accessToken, refreshToken, user }
```

### 4.4 吊销场景

| 场景 | 操作 |
|------|------|
| 用户登出 | 删除该用户所有 refresh_tokens |
| 用户改密码 | 删除该用户所有 refresh_tokens |
| 管理员封禁 | 删除该用户所有 refresh_tokens |

### 4.5 新增 API

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | /api/auth/refresh | 无（用refreshToken） | 刷新Token |
| POST | /api/auth/logout | 需要 | 登出，吊销所有refreshToken |

### 4.6 中间件兼容

```javascript
// middleware/auth.js 兼容逻辑
if (!decoded.type || decoded.type === 'access') {
  // 新格式或旧格式，均通过签名校验
  req.userId = decoded.userId
}
// 旧格式（无 type）→ 仍有效（30天内自然过期）
```

### 4.7 登录/注册返回格式变化

```javascript
// 改造前
{ code: 0, token, user }

// 改造后
{ code: 0, accessToken, refreshToken, user }
// token 字段保留兼容，值同 accessToken
```

---

## 5. 安全配置修复

### 5.1 CORS 修复

```javascript
// app.js — 修复 else 分支
} else {
  callback(new Error('Not allowed by CORS'));
}
```

### 5.2 Debug 接口删除

以下 4 个接口全部删除：

- `GET /api/debug/online`
- `GET /api/debug/token/:userId`
- `GET /api/debug/set-token/:userId/:token`
- `GET /api/debug/fcm/:userId`

### 5.3 Socket 消息频率限制

每个 Socket 连接限制 30 条消息/分钟（client和group各算）：

```javascript
// socket/index.js
const RATE_LIMIT = { max: 30, window: 60000 }

// message:send 和 group:message:send 开头插入检查
if (now > socket.msgRate.resetAt) {
  socket.msgRate = { count: 0, resetAt: now + RATE_LIMIT.window }
}
if (++socket.msgRate.count > RATE_LIMIT.max) {
  return socket.emit('message:error', { message: '发送过快' })
}
```

---

## 6. 文件存储与鉴权

### 6.1 目录结构改造

```
uploads/
├── public/              ← 静态默认资源，无需鉴权
│   ├── default-avatar.svg
│   ├── default-group.png
│   ├── system-bot-avatar.svg
│   └── topic-covers/
│       ├── books.jpg ... travel.jpg
│
├── private/             ← 用户上传，需Token鉴权
│   ├── avatars/
│   ├── messages/
│   ├── groups/
│   ├── moments/
│   ├── albums/
│   └── banners/
│
└── system/              ← 系统可写资源，需AdminToken
    └── logo_*.png
```

### 6.2 签名 URL 机制

```javascript
// GET /api/media?token=xxx
// token 格式: base64(path || '|' || expires || '|' || HMAC-SHA256(mediaKey, path + expires))
// expires 为 Unix 时间戳（秒），过期返回 404
```

### 6.3 启动自动迁移

```javascript
// 首次启动时执行
const defaultAssets = ['default-avatar.svg', 'default-group.png', 'system-bot-avatar.svg']
defaultAssets.forEach(f => {
  if (fs.existsSync(`uploads/${f}`) && !fs.existsSync(`uploads/public/${f}`)) {
    fs.renameSync(`uploads/${f}`, `uploads/public/${f}`)
  }
})
// topic-covers 目录整体迁移
if (fs.existsSync('uploads/topic-covers') && !fs.existsSync('uploads/public/topic-covers')) {
  fs.renameSync('uploads/topic-covers', 'uploads/public/topic-covers')
}
// private 子目录按需创建（通过 multer dest 自动）
```

### 6.4 兼容处理

- `/uploads/public/*` → 直接提供，无鉴权
- `/uploads/default-avatar.svg` 等旧路径 → 302 重定向到新路径
- 旧消息中的 `/uploads/msg_*.png` → 旧文件不移入 private，维持可访问但标记 deprecated
- 新上传全部走 private + token URL

---

## 7. 前端改造

### 7.1 AuthContext 改造

```typescript
// 改造前
localStorage.setItem('az_token', token)
localStorage.setItem('az_user', JSON.stringify(user))

// 改造后
// accessToken 仅存内存（useState/useRef）
// refreshToken 存 localStorage（唯一持久化项）
// user 精简后存 localStorage（移除 phone 字段）
localStorage.setItem('az_refresh', refreshToken)
localStorage.setItem('az_user', JSON.stringify({
  id, nickname, avatar, level, coins, role,
  lv30_style, banner_type, banner_preset
}))
```

### 7.2 自动刷新逻辑

```
Axios response interceptor:
  收到 401 → 尝试 POST /api/auth/refresh
    → 成功：更新内存 accessToken，重发原请求
    → 失败：清除所有状态，跳转 /login
```

### 7.3 localStorage 清理

| Key | 操作 |
|-----|------|
| `az_token` | 删除，不再写入 |
| `az_user` | 重写，移除 phone 字段 |
| `az_refresh` | 新增 |
| 其他 | 不变 |

### 7.4 媒体 URL 改造

```typescript
// src/utils/mediaUrl.ts
export function getMediaUrl(path: string): string {
  if (!path) return ''
  if (path.startsWith('http')) return path
  if (path.startsWith('/uploads/public/')) return `${API_BASE}${path}`
  if (path.startsWith('/uploads/')) {
    // 旧格式路径，直接返回（兼容期）
    return `${API_BASE}${path}`
  }
  // 新格式：生成签名URL
  return `${API_BASE}/api/media?token=${signPath(path)}`
}
```

### 7.5 XSS 防护

```typescript
// src/pages/Moments/PublishMoment.tsx
import DOMPurify from 'dompurify'

// 提交前清洗
const cleanContent = DOMPurify.sanitize(editorContent, { ALLOWED_TAGS: [] })
```

新增依赖：`dompurify` + `@types/dompurify`

### 7.6 fetch() 改为 axios

ChatRoom.tsx 和 GroupChatRoom.tsx 中手动 fetch() 调用改为 axios，受益于拦截器自动刷新。

---

## 8. 接口变更汇总

### 8.1 新增 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/auth/refresh | 刷新 Token |
| POST | /api/auth/logout | 登出 |
| GET | /api/media?token=xxx | 媒体文件签名访问 |

### 8.2 修改 API

| 方法 | 路径 | 变化 |
|------|------|------|
| POST | /api/auth/login | 返回新增 accessToken/refreshToken |
| POST | /api/auth/login-id | 同上 |
| POST | /api/auth/register | 同上 |

### 8.3 删除 API

| 路径 | 说明 |
|------|------|
| GET /api/debug/online | |
| GET /api/debug/token/:userId | |
| GET /api/debug/set-token/:userId/:token | |
| GET /api/debug/fcm/:userId | |

---

## 9. 新增依赖

### 后端

| 包 | 版本 | 用途 |
|----|------|------|
| 无新增 | | crypto 为 Node.js 内置模块 |

### 前端

| 包 | 版本 | 用途 |
|----|------|------|
| dompurify | ^3.x | XSS 清洗 |
| @types/dompurify | ^3.x | TypeScript 类型 |

---

## 10. 兼容性矩阵

| 场景 | 处理方式 |
|------|---------|
| 旧 Token（30天，无type） | auth 中间件兼容，自然过期 |
| 旧消息明文 content | 读路径自动识别明文/密文 |
| 旧 uploads 路径 | 302 重定向 + deprecated 标记 |
| 旧 localStorage key | 登录时清除旧 key，写入新 key |
| 旧客户端 API 不传 refreshToken | 返回兼容的 token 字段 |
| 数据库迁移中断（重启） | 幂等，从上次位置继续 |

---

## 11. 密钥生成与部署

### 11.1 生成 MASTER_KEY

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

输出 64 位 hex 字符串，写入 `.env`：

```
MASTER_KEY=a1b2c3d4e5f6...（64字符）
```

### 11.2 部署步骤

1. 生成 MASTER_KEY，写入 `.env`
2. 执行 `npm install`（前端安装 dompurify）
3. 启动后端，等待加密迁移完成（日志显示进度）
4. 启动前端，测试登录→刷新→消息加密→文件访问
5. 验证旧消息可读、新消息加密存储

---

## 12. 安全评分对比

| 维度 | 改造前 | 改造后 | 关键改进 |
|------|--------|--------|---------|
| 加密存储 | 30 | 95 | AES-256-GCM 全字段加密 |
| 传输安全 | 10 | 15 | 媒体 Token 签名 URL |
| 认证安全 | 40 | 90 | 双Token+吊销+限量签发 |
| 输入防护 | 45 | 85 | DOMPurify + 频率限制 |
| 配置安全 | 20 | 95 | CORS修复 + Debug删除 + 密钥管理 |
| **综合** | **55** | **91** | +36分 |

---

## 13. 不包含本次范围的改进

以下是有价值但本次不做的事项（单独评估后决定）：

- HTTPS 部署（需要域名+备案）
- Redis 缓存层（消息加密后性能回退的兜底）
- CDN/OSS 云存储
- 端到端加密（E2EE，需要客户端密钥协商）
- 音视频通话加密
- 单元测试/集成测试
- Docker 容器化
- CI/CD 流水线
