require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const pool = require('./config/db');
const { globalLimiter } = require('./middleware/rateLimiter');
const cryptoUtils = require('./utils/crypto');
const walletUtils = require('./utils/wallet');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const contactsRoutes = require('./routes/contacts');
const messagesRoutes = require('./routes/messages');
const groupsRoutes = require('./routes/groups');
const favoritesRoutes = require('./routes/favorites');
const albumRoutes = require('./routes/album');
const setupSocket = require('./socket');

// 启动时自动建表
async function initDatabase() {
  try {
    await pool.execute(`CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(255) NOT NULL UNIQUE,
      nickname VARCHAR(50) DEFAULT '',
      avatar VARCHAR(255) DEFAULT '/uploads/public/default-avatar.svg',
      gender TINYINT DEFAULT 0,
      weight DECIMAL(5,1) DEFAULT NULL,
      height DECIMAL(5,1) DEFAULT NULL,
      birthday DATE DEFAULT NULL,
      coins INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) AUTO_INCREMENT = 10000`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS sms_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(20) NOT NULL,
      code VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_phone (phone)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS email_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      code VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_email (email)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS friend_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      from_user_id INT NOT NULL,
      to_user_id INT NOT NULL,
      message VARCHAR(200) DEFAULT '',
      status TINYINT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_to_user (to_user_id, status),
      INDEX idx_from_user (from_user_id)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      friend_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_friend (user_id, friend_id),
      INDEX idx_user (user_id),
      INDEX idx_friend (friend_id)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      sender_id INT NOT NULL,
      receiver_id INT NOT NULL,
      content TEXT NOT NULL,
      type VARCHAR(10) DEFAULT 'text',
      is_read TINYINT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_conversation (sender_id, receiver_id, created_at),
      INDEX idx_receiver_unread (receiver_id, is_read)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS sign_in_records (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      sign_date DATE NOT NULL,
      exp_gained INT DEFAULT 10,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_date (user_id, sign_date)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS follows (
      id INT AUTO_INCREMENT PRIMARY KEY,
      follower_id INT NOT NULL,
      following_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_follow (follower_id, following_id)
    )`);

    // 群聊相关表
    await pool.execute(`CREATE TABLE IF NOT EXISTS \`groups\` (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      avatar VARCHAR(255) DEFAULT '/uploads/public/default-group.png',
      owner_id INT NOT NULL,
      notice VARCHAR(500) DEFAULT '',
      max_members INT DEFAULT 200,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS group_members (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      group_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      role ENUM('owner','admin','member') DEFAULT 'member',
      nickname VARCHAR(50) DEFAULT NULL,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_group_user (group_id, user_id),
      INDEX idx_user_groups (user_id)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS group_messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      group_id BIGINT NOT NULL,
      sender_id INT NOT NULL,
      content TEXT NOT NULL,
      type VARCHAR(10) DEFAULT 'text',
      is_recalled TINYINT DEFAULT 0,
      reply_to BIGINT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_group_time (group_id, created_at)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS group_requests (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      group_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      message VARCHAR(200) DEFAULT '',
      status TINYINT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_group_status (group_id, status)
    )`);

    // 群公告表
    await pool.execute(`CREATE TABLE IF NOT EXISTS group_notices (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      group_id BIGINT NOT NULL,
      author_id INT NOT NULL,
      content TEXT NOT NULL,
      is_broadcast TINYINT DEFAULT 0 COMMENT '1=播报',
      read_count INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_group (group_id, created_at)
    )`);
    try { await pool.execute("ALTER TABLE group_notices ADD COLUMN images TEXT NULL COMMENT 'JSON array of image URLs'"); } catch(e) {}
    try { await pool.execute("ALTER TABLE group_notices ADD COLUMN title VARCHAR(200) DEFAULT '' COMMENT '公告标题'"); } catch(e) {}
    await pool.execute(`CREATE TABLE IF NOT EXISTS group_notice_reads (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      notice_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_notice_user (notice_id, user_id)
    )`);

    // 群组新增字段
    try { await pool.execute("ALTER TABLE `groups` ADD COLUMN join_type TINYINT DEFAULT 0 COMMENT '0=直接加入,1=需审批'"); } catch(e) {}
    try { await pool.execute("ALTER TABLE `groups` ADD COLUMN description VARCHAR(500) DEFAULT ''"); } catch(e) {}
    try { await pool.execute("ALTER TABLE `groups` ADD COLUMN tags VARCHAR(500) DEFAULT '[]'"); } catch(e) {}
    try { await pool.execute("ALTER TABLE `groups` ADD COLUMN is_system TINYINT DEFAULT 0 COMMENT '0=普通群,1=系统群'"); } catch(e) {}
    try { await pool.execute("ALTER TABLE `groups` ADD COLUMN system_mode VARCHAR(10) DEFAULT NULL COMMENT 'all=全员群,selected=指定用户群'"); } catch(e) {}
    // 清理系统群中的通知机器人
    try { await pool.execute("DELETE gm FROM group_members gm JOIN `groups` g ON g.id = gm.group_id WHERE g.is_system = 1 AND gm.user_id = 9999"); } catch(e) {}
    // 群消息未读数
    try { await pool.execute("ALTER TABLE group_members ADD COLUMN last_read_msg_id BIGINT DEFAULT 0"); } catch(e) {}

    // 新增用户字段（已存在则忽略）
    try { await pool.execute('ALTER TABLE users ADD COLUMN password VARCHAR(255) DEFAULT NULL'); } catch(e) {}
    try { await pool.execute('ALTER TABLE users ADD COLUMN level INT DEFAULT 1'); } catch(e) {}
    try { await pool.execute('ALTER TABLE users ADD COLUMN exp INT DEFAULT 0'); } catch(e) {}
    // 修复已有用户level=0的情况，统一设为1
    try { await pool.execute('UPDATE users SET level = 1 WHERE level = 0 OR level IS NULL'); } catch(e) {}
    try { await pool.execute('ALTER TABLE users ADD COLUMN followers INT DEFAULT 0'); } catch(e) {}
    try { await pool.execute('ALTER TABLE users ADD COLUMN following INT DEFAULT 0'); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN signature VARCHAR(200) DEFAULT ''"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN tags VARCHAR(500) DEFAULT '[]'"); } catch(e) {}
    try { await pool.execute('ALTER TABLE users ADD COLUMN privacy TEXT'); } catch(e) {}
    try { await pool.execute('ALTER TABLE users ADD COLUMN last_seen DATETIME DEFAULT NULL'); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN hide_online_status TINYINT DEFAULT 0"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN email VARCHAR(255) DEFAULT NULL AFTER phone"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users MODIFY phone VARCHAR(255) NULL"); } catch(e) {}
    try { await pool.execute('ALTER TABLE messages ADD COLUMN is_recalled TINYINT DEFAULT 0'); } catch(e) {}
    try { await pool.execute('ALTER TABLE messages ADD COLUMN reply_to BIGINT DEFAULT NULL'); } catch(e) {}

    // 会话设置表（置顶、免打扰）
    await pool.execute(`CREATE TABLE IF NOT EXISTS conversation_settings (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      target_id BIGINT NOT NULL COMMENT '对方用户ID或群ID',
      type ENUM('private','group') NOT NULL DEFAULT 'private',
      is_pinned TINYINT DEFAULT 0,
      is_muted TINYINT DEFAULT 0,
      pinned_at DATETIME DEFAULT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_target (user_id, target_id, type),
      INDEX idx_user_pinned (user_id, is_pinned)
    )`);

    // @提及持久化表
    await pool.execute(`CREATE TABLE IF NOT EXISTS group_mentions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      group_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      msg_id BIGINT NOT NULL,
      is_cleared TINYINT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_group_user_msg (group_id, user_id, msg_id),
      INDEX idx_user_cleared (user_id, is_cleared)
    )`);

    // 群成员禁言表
    await pool.execute(`CREATE TABLE IF NOT EXISTS group_member_mutes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      group_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      muted_by INT NOT NULL,
      muted_until DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_group_user (group_id, user_id)
    )`);

    // 消息经验记录表：每天一行，cnt 记录当天已获经验次数（上限50）
    await pool.execute(`CREATE TABLE IF NOT EXISTS message_exp_records (
      user_id INT NOT NULL,
      record_date DATE NOT NULL,
      cnt INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, record_date)
    )`);
    // 迁移旧表结构：若旧表是多行设计，合并为计数列
    try { await pool.execute('ALTER TABLE message_exp_records ADD COLUMN cnt INT NOT NULL DEFAULT 0'); } catch(e) {}
    try { await pool.execute('ALTER TABLE message_exp_records DROP PRIMARY KEY'); } catch(e) {}
    try { await pool.execute('ALTER TABLE message_exp_records DROP COLUMN id'); } catch(e) {}
    try { await pool.execute('ALTER TABLE message_exp_records ADD PRIMARY KEY (user_id, record_date)'); } catch(e) {}
    // 将旧的多行数据合并成计数（如果 cnt 全为0说明是旧数据）
    try {
      await pool.execute(`
        UPDATE message_exp_records mer
        JOIN (
          SELECT user_id, record_date, COUNT(*) as c
          FROM message_exp_records
          WHERE cnt = 0
          GROUP BY user_id, record_date
          HAVING c > 1
        ) sub ON mer.user_id = sub.user_id AND mer.record_date = sub.record_date
        SET mer.cnt = sub.c
      `);
    } catch(e) {}

    await pool.execute(`CREATE TABLE IF NOT EXISTS favorites (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      msg_id BIGINT NOT NULL,
      msg_type ENUM('private','group') NOT NULL,
      sender_id INT NOT NULL,
      sender_nickname VARCHAR(50) DEFAULT '',
      sender_avatar VARCHAR(255) DEFAULT '',
      content TEXT NOT NULL,
      content_type VARCHAR(10) DEFAULT 'text',
      msg_created_at DATETIME,
      source_name VARCHAR(100) DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_msg (user_id, msg_id, msg_type),
      INDEX idx_user (user_id)
    )`);

    try { await pool.execute("ALTER TABLE favorites ADD COLUMN source_name VARCHAR(100) DEFAULT ''"); } catch(e) {}
    try { await pool.execute("UPDATE users SET signature = '这个人很懒，什么都没写~' WHERE signature IS NULL OR signature = ''"); } catch(e) {}

    // 相册表
    await pool.execute(`CREATE TABLE IF NOT EXISTS photo_albums (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(30) NOT NULL,
      cover VARCHAR(255) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id)
    )`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS album_photos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      album_id INT NOT NULL,
      user_id INT NOT NULL,
      url VARCHAR(255) NOT NULL,
      caption VARCHAR(100) DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_album (album_id),
      INDEX idx_user (user_id)
    )`);
    try { await pool.execute("ALTER TABLE photo_albums ADD COLUMN carousel_photos TEXT DEFAULT NULL"); } catch(e) {}

    // 相册收藏表
    await pool.execute(`CREATE TABLE IF NOT EXISTS album_favorites (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      album_id INT NOT NULL,
      album_owner_id INT NOT NULL,
      album_name VARCHAR(30) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_album (user_id, album_id),
      INDEX idx_user (user_id)
    )`);

    // 相册权限字段
    try { await pool.execute("ALTER TABLE photo_albums ADD COLUMN visibility ENUM('public','friends','private') DEFAULT 'public'"); } catch(e) {}

    // 相册评论表
    await pool.execute(`CREATE TABLE IF NOT EXISTS album_comments (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      album_id INT NOT NULL,
      user_id INT NOT NULL,
      content VARCHAR(200) NOT NULL,
      reply_to BIGINT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_album (album_id, created_at),
      INDEX idx_user (user_id)
    )`);

    // 创建系统通知机器人（ID=9999，所有环境）
    try {
      await pool.execute(
        "INSERT IGNORE INTO users (id, phone, nickname, avatar, signature, level, exp) VALUES (9999, 'system_bot_9999', '系统通知', '/uploads/public/system-bot-avatar.svg', '系统消息助手', 99, 9999)"
      );
      await pool.execute("UPDATE users SET avatar = '/uploads/public/system-bot-avatar.svg' WHERE id = 9999");
      await pool.execute('INSERT IGNORE INTO contacts (user_id, friend_id) SELECT id, 9999 FROM users WHERE id != 9999');
      await pool.execute('INSERT IGNORE INTO contacts (user_id, friend_id) SELECT 9999, id FROM users WHERE id != 9999');
    } catch(e) { console.error('[DB] 系统机器人初始化失败:', e.message); }

    // 创建测试用户（仅开发环境）
    if (process.env.NODE_ENV !== 'production') {
      const bcrypt = require('bcryptjs');
      const testPwd = await bcrypt.hash('123456', 10);
      try {
        await pool.execute(
          "INSERT IGNORE INTO users (id, phone, nickname, password, gender, coins, level, exp) VALUES (10001, '13800000001', '测试用户A', ?, 1, 100, 2, 230)",
          [testPwd]
        );
        await pool.execute(
          "INSERT IGNORE INTO users (id, phone, nickname, password, gender, coins, level, exp) VALUES (10002, '13800000002', '测试用户B', ?, 2, 50, 1, 80)",
          [testPwd]
        );
        await pool.execute(
          "INSERT IGNORE INTO users (id, phone, nickname, password, gender, coins, level, exp) VALUES (10003, '13800000003', '测试用户c', ?, 3, 500, 51, 500)",
          [testPwd]
        );
        console.log('[DB] 测试用户已就绪（开发环境）');
      } catch(e) {}
    }

    // 系统设置表
    await pool.execute(`CREATE TABLE IF NOT EXISTS system_settings (
      \`key\` VARCHAR(50) PRIMARY KEY,
      \`value\` VARCHAR(500) NOT NULL DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    // 默认系统名称
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('system_name', 'AZ-Chat')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('system_logo', '/logo.png')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('exp_signin', '10')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('exp_message', '2')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('exp_add_friend', '5')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('exp_message_daily_limit', '50')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('captcha_length', '4')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('captcha_include_alpha', '0')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('captcha_type', 'text')");
    // 等级经验开关默认值（全部启用）
    for (const k of ['exp_signin_enabled','exp_message_enabled','exp_group_message_enabled','exp_moment_enabled','exp_comment_enabled','exp_like_enabled','exp_follow_enabled','exp_add_friend_enabled']) {
      await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES (?, '1')", [k]);
    }

    // 用户表新增字段 & 扩大加密字段
    try { await pool.execute("ALTER TABLE users MODIFY phone VARCHAR(255) NULL"); } catch(e) {}
    try { await pool.execute("ALTER TABLE sms_codes MODIFY code VARCHAR(64) NOT NULL"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN role ENUM('admin','user') DEFAULT 'user'"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN is_banned TINYINT DEFAULT 0"); } catch(e) {}
    // 群组表新增封禁字段
    try { await pool.execute("ALTER TABLE `groups` ADD COLUMN is_banned TINYINT DEFAULT 0"); } catch(e) {}
    // 设置默认管理员（从 .env 读取，每次启动同步）
    const defaultAdminId = parseInt(process.env.DEFAULT_ADMIN_ID || '10000');
    try { await pool.execute("UPDATE users SET role = 'admin' WHERE id = ?", [defaultAdminId]); } catch(e) {}

    try { await pool.execute("ALTER TABLE users ADD COLUMN fcm_token VARCHAR(255) DEFAULT NULL"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN banner_type VARCHAR(20) DEFAULT 'default'"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN banner_preset VARCHAR(50) DEFAULT NULL"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN banner_image VARCHAR(500) DEFAULT NULL"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN banner_custom_urls TEXT DEFAULT NULL"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN lv30_style VARCHAR(20) DEFAULT 'original'"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN chat_style VARCHAR(32) DEFAULT 'latte'"); } catch(e) {}

    // 动态模块表
    await pool.execute(`CREATE TABLE IF NOT EXISTS moments (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      content VARCHAR(500) DEFAULT '',
      images TEXT,
      audio_url VARCHAR(255) DEFAULT NULL,
      audio_duration INT DEFAULT 0 COMMENT 'seconds',
      location VARCHAR(100) DEFAULT '',
      visibility ENUM('public','friends','private') DEFAULT 'public',
      topic_name VARCHAR(50) DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_time (user_id, created_at),
      INDEX idx_topic (topic_name, created_at)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS moment_likes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      moment_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_moment_user (moment_id, user_id),
      INDEX idx_moment (moment_id),
      INDEX idx_user (user_id)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS moment_comments (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      moment_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      content VARCHAR(200) NOT NULL,
      reply_to BIGINT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_moment (moment_id, created_at),
      INDEX idx_user (user_id)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS moment_topics (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL UNIQUE,
      cover_image VARCHAR(255) DEFAULT '/images/topic-covers/default.jpg',
      description VARCHAR(500) DEFAULT '',
      usage_count INT DEFAULT 0,
      status ENUM('new','active','hot') DEFAULT 'new',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_usage (usage_count DESC),
      INDEX idx_status (status)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS moment_notifications (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      owner_id INT NOT NULL,
      from_user_id INT NOT NULL,
      type ENUM('like','comment','follow','mention','favorite') NOT NULL,
      moment_id BIGINT DEFAULT NULL,
      comment_id BIGINT DEFAULT NULL,
      is_read TINYINT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_owner_read (owner_id, is_read, created_at),
      INDEX idx_owner (owner_id, created_at)
    )`);

    await pool.execute(`CREATE TABLE IF NOT EXISTS moment_favorites (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      moment_id BIGINT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_moment (user_id, moment_id),
      INDEX idx_user (user_id),
      INDEX idx_moment (moment_id)
    )`);

    // 预设默认话题（使用素材封面），使用量从0开始，靠真实用户积累
    const defaultTopics = [
      { name: '咖啡馆探店', cover: '/uploads/topic-covers/coffee-shop.jpg', desc: '城市角落的宝藏咖啡，等你来发现和分享' },
      { name: '电影安利', cover: '/uploads/topic-covers/movie.jpg', desc: '好片值得被更多人看到' },
      { name: '美食分享', cover: '/uploads/topic-covers/food.jpg', desc: '吃货的幸福就是分享美味时刻' },
      { name: '春日穿搭', cover: '/uploads/topic-covers/fashion.jpg', desc: '每天都要好好穿，记录你的时尚灵感' },
      { name: '读书笔记', cover: '/uploads/topic-covers/books.jpg', desc: '书中自有黄金屋，分享你的阅读感悟' },
      { name: '音乐日常', cover: '/uploads/topic-covers/music.jpg', desc: '耳机里的世界，今天在听什么？' },
      { name: '旅行日记', cover: '/uploads/topic-covers/travel.jpg', desc: '世界那么大，一起去看看' },
      { name: '运动打卡', cover: '/uploads/topic-covers/sports.jpg', desc: '自律即自由，记录每一次突破' },
    ];
    for (const t of defaultTopics) {
      await pool.execute(
        "INSERT INTO moment_topics (name, cover_image, description, status) VALUES (?, ?, ?, 'active') ON DUPLICATE KEY UPDATE cover_image = VALUES(cover_image), description = VALUES(description), usage_count = 0, status = 'active'",
        [t.name, t.cover, t.desc]);
    }

    // 相册未读通知表
    await pool.execute(`CREATE TABLE IF NOT EXISTS album_notifications (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      owner_id INT NOT NULL,
      album_id INT NOT NULL,
      type ENUM('comment','favorite') NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_owner (owner_id)
    )`);

    // 每日关注经验记录（防刷）
    await pool.execute(`CREATE TABLE IF NOT EXISTS follow_exp_records (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      record_date DATE NOT NULL,
      target_id INT NOT NULL,
      UNIQUE KEY uk_user_date (user_id, record_date)
    )`);

    // 关注动态未读数表
    await pool.execute(`CREATE TABLE IF NOT EXISTS follow_feed_unread (
      user_id INT PRIMARY KEY,
      unread_count INT DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);

    // Refresh Token 表（JWT 强化）
    await pool.execute(`CREATE TABLE IF NOT EXISTS refresh_tokens (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      family VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT NOW(),
      INDEX idx_user (user_id),
      INDEX idx_family (family),
      INDEX idx_expires (expires_at)
    )`);

    // 等级规则表（每级配置）
    await pool.execute(`CREATE TABLE IF NOT EXISTS level_config (
      level INT PRIMARY KEY,
      name VARCHAR(20) DEFAULT '',
      exp_required INT DEFAULT 100,
      coin_reward INT DEFAULT 2
    )`);
    // 默认填充 1-99 级
    const [[{ cnt: lcCnt }]] = await pool.execute('SELECT COUNT(*) as cnt FROM level_config');
    if (lcCnt === 0) {
      for (let i = 1; i <= 99; i++) {
        await pool.execute('INSERT IGNORE INTO level_config (level, exp_required, coin_reward) VALUES (?, 100, 2)', [i]);
      }
      console.log('[DB] level_config 1-99 级默认数据已填充');
    }

    // 签到连续奖励表
    await pool.execute(`CREATE TABLE IF NOT EXISTS signin_config (
      id INT PRIMARY KEY AUTO_INCREMENT,
      streak_days INT NOT NULL UNIQUE,
      bonus_coins INT DEFAULT 0
    )`);
    const [[{ cnt: scCnt }]] = await pool.execute('SELECT COUNT(*) as cnt FROM signin_config');
    if (scCnt === 0) {
      await pool.execute("INSERT IGNORE INTO signin_config (streak_days, bonus_coins) VALUES (3,2),(7,5),(14,10),(30,25)");
      console.log('[DB] signin_config 默认数据已填充');
    }

    // 预设背景表
    await pool.execute(`CREATE TABLE IF NOT EXISTS banner_presets (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(30) NOT NULL,
      image_url VARCHAR(255),
      animation_type VARCHAR(20) DEFAULT 'default',
      is_active TINYINT DEFAULT 1,
      sort_order INT DEFAULT 0
    )`);
    // 迁移现有硬编码预设
    const presets = [
      ['sunrise', 'sunrise', 1], ['mountain', 'mountain', 2], ['flow', 'flow', 3],
      ['starry', 'starry', 4], ['sakura', 'sakura', 5], ['forest', 'forest', 6],
    ];
    for (const [name, type, order] of presets) {
      await pool.execute(
        'INSERT IGNORE INTO banner_presets (name, animation_type, sort_order) VALUES (?, ?, ?)',
        [name, type, order]
      );
    }

    // 金币交易审计表（防篡改）
    await pool.execute(`CREATE TABLE IF NOT EXISTS coin_transactions (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      amount INT NOT NULL,
      balance_before INT NOT NULL,
      balance_after INT NOT NULL,
      reason VARCHAR(50) NOT NULL,
      detail TEXT,
      created_at DATETIME DEFAULT NOW(),
      INDEX idx_user (user_id, created_at),
      INDEX idx_reason (reason)
    )`);

    // 管理员操作审计
    await pool.execute(`CREATE TABLE IF NOT EXISTS admin_logs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      admin_id INT NOT NULL,
      action VARCHAR(50) NOT NULL,
      target_type VARCHAR(30),
      target_id VARCHAR(50),
      detail TEXT,
      ip VARCHAR(45),
      created_at DATETIME DEFAULT NOW(),
      INDEX idx_admin (admin_id, created_at)
    )`);

    // 用户表新增字段
    // 扩大加密字段（原 INT 放不下 base64）
    try { await pool.execute("ALTER TABLE users MODIFY coins VARCHAR(255) NOT NULL DEFAULT '0'"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users MODIFY exp VARCHAR(255) NOT NULL DEFAULT '0'"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users MODIFY level VARCHAR(255) NOT NULL DEFAULT '1'"); } catch(e) {}
    try { await pool.execute("ALTER TABLE users ADD COLUMN last_login DATETIME"); } catch(e) {}

    // 系统设置新增键
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('reg_enabled', '1')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('maintenance_msg', '')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('default_avatar', '/uploads/public/default-avatar.svg')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('default_group_avatar', '/uploads/public/default-group.png')");
    // 多登录方式配置
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('login_method_password', '1')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('login_method_phone', '0')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('login_method_email', '0')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('sms_template_id', '')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('sms_template_url', '')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('sms_code_length', '6')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('sms_code_expire', '300')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('smtp_host', '')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('smtp_port', '587')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('smtp_user', '')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('smtp_pass', '')");
    await pool.execute("INSERT IGNORE INTO system_settings (`key`, `value`) VALUES ('smtp_from', '')");

    console.log('[DB] 数据库表初始化完成');
  } catch (err) {
    console.error('[DB] 建表失败:', err.message);
  }
}

initDatabase();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: (origin, callback) => callback(null, origin || '*'), methods: ['GET', 'POST'], credentials: true }
});

const onlineUsers = new Map();

app.set('io', io);
app.set('onlineUsers', onlineUsers);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: (origin, callback) => {
    callback(null, origin || '*');
  },
  credentials: true,
}));

