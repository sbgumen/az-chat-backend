# AZ-Chat 系统管理功能完善设计

**日期**: 2026-06-05  
**版本**: v1.0  
**目标**: 完善管理后台，新增仪表盘/等级/签到/动态/预设/话题管理，修复验证码配置

---

## 1. 概述

### 1.1 背景

当前管理后台仅有 5 个浅层功能页面（基础设置/用户管理/群聊管理/等级管理/验证码），存在大量空白：无仪表盘、等级管理仅 4 个数字框、验证码配置后端不消费、无动态/话题/签到/预设管理、无操作审计。

### 1.2 目标

- 新增仪表盘首页（替代旧的 AdminSettings 为默认页）
- 等级管理全面重做（多行为经验值 + 等级规则表 + QQ 星级体系 + 太阳图标）
- 新增签到管理（统计 + 连续打卡奖励配置）
- 新增动态管理（列表/搜索/删除）
- 新增预设背景管理（CRUD + 上传）
- 新增话题管理（CRUD）
- 验证码配置实际生效
- 基础设置扩展（注册开关/维护模式/默认头像）
- 管理员操作日志

---

## 2. 路由与页面结构

```
/admin              → DashboardPage（新首页）
/admin/settings     → AdminSettingsPage（扩展）
/admin/users        → AdminUsersPage（增强）
/admin/groups       → AdminGroupsPage（增强）
/admin/level        → AdminLevelPage（重写）
/admin/moments      → AdminMomentsPage（新增）
/admin/signin       → AdminSigninPage（新增）
/admin/presets      → AdminPresetsPage（新增）
/admin/topics       → AdminTopicsPage（新增）
/admin/captcha      → AdminCaptchaPage（修复生效）
```

---

## 3. 数据库设计

### 3.1 新增表

#### level_config — 等级规则表

```sql
CREATE TABLE level_config (
  level INT PRIMARY KEY,
  name VARCHAR(20) DEFAULT '',
  exp_required INT DEFAULT 100,
  coin_reward INT DEFAULT 2
);
```

默认数据：level 1-99，每级 exp_required=100，coin_reward=2。

#### signin_config — 签到连续奖励配置

```sql
CREATE TABLE signin_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  streak_days INT NOT NULL UNIQUE,
  bonus_coins INT DEFAULT 0
);
```

默认数据：streak_days=3 → bonus_coins=2，streak_days=7 → bonus_coins=5，streak_days=14 → bonus_coins=10，streak_days=30 → bonus_coins=25。

#### banner_presets — 预设背景管理

```sql
CREATE TABLE banner_presets (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(30) NOT NULL,
  image_url VARCHAR(255),
  animation_type VARCHAR(20) DEFAULT 'default',
  is_active TINYINT DEFAULT 1,
  sort_order INT DEFAULT 0
);
```

#### admin_logs — 管理员操作审计

```sql
CREATE TABLE admin_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  admin_id INT NOT NULL,
  action VARCHAR(50) NOT NULL,
  target_type VARCHAR(30),
  target_id VARCHAR(50),
  detail TEXT,
  ip VARCHAR(45),
  created_at DATETIME DEFAULT NOW(),
  INDEX idx_admin (admin_id, created_at)
);
```

### 3.2 表扩展

#### users 表

```sql
ALTER TABLE users ADD COLUMN last_login DATETIME;
```

#### system_settings 新增键

| key | 默认值 | 说明 |
|-----|--------|------|
| `reg_enabled` | `'1'` | 注册开关（1=开启, 0=关闭） |
| `maintenance_msg` | `''` | 维护模式公告（空=正常模式） |
| `default_avatar` | `'/uploads/public/default-avatar.svg'` | 默认用户头像 |
| `default_group_avatar` | `'/uploads/public/default-group.png'` | 默认群头像 |

---

## 4. 后端 API 设计

### 4.1 仪表盘 — GET /api/admin/dashboard

返回：
```json
{
  "users_total": 1234,
  "users_today": 5,
  "messages_total": 56789,
  "messages_today": 234,
  "moments_total": 456,
  "moments_today": 12,
  "groups_total": 78,
  "groups_active": 23,
  "online_now": 15,
  "recent_logins": [...]
}
```

