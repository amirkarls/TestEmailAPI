const { Telegraf } = require('telegraf');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const express = require('express');

// ===== НАСТРОЙКИ =====
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Ошибка: BOT_TOKEN не найден в переменных окружения!');
  console.error('📌 Добавь BOT_TOKEN в Environment Variables на Render');
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
      address TEXT,
      token TEXT,
      password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked DATETIME
    )
  `);

  console.log('✅ База данных инициализирована');
}

// ===== РАБОТА С MAIL.TM =====
async function createMailAccount() {
  const domains = await axios.get('https://api.mail.tm/domains');
  const domain = domains.data['hydra:member'][0].domain;
  const random = Math.random().toString(36).substring(2, 10);
  const address = `${random}@${domain}`;
  const password = Math.random().toString(36).substring(2, 12);

  await axios.post('https://api.mail.tm/accounts', { address, password });
  const tokenRes = await axios.post('https://api.mail.tm/token', { address, password });

  return { address, token: tokenRes.data.token, password };
}

async function checkMail(token) {
  try {
    const response = await axios.get('https://api.mail.tm/messages', {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data['hydra:member'] || [];
  } catch (err) {
    return null;
  }
}

async function deleteMailAccount(token, address) {
  try {
    const accounts = await axios.get('https://api.mail.tm/accounts', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const account = accounts.data['hydra:member'].find(a => a.address === address);
    if (account) {
      await axios.delete(`https://api.mail.tm/accounts/${account.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    }
    return true;
  } catch (err) {
    return false;
  }
}

// ===== ПОЛЛИНГ ПОЧТЫ (ПРОВЕРКА КАЖДЫЕ 15 СЕКУНД) =====
let lastMessageIds = {};