app.use('/api', globalLimiter);

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const requestPath = req.path.replace(/^[\/\\]+/, '');
  const fullPath = path.join(__dirname, 'uploads', requestPath);

  // 文件存在 → 正常服务
  if (fs.existsSync(fullPath)) return next();

  const basename = path.basename(requestPath);
  const subs = ['avatars', 'messages', 'groups', 'moments', 'albums', 'banners'];

  // 旧路径 (avatar_xxx.png) → 在 private/ 子目录中查找(文件已被迁移)
  if (!requestPath.includes('/')) {
    for (const sub of subs) {
      const altPath = path.join(__dirname, 'uploads', 'private', sub, basename);
      if (fs.existsSync(altPath)) {
        return res.sendFile(altPath);
      }
    }
  }

  // 新路径 (private/xxx/file.png) → 在 uploads/ 根目录查找(文件尚未迁移)
  if (requestPath.startsWith('private/')) {
    const rootPath = path.join(__dirname, 'uploads', basename);
    if (fs.existsSync(rootPath)) {
      return res.sendFile(rootPath);
    }
  }

  next();
}, express.static(path.join(__dirname, 'uploads')));

app.get('/uploads/public/default-avatar.svg', (req, res) => {
  res.sendFile(path.join(__dirname, 'uploads/public/default-avatar.svg'));
});
app.get('/uploads/public/default-group.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'uploads/public/default-group.png'));
});

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/album', albumRoutes);

