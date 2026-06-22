const { Telegraf } = require('telegraf');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const express = require('express');

// ===== НАСТРОЙКИ =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const MOEMAIL_API_KEY = process.env.MOEMAIL_API_KEY;
const MOEMAIL_API_URL = process.env.MOEMAIL_API_URL || 'https://moemail.app/api';

if (!BOT_TOKEN) {
  console.error('❌ Ошибка: BOT_TOKEN не найден в переменных окружения!');
  console.error('📌 Добавь BOT_TOKEN в Environment Variables на Render');
  process.exit(1);
}

if (!MOEMAIL_API_KEY) {
  console.error('❌ Ошибка: MOEMAIL_API_KEY не найден в переменных окружения!');
  console.error('📌 Добавь MOEMAIL_API_KEY в Environment Variables на Render');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
let db;

// ===== ИНИЦИАЛИЗАЦИЯ БД =====
async function initDB() {
  db = await open({
    filename: './mails.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE,
      email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked DATETIME
    )
  `);

  console.log('✅ База данных инициализирована');
}

// ===== РАБОТА С MOEMAIL API =====

// Создать ящик (правильный эндпоинт)
async function createMailAccount() {
  try {
    console.log('📡 Создаю ящик через MoeMail API...');
    
    const response = await axios.post(
      `${MOEMAIL_API_URL}/emails/generate`,
      {
        name: Math.random().toString(36).substring(2, 10),
        expiryTime: 3600000, // 1 час
        domain: 'moemail.app'
      },
      {
        headers: {
          'X-API-Key': MOEMAIL_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Ящик создан:', response.data);
    return {
      email: response.data.email,
      id: response.data.id || response.data.email
    };
  } catch (err) {
    console.error('❌ Ошибка создания ящика:');
    console.error('Status:', err.response?.status);
    console.error('Data:', err.response?.data);
    
    if (err.response?.status === 403) {
      throw new Error('Доступ запрещен (403). Проверь API-ключ.');
    } else if (err.response?.status === 401) {
      throw new Error('Неверный API-ключ (401). Проверь MOEMAIL_API_KEY.');
    } else {
      throw new Error(`Ошибка: ${err.response?.data?.message || err.message}`);
    }
  }
}

// Проверить письма (правильный эндпоинт)
async function checkMail(email) {
  try {
    const response = await axios.get(
      `${MOEMAIL_API_URL}/emails/${encodeURIComponent(email)}`,
      {
        headers: {
          'X-API-Key': MOEMAIL_API_KEY
        }
      }
    );
    return response.data.messages || [];
  } catch (err) {
    console.error('Ошибка проверки почты:', err.response?.data || err.message);
    return null;
  }
}

// Отправить письмо
async function sendEmail(from, to, subject, text) {
  try {
    const response = await axios.post(
      `${MOEMAIL_API_URL}/send`,
      {
        from: from,
        to: to,
        subject: subject,
        text: text
      },
      {
        headers: {
          'X-API-Key': MOEMAIL_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (err) {
    console.error('Ошибка отправки:', err.response?.data || err.message);
    throw new Error('Не удалось отправить письмо: ' + (err.response?.data?.message || err.message));
  }
}

// Удалить ящик
async function deleteMailAccount(email) {
  try {
    await axios.delete(
      `${MOEMAIL_API_URL}/emails/${encodeURIComponent(email)}`,
      {
        headers: {
          'X-API-Key': MOEMAIL_API_KEY
        }
      }
    );
    return true;
  } catch (err) {
    console.error('Ошибка удаления ящика:', err.response?.data || err.message);
    return false;
  }
}

// ===== ПОЛЛИНГ ПОЧТЫ (ПРОВЕРКА КАЖДЫЕ 15 СЕКУНД) =====
let lastMessageIds = {};

async function pollAllAccounts() {
  const accounts = await db.all('SELECT * FROM accounts');
  
  for (const acc of accounts) {
    const messages = await checkMail(acc.email);
    if (!messages || messages.length === 0) continue;

    const sentIds = lastMessageIds[acc.telegram_id] || [];
    const newMessages = messages.filter(m => !sentIds.includes(m.id));

    for (const msg of newMessages) {
      const from = msg.from || 'Неизвестно';
      const subject = msg.subject || '(без темы)';
      const text = msg.text || '';
      
      try {
        await bot.telegram.sendMessage(
          acc.telegram_id,
          `📩 *Новое письмо!*\n\n` +
          `📤 От: ${from}\n` +
          `📌 Тема: ${subject}\n` +
          `📝 ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}\n\n` +
          `✉️ *Чтобы ответить:*\n` +
          `/reply [email] [текст]\n` +
          `Пример: /reply friend@gmail.com Привет!`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error(`Ошибка отправки пользователю ${acc.telegram_id}:`, err.message);
      }
    }

    const allIds = messages.map(m => m.id);
    lastMessageIds[acc.telegram_id] = allIds;

    await db.run(
      'UPDATE accounts SET last_checked = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      acc.telegram_id
    );
  }
}

// Запускаем поллинг каждые 15 секунд
setInterval(pollAllAccounts, 15000);

// ===== КОМАНДЫ БОТА =====

bot.start(async (ctx) => {
  await ctx.reply(
    '📧 *MoeMail Bot*\n\n' +
    'Я создаю временные email-ящики через MoeMail и умею отправлять письма!\n\n' +
    '📌 *Команды:*\n' +
    '/create - создать новый ящик\n' +
    '/check - проверить письма\n' +
    '/reply [email] [текст] - ответить на письмо\n' +
    '/delete - удалить ящик\n' +
    '/info - информация о ящике\n' +
    '/help - помощь\n\n' +
    '⚠️ *Важно:* Все данные сохраняются в БД и не удаляются при перезапуске!',
    { parse_mode: 'Markdown' }
  );
});

bot.command('create', async (ctx) => {
  const telegram_id = ctx.from.id.toString();
  
  const existing = await db.get('SELECT * FROM accounts WHERE telegram_id = ?', telegram_id);
  if (existing) {
    await ctx.reply(
      `⚠️ У вас уже есть ящик: \`${existing.email}\`\n\n` +
      `Используйте /delete чтобы удалить, или /check чтобы проверить письма`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.reply('⏳ Создаю ящик через MoeMail...');

  try {
    const { email, id } = await createMailAccount();
    
    await db.run(
      'INSERT INTO accounts (telegram_id, email) VALUES (?, ?)',
      telegram_id, email
    );

    lastMessageIds[telegram_id] = [];

    await ctx.reply(
      `✅ *Ящик создан!*\n\n` +
      `📫 Адрес: \`${email}\`\n` +
      `⏰ Живет: 1 час\n\n` +
      `📨 Отправьте письмо на этот адрес, и я пришлю уведомление!\n\n` +
      `✉️ *Чтобы отправить письмо:*\n` +
      `/reply [email] [текст]\n` +
      `Пример: /reply friend@gmail.com Привет! Как дела?`,
      { parse_mode: 'Markdown' }
    );

  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('check', async (ctx) => {
  const telegram_id = ctx.from.id.toString();
  
  const account = await db.get('SELECT * FROM accounts WHERE telegram_id = ?', telegram_id);
  if (!account) {
    await ctx.reply('❌ У вас нет ящика! Создайте его через /create');
    return;
  }

  await ctx.reply('⏳ Проверяю почту...');

  const messages = await checkMail(account.email);
  if (!messages) {
    await ctx.reply('❌ Ошибка при проверке почты. Попробуйте позже.');
    return;
  }

  if (messages.length === 0) {
    await ctx.reply('📭 Писем пока нет.');
    return;
  }

  lastMessageIds[telegram_id] = messages.map(m => m.id);

  let reply = `📬 *Найдено ${messages.length} писем:*\n\n`;
  messages.slice(0, 5).forEach((msg, i) => {
    const from = msg.from || 'Неизвестно';
    const subject = msg.subject || '(без темы)';
    reply += `${i + 1}. 📤 ${from}\n   📌 ${subject}\n`;
  });

  if (messages.length > 5) {
    reply += `\n...и еще ${messages.length - 5} писем. Нажмите /check позже.`;
  }

  reply += `\n\n✉️ *Чтобы ответить:*\n/reply [email] [текст]`;

  await ctx.reply(reply, { parse_mode: 'Markdown' });
});

// ===== КОМАНДА "ОТВЕТИТЬ" =====
bot.command('reply', async (ctx) => {
  const telegram_id = ctx.from.id.toString();
  
  const account = await db.get('SELECT * FROM accounts WHERE telegram_id = ?', telegram_id);
  if (!account) {
    await ctx.reply('❌ У вас нет ящика! Создайте его через /create');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    await ctx.reply(
      '❌ *Формат:* `/reply [email] [текст]`\n\n' +
      '📌 *Примеры:*\n' +
      '/reply friend@gmail.com Привет! Получил твое письмо.\n' +
      '/reply user@yandex.ru Спасибо за информацию!',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const to = args[0];
  const text = args.slice(1).join(' ');
  const subject = `Re: Письмо от ${to}`;

  try {
    await ctx.reply('⏳ Отправляю письмо через MoeMail...');
    
    const result = await sendEmail(account.email, to, subject, text);
    
    await ctx.reply(
      `✅ *Письмо отправлено!*\n\n` +
      `📤 Кому: ${to}\n` +
      `📌 Тема: ${subject}\n` +
      `📝 Текст: ${text}\n\n` +
      `📨 ID: ${result.id || 'неизвестен'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await ctx.reply(`❌ Ошибка отправки: ${err.message}`);
  }
});

bot.command('delete', async (ctx) => {
  const telegram_id = ctx.from.id.toString();
  
  const account = await db.get('SELECT * FROM accounts WHERE telegram_id = ?', telegram_id);
  if (!account) {
    await ctx.reply('❌ У вас нет ящика.');
    return;
  }

  await ctx.reply('⏳ Удаляю ящик...');

  const success = await deleteMailAccount(account.email);
  if (success) {
    await db.run('DELETE FROM accounts WHERE telegram_id = ?', telegram_id);
    delete lastMessageIds[telegram_id];
    await ctx.reply('✅ Ящик удален. Все данные стерты.');
  } else {
    await ctx.reply('⚠️ Не удалось удалить ящик на сервере, но я удалю его из базы данных.');
    await db.run('DELETE FROM accounts WHERE telegram_id = ?', telegram_id);
    delete lastMessageIds[telegram_id];
    await ctx.reply('✅ Ящик удален из базы данных.');
  }
});

bot.command('info', async (ctx) => {
  const telegram_id = ctx.from.id.toString();
  
  const account = await db.get('SELECT * FROM accounts WHERE telegram_id = ?', telegram_id);
  if (!account) {
    await ctx.reply('❌ У вас нет ящика. Создайте его через /create');
    return;
  }

  await ctx.reply(
    `📫 *Ваш ящик:* \`${account.email}\`\n` +
    `📅 Создан: ${account.created_at}\n` +
    `🔄 Последняя проверка: ${account.last_checked || 'никогда'}\n\n` +
    `✉️ *Чтобы отправить письмо:*\n` +
    `/reply [email] [текст]`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    '📖 *Помощь*\n\n' +
    '📌 Команды:\n' +
    '/create - создать новый ящик (живет 1 час)\n' +
    '/check - проверить письма\n' +
    '/reply [email] [текст] - отправить письмо\n' +
    '/delete - удалить ящик\n' +
    '/info - информация о ящике\n' +
    '/help - помощь\n\n' +
    '✉️ *Как отправить письмо:*\n' +
    `/reply friend@gmail.com Привет! Как дела?\n\n` +
    '⚡️ *Уведомления:*\n' +
    'Я автоматически проверяю почту каждые 15 секунд и присылаю уведомления о новых письмах!\n\n' +
    '💾 *Хранение:*\n' +
    'Все ящики хранятся в базе данных SQLite. При перезапуске бота данные НЕ теряются.\n\n' +
    '🔑 *API Key:*\n' +
    'Используется MoeMail API с ключом из переменных окружения.',
    { parse_mode: 'Markdown' }
  );
});

// ===== ЗАПУСК БОТА =====
async function main() {
  await initDB();
  
  // Удаляем старый webhook, чтобы избежать конфликта
  try {
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удален');
  } catch (err) {
    console.log('⚠️ Не удалось удалить webhook:', err.message);
  }
  
  await bot.launch();
  console.log('🤖 Бот запущен! Найди его в Telegram и напиши /start');
  
  const accounts = await db.all('SELECT * FROM accounts');
  for (const acc of accounts) {
    const messages = await checkMail(acc.email);
    if (messages) {
      lastMessageIds[acc.telegram_id] = messages.map(m => m.id);
    } else {
      lastMessageIds[acc.telegram_id] = [];
    }
  }
  console.log(`✅ Загружено ${accounts.length} ящиков`);
}

main();

// ===== ЗАГЛУШКА ДЛЯ RENDER WEB SERVICE =====
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('🤖 MoeMail Bot работает!');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const server = app.listen(PORT, () => {
  console.log(`✅ Web-заглушка слушает порт ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('🛑 Получен SIGTERM, закрываю сервер...');
  server.close(() => {
    console.log('✅ Сервер закрыт');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('👋 Бот остановлен');
  process.exit(0);
});
