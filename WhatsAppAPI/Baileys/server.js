ABM_WHATSAPP_API_VERSION=__VERSION__
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || path.join(__dirname, '.puppeteer-cache');

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

function log(level, message) {
  const timestamp = new Date().toISOString().substr(11, 8);
  console.log('[' + timestamp + '] [' + level + '] ' + message);
}

// ===== Env =====
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const SESSION_NAME = process.env.SESSION_NAME || 'default';
const HEADLESS_ENV = (process.env.HEADLESS || 'true').toLowerCase();
const HEADLESS = HEADLESS_ENV !== 'false';
const CHROME_PATH = process.env.CHROME_PATH || null;

// ===== Auth Storage =====
const WWEBJS_DATA_DIR = path.join(__dirname, 'wwebjs_auth');
try { fs.mkdirSync(WWEBJS_DATA_DIR, { recursive: true }); } catch {}
const CLIENT_SESSION_DIR = path.join(WWEBJS_DATA_DIR, 'session-' + SESSION_NAME);

// ===== State =====
let client = null;
let qrCodeData = '';
let sessionActive = false;
let lastState = 'init';
let starting = false;
let restartTimer = null;
let healthCheckInterval = null;
let lastActivityTime = Date.now();

// ===== Lock with Timeout =====
let opLock = Promise.resolve();

function withLock(fn, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      reject(new Error('Operation timeout'));
    }, timeoutMs);

    var execute = async function() {
      try {
        var result = await fn();
        clearTimeout(timer);
        resolve(result);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    };

    opLock = opLock.then(execute, execute);
  });
}

// ===== Health Check =====
function startHealthCheck() {
  stopHealthCheck();

  healthCheckInterval = setInterval(async function() {
    if (!sessionActive || !client) return;

    try {
      var state = await client.getState();
      log('DEBUG', 'Health check - State: ' + state);

      if (state === 'CONNECTED') {
        lastActivityTime = Date.now();
      } else if (state === 'UNPAIRED' || state === 'CONFLICT') {
        log('WARNING', 'Health check bad state: ' + state);
        sessionActive = false;
        lastState = 'health_check_failed';
        scheduleRestart(5000);
      }
    } catch (err) {
      log('ERROR', 'Health check failed: ' + err.message);
      sessionActive = false;
      lastState = 'health_check_error';
      scheduleRestart(5000);
    }
  }, 30000);

  log('INFO', 'Health check started (every 30s)');
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

// ===== Build Client =====
function buildClient() {
  var puppeteerOptions = {
    headless: HEADLESS ? 'new' : false,
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-accelerated-2d-canvas',
      '--disable-features=VizDisplayCompositor',
      '--disable-hang-monitor',
      '--js-flags=--max-old-space-size=512'
    ],
    timeout: 120000,
    protocolTimeout: 120000
  };

  if (CHROME_PATH) {
    puppeteerOptions.executablePath = CHROME_PATH;
  }

  return new Client({
    authStrategy: new LocalAuth({
      dataPath: WWEBJS_DATA_DIR,
      clientId: SESSION_NAME
    }),
    puppeteer: puppeteerOptions,
    qrMaxRetries: 5,
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    webVersionCache: {
      type: 'none'
    }
  });
}

// ===== Connection Management =====
function scheduleRestart(delayMs) {
  if (restartTimer) return;
  log('INFO', 'Restart scheduled in ' + (delayMs / 1000) + 's');
  restartTimer = setTimeout(function() {
    restartTimer = null;
    startWhatsapp().catch(function() {});
  }, delayMs);
}

function cancelRestart() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

async function cleanupClient() {
  stopHealthCheck();
  if (!client) return;

  try {
    client.removeAllListeners();
    await Promise.race([
      client.destroy(),
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error('destroy timeout')); }, 15000);
      })
    ]);
  } catch (err) {
    log('WARNING', 'Cleanup warning: ' + err.message);
    try {
      var browser = client && client.pupBrowser;
      if (browser) await browser.close();
    } catch (e) {}
  }

  client = null;
}

async function resetSession() {
  sessionActive = false;
  qrCodeData = '';
  lastState = 'reset_session';
  try { fs.rmSync(CLIENT_SESSION_DIR, { recursive: true, force: true }); } catch {}
}

