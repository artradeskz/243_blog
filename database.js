// database.js - НОВАЯ ВЕРСИЯ
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = new Database('blog.db');
const ARTICLES_DIR = path.join(__dirname, 'articles');

// Создаем папку для статей, если не существует
if (!fs.existsSync(ARTICLES_DIR)) {
  fs.mkdirSync(ARTICLES_DIR, { recursive: true });
}

// Инициализация таблиц (ТОЛЬКО метаданные)
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL
  )
`);

// Вспомогательная функция для создания slug из заголовка
function createSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\u0400-\u04FF]+/g, '-') // Кириллица + латиница
    .replace(/^-+|-+$/g, '')
    .substring(0, 100);
}

// Создание папки статьи
function createArticleFolder(postId) {
  const articlePath = path.join(ARTICLES_DIR, postId.toString());
  if (!fs.existsSync(articlePath)) {
    fs.mkdirSync(articlePath, { recursive: true });
    // Создаем папку для ассетов
    fs.mkdirSync(path.join(articlePath, 'assets'), { recursive: true });
  }
  return articlePath;
}

// ============ ФУНКЦИИ ДЛЯ РАБОТЫ С СТАТЬЯМИ ============

function createPost(title, content) {
  // Начинаем транзакцию
  const transaction = db.transaction(() => {
    const slug = createSlug(title);
    
    // Сохраняем в БД
    const result = db.prepare(
      'INSERT INTO posts (title, slug, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
    ).run(title, slug);
    
    const postId = result.lastInsertRowid;
    
    // Создаем папку для статьи
    const articlePath = createArticleFolder(postId);
    
    // Сохраняем контент в HTML файл
    const contentPath = path.join(articlePath, 'content.html');
    fs.writeFileSync(contentPath, content, 'utf8');
    
    // Создаем info.json
    const info = {
      id: postId,
      title: title,
      slug: slug,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    const infoPath = path.join(articlePath, 'info.json');
    fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), 'utf8');
    
    return { id: postId, slug: slug, path: articlePath };
  });
  
  return transaction();
}

function updatePost(id, title, content) {
  const slug = createSlug(title);
  
  // Обновляем в БД
  db.prepare(
    'UPDATE posts SET title = ?, slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(title, slug, id);
  
  // Обновляем файлы
  const articlePath = path.join(ARTICLES_DIR, id.toString());
  
  // Обновляем content.html
  const contentPath = path.join(articlePath, 'content.html');
  fs.writeFileSync(contentPath, content, 'utf8');
  
  // Обновляем info.json
  const infoPath = path.join(articlePath, 'info.json');
  let info = {};
  
  if (fs.existsSync(infoPath)) {
    info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  }
  
  info.title = title;
  info.slug = slug;
  info.updated_at = new Date().toISOString();
  
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), 'utf8');
  
  return { id: id, slug: slug };
}

function deletePost(id) {
  // Удаляем из БД
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  
  // Удаляем папку статьи (рекурсивно)
  const articlePath = path.join(ARTICLES_DIR, id.toString());
  if (fs.existsSync(articlePath)) {
    fs.rmSync(articlePath, { recursive: true, force: true });
  }
  
  return { success: true };
}

function getAllPosts() {
  // Получаем все статьи из БД
  return db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all();
}

function getPostById(id) {
  // Получаем метаданные из БД
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  
  if (!post) return null;
  
  // Читаем контент из файла
  const contentPath = path.join(ARTICLES_DIR, id.toString(), 'content.html');
  
  if (fs.existsSync(contentPath)) {
    post.content = fs.readFileSync(contentPath, 'utf8');
  } else {
    post.content = '';
  }
  
  // Читаем info.json для дополнительных данных
  const infoPath = path.join(ARTICLES_DIR, id.toString(), 'info.json');
  if (fs.existsSync(infoPath)) {
    post.info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  }
  
  return post;
}

function getPostBySlug(slug) {
  // Находим ID по slug
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug);
  
  if (!post) return null;
  
  // Читаем контент из файла
  const contentPath = path.join(ARTICLES_DIR, post.id.toString(), 'content.html');
  
  if (fs.existsSync(contentPath)) {
    post.content = fs.readFileSync(contentPath, 'utf8');
  } else {
    post.content = '';
  }
  
  return post;
}

// Функция для загрузки изображения в assets статьи
function uploadImageToPost(postId, imageBuffer, filename) {
  const assetsPath = path.join(ARTICLES_DIR, postId.toString(), 'assets');
  
  // Создаем папку assets если не существует
  if (!fs.existsSync(assetsPath)) {
    fs.mkdirSync(assetsPath, { recursive: true });
  }
  
  // Генерируем уникальное имя файла
  const ext = path.extname(filename);
  const uniqueName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${ext}`;
  const filePath = path.join(assetsPath, uniqueName);
  
  // Сохраняем файл
  fs.writeFileSync(filePath, imageBuffer);
  
  // Возвращаем относительный путь для использования в HTML
  return `/api/article-asset/${postId}/${uniqueName}`;
}

// Функция для получения изображения статьи
function getArticleAsset(postId, filename) {
  const filePath = path.join(ARTICLES_DIR, postId.toString(), 'assets', filename);
  
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath);
  }
  
  return null;
}

// Функция восстановления БД из файлов (для миграции/восстановления)
function rebuildDatabaseFromFiles() {
  console.log('Восстановление БД из файлов...');
  
  // Очищаем таблицу posts (опционально)
  db.prepare('DELETE FROM posts').run();
  
  // Сканируем папку articles
  const articleFolders = fs.readdirSync(ARTICLES_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && /^\d+$/.test(dirent.name))
    .map(dirent => dirent.name);
  
  for (const folder of articleFolders) {
    const infoPath = path.join(ARTICLES_DIR, folder, 'info.json');
    
    if (fs.existsSync(infoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        
        // Вставляем в БД
        db.prepare(
          'INSERT OR REPLACE INTO posts (id, title, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).run(
          info.id,
          info.title,
          info.slug,
          info.created_at,
          info.updated_at
        );
        
        console.log(`Восстановлена статья: ${info.title} (ID: ${info.id})`);
      } catch (error) {
        console.error(`Ошибка при восстановлении статьи ${folder}:`, error);
      }
    }
  }
  
  console.log('Восстановление завершено.');
}

// Хеширование пароля (остается без изменений)
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// Функции для пользователей (без изменений)
function getUserCount() {
  const result = db.prepare('SELECT COUNT(*) as count FROM users').get();
  return result.count;
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
}

function createUser(username, passwordHash, salt) {
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)'
  ).run(username, passwordHash, salt);
  return { id: result.lastInsertRowid };
}

module.exports = {
  // Хеширование
  hashPassword,
  generateSalt,
  
  // Пользователи
  getUserCount,
  getUserByUsername,
  getUserById,
  createUser,
  
  // Статьи
  createPost,
  updatePost,
  deletePost,
  getAllPosts,
  getPostById,
  getPostBySlug,
  
  // Работа с изображениями
  uploadImageToPost,
  getArticleAsset,
  
  // Восстановление
  rebuildDatabaseFromFiles
};