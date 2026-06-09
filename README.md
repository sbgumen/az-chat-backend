# AZ-Chat 后端 v1.1.1

Node.js + Express + MySQL + Socket.IO 全栈即时通讯后端

---

## 技术栈

| 技术 | 用途 |
|------|------|
| Node.js + Express 4 | HTTP 服务框架 |
| MySQL2 (promise) | 数据库驱动，自动建表 |
| Socket.IO 4 | 实时双向通信 |
| JWT (jsonwebtoken) | Access Token 2h + Refresh Token 7 天双令牌认证 |
| bcryptjs | 密码哈希（10 轮） |
| Multer | 文件上传 |
| Sharp | 图片压缩（Logo 上传） |
| Nodemailer | SMTP 邮件发送（邮箱验证码） |
| cookie-parser | HTTPS Cookie 支持 |
| Helmet | HTTP 安全头 |
| express-rate-limit | 频率限制 |
| svg-captcha | 图形验证码（支持算数模式） |
| ip2region | 离线 IP 定位 |
| 极光推送 JPush REST API | 离线消息推送 |

---

## 启动

```bash
npm install
node app.js
# 服务运行在 http://0.0.0.0:5001
# 首次启动自动创建所有数据库表并填充默认数据
```

开发模式（文件变更自动重启）：

```bash
npm run dev
```

---

## 配置

所有配置通过根目录 `.env` 文件管理：

```env
# 数据库
DB_HOST=localhost
DB_PORT=3306
DB_USER=azchat
DB_PASSWORD=你的密码
DB_NAME=azchat

# 服务
PORT=5001
JWT_SECRET=64位随机hex
MASTER_KEY=64位随机hex（数据加密主密钥）

# 跨域（通配符 * 允许所有来源）
CORS_ORIGINS=*

# 短信服务（v1.1.0 起由管理后台配置，无需在此填写）
# SMS_URL=已废弃

# 极光推送
JPUSH_APP_KEY=你的AppKey
JPUSH_MASTER_SECRET=你的MasterSecret

# 默认管理员用户ID
DEFAULT_ADMIN_ID=10003
```

> `JWT_SECRET` 和 `MASTER_KEY` 需使用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成。

---

## 安全特性

### 数据加密

| 加密对象 | 算法 | 说明 |
|----------|------|------|
| 聊天消息 | AES-256-GCM | 私聊 + 群聊内容加密存储 |
| 手机号 | AES-256-GCM 确定性 | 支持精确查询 |
| 邮箱 | AES-256-GCM 确定性 | 支持精确查询，兼容明文旧数据自动迁移 |
| 验证码 | HMAC-SHA256 | 仅比对，不可逆 |
| 密码 | bcrypt (10 轮) | 标准哈希 |
| 金币/经验/等级 | AES-256-GCM | 原子事务操作 + 审计记录 |
| 个人签名 | AES-256-GCM | 随机 IV |
| 朋友圈内容 | AES-256-GCM | 透明加解密 |
| SMTP 授权码 | AES-256-GCM 随机 IV | 不可查询，仅解密使用 |
| 短信模板 ID | AES-256-GCM 随机 IV | 不可查询，仅解密使用 |

### 认证强化

- **双令牌机制**：Access Token 2 小时 + Refresh Token 7 天
- **自动刷新**：Access Token 过期后使用 Refresh Token 无缝续期
- **防重放**：Refresh Token 轮换时旧令牌家族全部作废
- **HTTPS 兼容**：检测到 HTTPS 时自动使用 HttpOnly Secure Cookie 存储 Refresh Token

### 其他防护

- 全参数化 SQL 查询（防注入）
- 文件上传 MIME 白名单校验
- SMS/邮箱发送频率限制
- 管理员操作审计日志
- 金币操作 `SELECT FOR UPDATE` 事务防并发
- 敏感配置项（模板 ID / SMTP 授权码）不回显，仅标记已配置状态

---

## 数据库表