// ===== Start WhatsApp =====
async function startWhatsapp() {
  if (starting) {
    log('WARNING', 'Already starting, skipping...');
    return;
  }
  starting = true;
  cancelRestart();

  try {
    await cleanupClient();
    lastState = 'starting';
    log('INFO', '=== Starting WhatsApp Client ===');

    client = buildClient();

    client.on('qr', async function(qr) {
      try {
        qrCodeData = await qrcode.toDataURL(qr);
        sessionActive = false;
        lastState = 'qr';
        log('INFO', 'QR Code generated - waiting for scan');
      } catch (e) {
        log('ERROR', 'QR generate failed: ' + e.message);
      }
    });

    client.on('authenticated', function() {
      lastState = 'authenticated';
      log('SUCCESS', 'Authenticated successfully');
    });

    client.on('ready', function() {
      qrCodeData = '';
      sessionActive = true;
      lastState = 'ready';
      lastActivityTime = Date.now();
      log('SUCCESS', 'CONNECTED - WhatsApp ready!');
      startHealthCheck();
    });

    client.on('auth_failure', async function(msg) {
      sessionActive = false;
      lastState = 'auth_failure';
      log('ERROR', 'Auth failure: ' + msg);
      await resetSession();
      scheduleRestart(5000);
    });

    client.on('disconnected', async function(reason) {
      sessionActive = false;
      lastState = 'disconnected';
      stopHealthCheck();
      log('WARNING', 'Disconnected: ' + reason);

      var reasonStr = String(reason || '').toLowerCase();
      if (reasonStr.includes('logout') || reasonStr.includes('unpaired')) {
        await resetSession();
        scheduleRestart(5000);
      } else {
        scheduleRestart(10000);
      }
    });

    client.on('change_state', function(state) {
      log('INFO', 'Connection state changed: ' + state);
      lastState = 'state_' + state;

      if (state === 'CONNECTED') {
        sessionActive = true;
        lastActivityTime = Date.now();
      } else if (state === 'OPENING') {
        log('INFO', 'WhatsApp reconnecting...');
      } else if (state === 'PAIRING') {
        sessionActive = false;
      } else if (state === 'TIMEOUT') {
        log('WARNING', 'Connection TIMEOUT - will restart');
        sessionActive = false;
        scheduleRestart(10000);
      }
    });

    client.on('loading_screen', function(percent, message) {
      log('INFO', 'Loading: ' + percent + '% - ' + message);
      lastState = 'loading_' + percent;
    });

    client.on('message', async function(msg) {
      lastActivityTime = Date.now();

      try {
        if (msg.fromMe) return;
        if (!msg.from) return;
        if (msg.from.includes('@g.us')) return;
        if (msg.from.includes('@broadcast')) return;
        if (msg.from === 'status@broadcast') return;

        if (msg.type !== 'chat' && msg.type !== 'image' && msg.type !== 'video') return;

        var text = (msg.body || '').trim();
        if (!text) return;

        var sender = msg.from.split('@')[0];
        var botPort = parseInt(process.env.BOT_PORT || '5001', 10);

        var pushName = '';
        try {
          if (msg.getContact) {
            var contact = await msg.getContact();
            pushName = contact?.pushname || contact?.name || '';
          }
        } catch (e) { /* ignore */ }

        fetch('http://127.0.0.1:' + botPort + '/incoming', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: sender,
            message: text,
            timestamp: Date.now(),
            pushName: pushName
          })
        }).catch(function(err) {
          log('WARNING', 'Bot forward failed: ' + err.message);
        });
      } catch (e) {
        log('ERROR', 'Message handler: ' + e.message);
      }
    });

    await Promise.race([
      client.initialize(),
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error('Initialize timeout (3 min)')); }, 180000);
      })
    ]);

    lastState = 'initializing';
  } catch (err) {
    sessionActive = false;
    lastState = 'start_error';
    log('ERROR', 'startWhatsapp error: ' + err.message);
    await cleanupClient();
    scheduleRestart(15000);
  } finally {
    starting = false;
  }
}

