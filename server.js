'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const svgCaptcha = require('svg-captcha');
const morgan = require('morgan');
const TelegramBot = require('node-telegram-bot-api');

const app = express();

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'whitecore-dev-secret';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const DEFAULT_IMAGE_URL = '/img/whitecore-placeholder.svg';
const DEFAULT_ZIP_PATH = path.join('downloads', 'whitecore-default.zip');

[UPLOADS_DIR, DOWNLOADS_DIR].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

const db = new sqlite3.Database(DB_PATH);

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const ensureSetting = async (key, fallback) => {
  const existing = await dbGet('SELECT value FROM settings WHERE key = ?', [key]);
  if (!existing) {
    await dbRun('INSERT INTO settings (key, value) VALUES (?, ?)', [key, fallback]);
    return fallback;
  }
  return existing.value;
};

const setSetting = async (key, value) => {
  await dbRun(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
};

const getSetting = async (key, fallback) => {
  const row = await dbGet('SELECT value FROM settings WHERE key = ?', [key]);
  if (row) return row.value;
  return fallback;
};

const ensureAdminUser = async () => {
  const adminName = 'RURI';
  const adminPass = 'Wat3hahak';
  const existing = await dbGet('SELECT id FROM users WHERE username = ?', [adminName]);
  if (existing) return existing.id;

  const passwordHash = await bcrypt.hash(adminPass, 10);
  const result = await dbRun(
    'INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
    [adminName, passwordHash, 1]
  );

  console.log(`Создан администратор по умолчанию: ${adminName}/${adminPass} (id=${result.lastID})`);
  return result.lastID;
};

const toAbsolutePath = (storedPath) => {
  if (!storedPath) return null;
  if (path.isAbsolute(storedPath)) return storedPath;
  const normalized = storedPath.replace(/^[\\/]/, '');
  return path.join(__dirname, normalized);
};

const formatBytes = (bytes) => {
  if (!bytes || Number.isNaN(bytes)) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${sizes[i]}`;
};

const bootstrap = async () => {
  await dbRun(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  );

  const userColumns = await dbAll('PRAGMA table_info(users)');
  const hasEmail = userColumns.some((col) => col.name === 'email');
  if (!hasEmail) {
    await dbRun('ALTER TABLE users ADD COLUMN email TEXT');
  }
  await dbRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');

  await dbRun(
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`
  );

  await ensureSetting('cheat_image_url', DEFAULT_IMAGE_URL);
  await ensureSetting('cheat_zip_path', DEFAULT_ZIP_PATH);
  await ensureAdminUser();
};

const sessionMiddleware = session({
  name: 'whitecore.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 2,
  },
});

const imageStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `cheat-${Date.now()}${ext}`);
  },
});

const zipStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, DOWNLOADS_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname) || '.zip';
    cb(null, `whitecore-${Date.now()}${ext}`);
  },
});

const uploadImage = multer({
  storage: imageStorage,
  fileFilter: (_, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Допустимы только изображения'));
  },
});

const uploadZip = multer({
  storage: zipStorage,
  fileFilter: (_, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.zip')) return cb(null, true);
    cb(new Error('Нужен ZIP архив'));
  },
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(morgan('dev'));
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1d' }));

const setFlash = (req, type, message) => {
  req.session.flash = { type, message };
};

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  res.locals.year = new Date().getFullYear();
  delete req.session.flash;
  next();
});

const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.user || !req.session.user.isAdmin) {
    return res.redirect('/login?next=/admin');
  }
  return next();
};

app.get('/captcha', (req, res) => {
  const captcha = svgCaptcha.create({
    size: 5,
    noise: 3,
    color: true,
    background: '#0b0f1e',
    width: 140,
    height: 50,
    fontSize: 46,
  });
  req.session.captcha = captcha.text.toLowerCase();
  res.type('svg');
  res.set('Cache-Control', 'no-store');
  return res.send(captcha.data);
});

app.get('/', async (req, res) => {
  const cheatImageUrl = await getSetting('cheat_image_url', DEFAULT_IMAGE_URL);
  const zipPath = await getSetting('cheat_zip_path', DEFAULT_ZIP_PATH);
  const absoluteZip = toAbsolutePath(zipPath);

  const zipExists = absoluteZip ? fs.existsSync(absoluteZip) : false;
  const zipStats = zipExists ? fs.statSync(absoluteZip) : null;

  res.render('index', {
    title: 'Whitecore Client',
    cheatImageUrl,
    zipExists,
    zipSize: zipStats ? formatBytes(zipStats.size) : null,
    zipUpdatedAt: zipStats ? zipStats.mtime : null,
    downloadUrl: req.session.user ? '/download' : '/login?next=/',
  });
});