| 表名 | 说明 |
|------|------|
| users | 用户（含加密的 phone/email/coins/exp/level/signature） |
| messages | 私聊消息（content 加密） |
| group_messages | 群消息（content 加密） |
| groups | 群组 |
| group_members | 群成员（owner/admin/member） |
| contacts | 好友关系 |
| friend_requests | 好友申请 |
| follows | 关注关系 |
| moments | 朋友圈动态（content 加密） |
| moment_comments | 动态评论 |
| moment_likes | 点赞 |
| moment_favorites | 收藏 |
| moment_topics | 话题标签 |
| moment_notifications | 动态通知 |
| photo_albums | 相册 |
| album_photos | 相册图片 |
| album_comments | 相册评论 |
| album_favorites | 相册收藏 |
| sign_in_records | 签到记录 |
| follow_feed_unread | 关注动态未读数 |
| follow_exp_records | 每日关注经验防刷 |
| message_exp_records | 每日消息经验计数 |
| sms_codes | 短信验证码（code 哈希存储） |
| email_codes | 邮箱验证码（code 哈希存储） |
| conversation_settings | 会话置顶/免打扰 |
| system_settings | 系统配置（KV 键值对） |
| refresh_tokens | JWT Refresh Token |
| level_config | 等级规则表（每级经验/金币） |
| signin_config | 连续签到奖励配置 |
| banner_presets | 预设背景管理 |
| coin_transactions | 金币交易审计记录 |
| admin_logs | 管理员操作审计日志 |
| group_notices | 群公告 |
| group_notice_reads | 群公告已读记录 |
| group_mentions | @提及记录 |
| group_member_mutes | 禁言记录 |
| group_requests | 加群申请 |

---

## API 概览

### 认证 `/api/auth`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | /captcha | 无 | 获取图形验证码（支持文本/算数模式，动态配置位数和字母开关） |
| GET | /check-phone | 无 | 检查手机号是否已注册 |
| GET | /check-email | 无 | 检查邮箱是否已注册 |
| POST | /send-code | 无 | 发送短信验证码（三层频率限制，支持管理后台自定义模板） |
| POST | /send-email-code | 无 | 发送邮箱验证码（SMTP，支持管理后台配置） |
| POST | /login | 无 | 手机号 + 验证码登录（自动注册） |
| POST | /login-email | 无 | 邮箱 + 验证码登录（新用户返回需注册） |
| POST | /login-id | 无 | 账号ID/手机号/邮箱 + 密码登录 |
| POST | /register | 无 | 完成注册（设置昵称，支持 phone/email） |
| POST | /register-password | 无 | 纯密码注册（昵称+密码，自动生成ID） |
| POST | /refresh | 无 | 刷新 Access Token |
| POST | /logout | 需要 | 登出，吊销所有 Refresh Token |

### 用户 `/api/user`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | /profile | 需要 | 当前用户完整信息（含解密后的 phone/email） |
| GET | /profile/:userId | 需要 | 他人公开资料（隐私过滤） |
| PUT | /profile | 需要 | 更新个人资料（含 email 字段） |
| PUT | /avatar | 需要 | 上传头像（5MB，前端压缩） |
| GET | /search | 需要 | 搜索用户 |
| POST | /password | 需要 | 修改密码（支持旧密码直接改 / 验证码重置） |
| GET | /password-options | 需要 | 获取可用的密码重置方式及绑定状态 |
| POST | /rebind-phone | 需要 | 换绑手机号 |
| POST | /bind-phone | 需要 | 首次绑定手机号 |
| POST | /bind-email | 需要 | 绑定/换绑邮箱 |
| POST | /sign-in | 需要 | 每日签到（加密存储，原子操作） |
| GET | /level | 需要 | 等级 + 经验 + 签到状态 |
| GET | /level/ranking | 需要 | 好友等级排名 |
| GET | /level/ranking/global | 需要 | 全球等级排名 |
| GET | /ranking/popular | 需要 | 好友人气排名 |
| GET | /ranking/popular/global | 需要 | 全球人气排名 |
| POST | /follow/:userId | 需要 | 关注用户（每日经验上限） |
| POST | /unfollow/:userId | 需要 | 取消关注 |
| GET | /following | 需要 | 关注列表 |
| GET | /followers | 需要 | 粉丝列表 |
| GET | /presets | 无 | 获取可用预设背景 |
| GET | /level-rules | 无 | 获取等级规则 + 经验配置（前端同步） |
| POST | /fcm-token | 需要 | 上报极光 Registration ID |

### 消息 `/api/messages`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | /conversations | 需要 | 私聊会话列表（解密返回） |
| GET | /group-conversations | 需要 | 群聊会话列表（解密返回） |
| GET | /:userId | 需要 | 与某用户的聊天记录（分页，解密返回） |
| POST | /read/:userId | 需要 | 标记已读 |
| POST | /recall/:msgId | 需要 | 撤回消息（2 分钟内） |
| POST | /upload | 需要 | 上传图片消息（10MB） |
| POST | /upload-audio | 需要 | 上传语音消息（10MB） |
| GET | /search/:userId | 需要 | 搜索私聊记录 |
| GET | /group-search/:groupId | 需要 | 搜索群消息 |
| GET | /pinned/list | 需要 | 置顶会话列表 |
| GET | /muted/list | 需要 | 免打扰会话列表 |
| POST | /settings/:targetId | 需要 | 更新会话设置（置顶/免打扰） |

