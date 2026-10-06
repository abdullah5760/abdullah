'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizePhone, buildParameters, safeEqual } = require('./lib');
const { createSentClient } = require('./sent');

// Minimal .env loader (no dependencies)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* no .env */ }

function createApp(opts = {}) {
  const cfg = {
    password: opts.password ?? process.env.APP_PASSWORD,
    user: opts.user ?? process.env.APP_USER,
    dataFile: opts.dataFile ?? path.join(__dirname, 'data.json'),
    delayMs: Number(opts.delayMs ?? process.env.SEND_DELAY_MS ?? 1000),
    dailyLimit: Number(opts.dailyLimit ?? process.env.DAILY_LIMIT ?? 40),
    cooldownSec: Number(opts.cooldownSec ?? process.env.COOLDOWN_SEC ?? 20),
    repeatDays: Number(opts.repeatDays ?? process.env.REPEAT_DAYS ?? 7),
    dryRun: opts.dryRun ?? (process.env.DRY_RUN || 'true') !== 'false'
  };
  if (!cfg.password) throw new Error('APP_PASSWORD is required');
  const sent = opts.sent ?? createSentClient({
    baseUrl: process.env.SENT_BASE_URL || 'https://api.sent.dm',
    apiKey: process.env.SENT_API_KEY,
    senderId: process.env.SENT_SENDER_ID,
    dryRun: cfg.dryRun
  });
  if (!cfg.dryRun && !opts.sent && !(process.env.SENT_API_KEY && process.env.SENT_SENDER_ID)) {
    throw new Error('SENT_API_KEY and SENT_SENDER_ID are required when DRY_RUN=false');
  }

  let db = { contacts: [], templates: [], campaigns: [], manualLog: [] };
  try { db = JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8')); } catch { /* fresh */ }
  db.manualLog = db.manualLog || [];
  const dayKey = (d) => new Date(d).toLocaleDateString('en-CA'); // local calendar day
  // A campaign left "running" by a crash is paused, never auto-resumed.
  for (const c of db.campaigns) if (c.status === 'running') c.status = 'interrupted';
  const save = () => {
    const tmp = cfg.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, cfg.dataFile);
  };
  const id = () => crypto.randomUUID();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const running = new Set();
  const sessions = new Set();
  let loginToken = opts.loginToken || null; // one-time token used by the local launcher to skip the login prompt

  async function runCampaign(camp) {
    if (running.has(camp.id)) return;
    running.add(camp.id);
    camp.status = 'running'; save();
    try {
      for (const r of camp.results) {
        if (r.status !== 'pending') continue;
        if (camp.status === 'cancelled') break;
        const contact = db.contacts.find((c) => c.id === r.contactId);
        // Re-check consent at send time: opt-out after campaign creation must win.
        if (!contact || !contact.optIn || contact.optOut) { r.status = 'skipped'; r.error = 'no consent'; save(); continue; }
        r.status = 'sending'; save(); // persisted first so a crash can never double-send
        try {
          const out = await sent.sendWhatsApp({
            phone: contact.phone,
            templateName: camp.templateName,
            parameters: buildParameters(camp.mapping, contact)
          });
          r.status = 'accepted'; r.messageId = out.messageId; // accepted != delivered
        } catch (e) { r.status = 'failed'; r.error = String(e.message).slice(0, 300); }
        r.at = new Date().toISOString(); save();
        await sleep(cfg.delayMs);
      }
      if (camp.status !== 'cancelled') camp.status = 'done';
    } finally { running.delete(camp.id); save(); }
  }

  function body(req) {
    return new Promise((resolve, reject) => {
      let s = ''; req.on('data', (d) => { s += d; if (s.length > 5e6) { reject(new Error('too large')); req.destroy(); } });
      req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('bad json')); } });
    });
  }
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const u0 = new URL(req.url, 'http://x');
    if (loginToken && req.method === 'GET' && u0.pathname === '/' && u0.searchParams.get('login') && safeEqual(u0.searchParams.get('login'), loginToken)) {
      loginToken = null; // single use
      const sid = crypto.randomBytes(24).toString('hex'); sessions.add(sid);
      res.writeHead(302, { 'Set-Cookie': `wa_session=${sid}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' }); return res.end();
    }
    const m0 = /(?:^|;\s*)wa_session=([0-9a-f]+)/.exec(req.headers.cookie || '');
    const hasSession = !!(m0 && sessions.has(m0[1]));
    const auth = req.headers.authorization || '';
    const cred = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8') : '';
    const user = cred.split(':')[0], pass = cred.split(':').slice(1).join(':');
    // APP_USER is optional; when unset any username is accepted.
    if (!hasSession && (!safeEqual(pass, cfg.password) || (cfg.user && !safeEqual(user, cfg.user)))) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="whatsapp-sender"' }); return res.end('Auth required');
    }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
      }
      if (req.method === 'GET' && p === '/api/state') {
        const today = dayKey(Date.now());
        const manualToday = db.manualLog.filter((l) => dayKey(l.at) === today).length;
        return send(res, 200, { ...db, dryRun: cfg.dryRun, manual: { dailyLimit: cfg.dailyLimit, cooldownSec: cfg.cooldownSec, repeatDays: cfg.repeatDays, today: manualToday } });
      }

      if (req.method === 'POST' && p === '/api/contacts') {
        const b = await body(req);
        const added = [], rejected = [];
        for (const row of Array.isArray(b.contacts) ? b.contacts : []) {
          const phone = normalizePhone(row.phone, b.defaultCc);
          if (!phone) { rejected.push({ row, reason: 'invalid phone' }); continue; }
          if (db.contacts.some((c) => c.phone === phone)) { rejected.push({ row, reason: 'duplicate' }); continue; }
          // Consent is only recorded if the operator explicitly confirms it for the batch.
          const optIn = b.consentConfirmed === true;
          db.contacts.push({
            id: id(), phone, name: String(row.name || '').slice(0, 100), fields: row.fields || {},
            optIn, optInAt: optIn ? new Date().toISOString() : null, optInSource: optIn ? String(b.consentSource || '').slice(0, 200) : null,
            optOut: false
          });
          added.push(phone);
        }
        save(); return send(res, 200, { added: added.length, rejected });
      }
      let m;
      if ((m = p.match(/^\/api\/contacts\/([\w-]+)$/)) && req.method === 'DELETE') {
        db.contacts = db.contacts.filter((c) => c.id !== m[1]); save(); return send(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/contacts\/([\w-]+)\/optout$/)) && req.method === 'POST') {
        const c = db.contacts.find((x) => x.id === m[1]);
        if (!c) return send(res, 404, { error: 'not found' });
        c.optOut = true; save(); return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/templates') {
        const b = await body(req);
        const name = String(b.name || '').trim();
        if (!name) return send(res, 400, { error: 'name required' });
        const params = (Array.isArray(b.params) ? b.params : []).map(String).filter(Boolean);
        db.templates = db.templates.filter((t) => t.name !== name);
        db.templates.push({ id: id(), name, params }); save(); return send(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/templates\/([\w-]+)$/)) && req.method === 'DELETE') {
        db.templates = db.templates.filter((t) => t.id !== m[1]); save(); return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/campaigns') {
        const b = await body(req);
        const tpl = db.templates.find((t) => t.name === b.templateName);
        if (!tpl) return send(res, 400, { error: 'unknown template' });
        const missing = tpl.params.filter((k) => !(b.mapping && b.mapping[k]));
        if (missing.length) return send(res, 400, { error: 'missing params: ' + missing.join(', ') });
        const targets = db.contacts.filter((c) => c.optIn && !c.optOut);
        if (!targets.length) return send(res, 400, { error: 'no opted-in contacts' });
        const camp = {
          id: id(), name: String(b.name || 'Campaign').slice(0, 100), templateName: tpl.name, mapping: b.mapping || {},
          status: 'created', createdAt: new Date().toISOString(),
          results: targets.map((c) => ({ contactId: c.id, phone: c.phone, status: 'pending' }))
        };
        db.campaigns.push(camp); save();
        runCampaign(camp); // background; poll /api/state
        return send(res, 200, { id: camp.id, recipients: targets.length });
      }
      if ((m = p.match(/^\/api\/campaigns\/([\w-]+)\/cancel$/)) && req.method === 'POST') {
        const c = db.campaigns.find((x) => x.id === m[1]);
        if (c && c.status === 'running') c.status = 'cancelled'; save(); return send(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/campaigns\/([\w-]+)\/resume$/)) && req.method === 'POST') {
        const c = db.campaigns.find((x) => x.id === m[1]);
        if (!c || c.status !== 'interrupted') return send(res, 400, { error: 'not resumable' });
        // 'sending' means we don't know if it went out; never retry those automatically.
        for (const r of c.results) if (r.status === 'sending') { r.status = 'failed'; r.error = 'unknown outcome after crash'; }
        runCampaign(c); return send(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/manual\/([\w-]+)\/opened$/)) && req.method === 'POST') {
        // Called right before the browser opens a wa.me chat; the server is the gatekeeper for consent and limits.
        const c = db.contacts.find((x) => x.id === m[1]);
        if (!c) return send(res, 404, { error: 'not found' });
        if (!c.optIn || c.optOut) return send(res, 403, { error: 'no consent' });
        const now = Date.now();
        if (db.manualLog.filter((l) => dayKey(l.at) === dayKey(now)).length >= cfg.dailyLimit) return send(res, 429, { error: 'daily limit reached' });
        const last = db.manualLog.filter((l) => l.contactId === c.id).pop();
        if (last && now - new Date(last.at).getTime() < cfg.repeatDays * 864e5) return send(res, 409, { error: 'contacted recently' });
        db.manualLog.push({ contactId: c.id, at: new Date(now).toISOString() }); save();
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 400, { error: e.message }); }
  });
  return { server, db: () => db, runCampaign };
}

module.exports = { createApp };

if (require.main === module) {
  const { server } = createApp();
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`http://${host}:${port}  (DRY_RUN=${(process.env.DRY_RUN || 'true') !== 'false'})`));
}