### 4.2 等级管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin/level-config | 读取所有经验值配置（扩展为多行为） |
| PUT | /api/admin/level-config | 更新经验值配置 |
| GET | /api/admin/level-rules | 读取等级规则列表 |
| PUT | /api/admin/level-rules/:level | 编辑某级规则 |
| POST | /api/admin/level-rules/batch | 批量设置（自动填充未设等级） |

**经验值配置键扩展**：

| key | 默认值 | 说明 |
|-----|--------|------|
| exp_signin | 10 | 签到 |
| exp_message | 2 | 发消息 |
| exp_group_message | 2 | 发群消息 |
| exp_moment | 5 | 发动态 |
| exp_comment | 3 | 发评论 |
| exp_like | 1 | 点赞（给他人） |
| exp_follow | 3 | 关注他人 |
| exp_add_friend | 5 | 加好友 |
| exp_message_daily_limit | 50 | 消息每日上限 |
| exp_interaction_daily_limit | 30 | 互动每日上限 |

每个键附带 `_enabled` 开关（如 `exp_moment_enabled`）。

### 4.3 签到管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin/signin-stats | 今日/昨日/本周签到统计 |
| GET | /api/admin/signin-config | 签到配置 |
| PUT | /api/admin/signin-config | 更新签到配置 |

### 4.4 动态管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin/moments | 动态列表（分页+搜索+用户ID筛选） |
| DELETE | /api/admin/moments/:id | 删除动态（记录 admin_logs） |

注意事项：
- 管理员删除他人动态时：保留 moment_id 关联的评论/点赞通知，内容标记为 `[已被管理员删除]`
- 不读取私密动态的实际内容（visibility=private 时 content 返回 `[私密]`）

### 4.5 预设背景管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin/presets | 预设列表 |
| POST | /api/admin/presets | 新增预设（含图片上传，multer 限制 10MB/图片类型） |
| PUT | /api/admin/presets/:id | 编辑预设（名称/动画类型/状态/排序） |
| DELETE | /api/admin/presets/:id | 删除预设（不删除使用中的用户设置） |

用户端 `BannerSelectPage` 改为从 `GET /api/user/presets` 拉取（返回 active=true 的预设列表）。

### 4.6 话题管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/admin/topics | 话题列表（分页+搜索） |
| PUT | /api/admin/topics/:id | 编辑话题（名称/描述/状态/封面） |
| DELETE | /api/admin/topics/:id | 删除话题（清空关联动态的 topic_name，不删动态） |

### 4.7 基础设置扩展

PUT /api/admin/settings 扩展字段：
- `reg_enabled` — 注册开关
- `maintenance_msg` — 维护公告
- `default_avatar` — 默认头像URL
- `default_group_avatar` — 默认群头像URL

### 4.8 验证码修复

`routes/auth.js` 的 `GET /captcha` 改为从 `system_settings` 读取 `captcha_length` 和 `captcha_include_alpha`：
- `captcha_length`: 3-6，传递给 `svgCaptcha.create({ size })`
- `captcha_include_alpha`: 1/0，当 0 时传递 `ignoreChars` 排除所有字母

---

## 5. 前端设计

### 5.1 仪表盘 DashboardPage

使用 frontend-design/build 风格设计，包含：

