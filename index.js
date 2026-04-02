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

// ═══════ SESSION MANAGEMENT ═══════
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
    try { sessions[storeId].sock.end(); } catch (e) {}
  }

  const sessionDir = path.join(AUTH_DIR, storeId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['MyMarket', 'Chrome', '120.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
    emitOwnEvents: false,
  });

  sessions[storeId] = { sock, status: 'connecting', qr: null, phone: null, name: null, lastConnected: null };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        sessions[storeId].qr = qrDataUrl;
        sessions[storeId].status = 'waiting_qr';
        console.log(`[${storeId}] QR code generated`);
      } catch (e) { console.log('QR error:', e.message); }
    }

    if (connection === 'open') {
      const user = sock.user;
      sessions[storeId].status = 'connected';
      sessions[storeId].qr = null;
      sessions[storeId].phone = user?.id?.split(':')[0] || user?.id?.split('@')[0] || 'unknown';
      sessions[storeId].name = user?.name || '';
      sessions[storeId].lastConnected = new Date().toISOString();
      console.log(`[${storeId}] ✅ Connected: ${sessions[storeId].phone}`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[${storeId}] Disconnected: code=${code}, reconnect=${shouldReconnect}`);
      sessions[storeId].status = 'disconnected';
      sessions[storeId].qr = null;

      if (shouldReconnect) {
        setTimeout(() => startSession(storeId), 5000);
      } else {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        sessions[storeId].status = 'logged_out';
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

  // Normalize Algerian phone
  let num = String(phone).replace(/[\s\-\+\(\)]/g, '');
  if (num.startsWith('00213')) num = num.substring(2);
  else if (num.startsWith('0')) num = '213' + num.substring(1);
  else if (!num.startsWith('213') && num.length <= 10) num = '213' + num;

  const jid = num + '@s.whatsapp.net';

  try {
    await delay(2000); // Rate limit
    const result = await session.sock.sendMessage(jid, { text: message });
    console.log(`[${storeId}] ✅ Sent to ${num}`);
    return { success: true, messageId: result.key.id, to: num };
  } catch (e) {
    console.error(`[${storeId}] ❌ Send error:`, e.message);
    return { success: false, reason: e.message };
  }
}

// ═══════ AUTH MIDDLEWARE ═══════
function auth(req, res, next) {
  const key = req.headers['x-api-secret'] || req.query.secret;
  if (key !== API_SECRET) return res.status(401).json({ error: 'Invalid API secret' });
  next();
}

// ═══════ ROUTES ═══════

// Health check (no auth)
app.get('/', (req, res) => res.json({ service: 'MyMarket WhatsApp', status: 'running', uptime: Math.floor(process.uptime()) + 's' }));
app.get('/health', (req, res) => res.json({ ok: true }));

// Start session — generates QR
app.post('/start', auth, async (req, res) => {
  try {
    const { storeId } = req.body;
    if (!storeId) return res.status(400).json({ error: 'storeId required' });
    startSession(storeId).catch(e => console.log('Start error:', e.message));
    res.json({ status: 'starting' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get status + QR
app.get('/status/:storeId', auth, (req, res) => {
  res.json(getStatus(req.params.storeId));
});

// Send message
app.post('/send', auth, async (req, res) => {
  try {
    const { storeId, phone, message } = req.body;
    if (!storeId || !phone) return res.status(400).json({ error: 'storeId and phone required' });
    const result = await sendMessage(storeId, phone, message || 'Hello from your store!');
    if (result.success) res.json(result);
    else res.status(400).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Disconnect
app.post('/disconnect', auth, async (req, res) => {
  try {
    const { storeId } = req.body;
    const session = sessions[storeId];
    if (session?.sock) {
      try { await session.sock.logout(); session.sock.end(); } catch (e) {}
    }
    const sessionDir = path.join(AUTH_DIR, storeId);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    sessions[storeId] = { status: 'disconnected', qr: null, phone: null, name: null };
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ RESTORE SESSIONS ON START ═══════
async function restoreSessions() {
  if (!fs.existsSync(AUTH_DIR)) { fs.mkdirSync(AUTH_DIR, { recursive: true }); return; }
  const dirs = fs.readdirSync(AUTH_DIR);
  for (const storeId of dirs) {
    const sessionDir = path.join(AUTH_DIR, storeId);
    if (fs.statSync(sessionDir).isDirectory()) {
      console.log(`Restoring session: ${storeId}`);
      try { await startSession(storeId); } catch (e) { console.log(`Restore failed ${storeId}:`, e.message); }
    }
  }
}

app.listen(PORT, async () => {
  console.log(`🟢 WhatsApp service running on port ${PORT}`);
  console.log(`🔑 API_SECRET: ${API_SECRET.substring(0, 10)}...`);
  await restoreSessions();
});