### 好友 `/api/contacts`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | / | 需要 | 好友列表 |
| POST | /request | 需要 | 发送好友申请 |
| GET | /requests | 需要 | 收到的申请 |
| POST | /accept/:id | 需要 | 接受申请（双方加经验） |
| POST | /reject/:id | 需要 | 拒绝申请 |
| DELETE | /:friendId | 需要 | 删除好友 |

### 群组 `/api/groups`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | /create | 需要 | 创建群组 |
| GET | /my | 需要 | 我的群组 |
| GET | /search | 需要 | 搜索群组 |
| POST | /request | 需要 | 申请加入 |
| POST | /requests/:id/accept | 需要 | 接受申请 |
| POST | /requests/:id/reject | 需要 | 拒绝申请 |
| PUT | /:groupId | 需要 | 修改群信息 |
| POST | /:groupId/invite | 需要 | 邀请成员 |
| POST | /:groupId/kick | 需要 | 踢出成员 |
| POST | /:groupId/mute | 需要 | 禁言成员 |
| POST | /:groupId/unmute | 需要 | 解除禁言 |
| GET | /:groupId/messages | 需要 | 群聊天记录 |
| GET | /:groupId/members | 需要 | 群成员列表 |
| POST | /:groupId/notices | 需要 | 创建群公告 |
| GET | /:groupId/notices | 需要 | 群公告列表 |

### 朋友圈 `/api/moments`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | /feed | 需要 | 动态流（推荐/关注 tab） |
| POST | / | 需要 | 发布动态 |
| GET | /mine | 需要 | 我的动态 |
| GET | /:id | 需要 | 动态详情 |
| DELETE | /:id | 需要 | 删除动态 |
| POST | /:id/like | 需要 | 点赞/取消 |
| GET | /:id/comments | 需要 | 评论列表 |
| POST | /:id/comments | 需要 | 发表评论 |
| POST | /:id/favorite | 需要 | 收藏/取消 |
| GET | /search | 需要 | 搜索动态 |
| GET | /topics/hot | 需要 | 热门话题 |
| GET | /topics/:name/feed | 需要 | 话题动态流 |

### 相册 `/api/album`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | /my | 需要 | 我的相册 |
| GET | /user/:userId | 需要 | 他人相册（可见范围过滤） |
| POST | / | 需要 | 创建相册 |
| POST | /:id/photos | 需要 | 上传照片 |
| DELETE | /:id | 需要 | 删除相册 |

### 管理后台 `/api/admin`

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | /dashboard | admin | 仪表盘统计数据 |
| GET/PUT | /settings | admin | 系统设置（含登录方式/短信模板/SMTP 配置） |
| POST | /settings/logo | admin | 上传 Logo（自动压缩 512px） |
| POST | /test-sms | admin | 测试短信发送（自动回退已存储模板 ID） |
| POST | /test-email | admin | 测试邮件发送（自动回退已存储 SMTP 配置） |
| GET | /users | admin | 用户列表（分页/搜索，解密 phone/email） |
| POST | /users | admin | 创建用户（昵称+密码自动生成ID） |
| PUT | /users/:id | admin | 编辑用户（含 phone/email 字段） |
| PUT | /users/:id/ban | admin | 封禁/解封用户 |
| DELETE | /users/:id | admin | 删除用户 |
| GET | /groups | admin | 群组列表 |
| PUT | /groups/:id | admin | 编辑群组 |
| PUT | /groups/:id/ban | admin | 封禁群组 |
| DELETE | /groups/:id | admin | 删除群组 |
| GET/PUT | /level-config | admin | 等级经验配置（含启用开关） |
| GET | /level-rules | admin | 等级规则表 |
| PUT | /level-rules/:level | admin | 编辑单级规则 |
| POST | /level-rules/batch | admin | 批量填充规则 |
| GET | /signin-stats | admin | 签到统计 |
| GET/PUT | /signin-config | admin | 连续签到奖励配置 |
| GET | /moments | admin | 动态管理（解密返回） |
| DELETE | /moments/:id | admin | 删除动态（审计记录） |
| GET | /presets | admin | 预设背景管理 |
| POST | /presets | admin | 新增预设 |
| PUT | /presets/:id | admin | 编辑预设 |
| DELETE | /presets/:id | admin | 删除预设 |
| GET | /topics | admin | 话题管理 |
| PUT | /topics/:id | admin | 编辑话题 |
| DELETE | /topics/:id | admin | 删除话题 |
| GET/PUT | /captcha-config | admin | 图形验证码配置（位数/字母/算数模式） |
| GET | /public-settings | 无 | 公开设置（系统名称/Logo + 登录方式） |

