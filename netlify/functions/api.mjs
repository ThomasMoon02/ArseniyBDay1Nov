import express from 'express';
import serverless from 'serverless-http';
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const app = express();

/* ============================================================
   Body parsing — с фолбэком на случай, если serverless-http
   не передал req.body в Express.
   ============================================================ */
app.use(express.json({ limit: '16kb', type: ['application/json', 'application/*+json'] }));

app.use((req, res, next) => {
  // Если body не распарсился — пробуем взять напрямую из event
  if ((!req.body || typeof req.body !== 'object') && req.apiGateway?.event?.body) {
    try {
      let raw = req.apiGateway.event.body;
      if (req.apiGateway.event.isBase64Encoded) {
        raw = Buffer.from(raw, 'base64').toString('utf8');
      }
      req.body = JSON.parse(raw);
    } catch (e) {
      console.error('manual body parse failed:', e);
      req.body = {};
    }
  }
  if (!req.body || typeof req.body !== 'object') req.body = {};
  next();
});

/* Страховка от случая, когда Netlify передаёт в event.path
   уже переписанный путь /.netlify/functions/api/... */
app.use((req, res, next) => {
  if (req.url.startsWith('/.netlify/functions/api')) {
    req.url = req.url.replace('/.netlify/functions/api', '/api');
  }
  next();
});

/* ============================================================
   Blobs
   ============================================================ */
const STORE_NAME = 'bd-votes';
const COOKIE = 'bd_voter_id';

function getVoteStore() {
  // consistency: 'strong' гарантирует, что запись сразу видна при чтении
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function defaultData() {
  return {
    votes: {
      place: { 'Баня': 0, 'Дача': 0 },
      date: { '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0 },
      time: { '18:00': 0, '19:00': 0, '20:00': 0, '21:00': 0, '22:00': 0, '23:00': 0, '24:00': 0 }
    },
    voters: {}
  };
}

async function readData() {
  try {
    const data = await getVoteStore().get('data', { type: 'json' });
    if (!data || typeof data !== 'object' || !data.votes || !data.voters) {
      return defaultData();
    }
    return data;
  } catch (err) {
    console.error('readData error:', err);
    throw err;
  }
}

async function writeData(data) {
  try {
    await getVoteStore().setJSON('data', data);
  } catch (err) {
    console.error('writeData error:', err);
    throw err;
  }
}

function parseCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/* ============================================================
   API
   ============================================================ */

app.get('/api/results', async (req, res) => {
  try {
    const { votes } = await readData();
    const total = Object.values(votes.place || {}).reduce((a, b) => a + b, 0);
    res.json({ votes, total });
  } catch (err) {
    console.error('GET /results failed:', err);
    res.status(500).json({ error: 'internal error', detail: String(err?.message || err) });
  }
});

app.get('/api/me', async (req, res) => {
  try {
    const voterId = parseCookie(req.headers.cookie, COOKIE);
    const { voters } = await readData();
    const vote = voterId && voters[voterId] ? voters[voterId] : null;
    res.json({
      vote: vote ? { place: vote.place, date: vote.date, time: vote.time } : null
    });
  } catch (err) {
    console.error('GET /me failed:', err);
    res.status(500).json({ error: 'internal error', detail: String(err?.message || err) });
  }
});

const VALID_PLACES = ['Баня', 'Дача'];
const VALID_DATES  = ['2', '3', '4', '5', '6', '7', '8'];
const VALID_TIMES  = ['18:00', '19:00', '20:00', '21:00', '22:00', '23:00', '24:00'];

app.post('/api/vote', async (req, res) => {
  try {
    console.log('POST /vote body:', req.body);

    const { place, date, time } = req.body || {};
    const d = String(date ?? '');

    if (!VALID_PLACES.includes(place) ||
        !VALID_DATES.includes(d) ||
        !VALID_TIMES.includes(time)) {
      return res.status(400).json({ error: 'invalid vote payload', got: { place, date, time } });
    }

    let voterId = parseCookie(req.headers.cookie, COOKIE);
    const isNewVoter = !voterId;
    if (isNewVoter) {
      voterId = crypto.randomUUID();
      res.setHeader('Set-Cookie',
        `${COOKIE}=${voterId}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure`);
    }

    const data = await readData();

    if (data.voters[voterId]) {
      return res.status(409).json({
        error: 'already voted',
        vote: data.voters[voterId]
      });
    }

    // Защитная проверка: если ключа нет — создаём
    if (!data.votes.place[place]) data.votes.place[place] = 0;
    if (!data.votes.date[d])     data.votes.date[d] = 0;
    if (!data.votes.time[time])  data.votes.time[time] = 0;

    data.votes.place[place] += 1;
    data.votes.date[d]      += 1;
    data.votes.time[time]   += 1;

    data.voters[voterId] = { place, date: d, time, ts: Date.now() };

    await writeData(data);

    const total = Object.values(data.votes.place).reduce((a, b) => a + b, 0);
    res.json({ success: true, votes: data.votes, total });
  } catch (err) {
    console.error('POST /vote failed:', err);
    res.status(500).json({ error: 'internal error', detail: String(err?.message || err) });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await getVoteStore().get('data');
    res.json({ ok: true });
  } catch (err) {
    console.error('health check failed:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export const handler = serverless(app);