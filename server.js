const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const db = require('./database.js');
const multer = require('multer'); // Для загрузки файлов

const app = express();
const PORT = 3000;

// Настройка multer для временного хранения загруженных файлов
const upload = multer({ dest: 'uploads/' });

// Создаем папку для временных загрузок, если не существует
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads', { recursive: true });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
  secret: 'super-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// Middleware: проверка авторизации
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  next();
}

// ============ МИДЛВЭЙР ПРОВЕРКИ АДМИНА ============
// Проверяем наличие админа при каждом запросе к главной
app.use('/', (req, res, next) => {
  // Не проверяем для API и статики
  if (req.path.startsWith('/api') || 
      req.path.startsWith('/login') || 
      req.path.startsWith('/setup') ||
      req.path.includes('.') ||
      req.path === '/') {
    return next();
  }
  
  const userCount = db.getUserCount();
  if (userCount === 0 && req.path !== '/setup.html') {
    return res.redirect('/setup.html');
  }
  next();
});

// ============ API ЭНДПОИНТЫ ============

// API: проверка, создан ли админ
app.get('/api/admin-exists', (req, res) => {
  const userCount = db.getUserCount();
  res.json({ adminExists: userCount > 0 });
});

// API: создание первого админа
app.post('/api/setup-admin', (req, res) => {
  const userCount = db.getUserCount();
  if (userCount > 0) {
    return res.status(403).json({ error: 'Админ уже существует' });
  }
  
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  
  const salt = db.generateSalt();
  const passwordHash = db.hashPassword(password, salt);
  
  try {
    db.createUser(username, passwordHash, salt);
    res.json({ success: true });
  } catch (e) {
    console.error('Ошибка создания админа:', e);
    res.status(400).json({ error: 'Ошибка создания' });
  }
});

// API: вход
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.getUserByUsername(username);
  
  if (!user) {
    return res.status(401).json({ error: 'Неверные данные' });
  }
  
  const hash = db.hashPassword(password, user.salt);
  if (hash === user.password_hash) {
    req.session.userId = user.id;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Неверные данные' });
  }
});

// API: выход
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// API: проверка статуса
app.get('/api/me', (req, res) => {
  if (req.session.userId) {
    const user = db.getUserById(req.session.userId);
    res.json({ user });
  } else {
    res.json({ user: null });
  }
});

// API: загрузка изображения для статьи
app.post('/api/upload-image/:postId', requireAuth, upload.single('image'), (req, res) => {
  try {
    const postId = req.params.postId;
    
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }
    
    // Проверяем размер файла (максимум 10MB)
    if (req.file.size > 10 * 1024 * 1024) {
      // Удаляем временный файл
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Размер файла не должен превышать 10MB' });
    }
    
    // Читаем загруженный файл
    const imageBuffer = fs.readFileSync(req.file.path);
    
    // Сохраняем в assets статьи
    const imageUrl = db.uploadImageToPost(postId, imageBuffer, req.file.originalname);
    
    // Удаляем временный файл
    fs.unlinkSync(req.file.path);
    
    res.json({ url: imageUrl });
  } catch (error) {
    console.error('Ошибка загрузки изображения:', error);
    
    // Удаляем временный файл в случае ошибки
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ error: 'Ошибка загрузки изображения' });
  }
});

// API: получение ассета статьи
app.get('/api/article-asset/:postId/:filename', (req, res) => {
  try {
    const { postId, filename } = req.params;
    const imageBuffer = db.getArticleAsset(postId, filename);
    
    if (!imageBuffer) {
      return res.status(404).json({ error: 'Файл не найден' });
    }
    
    // Определяем Content-Type по расширению
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp'
    };
    
    res.set('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.send(imageBuffer);
  } catch (error) {
    console.error('Ошибка получения ассета:', error);
    res.status(500).json({ error: 'Ошибка получения файла' });
  }
});

// API: посты (только метаданные)
app.get('/api/posts', (req, res) => {
  const posts = db.getAllPosts();
  res.json(posts);
});