---

## Socket.IO 事件

| 事件 | 方向 | 说明 |
|------|------|------|
| user:online | 客户端→服务端 | 用户上线（携带 JWT） |
| message:send | 客户端→服务端 | 发送私聊消息（加密存储，30条/分钟限流） |
| message:receive | 服务端→客户端 | 收到私聊消息 |
| message:read | 双向 | 消息已读 |
| message:sent | 服务端→客户端 | 消息发送确认 |
| message:recalled | 服务端→客户端 | 消息被撤回 |
| group:message:send | 客户端→服务端 | 发送群消息（加密存储） |
| group:message:receive | 服务端→客户端 | 收到群消息 |
| group:mentioned | 服务端→客户端 | 被 @提及 |
| group:broadcast | 服务端→客户端 | 群广播通知 |
| group:member_muted | 服务端→客户端 | 被禁言/解禁 |
| group:join / group:leave | 服务端→客户端 | 加入/退出群组 |
| moment:new | 服务端→客户端 | 关注的人发新动态 |
| moment:notification | 服务端→客户端 | 动态互动通知 |
| moment:likeUpdate | 服务端→客户端 | 点赞实时更新 |
| exp:gained | 服务端→客户端 | 获得经验（含升级和金币信息） |
| user:status | 服务端→客户端 | 好友在线状态变化 |

---

## 文件存储结构

```
uploads/
├── public/              ← 静态默认资源（无需鉴权）
│   ├── default-avatar.svg
│   ├── default-group.png
│   ├── system-bot-avatar.svg
│   └── topic-covers/
├── private/             ← 用户上传文件（需签名访问）
│   ├── avatars/
│   ├── messages/
│   ├── groups/
│   ├── moments/
│   ├── albums/
│   └── banners/
└── system/              ← 系统可写资源
```

---

## 版本迭代

### v1.1.1 (2026-06-08)
- **极光推送升级**：图片消息推送通知栏展示大图，支持点击跳转
- **推送回调修复**：onNotifyMessageOpened 改为 WebView evaluateJavascript 派发事件实现页面跳转
- **文件路径回退**：express.static 增加双向回退中间件，旧路径/新路径均可正常加载
- **关注粉丝 API 修复**：following/followers 接口 signature 字段解密返回，修复杂码问题
- **用户搜索**：支持按 email 搜索（与 phone/id/nickname 并行）
- **应用配置 API**：新增 `/api/admin/app-config` 返回版本号和运行信息

### v1.1.0 (2026-06-06)
- **多登录方式**：账号密码/手机号/邮箱三种方式，管理后台可独立开关，至少开启一种
- **邮箱系统**：SMTP 邮件验证码，自动注册，支持管理后台配置+测试发送
- **密码注册**：昵称+密码自动生成ID，CAPTCHA 验证
- **密码修改增强**：支持旧密码直接修改 + 忘记密码（通过手机号/邮箱验证重置）
- **手机号+邮箱双绑定**：独立绑定/换绑，支持无需绑定状态
- **安全加密扩展**：邮箱 AES-256-GCM 确定性加密 + SMTP 授权码/短信模板 ID 加密存储
- **敏感配置保护**：模板 ID 和授权码不回显，仅标记已配置状态，空值不覆盖
- **验证码配置**：短信/邮箱验证码位数和有效期可配置，number 参数自动同步
- **图形验证码增强**：支持算数模式 (createMathExpr)，实时预览
- **数据迁移**：邮箱渐进加密迁移 (v2)，phone 列 NULL 约束修复
- **phone 解密修复**：profile 和 admin 列表接口解密 phone 字段

### v1.0.0
- 初始版本，手机号验证码登录 + ID密码登录
- 私聊/群聊/朋友圈/相册/等级系统/管理后台
- AES-256-GCM 加密体系
- 双令牌 JWT 认证
