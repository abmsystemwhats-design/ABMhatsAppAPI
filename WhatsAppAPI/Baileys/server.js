// ABM_WHATSAPP_API_VERSION=1.0.2
import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

console.log('[INIT] Baileys v7 loaded (ESM)');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const logger = pino({ level: 'silent' });
function log(l, m) {
  console.log('[' + new Date().toISOString().substr(11, 8) + '] [' + l + '] ' + m);
}

const PORT    = parseInt(process.env.PORT || '8080', 10);
const SESSION = process.env.SESSION_NAME || 'default';
const AUTH    = path.join(__dirname, 'baileys_auth', 'session-' + SESSION);

let sock      = null;
let qrData    = '';
let connected = false;
let curState  = 'init';
let booting   = false;
let timer     = null;
let lastAct   = Date.now();
let qrTries   = 0;
let attempts  = 0;

const wait = ms => new Promise(r => setTimeout(r, ms));

function mkAuth() {
  try { fs.mkdirSync(AUTH, { recursive: true }); } catch {}
}

function sched(ms) {
  if (timer) return;
  ms = Math.max(ms, 5000);
  log('INFO', 'Restart in ' + (ms / 1000) + 's');
  timer = setTimeout(() => {
    timer = null;
    boot().catch(() => {});
  }, ms);
}

function unsched() {
  if (timer) { clearTimeout(timer); timer = null; }
}

function wipe() {
  log('INFO', 'Wiping session...');
  connected = false;
  qrData    = '';
  qrTries   = 0;
  curState  = 'wiped';
  try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch {}
  mkAuth();
}

async function cleanup() {
  if (!sock) return;
  try { sock.ev.removeAllListeners(); } catch {}
  try { sock.ws.close(); } catch {}
  try { sock.end(undefined); } catch {}
  sock = null;
}

async function getVersion() {
  try {
    const v = await fetchLatestBaileysVersion();
    if (v && v.version) {
      log('INFO', 'WA version: ' + v.version.join('.'));
      return v.version;
    }
  } catch (e) {
    log('WARNING', 'Version fetch: ' + e.message);
  }
  return undefined;
}

