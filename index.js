const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_SECRET = process.env.API_SECRET || 'mymarket-wa-secret-2026';
const AUTH_DIR = path.join(__dirname, 'wa-sessions');

const sessions = {};

function getStatus(storeId) {
  const s = sessions[storeId];
  if (!s) return { status: 'not_started', connected: false };
  return {
    status: s.status,
    connected: s.status === 'connected',
    phone: s.phone,
    name: s.name,
    qr: s.qr,
    lastConnected: s.lastConnected,
  };
}

async function startSession(storeId) {
  if (sessions[storeId]?.sock) {
    try { sessions[storeId].sock.ws.close(); } catch (e) {}
    try { sessions[storeId].sock.end(); } catch (e) {}
  }

  const sessionDir = path.join(AUTH_DIR, storeId);
  // Clear old session to force fresh QR
  if (!sessions[storeId]?.status || sessions[storeId]?.status !== 'connected') {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
  }
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  console.log(`[${storeId}] Creating socket...`);

  const sock = makeWASocket({
    auth: state,
    browser: ['MyMarket', 'Chrome', '120.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
    emitOwnEvents: false,
  });

  sessions[storeId] = { sock, status: 'connecting', qr: null, phone: null, name: null, lastConnected: null, retryCount: 0 };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(`[${storeId}] update: connection=${connection} hasQr=${!!qr} code=${lastDisconnect?.error?.output?.statusCode}`);

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        sessions[storeId].qr = qrDataUrl;
        sessions[storeId].status = 'waiting_qr';
        console.log(`[${storeId}] QR READY (${qrDataUrl.length} bytes)`);
      } catch (e) { console.log(`[${storeId}] QR gen error:`, e.message); }
    }

    if (connection === 'open') {
      const user = sock.user;
      sessions[storeId].status = 'connected';
      sessions[storeId].qr = null;
      sessions[storeId].phone = user?.id?.split(':')[0] || user?.id?.split('@')[0] || 'unknown';
      sessions[storeId].name = user?.name || '';
      sessions[storeId].lastConnected = new Date().toISOString();
      sessions[storeId].retryCount = 0;
      console.log(`[${storeId}] CONNECTED: ${sessions[storeId].phone}`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut && code !== 403;
      sessions[storeId].status = 'disconnected';

      if (shouldReconnect && sessions[storeId].retryCount < 3) {
        sessions[storeId].retryCount++;
        const wait = 5000 * sessions[storeId].retryCount;
        console.log(`[${storeId}] Reconnecting in ${wait/1000}s (try ${sessions[storeId].retryCount})`);
        setTimeout(() => startSession(storeId), wait);
      } else if (!shouldReconnect) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        sessions[storeId].status = 'logged_out';
        sessions[storeId].qr = null;
      } else {
        sessions[storeId].status = 'failed';
      }
    }
  });

  return sessions[storeId];
}

async function sendMessage(storeId, phone, message) {
  const session = sessions[storeId];
  if (!session || session.status !== 'connected') {
    return { success: false, reason: 'WhatsApp not connected. Scan QR code first.' };
  }
  let num = String(phone).replace(/[\s\-\+\(\)]/g, '');
  if (num.startsWith('00213')) num = num.substring(2);
  else if (num.startsWith('0')) num = '213' + num.substring(1);
  else if (!num.startsWith('213') && num.length <= 10) num = '213' + num;
  const jid = num + '@s.whatsapp.net';
  try {
    await delay(2000);
    const result = await session.sock.sendMessage(jid, { text: message });
    console.log(`[${storeId}] SENT to ${num}`);
    return { success: true, messageId: result.key.id, to: num };
  } catch (e) {
    console.error(`[${storeId}] SEND ERROR:`, e.message);
    return { success: false, reason: e.message };
  }
}

function auth(req, res, next) {
  const key = req.headers['x-api-secret'] || req.query.secret;
  if (key !== API_SECRET) return res.status(401).json({ error: 'Invalid API secret' });
  next();
}

app.get('/', (req, res) => res.json({ service: 'MyMarket WhatsApp', status: 'running', uptime: Math.floor(process.uptime()) + 's', sessions: Object.keys(sessions).length }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/start', auth, async (req, res) => {
  try {
    const { storeId } = req.body;
    if (!storeId) return res.status(400).json({ error: 'storeId required' });
    console.log(`[${storeId}] START requested`);
    await startSession(storeId);
    // Wait up to 15 seconds for QR
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const s = getStatus(storeId);
      if (s.qr) return res.json(s);
      if (s.connected) return res.json(s);
    }
    res.json(getStatus(storeId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/status/:storeId', auth, (req, res) => {
  const s = getStatus(req.params.storeId);
  res.json(s);
});

app.post('/send', auth, async (req, res) => {
  try {
    const { storeId, phone, message } = req.body;
    if (!storeId || !phone) return res.status(400).json({ error: 'storeId and phone required' });
    const result = await sendMessage(storeId, phone, message || 'Hello from your store!');
    if (result.success) res.json(result);
    else res.status(400).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/disconnect', auth, async (req, res) => {
  try {
    const { storeId } = req.body;
    const session = sessions[storeId];
    if (session?.sock) {
      try { await session.sock.logout(); } catch (e) {}
      try { session.sock.end(); } catch (e) {}
    }
    const sessionDir = path.join(AUTH_DIR, storeId);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    sessions[storeId] = { status: 'disconnected', qr: null, phone: null, name: null };
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`WhatsApp service on port ${PORT}`);
});