```
┌─────────────────────────────────────────────┐
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ │
│  │ 用户总量 │ │ 消息总量 │ │ 动态总量 │ │ 群组总量 │ │
│  │  1,234   │ │ 56,789  │ │   456   │ │   78    │ │
│  │ +5 今日  │ │ +234 今日│ │ +12 今日 │ │ 23活跃  │ │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ │
│                                                   │
│  ┌──────────────────────┐ ┌─────────────────────┐│
│  │   实时在线: 15人      │ │   系统资源           ││
│  │   (在线用户列表)      │ │   CPU ████░ 76%     ││
│  │                      │ │   内存 ███░░ 42%     ││
│  └──────────────────────┘ └─────────────────────┘│
│                                                   │
│  ┌──────────────────────────────────────────────┐ │
│  │  最近登录记录                                  │ │
│  │  用户A — 2026-06-05 14:30                     │ │
│  │  用户B — 2026-06-05 14:25                     │ │
│  │  ...                                         │ │
│  └──────────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 5.2 等级管理 AdminLevelPage（重写）

- **Tab 1：经验值配置**
  - 分类表格：消息类（私聊/群聊）/ 社交类（动态/评论/点赞/关注）/ 每日类（签到/加好友）
  - 每行：行为名称 | 开关 toggle | 经验值 input | 每日上限
- **Tab 2：等级规则表**
  - 可编辑表格：等级 | 名称 | 所需经验 | 奖励金币
  - 底部：批量填充按钮（按默认值填充 1-99 级）
  - 星级换算说明卡片：⭐星星(1-3级) → 🌙月亮(4-15级) → ☀️太阳(16-63级) → 👑皇冠(64+级)
- **Tab 3：等级分布**
  - 柱状图：各等级用户数量分布

### 5.3 星级组件更新

前端星级渲染函数（`src/utils/levelStars.tsx`）：
```typescript
// 当前：⭐×n → 🌙×n → 👑×n  (3段)
// 改为：
// 1-3级    → ⭐ (每1级1颗星)
// 4-15级   → 🌙 (每4级1个月亮) + ⭐ 余数
// 16-63级  → ☀️ (每16级1个太阳) + 🌙 余数 + ⭐ 余数
// 64+级    → 👑 (每64级1个皇冠) + ☀️ 余数 + 🌙 余数 + ⭐ 余数
```

### 5.4 其他新页面

- **AdminSigninPage**: 统计卡片 + 连续奖励配置表 + 签到规则说明
- **AdminMomentsPage**: 搜索栏 + 动态表格（内容/用户/时间/操作）+ 删除确认
- **AdminPresetsPage**: 预设网格（名称/缩略图/状态标记）+ 新建/编辑/删除 + 图片上传
- **AdminTopicsPage**: 话题表格（名称/封面/引用数/状态/操作）+ 编辑/删除

### 5.5 前端等级页面同步

`LevelPage.tsx` 的"经验获取规则"区域改为从 `GET /api/user/level-rules` 动态拉取，与后台配置同步。

---

## 6. 安全措施

| 措施 | 实现 |
|------|------|
| 所有 admin API 双重中间件 | `auth` → `adminAuth`，缺一不可 |
| 操作审计日志 | 关键写操作写入 `admin_logs` |
| SQL 防注入 | 全参数化查询（继承现有模式） |
| 加密兼容 | 所有新增的敏感字段（如有）沿用 `safeDecrypt` |
| 文件上传限制 | MIME 白名单 + 10MB 上限 + 路径防穿越 |
| 输入校验 | exp/金币 ≤ 999，等级 1-99，连续天数 ≤ 30 |
| IP 记录 | admin_logs 记录操作 IP |
| 私密动态保护 | 管理员查看动态列表时，私密内容不显示原文 |

### auditLog 工具函数

```javascript
// utils/auditLog.js
async function auditLog(pool, adminId, action, targetType, targetId, detail, req) {
  await pool.execute(
    'INSERT INTO admin_logs (admin_id, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [adminId, action, targetType, String(targetId), JSON.stringify(detail), req.ip || '']
  );
}
```

---

## 7. 依赖与兼容

### 新增依赖（前端）

| 包 | 用途 |
|----|------|
| `recharts` | 仪表盘/等级分布图表 |

### 向后兼容

- 预设背景迁移：启动时将现有 6 个硬编码 preset 插入 `banner_presets` 表（`INSERT IGNORE`）
- 等级规则自动填充：启动时检查 `level_config` 表是否有数据，无则自动创建 1-99 级默认记录
- 签到配置自动填充：同上
- 现有 Banner 预设仍保留在前端代码作为 fallback

---

## 8. 实施顺序

```
1. 数据库表 + 初始数据          (后端, 无依赖)
2. 后端 API: 仪表盘/等级/签到   (后端, 依赖1)
3. 后端 API: 动态/预设/话题     (后端, 依赖1)
4. 验证码修复 + 基础设置扩展    (后端, 依赖1)
5. 审计日志工具函数             (后端, 依赖1)
6. 前端: AdminLayout 导航更新   (前端, 依赖1)
7. 前端: 仪表盘页面             (前端, 依赖2)
8. 前端: 等级管理重写 + 星级组件 (前端, 依赖2)
9. 前端: 签到/动态/预设/话题页面 (前端, 依赖3)
10. 前端: LevelPage 规则同步     (前端, 依赖2)
11. 前端: BannerSelectPage 改造  (前端, 依赖3)
12. 前端: 基础设置扩展           (前端, 依赖4)
```