const albumFavRoutes = require('./routes/albumFavorites');
app.use('/api/album-favorites', albumFavRoutes);

const albumCommentRoutes = require('./routes/albumComments');
app.use('/api/album-comments', albumCommentRoutes);

const momentsRoutes = require('./routes/moments');
app.use('/api/moments', momentsRoutes);

const adminRoutes = require('./routes/admin');
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => {
  res.json({ code: 0, message: 'AZ-Chat 后端运行中', time: new Date().toISOString() });
});

// Debug 接口已移除

setupSocket(io, onlineUsers);

// 定时清理过期禁言（每60秒）
setInterval(async () => {
  try {
    const [result] = await pool.execute('DELETE FROM group_member_mutes WHERE muted_until IS NOT NULL AND muted_until < NOW()');
    if (result.affectedRows > 0) console.log(`[Mute-Cleanup] 清理了 ${result.affectedRows} 条过期禁言`);
  } catch (e) { /* ignore */ }
}, 60000);

const PORT = process.env.PORT || 5001;

// 加密自检和数据迁移
(async () => {
  const masterKey = process.env.MASTER_KEY;
  if (masterKey && masterKey.length === 64) {
    cryptoUtils.selfTest(masterKey);
    // 确保加密字段列够宽（必须在迁移前执行）
    await pool.execute("ALTER TABLE users MODIFY coins VARCHAR(255) NOT NULL DEFAULT '0'").catch(() => {});
    await pool.execute("ALTER TABLE users MODIFY exp VARCHAR(255) NOT NULL DEFAULT '0'").catch(() => {});
    await pool.execute("ALTER TABLE users MODIFY level VARCHAR(255) NOT NULL DEFAULT '1'").catch(() => {});
    await cryptoUtils.runMigrations(pool, masterKey);
    await walletUtils.migrateWallet(pool);
  } else {
    console.warn('[Crypto] ⚠️  MASTER_KEY 未设置或不是64位十六进制，加密功能禁用');
  }

  // 文件存储结构迁移
  const upDir = path.join(__dirname, 'uploads');
  const pubDir = path.join(upDir, 'public');
  const privDir = path.join(upDir, 'private');
  const sysDir = path.join(upDir, 'system');
  [pubDir, privDir, sysDir].forEach(d => { fs.mkdirSync(d, { recursive: true }); });
  ['avatars', 'messages', 'groups', 'moments', 'albums', 'banners'].forEach(sub => {
    fs.mkdirSync(path.join(privDir, sub), { recursive: true });
  });

  // 移动默认资源到 public/
  const moves = [
    ['default-avatar.svg', 'public/default-avatar.svg'],
    ['default-group.png', 'public/default-group.png'],
    ['system-bot-avatar.svg', 'public/system-bot-avatar.svg'],
  ];
  moves.forEach(([from, to]) => {
    const src = path.join(upDir, from);
    const dst = path.join(upDir, to);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.renameSync(src, dst);
      console.log(`[Files] 迁移: ${from} → ${to}`);
    }
  });

  // 迁移 topic-covers 到 public/
  const tcSrc = path.join(upDir, 'topic-covers');
  const tcDst = path.join(pubDir, 'topic-covers');
  if (fs.existsSync(tcSrc) && !fs.existsSync(tcDst)) {
    fs.mkdirSync(tcDst, { recursive: true });
    fs.readdirSync(tcSrc).forEach(f => {
      const from = path.join(tcSrc, f);
      const to = path.join(tcDst, f);
      if (fs.statSync(from).isFile()) fs.renameSync(from, to);
    });
    fs.rmdirSync(tcSrc);
    console.log('[Files] 迁移: topic-covers/ → public/topic-covers/');
  }

  // 迁移用户上传文件: 从 uploads/ 根目录 → uploads/private/<subdir>/
  const fileCategoryMap = [
    { prefix: 'avatar_', sub: 'avatars' },
    { prefix: 'msg_', sub: 'messages' },
    { prefix: 'group_', sub: 'groups' },
    { prefix: 'moment_', sub: 'moments' },
    { prefix: 'album_', sub: 'albums' },
    { prefix: 'banner_', sub: 'banners' },
  ];
  let migratedCount = 0;
  fs.readdirSync(upDir).forEach(f => {
    const src = path.join(upDir, f);
    if (!fs.statSync(src).isFile()) return;
    for (const { prefix, sub } of fileCategoryMap) {
      if (f.startsWith(prefix)) {
        const dst = path.join(privDir, sub, f);
        if (!fs.existsSync(dst)) {
          fs.renameSync(src, dst);
          migratedCount++;
        }
        break;
      }
    }
  });
  if (migratedCount > 0) console.log('[Files] 迁移 ' + migratedCount + ' 个用户文件到 private/ 子目录');

  console.log('[Files] 文件存储结构初始化完成');
})().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[AZ-Chat] 后端服务启动在 http://0.0.0.0:${PORT}`);
  });
});

