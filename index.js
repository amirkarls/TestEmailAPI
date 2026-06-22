const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Храним токен и адрес в памяти (при перезапуске сбросится)
let currentAccount = null;
let currentToken = null;

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
    const domains = await axios.get('https://api.mail.tm/domains');
    const domain = domains.data['hydra:member'][0].domain;
    const random = Math.random().toString(36).substring(2, 10);
    const address = `${random}@${domain}`;
    const password = 'temp123456'; // Или генерируй случайный

    // Регистрируем
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
      message: 'Ящик создан! Используйте /api/messages для чтения писем'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Получить письма
app.get('/api/messages', async (req, res) => {
  if (!currentToken) {
    return res.status(401).json({ error: 'Сначала создайте ящик через /api/create' });
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

// 5. Удалить ящик (почистить)
app.delete('/api/delete', async (req, res) => {
  if (!currentAccount) {
    return res.status(400).json({ error: 'Нет активного ящика' });
  }

  try {
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
    res.json({ message: 'Ящик удален' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📧 Эндпоинты:`);
  console.log(`  GET  /api/domains   - список доменов`);
  console.log(`  POST /api/create    - создать ящик`);
  console.log(`  GET  /api/messages  - все письма`);
  console.log(`  GET  /api/message/:id - письмо по ID`);
  console.log(`  DELETE /api/delete  - удалить ящик`);
});