// ===== Graceful Shutdown =====
async function gracefulShutdown(signal) {
  log('INFO', signal + ' received - shutting down...');
  cancelRestart();
  stopHealthCheck();
  try { await cleanupClient(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });

process.on('uncaughtException', function(err) {
  log('ERROR', 'Uncaught Exception: ' + err.message);
});

process.on('unhandledRejection', function(reason) {
  log('ERROR', 'Unhandled Rejection: ' + (reason && reason.message ? reason.message : reason));
});

// ===== Error Handler =====
function handleClientError(res, err, context) {
  var msg = (err && err.message) ? err.message : String(err);
  log('ERROR', context + ' failed: ' + msg);

  var msgLower = msg.toLowerCase();
  if (
    msgLower.includes('detached frame') ||
    msgLower.includes('session closed') ||
    msgLower.includes('target closed') ||
    msgLower.includes('protocol error') ||
    msgLower.includes('page crashed') ||
    msgLower.includes('browser disconnected')
  ) {
    sessionActive = false;
    lastState = 'browser_error';
    scheduleRestart(3000);
  }

  return res.status(500).json({
    valid: false, exists: false,
    status: 'error',
    error: 'CHECK_FAILED',
    details: msg
  });
}

// ===== Start =====
startWhatsapp().catch(function(err) { log('ERROR', err.message); });

// ===== Routes =====
app.get('/qr', function(req, res) {
  res.json({ qr: qrCodeData });
});

app.get('/status', function(req, res) {
  res.json({
    connected: sessionActive,
    starting: starting,
    state: lastState,
    lastActivity: new Date(lastActivityTime).toISOString(),
    uptime: Math.floor((Date.now() - lastActivityTime) / 1000) + 's ago'
  });
});

app.post('/check-number', function(req, res) {
  return withLock(async function() {
    if (!sessionActive || !client) {
      return res.status(503).json({ valid: false, exists: false, error: 'Not connected' });
    }

    var number = req.body.number;
    if (!number) {
      return res.status(400).json({ valid: false, exists: false, error: 'No number provided' });
    }

    var cleanNumber = number.toString().replace(/\D/g, '');
    if (cleanNumber.length < 8 || cleanNumber.length > 15) {
      return res.status(400).json({ valid: false, exists: false, error: 'Invalid number length', number: cleanNumber });
    }

    var wid = cleanNumber + '@c.us';

    try {
      var exists = await client.isRegisteredUser(wid);
      lastActivityTime = Date.now();
      return res.json({ valid: true, exists: exists, jid: wid, number: cleanNumber });
    } catch (err) {
      return handleClientError(res, err, 'check-number');
    }
  }, 20000).catch(function(err) {
    return res.status(500).json({ valid: false, exists: false, error: err.message });
  });
});

app.post('/send', function(req, res) {
  return withLock(async function() {
    if (!sessionActive || !client) {
      return res.status(503).json({ status: 'error', message: 'Not connected' });
    }

    var number = req.body.number;
    var message = req.body.message;
    var media = req.body.media;
    var filename = req.body.filename;
    var mediaType = req.body.mediaType;
    var mimetype = req.body.mimetype;

    if (!number) {
      return res.status(400).json({ status: 'error', message: 'No number provided' });
    }

    var cleanNumber = number.toString().replace(/\D/g, '');
    if (cleanNumber.length < 8 || cleanNumber.length > 15) {
      return res.status(400).json({ status: 'error', message: 'Invalid number length', number: cleanNumber });
    }

    var chatId = cleanNumber + '@c.us';
    log('INFO', 'Sending to: ' + cleanNumber);

    try {
      var exists = await client.isRegisteredUser(chatId);
      if (!exists) {
        return res.json({ status: 'error', message: 'Number not on WhatsApp', number: cleanNumber });
      }
    } catch (err) {
      return handleClientError(res, err, 'send-precheck');
    }

    try {
      var sent = null;

      if (media) {
        var mt = mimetype || (mediaType === 'image' ? 'image/jpeg' : 'application/pdf');
        var name = filename || (mediaType === 'image' ? 'image.jpg' : 'document.pdf');
        var mm = new MessageMedia(mt, media, name);
        sent = await client.sendMessage(chatId, mm, { caption: message || '' });
      } else {
        sent = await client.sendMessage(chatId, message || '');
      }

      lastActivityTime = Date.now();
      var messageId = (sent && sent.id && sent.id._serialized) ? sent.id._serialized : ((sent && sent.id) ? sent.id : null);
      return res.json({ status: 'sent', messageId: messageId, to: chatId });
    } catch (err) {
      return handleClientError(res, err, 'send');
    }
  }, 60000).catch(function(err) {
    return res.status(500).json({ status: 'error', error: err.message });
  });
});

app.get('/logout', async function(req, res) {
  try {
    try { await client.logout(); } catch (e) {}
    await resetSession();
    await cleanupClient();
    scheduleRestart(3000);
    return res.json({ status: 'logged_out' });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/restart', async function(req, res) {
  log('INFO', 'Manual restart requested');
  cancelRestart();
  startWhatsapp().catch(function() {});
  return res.json({ status: 'restarting' });
});

app.listen(PORT, '0.0.0.0', function() {
  log('INFO', 'SERVER_STARTED on port ' + PORT);
});