// API: получение статьи по ID
app.get('/api/post/:id', (req, res) => {
  const post = db.getPostById(req.params.id);
  res.json(post || { error: 'Не найдено' });
});

// API: создание поста (только админ)
app.post('/api/posts', requireAuth, (req, res) => {
  const { title, content } = req.body;
  
  if (!title || !content) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  
  try {
    const result = db.createPost(title, content);
    res.json({ id: result.id, slug: result.slug });
  } catch (e) {
    console.error('Ошибка создания статьи:', e);
    res.status(400).json({ error: 'Ошибка создания' });
  }
});

// API: обновление поста (только админ)
app.put('/api/post/:id', requireAuth, (req, res) => {
  const { title, content } = req.body;
  const postId = req.params.id;
  
  if (!title || !content) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  
  try {
    const result = db.updatePost(postId, title, content);
    res.json({ success: true, id: result.id, slug: result.slug });
  } catch (e) {
    console.error('Ошибка обновления статьи:', e);
    res.status(400).json({ error: 'Ошибка обновления' });
  }
});

// API: удаление поста (только админ)
app.delete('/api/post/:id', requireAuth, (req, res) => {
  try {
    db.deletePost(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Ошибка удаления статьи:', e);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// API: восстановление БД из файлов (только админ)
app.post('/api/rebuild-database', requireAuth, (req, res) => {
  try {
    db.rebuildDatabaseFromFiles();
    res.json({ success: true, message: 'База данных восстановлена из файлов' });
  } catch (error) {
    console.error('Ошибка восстановления БД:', error);
    res.status(500).json({ error: 'Ошибка восстановления' });
  }
});

// ============ СТРАНИЦЫ ============

// Главная страница - проверяем админа
app.get('/', (req, res) => {
  const userCount = db.getUserCount();
  
  if (userCount === 0) {
    // Если админа нет, перенаправляем на setup
    return res.redirect('/setup.html');
  }
  
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Страница создания админа
app.get('/setup.html', (req, res) => {
  const userCount = db.getUserCount();
  
  if (userCount > 0) {
    // Если админ уже есть, перенаправляем на главную
    return res.redirect('/');
  }
  
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// Страница входа
app.get('/login.html', (req, res) => {
  const userCount = db.getUserCount();
  
  if (userCount === 0) {
    // Если админа нет, перенаправляем на setup
    return res.redirect('/setup.html');
  }
  
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Страница редактора
app.get('/editor.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

// Страница статьи
app.get('/post.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'post.html'));
});

// Страница предпросмотра
app.get('/preview.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

// ============ ЗАПУСК СЕРВЕРА ============

app.listen(PORT, () => {
  console.log(`=======================================`);
  console.log(`Блог запущен на http://localhost:${PORT}`);
  console.log(`=======================================`);
  
  // Проверяем наличие админа при запуске
  const userCount = db.getUserCount();
  
  if (userCount === 0) {
    console.log(`⚠️  Администратор не создан!`);
    console.log(`📝 Перейдите по ссылке: http://localhost:${PORT}/setup.html`);
    console.log(`📝 Для создания первого администратора`);
  } else {
    console.log(`✅ Администратор существует`);
    console.log(`🔗 Главная страница: http://localhost:${PORT}/`);
  }
  
  console.log(`📁 Статьи хранятся в: ${path.join(__dirname, 'articles')}`);
  console.log(`📁 Временные загрузки в: ${path.join(__dirname, 'uploads')}`);
  console.log(`=======================================`);
  
  // Автоматическое восстановление БД из файлов (опционально)
  if (process.env.REBUILD_DB === 'true') {
    console.log('Восстановление БД из файлов...');
    try {
      db.rebuildDatabaseFromFiles();
      console.log('✅ База данных восстановлена из файлов');
    } catch (error) {
      console.error('❌ Ошибка восстановления БД:', error);
    }
  }
});