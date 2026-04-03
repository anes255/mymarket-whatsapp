const express = require('express');
const cors = require('cors');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_SECRET = process.env.API_SECRET || 'mymarket-wa-secret-2026';
const AUTH_DIR = path.join(__dirname, 'wa-sessions');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Baileys REQUIRES a pino logger — without it the noise protocol handshake fails silently
const baileysLogger = pino({ level: process.env.LOG_LEVEL || 'silent' });

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
    retries: s.retries || 0,
  };
}

async function startSession(storeId) {
  const existing = sessions[storeId];
  if (existing) {
    if (existing.status === 'connected') return;
    if (existing.status === 'waiting_qr' && existing.qr) return;
    if (existing.status === 'connecting' && existing.startedAt && (Date.now() - existing.startedAt < 30000)) return;
  }

  // Kill old socket
  if (existing?.sock) {
    try { existing.sock.ws.close(); } catch (e) {}
    try { existing.sock.end(); } catch (e) {}
  }

  const sessionDir = path.join(AUTH_DIR, storeId);
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(sessionDir, { recursive: true });

  sessions[storeId] = {
    sock: null, status: 'connecting', qr: null,
    phone: null, name: null, lastConnected: null,
    error: null, retries: 0, startedAt: Date.now(),
  };

  try {
    await createSocket(storeId, sessionDir);
  } catch (e) {
    console.error(`[${storeId}] startSession error:`, e.message);
    sessions[storeId].status = 'error';
    sessions[storeId].error = e.message;
  }
}

async function createSocket(storeId, sessionDir) {
  // Fetch the correct WA Web protocol version — without this, WhatsApp rejects the connection
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[${storeId}] WA Web version: ${version.join('.')} (latest=${isLatest})`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  console.log(`[${storeId}] Creating Baileys socket...`);

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    printQRInTerminal: true,
    browser: ['MyMarket', 'Chrome', '4.0.0'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
  });

  sessions[storeId].sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const code = lastDisconnect?.error?.output?.statusCode;
    console.log(`[${storeId}] event → conn=${connection || '-'}, qr=${!!qr}, code=${code || '-'}`);

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        sessions[storeId].qr = qrDataUrl;
        sessions[storeId].status = 'waiting_qr';
        sessions[storeId].error = null;
        sessions[storeId].retries = 0;
        console.log(`[${storeId}] ✅ QR READY`);
      } catch (e) {
        console.error(`[${storeId}] QR encode error:`, e.message);
      }
    }

    if (connection === 'open') {
      const user = sock.user;
      sessions[storeId].status = 'connected';
      sessions[storeId].qr = null;
      sessions[storeId].error = null;
      sessions[storeId].retries = 0;
      sessions[storeId].phone = user?.id?.split(':')[0] || user?.id?.split('@')[0] || '';
      sessions[storeId].name = user?.name || '';
      sessions[storeId].lastConnected = new Date().toISOString();
      console.log(`[${storeId}] ✅ CONNECTED: +${sessions[storeId].phone}`);
    }

    if (connection === 'close') {
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      const retries = (sessions[storeId].retries || 0) + 1;
      sessions[storeId].retries = retries;

      console.log(`[${storeId}] ❌ CLOSED code=${code} reconnect=${shouldReconnect} retry=${retries}/5`);

      if (!shouldReconnect) {
        // Logged out — clean up
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        sessions[storeId].status = 'logged_out';
        sessions[storeId].qr = null;
        sessions[storeId].sock = null;
        return;
      }

      if (retries > 5) {
        sessions[storeId].status = 'error';
        sessions[storeId].error = `Connection failed after ${retries} attempts. Click Generate QR again.`;
        sessions[storeId].qr = null;
        sessions[storeId].sock = null;
        return;
      }

      // Exponential backoff: 3s, 6s, 12s, 24s, 48s
      const backoff = Math.min(3000 * Math.pow(2, retries - 1), 48000);
      console.log(`[${storeId}] Retrying in ${backoff / 1000}s...`);
      sessions[storeId].status = 'reconnecting';
      sessions[storeId].qr = null;

      setTimeout(async () => {
        try {
          await createSocket(storeId, sessionDir);
        } catch (e) {
          console.error(`[${storeId}] reconnect error:`, e.message);
          sessions[storeId].status = 'error';
          sessions[storeId].error = e.message;
        }
      }, backoff);
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

// ═══ AUTH ═══
function auth(req, res, next) {
  const key = req.headers['x-api-secret'] || req.query.secret;
  if (key !== API_SECRET) return res.status(401).json({ error: 'Invalid API secret' });
  next();
}

// ═══ ROUTES ═══
app.get('/', (req, res) => res.json({
  service: 'MyMarket WhatsApp', version: 'baileys-v8-fixed',
  uptime: Math.floor(process.uptime()) + 's', activeSessions: Object.keys(sessions).length,
}));

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

app.post('/start', auth, async (req, res) => {
  try {
    const { storeId } = req.body;
    if (!storeId) return res.status(400).json({ error: 'storeId required' });
    console.log(`[${storeId}] ▶ START requested`);

    startSession(storeId);

    // Wait up to 8s for quick QR
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      const s = getStatus(storeId);
      if (s.qr || s.connected || s.status === 'error') return res.json(s);
    }
    res.json(getStatus(storeId));
  } catch (e) {
    console.error('[START ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
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

app.get('/sessions', auth, (req, res) => {
  const result = {};
  for (const [id, s] of Object.entries(sessions)) {
    result[id] = { status: s.status, connected: s.status === 'connected', hasQr: !!s.qr, phone: s.phone, error: s.error, retries: s.retries };
  }
  res.json(result);
});

app.listen(PORT, () => console.log(`✅ WhatsApp service (baileys-v8-fixed) on port ${PORT}`));
