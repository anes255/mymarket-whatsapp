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
  // Kill old socket
  if (sessions[storeId]?.sock) {
    try { sessions[storeId].sock.ws.close(); } catch (e) {}
    try { sessions[storeId].sock.end(); } catch (e) {}
  }

  const sessionDir = path.join(AUTH_DIR, storeId);
  // Clear old session to force fresh QR
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  console.log(`[${storeId}] Creating socket (Baileys v6)...`);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['MyMarket', 'Chrome', '4.0.0'],
    connectTimeoutMs: 60000,
  });

  sessions[storeId] = { sock, status: 'connecting', qr: null, phone: null, name: null, lastConnected: null };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(`[${storeId}] event: conn=${connection} qr=${!!qr} code=${lastDisconnect?.error?.output?.statusCode}`);

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        sessions[storeId].qr = qrDataUrl;
        sessions[storeId].status = 'waiting_qr';
        console.log(`[${storeId}] ✅ QR READY`);
      } catch (e) { console.log(`[${storeId}] QR error:`, e.message); }
    }

    if (connection === 'open') {
      const user = sock.user;
      sessions[storeId].status = 'connected';
      sessions[storeId].qr = null;
      sessions[storeId].phone = user?.id?.split(':')[0] || user?.id?.split('@')[0] || '';
      sessions[storeId].name = user?.name || '';
      sessions[storeId].lastConnected = new Date().toISOString();
      console.log(`[${storeId}] ✅ CONNECTED: +${sessions[storeId].phone}`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[${storeId}] CLOSED code=${code} reconnect=${shouldReconnect}`);
      sessions[storeId].status = 'disconnected';

      if (shouldReconnect) {
        console.log(`[${storeId}] Reconnecting in 5s...`);
        setTimeout(() => startSession(storeId), 5000);
      } else {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        sessions[storeId].status = 'logged_out';
        sessions[storeId].qr = null;
      }
    }
  });
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
    console.log(`[${storeId}] ✅ SENT to ${num}`);
    return { success: true, messageId: result.key.id, to: num };
  } catch (e) {
    console.error(`[${storeId}] ❌ SEND ERROR:`, e.message);
    return { success: false, reason: e.message };
  }
}

function auth(req, res, next) {
  const key = req.headers['x-api-secret'] || req.query.secret;
  if (key !== API_SECRET) return res.status(401).json({ error: 'Invalid API secret' });
  next();
}

app.get('/', (req, res) => res.json({ service: 'MyMarket WhatsApp', version: 'baileys-v6', uptime: Math.floor(process.uptime()) + 's' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/start', auth, async (req, res) => {
  try {
    const { storeId } = req.body;
    if (!storeId) return res.status(400).json({ error: 'storeId required' });
    console.log(`[${storeId}] START`);
    await startSession(storeId);
    // Wait up to 15s for QR
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const s = getStatus(storeId);
      if (s.qr || s.connected) return res.json(s);
    }
    res.json(getStatus(storeId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/status/:storeId', auth, (req, res) => res.json(getStatus(req.params.storeId)));

app.post('/send', auth, async (req, res) => {
  try {
    const { storeId, phone, message } = req.body;
    if (!storeId || !phone) return res.status(400).json({ error: 'storeId and phone required' });
    const result = await sendMessage(storeId, phone, message || 'Hello from your store!');
    if (result.success) res.json(result); else res.status(400).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/disconnect', auth, async (req, res) => {
  try {
    const { storeId } = req.body;
    if (sessions[storeId]?.sock) {
      try { await sessions[storeId].sock.logout(); } catch (e) {}
      try { sessions[storeId].sock.end(); } catch (e) {}
    }
    const sessionDir = path.join(AUTH_DIR, storeId);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    sessions[storeId] = { status: 'disconnected', qr: null, phone: null, name: null };
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`WhatsApp service (Baileys v6) on port ${PORT}`));
