ABM_WHATSAPP_API_VERSION=__VERSION__
    // Engine: Baileys Enhanced (Stable)
    const express = require('express');
    const cors    = require('cors');
    const qrcode  = require('qrcode');
    const fs      = require('fs');
    const path    = require('path');
    const pino    = require('pino');

    /* ===== Load Baileys ===== */
    let makeWASocket, useMultiFileAuthState, DisconnectReason,
        makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers;

    (function() {
      const B = require('@whiskeysockets/baileys');
      makeWASocket                = B.default;
      useMultiFileAuthState       = B.useMultiFileAuthState;
      DisconnectReason            = B.DisconnectReason;
      makeCacheableSignalKeyStore = B.makeCacheableSignalKeyStore;
      fetchLatestBaileysVersion   = B.fetchLatestBaileysVersion;
      Browsers                    = B.Browsers;
      console.log('[INIT] Baileys Enhanced (Stable) loaded');
    })();

    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '50mb' }));

    const logger = pino({ level: 'silent' });
    function log(l, m) {
      console.log('[' + new Date().toISOString().substr(11, 8) + '] [' + l + '] ' + m);
    }

    const PORT    = parseInt(process.env.PORT || '8080', 10);
    const SESSION = process.env.SESSION_NAME || 'default';
    const AUTH    = path.join(__dirname, 'evo_auth', 'session-' + SESSION);

    let sock      = null;
    let qrData    = '';
    let connected = false;
    let curState  = 'init';
    let booting   = false;
    let timer     = null;
    let lastAct   = Date.now();
    let qrTries   = 0;
    let attempts  = 0;

    /* ═══ Enhanced: Exponential Backoff ═══ */
    let reconnectDelay = 3000;
    var MAX_RECONNECT_DELAY = 300000;
    var MIN_RECONNECT_DELAY = 3000;

    /* ═══ Enhanced: Health Check ═══ */
    let healthInterval = null;
    var HEALTH_CHECK_MS = 30000;
    var HEALTH_TIMEOUT  = 90000;

    /* ═══ Enhanced: Message Retry ═══ */
    var MAX_MSG_RETRIES = 3;

    var wait = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

    function mkAuth() {
      try { fs.mkdirSync(AUTH, { recursive: true }); } catch (e) {}
    }

    function resetDelay()    { reconnectDelay = MIN_RECONNECT_DELAY; }
    function increaseDelay() { reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY); }

    function sched(ms) {
      if (timer) return;
      ms = Math.max(ms, MIN_RECONNECT_DELAY);
      ms = Math.min(ms, MAX_RECONNECT_DELAY);
      log('INFO', 'Restart in ' + (ms / 1000) + 's');
      timer = setTimeout(function() {
        timer = null;
        boot().catch(function() {});
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
      try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (e) {}
      mkAuth();
    }

    async function cleanup() {
      stopHealth();
      if (!sock) return;
      try { sock.ev.removeAllListeners(); } catch (e) {}
      try { sock.ws.close(); } catch (e) {}
      try { sock.end(undefined); } catch (e) {}
      sock = null;
    }

    /* ═══ Enhanced: Health Check ═══ */
    function startHealth() {
      stopHealth();
      healthInterval = setInterval(async function() {
        if (!connected || !sock) return;

        try {
          var idle = Date.now() - lastAct;

          if (idle > HEALTH_TIMEOUT * 3) {
            log('WARNING', 'No activity ' + Math.floor(idle / 1000) + 's. Reconnecting...');
            connected = false;
            curState = 'health_timeout';
            await cleanup();
            resetDelay();
            sched(MIN_RECONNECT_DELAY);
            return;
          }

          try {
            if (sock && sock.ws && sock.ws.readyState !== 1) {
              log('WARNING', 'WebSocket closed (state=' + sock.ws.readyState + '). Reconnecting...');
              connected = false;
              curState = 'ws_closed';
              await cleanup();
              resetDelay();
              sched(MIN_RECONNECT_DELAY);
              return;
            }
          } catch (e) {}

        } catch (err) {
          log('WARNING', 'Health error: ' + err.message);
        }
      }, HEALTH_CHECK_MS);
      log('INFO', 'Health check started (every ' + (HEALTH_CHECK_MS / 1000) + 's)');
    }

    function stopHealth() {
      if (healthInterval) { clearInterval(healthInterval); healthInterval = null; }
    }

    async function getVersion() {
      try {
        var v = await fetchLatestBaileysVersion();
        if (v && v.version) {
          log('INFO', 'WA version: ' + v.version.join('.'));
          return v.version;
        }
      } catch (e) { log('WARNING', 'Version fetch: ' + e.message); }
      return undefined;
    }

    /* ═══ Enhanced: Boot with Exponential Backoff ═══ */
    async function boot() {
      if (booting) return;
      booting = true;
      unsched();
      attempts++;

      if (attempts > 15) {
        log('ERROR', 'Too many attempts (' + attempts + '). Wait 5 min...');
        attempts = 0;
        booting = false;
        setTimeout(function() { boot().catch(function() {}); }, MAX_RECONNECT_DELAY);
        return;
      }

      try {
        await cleanup();
        await wait(2000);
        curState = 'starting';
        log('INFO', '=== Boot #' + attempts + ' (delay=' + reconnectDelay + 'ms) ===');

        mkAuth();
        var authResult = await useMultiFileAuthState(AUTH);
        var state = authResult.state;
        var saveCreds = authResult.saveCreds;

        var cfg = {
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
          },
          logger: logger,
          printQRInTerminal: false,
          browser: Browsers.windows('Desktop'),
          connectTimeoutMs: 120000,
          qrTimeout: 60000,
          defaultQueryTimeoutMs: 90000,
          keepAliveIntervalMs: 25000,
          retryRequestDelayMs: 500,
          markOnlineOnConnect: false,
          generateHighQualityLinkPreview: false,
          syncFullHistory: false,
          fireInitQueries: false,
          shouldIgnoreJid: function(jid) {
            if (!jid) return true;
            return jid.indexOf('@g.us') !== -1 || jid.indexOf('@broadcast') !== -1;
          },
          getMessage: async function() { return { conversation: '' }; },
          patchMessageBeforeSending: function(msg) {
            if (msg.buttonsMessage || msg.listMessage || msg.templateMessage) {
              msg = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...msg } } };
            }
            return msg;
          }
        };

        var ver = await getVersion();
        if (ver) cfg.version = ver;

        sock = makeWASocket(cfg);

        /* ═══ Enhanced: Connection update with smart reconnect ═══ */
        sock.ev.on('connection.update', async function(u) {
          var qr = u.qr;
          var connection = u.connection;
          var lastDisconnect = u.lastDisconnect;

          if (qr) {
            qrTries++;
            attempts = 0;
            resetDelay();
            log('INFO', 'QR received (' + qrTries + '/7)');

            if (qrTries > 7) {
              log('WARNING', 'Too many QR attempts. Wiping...');
              wipe();
              sched(10000);
              return;
            }

            try {
              qrData = await qrcode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
              connected = false;
              curState = 'qr';
            } catch (e) { log('ERROR', 'QR gen: ' + e.message); }
            return;
          }

          if (connection === 'open') {
            qrData = ''; qrTries = 0; attempts = 0;
            resetDelay();
            connected = true; curState = 'ready'; lastAct = Date.now();
            log('SUCCESS', 'CONNECTED - WhatsApp ready!');
            startHealth();
            return;
          }

          if (connection === 'connecting') { curState = 'connecting'; return; }

          if (connection === 'close') {
            connected = false;
            stopHealth();

            var code = 0;
            try {
              code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
                ? lastDisconnect.error.output.statusCode : 0;
            } catch (e) { code = 0; }

            log('WARNING', 'Closed code=' + code);

            if (code === 401 || code === DisconnectReason.loggedOut) {
              log('WARNING', 'Logged out. Wiping...');
              wipe(); resetDelay(); sched(5000);
            } else if (code === 403) {
              log('WARNING', 'Forbidden. Wait 3min...');
              wipe(); sched(180000);
            } else if (code === 405) {
              log('WARNING', '405 retry without wipe');
              await cleanup(); increaseDelay(); sched(reconnectDelay);
            } else if (code === 500 || code === DisconnectReason.badSession) {
              log('WARNING', 'Bad session. Wiping...');
              wipe(); resetDelay(); sched(5000);
            } else if (code === 515 || code === DisconnectReason.restartRequired) {
              resetDelay(); sched(3000);
            } else if (code === 408 || code === DisconnectReason.timedOut) {
              sched(Math.min(reconnectDelay, 5000));
            } else if (code === 440) {
              log('WARNING', 'Connection replaced by another device');
              sched(10000);
            } else {
              increaseDelay();
              if (attempts >= 8) { log('WARNING', 'Many failures. Wiping...'); wipe(); resetDelay(); }
              sched(reconnectDelay);
            }
          }
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', async function(update) {
          lastAct = Date.now();

          var messages = update && update.messages ? update.messages : [];
          var type = update && update.type ? update.type : '';
          if (type !== 'notify') return;

          for (var i = 0; i < messages.length; i++) {
            var msg = messages[i];
            try {
              if (msg.key && msg.key.fromMe) continue;
              var jid = (msg.key && msg.key.remoteJid) || '';
              if (!jid) continue;
              if (jid.indexOf('@g.us') !== -1) continue;
              if (jid.indexOf('@broadcast') !== -1) continue;
              if (jid === 'status@broadcast') continue;

              var m = msg.message || {};
              var text = m.conversation
                      || (m.extendedTextMessage && m.extendedTextMessage.text)
                      || (m.imageMessage && m.imageMessage.caption)
                      || (m.videoMessage && m.videoMessage.caption)
                      || '';

              if (!text || !text.trim()) continue;

              var sender = jid.split('@')[0];
              var botPort = parseInt(process.env.BOT_PORT || '5001', 10);

              fetch('http://127.0.0.1:' + botPort + '/incoming', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  phone: sender,
                  message: text.trim(),
                  timestamp: Date.now(),
                  pushName: msg.pushName || ''
                })
              }).catch(function(err) {
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
        increaseDelay(); sched(reconnectDelay);
      } finally {
        booting = false;
      }
    }

    mkAuth();
    wait(1500).then(function() { boot().catch(function(e) { log('ERROR', e.message); }); });

    /* ═══ Enhanced: Send with retry ═══ */
    async function sendWithRetry(jid, content, retries) {
      retries = retries || 0;
      try {
        var result = await Promise.race([
          sock.sendMessage(jid, content),
          wait(60000).then(function() { throw new Error('Send timeout 60s'); })
        ]);
        return result;
      } catch (err) {
        if (retries < MAX_MSG_RETRIES) {
          var d = (retries + 1) * 2000;
          log('WARNING', 'Retry ' + (retries+1) + '/' + MAX_MSG_RETRIES + ' in ' + d + 'ms: ' + err.message);
          await wait(d);
          return sendWithRetry(jid, content, retries + 1);
        }
        throw err;
      }
    }

    /* ═══ Routes ═══ */
    app.get('/qr', function(req, res) {
      res.json({ qr: qrData, state: curState, retry: qrTries });
    });

    app.get('/status', function(req, res) {
      res.json({
        connected: connected, starting: booting, state: curState,
        engine: 'baileys-enhanced',
        qrAvailable: !!qrData, qrRetry: qrTries,
        connectionAttempts: attempts, reconnectDelay: reconnectDelay,
        lastActivity: new Date(lastAct).toISOString()
      });
    });

    app.post('/check-number', async function(req, res) {
      try {
        if (!connected || !sock)
          return res.status(503).json({ valid: false, exists: false, error: 'Not connected' });

        var num = (req.body.number || '').toString().replace(/\D/g, '');
        if (num.length < 8 || num.length > 15)
          return res.status(400).json({ valid: false, exists: false, error: 'Invalid length' });

        var jid = num + '@s.whatsapp.net';
        var r = await Promise.race([
          sock.onWhatsApp(jid),
          wait(15000).then(function() { throw new Error('Timeout'); })
        ]);

        lastAct = Date.now();
        var exists = r && r[0] && r[0].exists;
        res.json({ valid: true, exists: !!exists, jid: jid, number: num });
      } catch (e) {
        res.status(500).json({ valid: false, exists: false, error: e.message });
      }
    });

    app.post('/send', async function(req, res) {
      try {
        if (!connected || !sock)
          return res.status(503).json({ status: 'error', message: 'Not connected' });

        var number = req.body.number;
        var message = req.body.message;
        var media = req.body.media;
        var filename = req.body.filename;
        var mediaType = req.body.mediaType;
        var mimetype = req.body.mimetype;

        if (!number) return res.status(400).json({ status: 'error', message: 'No number' });

        var num = number.toString().replace(/\D/g, '');
        var jid = num + '@s.whatsapp.net';

        try {
          var chk = await Promise.race([
            sock.onWhatsApp(jid),
            wait(10000).then(function() { throw new Error('timeout'); })
          ]);
          if (!chk || !chk[0] || !chk[0].exists)
            return res.json({ status: 'error', message: 'Not on WhatsApp' });
        } catch (e) {
          log('WARNING', 'Check failed, sending anyway: ' + e.message);
        }

        var sent;
        if (media) {
          var buf = Buffer.from(media, 'base64');
          var mt = mimetype || (mediaType === 'image' ? 'image/jpeg' : 'application/pdf');

          if (mediaType === 'image') {
            sent = await sendWithRetry(jid, { image: buf, caption: message || '', mimetype: mt });
          } else {
            sent = await sendWithRetry(jid, { document: buf, caption: message || '', mimetype: mt, fileName: filename || 'document.pdf' });
          }
        } else {
          sent = await sendWithRetry(jid, { text: message || '' });
        }

        lastAct = Date.now();
        var msgId = (sent && sent.key && sent.key.id) ? sent.key.id : '';
        res.json({ status: 'sent', messageId: msgId, to: jid });
      } catch (e) {
        log('ERROR', 'Send: ' + e.message);
        if (e.message && (e.message.indexOf('not connected') !== -1 || e.message.indexOf('Connection Closed') !== -1))
          return res.status(503).json({ status: 'error', message: 'Not connected' });
        res.status(500).json({ status: 'error', error: e.message });
      }
    });

    app.get('/logout', async function(req, res) {
      try {
        if (sock) try { await sock.logout(); } catch (e) {}
        wipe(); await cleanup(); resetDelay(); sched(5000);
        res.json({ status: 'logged_out' });
      } catch (e) { res.status(500).json({ status: 'error', error: e.message }); }
    });

    app.get('/restart', async function(req, res) {
      unsched(); await cleanup(); attempts = 0; resetDelay();
      await wait(1000); boot().catch(function() {});
      res.json({ status: 'restarting' });
    });

    app.get('/reset', async function(req, res) {
      unsched(); await cleanup(); wipe(); attempts = 0; resetDelay();
      await wait(2000); boot().catch(function() {});
      res.json({ status: 'reset' });
    });

    app.get('/health', function(req, res) {
      var healthy = connected && (Date.now() - lastAct) < HEALTH_TIMEOUT * 3;
      res.json({
        status: healthy ? 'ok' : 'degraded',
        connected: connected, engine: 'baileys-enhanced',
        lastActivity: Math.floor((Date.now() - lastAct) / 1000) + 's ago',
        reconnectDelay: reconnectDelay,
        qrTries: qrTries, attempts: attempts
      });
    });

    process.on('SIGTERM', async function() { stopHealth(); await cleanup(); process.exit(0); });
    process.on('SIGINT',  async function() { stopHealth(); await cleanup(); process.exit(0); });
    process.on('uncaughtException',  function(e) { log('ERROR', 'Uncaught: ' + e.message); });
    process.on('unhandledRejection', function(e) { log('ERROR', 'Unhandled: ' + e); });

    app.listen(PORT, '0.0.0.0', function() { log('INFO', 'SERVER_STARTED port=' + PORT); });
