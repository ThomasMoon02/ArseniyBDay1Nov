import express from 'express';
import serverless from 'serverless-http';
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const app = express();

/* ============================================================
   Парсинг JSON. Даже если express.json не справится,
   ниже подхватываем тело из event вручную.
   ============================================================ */
app.use(express.json({ limit: '16kb', type: ['application/json', 'application/*+json'] }));

app.use((req, res, next) => {
  if ((!req.body || typeof req.body !== 'object') && req.apiGateway?.event?.body) {
    try {
      let raw = req.apiGateway.event.body;
      if (req.apiGateway.event.isBase64Encoded) {
        raw = Buffer.from(raw, 'base64').toString('utf8');
      }
      req.body = JSON.parse(raw);
    } catch (e) {
      req.body = {};
    }
  }
  if (!req.body || typeof req.body !== 'object') req.body = {};
  next();
});

/* ============================================================
   Blobs — самая совместимая инициализация.
   Порядок:
     1) если в env есть SITE_ID + NETLIFY_BLOBS_TOKEN → ручной режим
     2) иначе auto-detect (Netlify сам подставит контекст)
   ============================================================ */
const STORE_NAME = 'bd-votes-V2';
const COOKIE     = 'bd_voter_id';

function getVoteStore() {
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN;

  if (siteID && token) {
    console.log('Blobs: manual mode (siteID + token)');
    return getStore({ name: STORE_NAME, siteID, token });
  }

  console.log('Blobs: auto-detect mode');
  return getStore(STORE_NAME);
}

function defaultData() {
  return {
    votes: {
      place: { 'Баня': 0, 'Дача': 0 },
      date:  { '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0 },
      time:  { '18:00': 0, '19:00': 0, '20:00': 0, '21:00': 0, '22:00': 0, '23:00': 0, '24:00': 0 }
    },
    voters: {}
  };
}

async function readData() {
  const data = await getVoteStore().get('data', { type: 'json' });
  if (!data || typeof data !== 'object' || !data.votes || !data.voters) {
    return defaultData();
  }
  return data;
}

async function writeData(data) {
  await getVoteStore().setJSON('data', data);
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
    res.status(500).json({
      error: 'internal error',
      detail: String(err?.message || err)
    });
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
    res.status(500).json({
      error: 'internal error',
      detail: String(err?.message || err)
    });
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
      return res.status(400).json({
        error: 'invalid vote payload',
        got: { place, date, time }
      });
    }

    let voterId = parseCookie(req.headers.cookie, COOKIE);
    if (!voterId) {
      voterId = crypto.randomUUID();
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${voterId}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure`
      );
    }

    const data = await readData();

    if (data.voters[voterId]) {
      return res.status(409).json({
        error: 'already voted',
        vote:  data.voters[voterId]
      });
    }

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
    res.status(500).json({
      error: 'internal error',
      detail: String(err?.message || err)
    });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const store = getVoteStore();
    await store.get('data');
    res.json({
      ok: true,
      mode: process.env.NETLIFY_BLOBS_TOKEN ? 'manual' : 'auto',
      hasSiteId: !!process.env.SITE_ID,
      hasBlobsContext: !!process.env.NETLIFY_BLOBS_CONTEXT
    });
  } catch (err) {
    console.error('health check failed:', err);
    res.status(500).json({
      ok: false,
      error: String(err?.message || err),
      hasSiteId: !!process.env.SITE_ID,
      hasBlobsContext: !!process.env.NETLIFY_BLOBS_CONTEXT
    });
  }
});

export const handler = serverless(app);