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

// Ensure auth dir exists
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const sessions = {};

function getStatus(storeId) {
  const s = sessions[storeId];
  if (!s) return { status: 'not_started', connected: false };
  return {
    status: s.status,
    connected: s.status === 'connected',
    phone: s.phone || null,
    name: s.name || null,
    qr: s.qr || null,
    lastConnected: s.lastConnected || null,
    error: s.error || null,
    startedAt: s.startedAt || null,
  };
}

async function startSession(storeId) {
  // If already connecting and started less than 45s ago, don't restart
  const existing = sessions[storeId];
  if (existing && existing.status === 'connecting' && existing.startedAt) {
    const elapsed = Date.now() - existing.startedAt;
    if (elapsed < 45000) {
      console.log(`[${storeId}] Already connecting (${Math.round(elapsed/1000)}s ago), skipping restart`);
      return;
    }
  }
  // If already waiting for QR scan, don't restart
  if (existing && existing.status === 'waiting_qr' && existing.qr) {
    console.log(`[${storeId}] Already has QR, skipping restart`);
    return;
  }
  // If already connected, don't restart
  if (existing && existing.status === 'connected') {
    console.log(`[${storeId}] Already connected, skipping restart`);
    return;
  }

  // Kill old socket if any
  if (existing?.sock) {
    try { existing.sock.ws.close(); } catch (e) {}
    try { existing.sock.end(); } catch (e) {}
  }

  const sessionDir = path.join(AUTH_DIR, storeId);
  // Clear old session to force fresh QR
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(sessionDir, { recursive: true });

  // Mark as connecting IMMEDIATELY
  sessions[storeId] = {
    sock: null,
    status: 'connecting',
    qr: null,
    phone: null,
    name: null,
    lastConnected: null,
    error: null,
    startedAt: Date.now(),
  };

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    console.log(`[${storeId}] Creating Baileys socket...`);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      browser: ['MyMarket', 'Chrome', '4.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 30000,
    });

    sessions[storeId].sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log(`[${storeId}] connection.update → conn=${connection || '-'}, qr=${!!qr}, code=${lastDisconnect?.error?.output?.statusCode || '-'}`);

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          sessions[storeId].qr = qrDataUrl;
          sessions[storeId].status = 'waiting_qr';
          sessions[storeId].error = null;
          console.log(`[${storeId}] ✅ QR READY (${qrDataUrl.length} chars)`);
        } catch (e) {
          console.log(`[${storeId}] ❌ QR encode error:`, e.message);
          sessions[storeId].error = 'QR encode failed: ' + e.message;
        }
      }

      if (connection === 'open') {
        const user = sock.user;
        sessions[storeId].status = 'connected';
        sessions[storeId].qr = null;
        sessions[storeId].error = null;
        sessions[storeId].phone = user?.id?.split(':')[0] || user?.id?.split('@')[0] || '';
        sessions[storeId].name = user?.name || '';
        sessions[storeId].lastConnected = new Date().toISOString();
        console.log(`[${storeId}] ✅ CONNECTED: +${sessions[storeId].phone}`);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log(`[${storeId}] ❌ CLOSED code=${code} reconnect=${shouldReconnect}`);

        if (shouldReconnect) {
          sessions[storeId].status = 'reconnecting';
          sessions[storeId].qr = null;
          console.log(`[${storeId}] Reconnecting in 5s...`);
          setTimeout(() => startSession(storeId), 5000);
        } else {
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
          sessions[storeId].status = 'logged_out';
          sessions[storeId].qr = null;
          sessions[storeId].sock = null;
        }
      }
    });
  } catch (e) {
    console.error(`[${storeId}] ❌ startSession error:`, e.message);
    sessions[storeId].status = 'error';
    sessions[storeId].error = e.message;
  }
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

// ═══ AUTH MIDDLEWARE ═══
function auth(req, res, next) {
  const key = req.headers['x-api-secret'] || req.query.secret;
  if (key !== API_SECRET) return res.status(401).json({ error: 'Invalid API secret' });
  next();
}

// ═══ ROUTES ═══
app.get('/', (req, res) => res.json({
  service: 'MyMarket WhatsApp',
  version: 'baileys-v7-nonblocking',
  uptime: Math.floor(process.uptime()) + 's',
  activeSessions: Object.keys(sessions).length,
}));

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

// START — non-blocking! Fires off session, returns immediately
app.post('/start', auth, async (req, res) => {
  try {
    const { storeId } = req.body;
    if (!storeId) return res.status(400).json({ error: 'storeId required' });

    console.log(`[${storeId}] ▶ START requested`);

    // Fire and forget — don't await the full connection
    startSession(storeId);

    // Give it a brief moment (3s) to see if QR comes fast
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 500));
      const s = getStatus(storeId);
      if (s.qr || s.connected) {
        console.log(`[${storeId}] QR ready in ${(i+1)*500}ms`);
        return res.json(s);
      }
    }

    // Return current status — frontend will poll /status
    res.json(getStatus(storeId));
  } catch (e) {
    console.error(`[START ERROR]`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// STATUS — lightweight poll endpoint
app.get('/status/:storeId', auth, (req, res) => {
  res.json(getStatus(req.params.storeId));
});

// SEND
app.post('/send', auth, async (req, res) => {
  try {
    const { storeId, phone, message } = req.body;
    if (!storeId || !phone) return res.status(400).json({ error: 'storeId and phone required' });
    const result = await sendMessage(storeId, phone, message || 'Hello from your store!');
    if (result.success) res.json(result); else res.status(400).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DISCONNECT
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

// DEBUG — list all sessions
app.get('/sessions', auth, (req, res) => {
  const result = {};
  for (const [id, s] of Object.entries(sessions)) {
    result[id] = { status: s.status, connected: s.status === 'connected', hasQr: !!s.qr, phone: s.phone, error: s.error };
  }
  res.json(result);
});

app.listen(PORT, () => console.log(`✅ WhatsApp service on port ${PORT}`));