async function boot() {
  if (booting) return;
  booting = true;
  unsched();
  attempts++;

  if (attempts > 10) {
    log('ERROR', 'Too many attempts. Wait 5 min...');
    attempts = 0;
    booting = false;
    setTimeout(() => boot().catch(() => {}), 300000);
    return;
  }

  try {
    await cleanup();
    await wait(2000);
    curState = 'starting';
    log('INFO', '=== Boot #' + attempts + ' ===');

    mkAuth();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH);

    const cfg = {
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      printQRInTerminal: false,
      browser: Browsers.windows('Desktop'),
      connectTimeoutMs: 120000,
      qrTimeout: 45000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 250,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      fireInitQueries: false,
      shouldIgnoreJid: jid => jid?.includes('@g.us') || jid?.includes('@broadcast'),
      getMessage: async () => ({ conversation: '' }),
      patchMessageBeforeSending: msg => {
        if (msg.buttonsMessage || msg.listMessage || msg.templateMessage) {
          msg = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...msg } } };
        }
        return msg;
      }
    };

    const ver = await getVersion();
    if (ver) cfg.version = ver;

    sock = makeWASocket(cfg);

    sock.ev.on('connection.update', async u => {
      const { qr, connection, lastDisconnect } = u;

      if (qr) {
        qrTries++;
        attempts = 0;
        log('INFO', 'QR received (' + qrTries + '/5)');
        if (qrTries > 5) { wipe(); sched(10000); return; }
        try {
          qrData = await qrcode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
          connected = false;
          curState = 'qr';
        } catch (e) { log('ERROR', 'QR gen: ' + e.message); }
        return;
      }

      if (connection === 'open') {
        qrData = ''; qrTries = 0; attempts = 0;
        connected = true; curState = 'ready'; lastAct = Date.now();
        log('SUCCESS', 'CONNECTED');
        return;
      }

      if (connection === 'connecting') { curState = 'connecting'; return; }

      if (connection === 'close') {
        connected = false;
        const code = lastDisconnect?.error?.output?.statusCode || 0;
        log('WARNING', 'Closed: ' + code);

        if (code === 401 || code === DisconnectReason.loggedOut) {
          wipe(); sched(5000);
        } else if (code === 405) {
          log('WARNING', '405 - retry without wipe');
          await cleanup();
          sched(Math.min(attempts * 15000, 120000));
        } else if (code === 403) {
          wipe(); sched(180000);
        } else if (code === 500 || code === DisconnectReason.badSession) {
          wipe(); sched(5000);
        } else if (code === 515 || code === DisconnectReason.restartRequired) {
          sched(3000);
        } else if (code === 408 || code === DisconnectReason.timedOut) {
          sched(5000);
        } else {
          if (attempts >= 5) wipe();
          sched(10000);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // ═══════════════════════════════════════════════════════════
    // 🤖 استقبال الرسائل الواردة وإرسالها إلى Bot Listener (C#)
    // ═══════════════════════════════════════════════════════════
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      lastAct = Date.now();
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
                // تجاهل رسائلنا + المجموعات + الحالات
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid || '';
      if (jid.includes('@g.us') || jid.includes('@broadcast') || jid === 'status@broadcast') continue;

      // استخراج النص
      const text = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption
                || msg.message?.videoMessage?.caption
                || '';

      if (!text || !text.trim()) continue;

      // ═══════════════════════════════════════════════════════════
      // 🔧 الحل: معالجة LID JIDs (Baileys v7)
      // ═══════════════════════════════════════════════════════════
      let sender = '';

      if (jid.includes('@lid')) {
        // محاولة استخراج الرقم الحقيقي من الحقول البديلة
        const altJid = msg.key.remoteJidAlt
                    || msg.key.participantAlt
                    || msg.key.senderPn
                    || '';

        if (altJid && altJid.includes('@s.whatsapp.net')) {
          sender = altJid.split('@')[0];
          log('INFO', 'LID resolved: ' + jid + ' → ' + sender);
        } else {
          // لا يوجد بديل — تجاهل الرسالة مع تسجيل
          log('WARNING', 'Skipping LID message (no alt): ' + jid);
          continue;
        }
      } else {
        // JID عادي (رقم هاتف)
        sender = jid.split('@')[0];
      }

      if (!sender) continue;

      const botPort = parseInt(process.env.BOT_PORT || '5001', 10);
          // إرسال إلى C# Bot Listener
          fetch(`http://127.0.0.1:${botPort}/incoming`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              phone: sender,
              message: text.trim(),
              timestamp: Date.now(),
              pushName: msg.pushName || ''
            })
          }).catch(err => {
            log('WARNING', 'Bot forward failed: ' + err.message);
          });

        } catch (e) {
          log('ERROR', 'Message handler: ' + e.message);
        }
      }
    });

    curState = 'initializing';
    log('INFO', 'Socket created');

  } catch (err) {
    connected = false; curState = 'error';
    log('ERROR', 'Boot: ' + err.message);
    sched(15000);
  } finally {
    booting = false;
  }
}

mkAuth();
wait(1500).then(() => boot().catch(e => log('ERROR', e.message)));

/* ===== Routes ===== */
app.get('/qr', (_, res) => res.json({ qr: qrData, state: curState, retry: qrTries }));

app.get('/status', (_, res) => res.json({
  connected, starting: booting, state: curState, engine: 'baileys',
  qrAvailable: !!qrData, qrRetry: qrTries, connectionAttempts: attempts,
  lastActivity: new Date(lastAct).toISOString()
}));

app.post('/check-number', async (req, res) => {
  try {
    if (!connected || !sock) return res.status(503).json({ valid: false, exists: false, error: 'Not connected' });
    const num = (req.body.number || '').toString().replace(/\D/g, '');
    if (num.length < 8 || num.length > 15) return res.status(400).json({ valid: false, exists: false, error: 'Invalid length' });
    const jid = num + '@s.whatsapp.net';
    const r = await Promise.race([sock.onWhatsApp(jid), wait(15000).then(() => { throw new Error('Timeout'); })]);
    lastAct = Date.now();
    res.json({ valid: true, exists: r?.[0]?.exists || false, jid, number: num });
  } catch (e) { res.status(500).json({ valid: false, exists: false, error: e.message }); }
});

