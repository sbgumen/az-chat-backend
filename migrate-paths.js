/**
 * 修复因路径缺少子目录导致的破损图片/音频记录
 * 将 /uploads/xxx.ext 修正为 /uploads/private/<dir>/xxx.ext
 * 用法: node migrate-paths.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, 'uploads', 'private');

// 扫描 private/ 下所有文件
function scanFiles() {
  const map = {}; // filename → relativePath
  const dirs = fs.readdirSync(UPLOAD_DIR);
  for (const dir of dirs) {
    const dirPath = path.join(UPLOAD_DIR, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const files = fs.readdirSync(dirPath);
    for (const f of files) {
      map[f] = `private/${dir}/${f}`;
    }
  }
  return map;
}

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  console.log('扫描 uploads/private/ 目录...');
  const fileMap = scanFiles();
  console.log(`找到 ${Object.keys(fileMap).length} 个文件`);

  let totalFixed = 0;

  // 修复 users 表 avatar
  const [users] = await pool.query(
    "SELECT id, avatar FROM users WHERE avatar LIKE '/uploads/%' AND avatar NOT LIKE '/uploads/%/%'"
  );
  console.log(`头像需修复: ${users.length} 条`);
  for (const u of users) {
    const fname = path.basename(u.avatar);
    if (fileMap[fname]) {
      const newPath = `/uploads/${fileMap[fname]}`;
      await pool.execute('UPDATE users SET avatar = ? WHERE id = ?', [newPath, u.id]);
      console.log(`  [${u.id}] 头像: ${newPath}`);
      totalFixed++;
    }
  }

  // 修复 users 表 banner_image
  const [banners] = await pool.query(
    "SELECT id, banner_image FROM users WHERE banner_image LIKE '/uploads/%' AND banner_image NOT LIKE '/uploads/%/%'"
  );
  console.log(`Banner需修复: ${banners.length} 条`);
  for (const u of banners) {
    const fname = path.basename(u.banner_image);
    if (fileMap[fname]) {
      const newPath = `/uploads/${fileMap[fname]}`;
      await pool.execute('UPDATE users SET banner_image = ? WHERE id = ?', [newPath, u.id]);
      console.log(`  [${u.id}] Banner: ${newPath}`);
      totalFixed++;
    }
  }

  // 修复 moments 表 images
  const [moments] = await pool.query(
    "SELECT id, images FROM moments WHERE images LIKE '%/uploads/%' AND images NOT LIKE '%/uploads/%/%'"
  );
  console.log(`动态图片需修复: ${moments.length} 条`);
  for (const m of moments) {
    try {
      const imgs = JSON.parse(m.images || '[]');
      let changed = false;
      for (let i = 0; i < imgs.length; i++) {
        const fname = path.basename(imgs[i]);
        if (fileMap[fname]) {
          imgs[i] = `/uploads/${fileMap[fname]}`;
          changed = true;
        }
      }
      if (changed) {
        await pool.execute('UPDATE moments SET images = ? WHERE id = ?', [JSON.stringify(imgs), m.id]);
        console.log(`  [${m.id}] 动态: ${imgs.length} 张图片`);
        totalFixed++;
      }
    } catch {}
  }

  // 修复 moments 表 audio_url
  const [momentAudio] = await pool.query(
    "SELECT id, audio_url FROM moments WHERE audio_url LIKE '/uploads/%' AND audio_url NOT LIKE '/uploads/%/%' AND audio_url != ''"
  );
  console.log(`动态音频需修复: ${momentAudio.length} 条`);
  for (const m of momentAudio) {
    const fname = path.basename(m.audio_url);
    if (fileMap[fname]) {
      const newPath = `/uploads/${fileMap[fname]}`;
      await pool.execute('UPDATE moments SET audio_url = ? WHERE id = ?', [newPath, m.id]);
      console.log(`  [${m.id}] 动态音频: ${newPath}`);
      totalFixed++;
    }
  }

  console.log(`\n修复完成: ${totalFixed} 条`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
