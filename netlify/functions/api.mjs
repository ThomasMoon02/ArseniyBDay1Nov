import express from 'express';
import serverless from 'serverless-http';
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const app = express();
app.use(express.json());

const STORE_NAME = 'bd-votes';
const COOKIE = 'bd_voter_id';

// Хелпер для получения хранилища
const store = () => getStore(STORE_NAME);

// Чтение данных
async function readData() {
  const data = await store().get('data', { type: 'json' });
  // Если данных нет, возвращаем структуру по умолчанию
  return data || {
    votes: {
      place: { 'Баня': 0, 'Дача': 0 },
      date: { '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0 },
      time: { '18:00': 0, '19:00': 0, '20:00': 0, '21:00': 0, '22:00': 0, '23:00': 0, '24:00': 0 }
    },
    voters: {} // { voterId: { place, date, time, ts } }
  };
}

// Запись данных
async function writeData(data) {
  await store().setJSON('data', data);
}

// --- API Эндпоинты ---

// 1. Получить текущие результаты
app.get('/api/results', async (req, res) => {
  try {
    const { votes } = await readData();
    const total = Object.values(votes.place).reduce((a, b) => a + b, 0);
    res.json({ votes, total });
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. Узнать, голосовал ли текущий пользователь
app.get('/api/me', async (req, res) => {
  try {
    const voterId = req.headers.cookie?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];
    const { voters } = await readData();
    const userVote = voterId ? voters[voterId] : null;
    res.json({ vote: userVote });
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. Проголосовать
app.post('/api/vote', async (req, res) => {
  try {
    const { place, date, time } = req.body;
    
    // Валидация
    const validPlaces = ['Баня', 'Дача'];
    const validDates = ['2', '3', '4', '5', '6', '7', '8'];
    const validTimes = ['18:00', '19:00', '20:00', '21:00', '22:00', '23:00', '24:00'];
    
    if (!validPlaces.includes(place) || !validDates.includes(String(date)) || !validTimes.includes(time)) {
      return res.status(400).json({ error: 'Invalid vote data' });
    }

    // Получаем или создаем ID пользователя
    let voterId = req.headers.cookie?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];
    if (!voterId) {
      voterId = crypto.randomUUID();
      // Устанавливаем HttpOnly cookie на 1 год
      res.setHeader('Set-Cookie', `${COOKIE}=${voterId}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`);
    }

    const data = await readData();

    // Проверка на уникальность
    if (data.voters[voterId]) {
      return res.status(409).json({ error: 'You have already voted', vote: data.voters[voterId] });
    }

    // Записываем голос
    data.votes.place[place]++;
    data.votes.date[date]++;
    data.votes.time[time]++;
    data.voters[voterId] = { place, date, time, ts: Date.now() };

    await writeData(data);

    res.json({ success: true, votes: data.votes });
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Экспортируем функцию, обернутую в serverless-http
export const handler = serverless(app);