app.get('/register', (req, res) => {
  res.render('register', {
    title: 'Регистрация',
    next: req.query.next || '/',
  });
});

app.post('/register', async (req, res) => {
  const { username = '', email = '', password = '', captcha = '', next = '/' } = req.body;
  const normalizedUser = username.trim();
  const normalizedEmail = email.trim().toLowerCase();
  const sessionCaptcha = req.session.captcha;
  req.session.captcha = null;

  if (!sessionCaptcha || captcha.toLowerCase() !== sessionCaptcha) {
    setFlash(req, 'error', 'Неверная капча');
    return res.redirect('/register');
  }

  if (!normalizedUser || !password || !normalizedEmail) {
    setFlash(req, 'error', 'Логин, email и пароль обязательны');
    return res.redirect('/register');
  }

  if (normalizedUser.length < 3) {
    setFlash(req, 'error', 'Логин должен быть длиннее 3 символов');
    return res.redirect('/register');
  }

  const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    setFlash(req, 'error', 'Укажите корректный email');
    return res.redirect('/register');
  }

  const existing = await dbGet('SELECT id FROM users WHERE username = ?', [normalizedUser]);
  if (existing) {
    setFlash(req, 'error', 'Такой логин уже существует');
    return res.redirect('/register');
  }

  const existingEmail = await dbGet('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
  if (existingEmail) {
    setFlash(req, 'error', 'Такой email уже зарегистрирован');
    return res.redirect('/register');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await dbRun(
    'INSERT INTO users (username, email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
    [normalizedUser, normalizedEmail, passwordHash, 0]
  );

  req.session.user = { id: result.lastID, username: normalizedUser, email: normalizedEmail, isAdmin: false };
  setFlash(req, 'success', 'Аккаунт создан, добро пожаловать!');
  return res.redirect(next || '/');
});

app.get('/login', (req, res) => {
  res.render('login', {
    title: 'Вход',
    next: req.query.next || '/',
  });
});

app.post('/login', async (req, res) => {
  const { username = '', password = '', captcha = '', next = '/' } = req.body;
  const sessionCaptcha = req.session.captcha;
  req.session.captcha = null;

  if (!sessionCaptcha || captcha.toLowerCase() !== sessionCaptcha) {
    setFlash(req, 'error', 'Неверная капча');
    return res.redirect('/login');
  }

  const identifier = username.trim();
  const identifierLower = identifier.toLowerCase();
  const user = await dbGet(
    'SELECT id, username, email, password_hash, is_admin FROM users WHERE username = ? OR email = ?',
    [identifier, identifierLower]
  );

  if (!user) {
    setFlash(req, 'error', 'Пользователь не найден');
    return res.redirect('/login');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    setFlash(req, 'error', 'Неверный пароль');
    return res.redirect('/login');
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    email: user.email || '',
    isAdmin: !!user.is_admin,
  };

  setFlash(req, 'success', 'Вы вошли в систему');
  return res.redirect(next || '/');
});

app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/download', requireAuth, async (req, res) => {
  const zipPath = await getSetting('cheat_zip_path', DEFAULT_ZIP_PATH);
  const absoluteZip = toAbsolutePath(zipPath);

  if (!absoluteZip || !fs.existsSync(absoluteZip)) {
    setFlash(req, 'error', 'Файл пока недоступен, свяжитесь с админом');
    return res.redirect('/');
  }

  res.set('Cache-Control', 'no-store');
  return res.download(absoluteZip, path.basename(absoluteZip) || 'whitecore.zip');
});

app.get('/admin', requireAdmin, async (req, res) => {
  const cheatImageUrl = await getSetting('cheat_image_url', DEFAULT_IMAGE_URL);
  const zipPath = await getSetting('cheat_zip_path', DEFAULT_ZIP_PATH);
  const absoluteZip = toAbsolutePath(zipPath);
  const normalizedImagePath = cheatImageUrl.replace(/^[\\/]/, '');
  const absoluteImage = cheatImageUrl.startsWith('/uploads/')
    ? toAbsolutePath(cheatImageUrl)
    : toAbsolutePath(path.join('public', normalizedImagePath));

  const zipExists = absoluteZip ? fs.existsSync(absoluteZip) : false;
  const zipStats = zipExists ? fs.statSync(absoluteZip) : null;

  res.render('admin', {
    title: 'Админ-панель',
    cheatImageUrl,
    zipPath,
    zipExists,
    zipStats,
    imageExists: absoluteImage ? fs.existsSync(absoluteImage) : false,
  });
});