async function pollAllAccounts() {
  const accounts = await db.all('SELECT * FROM accounts');
  
  for (const acc of accounts) {
    const messages = await checkMail(acc.token);
    if (!messages || messages.length === 0) continue;

    const sentIds = lastMessageIds[acc.telegram_id] || [];
    const newMessages = messages.filter(m => !sentIds.includes(m.id));

    for (const msg of newMessages) {
      const from = msg.from?.address || 'Неизвестно';
      const subject = msg.subject || '(без темы)';
      const intro = msg.intro || '';
      
      try {
        await bot.telegram.sendMessage(
          acc.telegram_id,
          `📩 *Новое письмо!*\n\n` +
          `📤 От: ${from}\n` +
          `📌 Тема: ${subject}\n` +
          `📝 ${intro.substring(0, 200)}${intro.length > 200 ? '...' : ''}\n\n` +
          `✉️ *Чтобы ответить, используй одну из команд:*\n` +
          `/web - открыть почту в браузере\n` +
          `/login - показать логин/пароль\n` +
          `/replyto - скопировать адрес отправителя`,
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
    '📧 *Temp Mail Bot*\n\n' +
    'Я создаю одноразовые email-ящики и уведомляю о новых письмах!\n\n' +
    '📌 *Команды:*\n' +
    '/create - создать новый ящик\n' +
    '/check - проверить письма\n' +
    '/web - открыть почту в браузере (авто-вход)\n' +
    '/login - показать логин/пароль для входа\n' +
    '/replyto - показать адрес отправителя для ответа\n' +
    '/delete - удалить ящик\n' +
    '/info - информация о ящике\n' +
    '/help - помощь\n\n' +
    '✉️ *Как ответить на письмо?*\n' +
    'Вариант 1: /web → открыть почту в браузере → ответить\n' +
    'Вариант 2: /replyto → скопировать email → отправить с любого ящика\n' +
    'Вариант 3: /login → войти в Mail.tm через браузер\n\n' +
    '⚠️ *Важно:* Ящик сохраняется в БД и не удаляется при перезапуске бота!',
    { parse_mode: 'Markdown' }
  );
});

bot.command('create', async (ctx) => {
  const telegram_id = ctx.from.id.toString();
  
  const existing = await db.get('SELECT * FROM accounts WHERE telegram_id = ?', telegram_id);
  if (existing) {
    await ctx.reply(
      `⚠️ У вас уже есть ящик: \`${existing.address}\`\n\n` +
      `Используйте /delete чтобы удалить, или /check чтобы проверить письма`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.reply('⏳ Создаю ящик...');

  try {
    const { address, token, password } = await createMailAccount();
    
    await db.run(
      'INSERT INTO accounts (telegram_id, address, token, password) VALUES (?, ?, ?, ?)',
      telegram_id, address, token, password
    );

    lastMessageIds[telegram_id] = [];

    await ctx.reply(
      `✅ *Ящик создан!*\n\n` +
      `📫 Адрес: \`${address}\`\n` +
      `🔑 Пароль: \`${password}\` (сохраните!)\n\n` +
      `📨 Отправьте письмо на этот адрес, и я пришлю уведомление!\n\n` +
      `✉️ *Чтобы ответить на письмо:*\n` +
      `/web - открыть почту в браузере\n` +
      `/login - показать логин/пароль\n\n` +
      `⚠️ *Важно:* Ящик сохраняется в базе данных и не удаляется при перезапуске бота.`,
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

  const messages = await checkMail(account.token);
  if (!messages) {
    await ctx.reply('❌ Ошибка при проверке почты. Возможно, токен устарел. Удалите ящик и создайте новый.');
    return;
  }

  if (messages.length === 0) {
    await ctx.reply('📭 Писем пока нет.');
    return;
  }

  lastMessageIds[telegram_id] = messages.map(m => m.id);

  let reply = `📬 *Найдено ${messages.length} писем:*\n\n`;
  messages.slice(0, 5).forEach((msg, i) => {
    const from = msg.from?.address || 'Неизвестно';
    const subject = msg.subject || '(без темы)';
    reply += `${i + 1}. 📤 ${from}\n   📌 ${subject}\n`;
  });

  if (messages.length > 5) {
    reply += `\n...и еще ${messages.length - 5} писем. Нажмите /check позже.`;
  }

  reply += `\n\n✉️ *Чтобы ответить:*\n/web - открыть почту в браузере\n/replyto - скопировать адрес отправителя`;

  await ctx.reply(reply, { parse_mode: 'Markdown' });
});

// ===== НОВАЯ КОМАНДА "ОТКРЫТЬ ПОЧТУ В БРАУЗЕРЕ" =====
bot.command('web', async (ctx) => {
  const telegram_id = ctx.from.id.toString();
  
  const account = await db.get('SELECT * FROM accounts WHERE telegram_id = ?', telegram_id);
  if (!account) {
    await ctx.reply('❌ У вас нет ящика! Создайте его через /create');
    return;
  }

  const webUrl = `https://mail.tm/#/?token=${account.token}`;

  await ctx.reply(
    `🌐 *Веб-версия Mail.tm*\n\n` +
    `📫 Ваш ящик: \`${account.address}\`\n\n` +
    `🔗 *Перейди по ссылке для авто-входа:*\n` +
    `${webUrl}\n\n` +
    `💡 Если не открывается, используй команду /login для входа с паролем.`,
    { parse_mode: 'Markdown' }
  );
});

// ===== НОВАЯ КОМАНДА "ПОКАЗАТЬ ЛОГИН/ПАРОЛЬ" =====
bot.command('login', async (ctx) => {
  const telegram_id = ctx.from.id.toString();
  
  const account = await db.get('SELECT * FROM accounts WHERE telegram_id = ?', telegram_id);
  if (!account) {
    await ctx.reply('❌ У вас нет ящика! Создайте его через /create');
    return;
  }

  await ctx.reply(
    `🔐 *Данные для входа в Mail.tm*\n\n` +
    `🔗 Ссылка: https://mail.tm\n` +
    `📫 Адрес: \`${account.address}\`\n` +
    `🔑 Пароль: \`${account.password}\`\n\n` +
    `💡 Используй эти данные для входа в веб-версию, чтобы ответить на письма.`,
    { parse_mode: 'Markdown' }
  );
});

// ===== НОВАЯ КОМАНДА "ПОКАЗАТЬ АДРЕС ОТПРАВИТЕЛЯ" =====
bot.command('replyto', async (ctx) => {
  const telegram_id = ctx.from.id.toString();
  
  const account = await db.get('SELECT * FROM accounts WHERE telegram_id = ?', telegram_id);
  if (!account) {
    await ctx.reply('❌ У вас нет ящика! Создайте его через /create');
    return;
  }

  const messages = await checkMail(account.token);
  if (!messages || messages.length === 0) {
    await ctx.reply('📭 Писем пока нет.');
    return;
  }

  const lastMsg = messages[0];
  const from = lastMsg.from?.address || 'Неизвестно';
  const subject = lastMsg.subject || '(без темы)';

  await ctx.reply(
    `✉️ *Чтобы ответить на письмо:*\n\n` +
    `📤 Кому: \`${from}\`\n` +
    `📌 Тема: ${subject}\n\n` +
    `📝 *Инструкция:*\n` +
    `1. Скопируй адрес \`${from}\`\n` +
    `2. Открой любой почтовый клиент (Gmail, Яндекс, Mail.ru)\n` +
    `3. Создай новое письмо и вставь адрес\n` +
    `4. В теме напиши \`Re: ${subject}\`\n` +
    `5. Отправь ответ\n\n` +
    `💡 Так письмо уйдет с твоего личного ящика, а не с временного.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('delete', async (ctx) => {
  const telegram_id = ctx.from.id.toString();
  
  const account = await db.get('SELECT * FROM accounts WHERE telegram_id = ?', telegram_id);
  if (!account) {
    await ctx.reply('❌ У вас нет ящика.');
    return;
  }

  await ctx.reply('⏳ Удаляю ящик...');

  const success = await deleteMailAccount(account.token, account.address);
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
    `📫 *Ваш ящик:* \`${account.address}\`\n` +
    `📅 Создан: ${account.created_at}\n` +
    `🔄 Последняя проверка: ${account.last_checked || 'никогда'}\n\n` +
    `✉️ *Чтобы ответить:*\n` +
    `/web - открыть почту в браузере\n` +
    `/login - показать логин/пароль\n\n` +
    `⚠️ Ящик хранится в базе данных и НЕ удаляется при перезапуске бота.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    '📖 *Помощь*\n\n' +
    '📌 Команды:\n' +
    '/create - создать новый ящик\n' +
    '/check - проверить письма\n' +
    '/web - открыть почту в браузере (авто-вход)\n' +
    '/login - показать логин/пароль для входа\n' +
    '/replyto - показать адрес отправителя для ответа\n' +
    '/delete - удалить ящик\n' +
    '/info - информация о ящике\n' +
    '/help - помощь\n\n' +
    '✉️ *Как ответить на письмо? (3 способа)*\n' +
    '1️⃣ /web → открыть почту в браузере → ответить\n' +
    '2️⃣ /replyto → скопировать email → отправить с любого ящика\n' +
    '3️⃣ /login → войти в Mail.tm через браузер с паролем\n\n' +
    '⚡️ *Уведомления:*\n' +
    'Я автоматически проверяю почту каждые 15 секунд и присылаю уведомления о новых письмах!\n\n' +
    '💾 *Хранение:*\n' +
    'Все ящики хранятся в базе данных SQLite. При перезапуске бота данные НЕ теряются.',
    { parse_mode: 'Markdown' }
  );
});

// ===== ЗАПУСК БОТА =====
async function main() {
  await initDB();
  await bot.launch();
  console.log('🤖 Бот запущен! Найди его в Telegram и напиши /start');
  
  const accounts = await db.all('SELECT * FROM accounts');
  for (const acc of accounts) {
    const messages = await checkMail(acc.token);
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
  res.send('🤖 Temp Mail Bot работает!');
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
