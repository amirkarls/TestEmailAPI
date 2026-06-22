const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Храним данные в памяти (при перезапуске сбросятся)
let currentAccount = null;
let currentToken = null;

// ============ API ЭНДПОИНТЫ ============

// 1. Получить доступные домены
app.get('/api/domains', async (req, res) => {
  try {
    const response = await axios.get('https://api.mail.tm/domains');
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Создать новый ящик
app.post('/api/create', async (req, res) => {
  try {
    // Получаем первый доступный домен
    const domains = await axios.get('https://api.mail.tm/domains');
    const domain = domains.data['hydra:member'][0].domain;
    
    // Генерируем случайный адрес
    const random = Math.random().toString(36).substring(2, 10);
    const address = `${random}@${domain}`;
    const password = 'temp123456';

    // Регистрируем аккаунт
    await axios.post('https://api.mail.tm/accounts', {
      address,
      password
    });

    // Получаем токен
    const tokenRes = await axios.post('https://api.mail.tm/token', {
      address,
      password
    });

    currentAccount = { address, password };
    currentToken = tokenRes.data.token;

    res.json({
      address,
      token: currentToken,
      message: 'Ящик создан! Отправьте письмо и проверьте /api/messages'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Получить все письма
app.get('/api/messages', async (req, res) => {
  if (!currentToken) {
    return res.status(401).json({ error: 'Сначала создайте ящик через POST /api/create' });
  }

  try {
    const response = await axios.get('https://api.mail.tm/messages', {
      headers: { Authorization: `Bearer ${currentToken}` }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Получить конкретное письмо по ID
app.get('/api/message/:id', async (req, res) => {
  if (!currentToken) {
    return res.status(401).json({ error: 'Сначала создайте ящик' });
  }

  try {
    const response = await axios.get(`https://api.mail.tm/messages/${req.params.id}`, {
      headers: { Authorization: `Bearer ${currentToken}` }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Удалить ящик
app.delete('/api/delete', async (req, res) => {
  if (!currentAccount || !currentToken) {
    return res.status(400).json({ error: 'Нет активного ящика' });
  }

  try {
    // Получаем список всех аккаунтов
    const accounts = await axios.get('https://api.mail.tm/accounts', {
      headers: { Authorization: `Bearer ${currentToken}` }
    });

    // Находим ID нашего аккаунта
    const account = accounts.data['hydra:member'].find(
      a => a.address === currentAccount.address
    );

    if (account) {
      await axios.delete(`https://api.mail.tm/accounts/${account.id}`, {
        headers: { Authorization: `Bearer ${currentToken}` }
      });
    }

    currentAccount = null;
    currentToken = null;
    res.json({ message: 'Ящик успешно удален' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ВЕБ-ИНТЕРФЕЙС (ГЛАВНАЯ СТРАНИЦА) ============

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Temp Mail - Одноразовая почта</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 20px;
        }
        .container {
          background: white;
          max-width: 800px;
          width: 100%;
          padding: 40px;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h1 {
          font-size: 32px;
          margin-bottom: 8px;
          color: #333;
        }
        .subtitle {
          color: #666;
          margin-bottom: 30px;
          font-size: 14px;
        }
        .btn-group {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-bottom: 20px;
        }
        button {
          padding: 12px 24px;
          border: none;
          border-radius: 10px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          flex: 1;
          min-width: 120px;
        }
        button:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        .btn-create { background: #4CAF50; color: white; }
        .btn-check { background: #2196F3; color: white; }
        .btn-delete { background: #f44336; color: white; }
        .btn-clear { background: #ff9800; color: white; }
        .address-box {
          background: #f0f4ff;
          padding: 15px;
          border-radius: 10px;
          margin: 15px 0;
          font-family: monospace;
          font-size: 18px;
          word-break: break-all;
          display: none;
          border: 2px dashed #667eea;
        }
        .address-box.show { display: block; }
        .address-box strong { color: #667eea; }
        .status {
          padding: 10px 15px;
          border-radius: 8px;
          margin: 10px 0;
          display: none;
          font-size: 14px;
        }
        .status.success { background: #d4edda; color: #155724; display: block; }
        .status.error { background: #f8d7da; color: #721c24; display: block; }
        .status.info { background: #d1ecf1; color: #0c5460; display: block; }
        .messages-container {
          margin-top: 20px;
          border-top: 2px solid #eee;
          padding-top: 20px;
        }
        .messages-container h3 {
          margin-bottom: 15px;
          color: #333;
          font-size: 18px;
        }
        .message-item {
          background: #f8f9fa;
          padding: 15px;
          border-radius: 10px;
          margin-bottom: 12px;
          border-left: 4px solid #667eea;
          cursor: pointer;
          transition: all 0.2s;
        }
        .message-item:hover { background: #e9ecef; }
        .message-item .from { font-weight: 600; color: #333; font-size: 14px; }
        .message-item .subject { color: #667eea; font-weight: 500; margin: 5px 0; }
        .message-item .intro { color: #666; font-size: 13px; }
        .message-item .date { color: #999; font-size: 12px; float: right; }
        .message-detail {
          background: #f8f9fa;
          padding: 20px;
          border-radius: 10px;
          margin-top: 15px;
          display: none;
          white-space: pre-wrap;
          word-wrap: break-word;
          font-size: 14px;
          line-height: 1.6;
          max-height: 400px;
          overflow-y: auto;
          border: 1px solid #dee2e6;
        }
        .message-detail.show { display: block; }
        .loading { 
          text-align: center; 
          color: #666; 
          padding: 20px;
          font-style: italic;
        }
        .badge {
          display: inline-block;
          background: #667eea;
          color: white;
          padding: 2px 10px;
          border-radius: 20px;
          font-size: 12px;
          margin-left: 10px;
        }
        @media (max-width: 600px) {
          .container { padding: 20px; }
          button { min-width: 100%; }
          h1 { font-size: 24px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📧 Temp Mail</h1>
        <div class="subtitle">Одноразовый email-ящик. Письма хранятся на mail.tm до 7 дней.</div>

        <div class="btn-group">
          <button class="btn-create" onclick="createMail()">📨 Создать ящик</button>
          <button class="btn-check" onclick="checkMail()">📬 Проверить письма</button>
          <button class="btn-delete" onclick="deleteMail()">🗑 Удалить ящик</button>
          <button class="btn-clear" onclick="clearDetail()">🧹 Очистить</button>
        </div>

        <div id="status" class="status"></div>

        <div id="addressBox" class="address-box">
          📫 Ваш ящик: <strong id="addressDisplay">—</strong>
        </div>

        <div class="messages-container">
          <h3>📩 Входящие <span id="countBadge" class="badge">0</span></h3>
          <div id="messagesList">
            <div class="loading">Нажмите "Создать ящик", затем "Проверить письма"</div>
          </div>
          <div id="detailView" class="message-detail"></div>
        </div>
      </div>

      <script>
        const BASE = window.location.origin;

        function showStatus(msg, type = 'info') {
          const el = document.getElementById('status');
          el.textContent = msg;
          el.className = 'status ' + type;
        }

        function showAddress(addr) {
          const box = document.getElementById('addressBox');
          document.getElementById('addressDisplay').textContent = addr || '—';
          box.classList.toggle('show', !!addr);
        }

        function renderMessages(data) {
          const container = document.getElementById('messagesList');
          const badge = document.getElementById('countBadge');
          
          if (!data || !data['hydra:member'] || data['hydra:member'].length === 0) {
            container.innerHTML = '<div class="loading">📭 Писем пока нет. Отправьте письмо на свой ящик!</div>';
            badge.textContent = '0';
            return;
          }

          const messages = data['hydra:member'];
          badge.textContent = messages.length;
          
          container.innerHTML = messages.map((msg, index) => {
            const from = msg.from?.address || 'Неизвестно';
            const subject = msg.subject || '(без темы)';
            const intro = msg.intro || '';
            const date = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : '';
            return \`
              <div class="message-item" onclick="showDetail(\${index})">
                <span class="date">\${date}</span>
                <div class="from">📤 \${from}</div>
                <div class="subject">📌 \${subject}</div>
                <div class="intro">\${intro.substring(0, 100)}\${intro.length > 100 ? '...' : ''}</div>
              </div>
            \`;
          }).join('');

          // Сохраняем сообщения для просмотра деталей
          window._messages = messages;
        }

        function showDetail(index) {
          const messages = window._messages || [];
          const msg = messages[index];
          if (!msg) return;

          const detail = document.getElementById('detailView');
          const content = msg.html ? msg.html[0] : (msg.text || 'Нет содержимого');
          detail.innerHTML = \`
            <strong>📤 От:</strong> \${msg.from?.address || 'Неизвестно'}<br>
            <strong>📌 Тема:</strong> \${msg.subject || '(без темы)'}<br>
            <strong>📅 Дата:</strong> \${msg.createdAt ? new Date(msg.createdAt).toLocaleString() : ''}<br>
            <hr>
            <div style="margin-top:10px;">\${content}</div>
          \`;
          detail.classList.add('show');
        }

        function clearDetail() {
          document.getElementById('detailView').classList.remove('show');
          document.getElementById('detailView').innerHTML = '';
        }

        async function createMail() {
          clearDetail();
          showStatus('⏳ Создаем ящик...', 'info');
          try {
            const res = await fetch(BASE + '/api/create', { method: 'POST' });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            showAddress(data.address);
            showStatus('✅ Ящик создан! Отправьте письмо на ' + data.address, 'success');
            document.getElementById('messagesList').innerHTML = '<div class="loading">Ящик создан. Нажмите "Проверить письма"</div>';
            document.getElementById('countBadge').textContent = '0';
          } catch (err) {
            showStatus('❌ Ошибка: ' + err.message, 'error');
          }
        }

        async function checkMail() {
          clearDetail();
          showStatus('⏳ Проверяем почту...', 'info');
          try {
            const res = await fetch(BASE + '/api/messages');
            if (res.status === 401) {
              showStatus('❌ Сначала создайте ящик!', 'error');
              return;
            }
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            renderMessages(data);
            const count = data['hydra:member']?.length || 0;
            showStatus(\`✅ Найдено \${count} писем\`, 'success');
          } catch (err) {
            showStatus('❌ Ошибка: ' + err.message, 'error');
          }
        }

        async function deleteMail() {
          clearDetail();
          showStatus('⏳ Удаляем ящик...', 'info');
          try {
            const res = await fetch(BASE + '/api/delete', { method: 'DELETE' });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            showAddress(null);
            document.getElementById('messagesList').innerHTML = '<div class="loading">Ящик удален</div>';
            document.getElementById('countBadge').textContent = '0';
            showStatus('✅ Ящик удален', 'success');
          } catch (err) {
            showStatus('❌ Ошибка: ' + err.message, 'error');
          }
        }
      </script>
    </body>
    </html>
  `);
});

// ============ ЗАПУСК СЕРВЕРА ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Temp Mail сервер запущен на порту ${PORT}`);
  console.log(`📧 Откройте https://localhost:${PORT} или ваш Render URL`);
  console.log(`📋 API эндпоинты:`);
  console.log(`   POST /api/create     - создать ящик`);
  console.log(`   GET  /api/messages   - все письма`);
  console.log(`   GET  /api/message/:id - письмо по ID`);
  console.log(`   DELETE /api/delete   - удалить ящик`);
});