app.post('/admin/upload-image', requireAdmin, (req, res) => {
  uploadImage.single('cheatImage')(req, res, async (err) => {
    if (err) {
      setFlash(req, 'error', err.message);
      return res.redirect('/admin');
    }

    if (!req.file) {
      setFlash(req, 'error', 'Файл не получен');
      return res.redirect('/admin');
    }

    const newUrl = `/uploads/${req.file.filename}`;
    const prev = await getSetting('cheat_image_url', DEFAULT_IMAGE_URL);

    if (prev && prev.startsWith('/uploads/')) {
      const prevAbsolute = toAbsolutePath(prev);
      if (prevAbsolute && fs.existsSync(prevAbsolute)) {
        fs.unlink(prevAbsolute, () => {});
      }
    }

    await setSetting('cheat_image_url', newUrl);
    setFlash(req, 'success', 'Картинка чита обновлена');
    return res.redirect('/admin');
  });
});

app.post('/admin/upload-zip', requireAdmin, (req, res) => {
  uploadZip.single('cheatZip')(req, res, async (err) => {
    if (err) {
      setFlash(req, 'error', err.message);
      return res.redirect('/admin');
    }

    if (!req.file) {
      setFlash(req, 'error', 'Архив не получен');
      return res.redirect('/admin');
    }

    const newPath = path.join('downloads', req.file.filename);
    const prev = await getSetting('cheat_zip_path', DEFAULT_ZIP_PATH);
    if (prev && prev.startsWith('downloads')) {
      const prevAbsolute = toAbsolutePath(prev);
      if (prevAbsolute && fs.existsSync(prevAbsolute)) {
        fs.unlink(prevAbsolute, () => {});
      }
    }

    await setSetting('cheat_zip_path', newPath);
    setFlash(req, 'success', 'Файл чита обновлен');
    return res.redirect('/admin');
  });
});

const startTelegramBot = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('Telegram бот не настроен (укажите TELEGRAM_BOT_TOKEN)');
    return;
  }

  const bot = new TelegramBot(token, { polling: true });
  const sessions = new Map(); // chatId -> user

  const loginWithCredentials = async (username, password) => {
    const identifier = username.trim();
    const identifierLower = identifier.toLowerCase();
    const user = await dbGet(
      'SELECT id, username, email, password_hash, is_admin FROM users WHERE username = ? OR email = ?',
      [identifier, identifierLower]
    );
    if (!user) return null;
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return null;
    return { id: user.id, username: user.username, isAdmin: !!user.is_admin };
  };

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      'Whitecore bot готов. Используйте:\n/login <логин> <пароль>\n/download — получить текущий файл\n/logout — выйти'
    );
  });

  bot.onText(/\/login (.+)/, async (msg, match) => {
    const [, credentials] = match;
    const [username, password] = credentials.split(/\s+/);
    if (!username || !password) {
      return bot.sendMessage(msg.chat.id, 'Формат: /login <логин> <пароль>');
    }

    const user = await loginWithCredentials(username, password);
    if (!user) {
      return bot.sendMessage(msg.chat.id, 'Неверные данные');
    }

    sessions.set(msg.chat.id, user);
    return bot.sendMessage(msg.chat.id, `Вход выполнен. Привет, ${user.username}!`);
  });

  bot.onText(/\/download/, async (msg) => {
    const sessionUser = sessions.get(msg.chat.id);
    if (!sessionUser) {
      return bot.sendMessage(msg.chat.id, 'Сначала залогиньтесь: /login <логин> <пароль>');
    }

    const zipPath = await getSetting('cheat_zip_path', DEFAULT_ZIP_PATH);
    const absoluteZip = toAbsolutePath(zipPath);
    if (!absoluteZip || !fs.existsSync(absoluteZip)) {
      return bot.sendMessage(msg.chat.id, 'Файл пока недоступен, свяжитесь с админом');
    }

    return bot.sendDocument(msg.chat.id, absoluteZip, {}, { filename: path.basename(absoluteZip) });
  });

  bot.onText(/\/logout/, (msg) => {
    sessions.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Вы вышли.');
  });

  bot.on('polling_error', (err) => {
    console.error('Telegram polling error:', err.message);
  });

  console.log('Telegram бот запущен');
};

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  setFlash(req, 'error', 'Что-то пошло не так. Повторите попытку.');
  return res.redirect('back');
});

bootstrap()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Whitecore client готов: http://localhost:${PORT}`);
    });
    startTelegramBot();
  })
  .catch((err) => {
    console.error('Не удалось инициализировать приложение', err);
    process.exit(1);
  });

