const express = require('express');
const cors = require('cors');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay,
  Browsers,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { WebSocket } = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_SECRET = process.env.API_SECRET || 'mymarket-wa-secret-2026';
const AUTH_DIR = path.join(__dirname, 'wa-sessions');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Set to 'warn' so we can see Baileys actual error messages
const baileysLogger = pino({ level: 'warn' });

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
    console.error(`[${storeId}] startSession CRASH:`, e);
    sessions[storeId].status = 'error';
    sessions[storeId].error = e.message;
  }
}

async function createSocket(storeId, sessionDir) {
  let version;
  try {
    const vInfo = await fetchLatestBaileysVersion();
    version = vInfo.version;
    console.log(`[${storeId}] WA version: ${version.join('.')} (latest=${vInfo.isLatest})`);
  } catch (e) {
    console.log(`[${storeId}] fetchVersion failed: ${e.message}, using default`);
    version = [2, 3000, 1015901307]; // fallback
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  console.log(`[${storeId}] Creating socket...`);

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    printQRInTerminal: true,
    // Use Baileys built-in browser identity
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    connectTimeoutMs: 120000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    // These options help with connection stability
    retryRequestDelayMs: 2000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sessions[storeId].sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const code = lastDisconnect?.error?.output?.statusCode;
    const errorMsg = lastDisconnect?.error?.message || '';
    const errorData = lastDisconnect?.error?.data || lastDisconnect?.error?.output?.payload || '';

    // Full error logging
    console.log(`[${storeId}] conn.update → connection=${connection || '-'} qr=${!!qr} code=${code || '-'} error="${errorMsg}" data=${JSON.stringify(errorData)}`);

    if (lastDisconnect?.error) {
      console.log(`[${storeId}] FULL ERROR:`, JSON.stringify({
        message: lastDisconnect.error.message,
        statusCode: lastDisconnect.error.output?.statusCode,
        payload: lastDisconnect.error.output?.payload,
        data: lastDisconnect.error.data,
        isBoom: lastDisconnect.error.isBoom,
        stack: (lastDisconnect.error.stack || '').split('\n').slice(0, 3).join(' | '),
      }));
    }

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

      console.log(`[${storeId}] ❌ CLOSED code=${code} err="${errorMsg}" reconnect=${shouldReconnect} retry=${retries}/5`);

      if (!shouldReconnect) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        sessions[storeId].status = 'logged_out';
        sessions[storeId].qr = null;
        sessions[storeId].sock = null;
        return;
      }

      if (retries > 5) {
        sessions[storeId].status = 'error';
        sessions[storeId].error = `Failed after ${retries} attempts: ${errorMsg || 'unknown error'}`;
        sessions[storeId].qr = null;
        sessions[storeId].sock = null;
        return;
      }

      const backoff = Math.min(3000 * Math.pow(2, retries - 1), 48000);
      console.log(`[${storeId}] Retry ${retries}/5 in ${backoff / 1000}s...`);
      sessions[storeId].status = 'reconnecting';
      sessions[storeId].qr = null;

      setTimeout(async () => {
        try {
          await createSocket(storeId, sessionDir);
        } catch (e) {
          console.error(`[${storeId}] reconnect error:`, e);
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
    return { success: false, reason: 'WhatsApp not connected' };
  }
  let num = String(phone).replace(/[\s\-\+\(\)]/g, '');
  if (num.startsWith('00213')) num = num.substring(2);
  else if (num.startsWith('0')) num = '213' + num.substring(1);
  else if (!num.startsWith('213') && num.length <= 10) num = '213' + num;
  const jid = num + '@s.whatsapp.net';
  try {
    await delay(2000);
    const result = await session.sock.sendMessage(jid, { text: message });
    return { success: true, messageId: result.key.id, to: num };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}

function auth(req, res, next) {
  const key = req.headers['x-api-secret'] || req.query.secret;
  if (key !== API_SECRET) return res.status(401).json({ error: 'Invalid API secret' });
  next();
}

// ═══ ROUTES ═══
app.get('/', (req, res) => res.json({
  service: 'MyMarket WhatsApp', version: 'baileys-v9-debug',
  uptime: Math.floor(process.uptime()) + 's',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
}));

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

// ═══ CONNECTIVITY TEST — tests if Railway can reach WhatsApp servers ═══
app.get('/test-connectivity', auth, async (req, res) => {
  const results = {};

  // Test 1: DNS resolution
  try {
    const dns = require('dns').promises;
    const addrs = await dns.resolve4('web.whatsapp.com');
    results.dns = { ok: true, addresses: addrs };
  } catch (e) {
    results.dns = { ok: false, error: e.message };
  }

  // Test 2: HTTPS to WhatsApp web
  try {
    const resp = await fetch('https://web.whatsapp.com/check-update?version=0&platform=web');
    const text = await resp.text();
    results.https = { ok: resp.ok, status: resp.status, body: text.substring(0, 200) };
  } catch (e) {
    results.https = { ok: false, error: e.message };
  }

  // Test 3: WebSocket to WhatsApp
  try {
    const wsResult = await new Promise((resolve) => {
      const ws = new WebSocket('wss://web.whatsapp.com/ws/chat', {
        headers: { Origin: 'https://web.whatsapp.com' },
        timeout: 10000,
      });
      const timer = setTimeout(() => {
        ws.close();
        resolve({ ok: false, error: 'timeout after 10s' });
      }, 10000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        resolve({ ok: true, message: 'WebSocket connected successfully' });
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: e.message });
      });
    });
    results.websocket = wsResult;
  } catch (e) {
    results.websocket = { ok: false, error: e.message };
  }

  // Test 4: Baileys version check
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    results.baileys_version = { ok: true, version: version.join('.'), isLatest };
  } catch (e) {
    results.baileys_version = { ok: false, error: e.message };
  }

  results.node_version = process.version;
  results.platform = process.platform;

  res.json(results);
});

app.post('/start', auth, async (req, res) => {
  try {
    const { storeId } = req.body;
    if (!storeId) return res.status(400).json({ error: 'storeId required' });
    console.log(`[${storeId}] ▶ START requested`);

    startSession(storeId);

    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      const s = getStatus(storeId);
      if (s.qr || s.connected || s.status === 'error') return res.json(s);
    }
    res.json(getStatus(storeId));
  } catch (e) {
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
    result[id] = { status: s.status, hasQr: !!s.qr, phone: s.phone, error: s.error, retries: s.retries };
  }
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`✅ WhatsApp service (v9-debug) on port ${PORT}`);
  console.log(`   Node: ${process.version}`);
  console.log(`   Platform: ${process.platform} ${process.arch}`);
});
