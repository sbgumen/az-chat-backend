-- AZ-Chat 数据库初始化脚本
-- 创建数据库
CREATE DATABASE IF NOT EXISTS azchat DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE azchat;

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL UNIQUE,
  nickname VARCHAR(50) DEFAULT '',
  avatar VARCHAR(255) DEFAULT '/default-avatar.png',
  gender TINYINT DEFAULT 0 COMMENT '0未知 1男 2女',
  weight DECIMAL(5,1) DEFAULT NULL,
  height DECIMAL(5,1) DEFAULT NULL,
  birthday DATE DEFAULT NULL,
  coins INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) AUTO_INCREMENT = 10000;

-- 验证码表
CREATE TABLE IF NOT EXISTS sms_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  code VARCHAR(6) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_phone (phone)
);

-- 好友申请表
CREATE TABLE IF NOT EXISTS friend_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  from_user_id INT NOT NULL,
  to_user_id INT NOT NULL,
  message VARCHAR(200) DEFAULT '',
  status TINYINT DEFAULT 0 COMMENT '0待处理 1已通过 2已拒绝',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_to_user (to_user_id, status),
  INDEX idx_from_user (from_user_id)
);

-- 联系人关系表
CREATE TABLE IF NOT EXISTS contacts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  friend_id INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_friend (user_id, friend_id),
  INDEX idx_user (user_id),
  INDEX idx_friend (friend_id)
);

-- 等级/经验相关字段（ALTER，如已存在则忽略）
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS level INT DEFAULT 1;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS exp INT DEFAULT 0;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS signature VARCHAR(200) DEFAULT '';
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT NULL;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy TEXT DEFAULT NULL;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS followers INT DEFAULT 0;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS following INT DEFAULT 0;

-- 签到记录表
CREATE TABLE IF NOT EXISTS sign_in_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  sign_date DATE NOT NULL,
  exp_gained INT DEFAULT 10,
  UNIQUE KEY uk_user_date (user_id, sign_date),
  INDEX idx_user (user_id)
);

-- 关注表
CREATE TABLE IF NOT EXISTS follows (
  id INT AUTO_INCREMENT PRIMARY KEY,
  follower_id INT NOT NULL,
  following_id INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_follow (follower_id, following_id)
);

-- 发消息经验记录（每天上限50）
CREATE TABLE IF NOT EXISTS message_exp_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  record_date DATE NOT NULL,
  INDEX idx_user_date (user_id, record_date)
);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  sender_id INT NOT NULL,
  receiver_id INT NOT NULL,
  content TEXT NOT NULL,
  type VARCHAR(10) DEFAULT 'text' COMMENT 'text/image',
  is_read TINYINT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conversation (sender_id, receiver_id, created_at),
  INDEX idx_receiver_unread (receiver_id, is_read)
);