app.post('/send', async (req, res) => {
  try {
    if (!connected || !sock) return res.status(503).json({ status: 'error', message: 'Not connected' });
    const { number, message, media, filename, mediaType, mimetype } = req.body;
    if (!number) return res.status(400).json({ status: 'error', message: 'No number' });
    const num = number.toString().replace(/\D/g, '');
    const jid = num + '@s.whatsapp.net';
    try {
      const chk = await Promise.race([sock.onWhatsApp(jid), wait(10000).then(() => { throw new Error('timeout'); })]);
      if (!chk?.[0]?.exists) return res.json({ status: 'error', message: 'Not on WhatsApp' });
    } catch {}
    let sent;
    if (media) {
      const buf = Buffer.from(media, 'base64');
      const mt = mimetype || (mediaType === 'image' ? 'image/jpeg' : 'application/pdf');
      if (mediaType === 'image') sent = await sock.sendMessage(jid, { image: buf, caption: message || '', mimetype: mt });
      else sent = await sock.sendMessage(jid, { document: buf, caption: message || '', mimetype: mt, fileName: filename || 'document.pdf' });
    } else {
      sent = await sock.sendMessage(jid, { text: message || '' });
    }
    lastAct = Date.now();
    res.json({ status: 'sent', messageId: sent?.key?.id, to: jid });
  } catch (e) { res.status(500).json({ status: 'error', error: e.message }); }
});

app.get('/logout', async (_, res) => {
  try {
    if (sock) try { await sock.logout(); } catch {}
    wipe(); await cleanup(); sched(5000);
    res.json({ status: 'logged_out' });
  } catch (e) { res.status(500).json({ status: 'error', error: e.message }); }
});

app.get('/restart', async (_, res) => {
  unsched(); await cleanup(); attempts = 0;
  await wait(1000); boot().catch(() => {});
  res.json({ status: 'restarting' });
});

// ═══════════════════════════════════════════════════════════
// 🤖 Bot Reply - بدون check-number (أسرع للرد التلقائي)
// ═══════════════════════════════════════════════════════════
app.post('/reply', async (req, res) => {
  try {
    if (!connected || !sock)
      return res.status(503).json({ status: 'error', message: 'Not connected' });

    const { number, message } = req.body || {};
    if (!number || !message)
      return res.status(400).json({ status: 'error', message: 'Missing params' });

    const num = String(number).replace(/\D/g, '');
    if (num.length < 8 || num.length > 15)
      return res.status(400).json({ status: 'error', message: 'Invalid number' });

    const jid = num + '@s.whatsapp.net';
    const sent = await sock.sendMessage(jid, { text: message });

    lastAct = Date.now();
    res.json({
      status: 'sent',
      messageId: sent?.key?.id || '',
      to: jid
    });
  } catch (e) {
    log('ERROR', 'Reply: ' + e.message);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

app.get('/reset', async (_, res) => {
  unsched(); await cleanup(); wipe(); attempts = 0;
  await wait(2000); boot().catch(() => {});
  res.json({ status: 'reset' });
});
app.get('/me', (_, res) => {
  if (!connected || !sock) {
    return res.status(503).json({ number: null, name: null });
  }
  try {
    const jid = sock.user?.id || '';
    // جيد مثلاً: 9665xxxxxxxx:xx@s.whatsapp.net
    const number = jid.split(':')[0].split('@')[0];
    const name   = sock.user?.name || '';
    res.json({ number, name, jid });
  } catch (e) {
    res.status(500).json({ number: null, name: null, error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', connected }));

process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
process.on('SIGINT',  async () => { await cleanup(); process.exit(0); });
process.on('uncaughtException',  e => log('ERROR', 'Uncaught: ' + e.message));
process.on('unhandledRejection', e => log('ERROR', 'Unhandled: ' + e));

app.listen(PORT, '0.0.0.0', () => log('INFO', 'SERVER_STARTED port=' + PORT));