// 媒体签名访问
const mediaSecret = process.env.MASTER_KEY || 'media_fallback_secret';
app.get('/api/media', (req, res) => {
  const filepath = req.query.path;
  if (!filepath) return res.status(400).json({ code: 400, message: '缺少路径参数' });
  // 安全检查：防止路径穿越
  let normalized = path.normalize(filepath).replace(/^(\.\.[\/\\])+/, '').replace(/^[\/\\]+/, '');
  if (normalized.startsWith('uploads/') || normalized.startsWith('uploads\\')) normalized = normalized.slice(8);
  const fullPath = path.join(__dirname, 'uploads', normalized);
  if (!fullPath.startsWith(path.join(__dirname, 'uploads'))) {
    return res.status(403).json({ code: 403, message: '非法路径' });
  }
  if (!fs.existsSync(fullPath)) {
    // 回退检查: 尝试在 uploads/ 根目录查找同名文件(旧路径兼容)
    const basename = path.basename(normalized);
    const rootPath = path.join(__dirname, 'uploads', basename);
    if (basename !== normalized && fs.existsSync(rootPath)) {
      return res.sendFile(rootPath);
    }
    return res.status(404).json({ code: 404, message: '文件不存在' });
  }
  res.sendFile(fullPath);
});

// 旧路径兼容重定向 → 新路径
app.get('/default-avatar.png', (req, res) => res.redirect('/uploads/public/default-avatar.svg'));
app.get('/default-group.png', (req, res) => res.redirect('/uploads/public/default-group.png'));
app.get('/uploads/default-avatar.svg', (req, res) => res.redirect('/uploads/public/default-avatar.svg'));
app.get('/uploads/default-group.png', (req, res) => res.redirect('/uploads/public/default-group.png'));
app.get('/uploads/system-bot-avatar.svg', (req, res) => res.redirect('/uploads/public/system-bot-avatar.svg'));
app.get('/uploads/topic-covers/:name', (req, res) => res.redirect(`/uploads/public/topic-covers/${req.params.name}`));
