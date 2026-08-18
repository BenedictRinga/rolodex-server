// src/index.js — Rolodex sync backend (2026-08-16)
// A FRESH `rolodex` database (separate from Zyppar's `zyppar` db — on the same
// paid cluster, or a future dedicated Atlas account via MONGO_DB_URI_ROLODEX).
// YARN ONLY. Minimal surface for the one-chance demo:
//   POST /api/rolodex/sync   { deviceId, contacts[], followUps[], deviceName }
//                            -> upsert the device's latest state (the app talks
//                               to the DB the moment it launches).
//   GET  /api/rolodex/live   -> the investor "peek" view: a self-contained HTML
//                               page showing every synced device + last sync +
//                               counts, auto-refreshing — proof the product is
//                               alive and communicating RIGHT NOW.
//   GET  /api/rolodex/health -> liveness for the droplet deploy.
//   GET  /api/rolodex/state/:deviceId -> the device's stored state (read-only).
const fs = require('fs');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

function resolveMongoUri() {
  if (process.env.MONGO_DB_URI_ROLODEX) return process.env.MONGO_DB_URI_ROLODEX;
  // Droplet-safe fallbacks (same pattern as the Zyppar scripts): the fresh
  // `rolodex` database on the existing paid cluster.
  const candidates = ['D:/TODOs/db-tools-tmp/zyppar.env', '.env'];
  for (const p of candidates) {
    try {
      const t = fs.readFileSync(p, 'utf8');
      const m = t.match(/^MONGO_DB_URI_PAID=["']?([^\r\n"']+)/m);
      if (m) {
        const base = m[1].replace(/\/[^/]*\?/, '/?'); // strip any db name → params
        const sep = base.includes('?') ? '&' : '?';
        return `${base}${sep}appName=rolodex` + (base.includes('?') ? '' : '');
      }
    } catch { /* try next */ }
  }
  return '';
}

const uri = resolveMongoUri();
const port = Number(process.env.PORT || 4411);

// 2026-08-18 AI KEYS: the app never brings a key — Rolodex holds them on the
// server. Read from process.env first, then from the same .env file the deploy
// script already maintains for Mongo, so adding DEEPSEEK_API_KEY=... is a
// one-line edit on the droplet (no new dependency, no dotenv).
function envVar(name) {
  if (process.env[name]) return process.env[name];
  const candidates = ['D:/TODOs/db-tools-tmp/zyppar.env', '.env'];
  for (const p of candidates) {
    try {
      const t = fs.readFileSync(p, 'utf8');
      const m = t.match(new RegExp('^' + name + '=[\"\']?([^\\r\\n\"\']+)', 'm'));
      if (m) return m[1];
    } catch { /* try next */ }
  }
  return '';
}

if (!uri) {
  console.error('MONGO_DB_URI_ROLODEX not found (env var or repo .env).');
  process.exit(1);
}

// The fresh database is NAMED `rolodex` (never touches the Zyppar `zyppar` db).
const conn = mongoose.createConnection(uri, { dbName: 'rolodex', serverSelectionTimeoutMS: 20000 });

const DeviceState = conn.model('DeviceState', new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, index: true },
  deviceName: { type: String, default: '' },
  room: { type: String, default: '' }, // demo share code — links Tom's device to yours live
  lastSyncAt: { type: Date, default: Date.now },
  contactsCount: { type: Number, default: 0 },
  followUpsCount: { type: Number, default: 0 },
  contactNames: { type: [String], default: [] },
  contacts: { type: [mongoose.Schema.Types.Mixed], default: [] }, // full contact list (rolodex-server storage)
  sample: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true }));

// 2026-08-18 THE USERS DB + THE INVESTOR GATE: these models were referenced by
// the sync/lookup/investor routes but never defined - a fresh-clone ReferenceError.
// The registry is phone-keyed so the chat's honest-send lookup can answer
// "is this sendee already reachable in-app?" before a message goes out.
const RolodexUser = conn.model('RolodexUser', new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  deviceId: { type: String, default: '' },
  room: { type: String, default: '' },
  name: { type: String, default: '' },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true }));

const InvestorRequest = conn.model('InvestorRequest', new mongoose.Schema({
  name: { type: String, default: '' },
  email: { type: String, required: true },
  note: { type: String, default: '' },
}, { timestamps: true }));

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/api/rolodex/health', (_req, res) => {
  res.json({ ok: true, db: conn.readyState === 1 ? 'connected' : 'connecting', at: new Date().toISOString() });
});

// 2026-08-16: the update check — the app polls this and compares against its
// bundled version; a critical difference shows a polite notice in Settings.
// 2026-08-16 BILLING: Stripe Checkout for the two tiers.
// Basic () = contact manager + the Assistant (5 AI interventions/month);
// Confidante () = the full AI agent all month. Without STRIPE_SECRET_KEY
// the endpoint answers 501 so the app can show the connect-Stripe state.
app.post('/api/rolodex/billing/checkout', async (req, res) => {
  try {
    const plan = String(req.body?.plan || '');
    const plans = {
      basic: { name: 'Rolodex Basic', amount: 100, id: 'rolodex-basic' },
      confidante: { name: 'RolodexAI Confidante', amount: 500, id: 'rolodex-confidante' },
    };
    const cfg = plans[plan];
    if (!cfg) return res.status(400).json({ error: 'Unknown plan' });
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(501).json({ error: 'Stripe is not connected - add STRIPE_SECRET_KEY' });
    }
    const stripe = new (require('stripe'))(process.env.STRIPE_SECRET_KEY);
    const origin = req.headers.origin || 'https://zyppar.com';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: cfg.name, metadata: { planId: cfg.id } },
          unit_amount: cfg.amount,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      success_url: origin + '/rolodex/?checkout=success&plan=' + plan,
      cancel_url: origin + '/rolodex/?checkout=cancelled',
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: 'Checkout failed: ' + (e?.message || 'unknown') });
  }
});

// 2026-08-16 AI COMPOSE PROXY: the user chooses which AI engine Rolodex
// uses to deliver the confidante (Rolodex's own on-device engine, DeepSeek,
// or Grok). The keys are ROLODEX's (env DEEPSEEK_API_KEY / GROK_API_KEY) -
// the user never brings a key. The briefing passes through transiently and is
// never stored; the on-device engine never calls here.
app.post('/api/rolodex/ai/compose', async (req, res) => {
  try {
    const engine = String(req.body?.engine || '');
    const briefing = String(req.body?.briefing || '').slice(0, 4000);
    if (!briefing) return res.status(400).json({ error: 'No briefing' });
    if (engine === 'deepseek') {
      if (!envVar('DEEPSEEK_API_KEY')) return res.status(501).json({ error: 'DeepSeek key not configured on the Rolodex server' });
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + envVar('DEEPSEEK_API_KEY') },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: 'You are RolodexAI, a confidential secretary. You proffer messages; the user hits Send. Keep it warm, human, one paragraph, in the user\'s voice.' },
            { role: 'user', content: briefing },
          ],
          max_tokens: 220,
          temperature: 0.7,
        }),
      });
      if (!r.ok) return res.status(502).json({ error: 'DeepSeek upstream ' + r.status });
      const data = await r.json();
      const draft = data?.choices?.[0]?.message?.content?.trim();
      if (!draft) return res.status(502).json({ error: 'DeepSeek empty reply' });
      return res.json({ draft });
    }
    if (engine === 'grok') {
      if (!envVar('GROK_API_KEY')) return res.status(501).json({ error: 'Grok key not configured on the Rolodex server' });
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + envVar('GROK_API_KEY') },
        body: JSON.stringify({
          model: 'grok-2-latest',
          messages: [
            { role: 'system', content: 'You are RolodexAI, a confidential secretary. You proffer messages; the user hits Send. Keep it warm, human, one paragraph, in the user\'s voice.' },
            { role: 'user', content: briefing },
          ],
          max_tokens: 220,
          temperature: 0.7,
        }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Grok upstream ' + r.status });
      const data = await r.json();
      const draft = data?.choices?.[0]?.message?.content?.trim();
      if (!draft) return res.status(502).json({ error: 'Grok empty reply' });
      return res.json({ draft });
    }
    return res.status(400).json({ error: 'Unknown engine' });
  } catch (e) {
    res.status(500).json({ error: 'AI compose failed: ' + (e?.message || 'unknown') });
  }
});

app.get('/api/rolodex/version', (_req, res) => {
  res.json({ version: require('../package.json').version || '0.0.0', at: new Date().toISOString() });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-08-17 THE DROPBOX MOMENT — invites.
 * When the counterparty does NOT have Rolodex, the appointment/message is
 * delivered through the channels they already use (WhatsApp / email / SMS /
 * X / copy-link). The share URL carries a short token; clicking it opens the
 * PWA, which fetches the invite and shows the landing card. The invite store
 * is a TTL in-memory map (48h) — production can move it to Mongo without
 * changing the API shape.
 * ──────────────────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const invites = new Map(); // token -> { from, room, kind, title, when, text, createdAt }
const INVITE_TTL_MS = 48 * 3600_000;

function inviteToken() {
  return crypto.randomBytes(4).toString('hex');
}

setInterval(() => {
  const now = Date.now();
  for (const [t, inv] of invites) {
    if (now - inv.createdAt > INVITE_TTL_MS) invites.delete(t);
  }
}, 3600_000).unref();

app.post('/api/rolodex/invites', (req, res) => {
  const { from = '', room = '', kind = 'message', title = '', when = '', text = '' } = req.body || {};
  if (!from || !room) return res.status(400).json({ error: 'from + room required' });
  const token = inviteToken();
  invites.set(token, { from: String(from).slice(0, 60), room: String(room).slice(0, 60), kind: kind === 'appointment' ? 'appointment' : 'message', title: String(title).slice(0, 120), when: String(when).slice(0, 32), text: String(text).slice(0, 600), createdAt: Date.now() });
  res.json({ ok: true, token, url: 'https://zyppar.com/rolodex/?invite=' + token, ogUrl: 'https://zyppar.com/api/rolodex/invites/' + token + '/og' });
});

app.get('/api/rolodex/invites/:token', (req, res) => {
  const inv = invites.get(String(req.params.token || ''));
  if (!inv) return res.status(404).json({ error: 'Invite expired or not found' });
  res.json({ ok: true, invite: { ...inv, token: req.params.token } });
});

// 2026-08-18 THE OG-TAGGED LANDING - the SHAREAPP moment. This is the URL the
// share text carries. WhatsApp / email / X fetch it and see the branded card in
// the preview (logo + "You have a message on RolodexAI"); a human tap gets a
// branded splash and is carried into the PWA invite landing automatically.
app.get('/api/rolodex/invites/:token/og', (req, res) => {
  const token = String(req.params.token || '');
  const inv = invites.get(token);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(inviteOgPage(inv, token));
});


// 2026-08-18 CHAT AWARENESS: is this number a Rolodex user? The sender's app
// consults this BEFORE sending, so it can tell the truth - the message lands
// in-app, or the share/invite path is the honest answer.
app.get('/api/rolodex/users/lookup', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const u = await RolodexUser.findOne({ phone }).lean();
    res.json({ ok: true, isUser: !!u, name: u?.name || '', room: u?.room || '' });
  } catch (err) {
    console.error('[rolodex/users/lookup]', err.message);
    res.status(500).json({ error: 'lookup failed' });
  }
});

// 2026-08-18 THE INVESTOR GATE: a requesting investor leaves their details
// and receives the access on the spot - the gate is the exclusivity mechanic.
app.post('/api/rolodex/investor-requests', async (req, res) => {
  try {
    const { name = '', email = '', note = '' } = req.body || {};
    if (!String(email || '').trim()) return res.status(400).json({ error: 'email required' });
    await InvestorRequest.create({ name: String(name).slice(0, 80), email: String(email).trim().slice(0, 120), note: String(note).slice(0, 300) });
    res.json({ ok: true, access: 'northstar' }); // dispensed on request
  } catch (err) {
    console.error('[rolodex/investor-requests]', err.message);
    res.status(500).json({ error: 'request failed' });
  }
});

// The app talks to the DB here — the demo's "it communicates" moment.
app.post('/api/rolodex/sync', async (req, res) => {
  try {
    const { deviceId, contacts = [], followUps = [], deviceName = '', room = '', ownerPhone = '', ownerName = '' } = req.body || {};
    if (!deviceId) return res.status(400).json({ message: 'deviceId required' });
    // 2026-08-18 THE USERS DB: the sync registers the device's identity
    if (ownerPhone) {
      await RolodexUser.updateOne(
        { phone: String(ownerPhone).trim() },
        { $set: { deviceId, room: String(room || '').trim().toUpperCase().slice(0, 24), name: String(ownerName || deviceName || '').slice(0, 60), lastSeenAt: new Date() } },
        { upsert: true }
      );
    }
    const names = (contacts || [])
      .map((c) => (c && (c.name || (c.firstName && `${c.firstName} ${c.lastName || ''}`))) ? String(c.name || (c.firstName && `${c.firstName} ${c.lastName || ''}`)) : null)
      .filter(Boolean)
      .slice(0, 40);
    await DeviceState.updateOne(
      { deviceId },
      {
        $set: {
          deviceName: String(deviceName || deviceId).slice(0, 60),
          room: String(room || '').trim().toUpperCase().slice(0, 24),
          lastSyncAt: new Date(),
          contactsCount: (contacts || []).length,
          followUpsCount: (followUps || []).length,
          contactNames: names,
          // 2026-08-16: the FULL contact list is stored — "rolodex-server" is a
          // real storage location (the app restores from here), not a mirror.
          contacts: (contacts || []).slice(0, 500),
          sample: {
            first: (contacts || [])[0]
              ? String((contacts[0] && (contacts[0].name?.display || contacts[0].name)) || (contacts[0].firstName && `${contacts[0].firstName} ${contacts[0].lastName || ''}`) || '(unnamed)')
              : null,
            dueToday: (followUps || []).filter((f) => f && f.overdue === true).length,
          },
        },
      },
      { upsert: true }
    );
    res.json({ ok: true, deviceId, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[rolodex/sync]', err.message);
    res.status(500).json({ message: 'sync failed' });
  }
});

// Full restore — a device keeps its contacts on the Rolodex server.
app.get('/api/rolodex/state/:deviceId', async (req, res) => {
  try {
    const d = await DeviceState.findOne({ deviceId: req.params.deviceId }).lean();
    if (!d) return res.status(404).json({ message: 'no state yet' });
    res.json({
      deviceId: d.deviceId,
      room: d.room || '',
      lastSyncAt: d.lastSyncAt,
      contactsCount: d.contactsCount,
      followUpsCount: d.followUpsCount,
      contacts: d.contacts || [],
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// The investor peek view — read-only, auto-refreshing, no account.
app.get('/api/rolodex/live', async (_req, res) => {
  try {
    const devices = await DeviceState.find({}).sort({ lastSyncAt: -1 }).limit(50).lean();
    const total = await DeviceState.countDocuments();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(peekPage(devices, total));
  } catch (err) {
    res.status(500).send(`<h1>live unavailable</h1><p>${err.message}</p>`);
  }
});

function peekPage(devices, total) {
  const rows = devices
    .map((d) => {
      const t = d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleTimeString() : '—';
      return `<tr>
        <td><b>${escapeHtml(d.deviceName || d.deviceId)}</b><br/><span class="dim">${escapeHtml(String(d.deviceId).slice(0, 18))}</span></td>
        <td>${escapeHtml(t)}</td>
        <td>${d.contactsCount ?? 0}</td>
        <td>${d.followUpsCount ?? 0}</td>
        <td class="dim">${escapeHtml((d.contactNames || []).slice(0, 4).join(', ') || '—')}</td>
      </tr>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rolodex — Live</title><style>
body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6e8f0;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;color:#8b93b0;font-weight:400;margin:0 0 20px}
.badge{display:inline-block;background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55;border-radius:20px;padding:3px 10px;font-size:12px;margin-left:8px}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #21262d}th{color:#8b93b0;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.dim{color:#8b93b0;font-size:12px}.live{color:#3fb950;font-weight:600}
.foot{color:#8b93b0;font-size:12px;margin-top:20px}
</style></head><body>
<h1>Rolodex <span class="badge live">● LIVE</span></h1>
<h2>Every device that talks to the fresh <code>rolodex</code> database — auto-refreshing every 5s.</h2>
<table><thead><tr><th>Device</th><th>Last sync</th><th>Contacts</th><th>Follow-ups</th><th>Recent names</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="dim">Waiting for the first device to sync…</td></tr>'}</tbody></table>
<div class="foot">${total} device(s) synced · <span id="clock">—</span></div>
<script>setInterval(()=>{fetch('/api/rolodex/live',{headers:{Accept:'text/html'}}).then(r=>r.text()).then(h=>{const m=h.match(/<tbody>([\\s\\S]*?)<\\/tbody>/);if(m)document.querySelector('tbody').innerHTML=m[1];document.getElementById('clock').textContent=new Date().toLocaleTimeString();}).catch(()=>{});},5000);</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The SHAREAPP landing: branded OG card for link crawlers + a tiny splash that
// carries the human into the PWA invite. Absolute asset URLs (the page is served
// from /api/rolodex/, not from the Angular app).
function inviteOgPage(inv, token) {
  const base = 'https://zyppar.com/rolodex';
  const pwaUrl = inv ? `${base}/?invite=${encodeURIComponent(token)}` : `${base}/`;
  const hasInvite = !!inv;
  const kind = inv?.kind === 'appointment' ? 'appointment' : 'message';
  const from = escapeHtml(inv?.from || 'A friend');
  let whenLabel = '';
  if (inv?.when) {
    try { whenLabel = escapeHtml(new Date(inv.when).toLocaleString()); } catch { whenLabel = escapeHtml(inv.when); }
  }
  const ogTitle = hasInvite
    ? (kind === 'appointment'
        ? `${escapeHtml(inv.from)} invited you to ${escapeHtml(inv.title || 'an appointment')} on RolodexAI`
        : `${escapeHtml(inv.from)} sent you a message on RolodexAI`)
    : 'You have a message on RolodexAI';
  const ogDesc = hasInvite
    ? (kind === 'appointment'
        ? `A RolodexAI appointment is waiting for you${inv.title ? `: ${escapeHtml(inv.title)}` : ''}${whenLabel ? ` — ${whenLabel}` : ''}.`
        : `“${escapeHtml(inv.text || '')}” — your card is ready on RolodexAI.`)
    : 'The contacts app that remembers why you know someone.';
  const ogImage = 'https://zyppar.com/rolodex/assets/rolodex/icon-512.png';
  const refresh = hasInvite ? `<meta http-equiv="refresh" content="0;url=${pwaUrl}">` : '';
  const body = hasInvite
    ? `<div class="kicker">${kind === 'appointment' ? 'Appointment from' : 'Message from'} ${from}</div>
       <div class="title">${kind === 'appointment' ? escapeHtml(inv.title || 'An appointment') : 'Your card is ready'}</div>
       <div class="dim">${kind === 'appointment' ? (whenLabel || '') : '“' + escapeHtml(inv.text || '') + '”'}</div>
       <a class="btn" href="${pwaUrl}">Open in Rolodex</a>`
    : `<div class="kicker">RolodexAI</div>
       <div class="title">This invite has expired</div>
       <div class="dim">Ask your friend to send it again — or grab the app and never forget to stay in touch… again.</div>
       <a class="btn" href="https://play.google.com/store/apps/details?id=com.zyppar.rolodexai">Get RolodexAI</a>`;
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh}
<title>${ogTitle}</title>
<meta property="og:site_name" content="RolodexAI">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDesc}">
<meta property="og:image" content="${ogImage}">
<meta property="og:url" content="${pwaUrl}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image" content="${ogImage}">
<style>
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#12141c;color:#e6e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}
.shell{max-width:420px;padding:32px}
.logo{width:88px;height:88px;border-radius:22px}
.wordmark{width:200px;margin-top:16px}
.kicker{color:#8b93b0;font-size:13px;margin-top:20px}
.title{font-size:20px;font-weight:600;margin-top:8px}
.dim{color:#8b93b0;font-size:14px;margin-top:8px;line-height:1.5}
.btn{display:inline-block;margin-top:24px;background:#f5c542;color:#12141c;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:14px}
</style>
</head><body>
<div class="shell">
  <img class="logo" src="${ogImage}" alt="RolodexAI">
  <br><img class="wordmark" src="https://zyppar.com/rolodex/assets/rolodex/name-512.png" alt="RolodexAI">
  ${body}
  <div class="dim" style="margin-top:28px">You never forget to stay in touch… again</div>
</div>
</body></html>`;
}

conn.on('connected', () => console.log('[rolodex] connected to the fresh rolodex db'));
conn.on('error', (e) => console.error('[rolodex] db error:', e.message));

// 2026-08-16 SOCKET CHAT: real-time text chat across devices in a demo room —
// the investor sees a message they send on one device appear on the other,
// immediately. Rooms are the shared demo room code; payloads are minimal.
const httpServer = http.createServer(app);
// 2026-08-16: dedicated /socket-rolodex/ path - Zyppar's socket.io owns
// /socket.io -> :3001 on this same nginx; a shared path would clash.
const io = new Server(httpServer, { cors: { origin: '*' }, path: '/socket-rolodex/' });

io.on('connection', (socket) => {
  socket.on('chat:join', async (data) => {
    const room = String(data?.room || '').trim();
    const name = String(data?.name || 'Someone').slice(0, 40);
    if (!room) return;
    socket.join('room:' + room);
    socket.data.chatRoom = room;
    socket.data.chatName = name;
    socket.to('room:' + room).emit('chat:joined', { name, ts: Date.now() });
    // 2026-08-17 PRESENCE: tell the joiner who is already here.
    try {
      const peers = await io.in('room:' + room).fetchSockets();
      socket.emit('chat:present', { count: Math.max(0, peers.length - 1) });
    } catch { socket.emit('chat:present', { count: 0 }); }
  });

  socket.on('chat:message', (data) => {
    const room = socket.data.chatRoom;
    if (!room) return;
    const text = String(data?.text || '').slice(0, 500).trim();
    if (!text) return;
    const payload = { room, name: socket.data.chatName || 'Someone', text, ts: Date.now() };
    socket.to('room:' + room).emit('chat:message', payload);
    socket.emit('chat:ack', { ts: payload.ts });
  });

  socket.on('chat:typing', () => {
    const room = socket.data.chatRoom;
    if (!room) return;
    socket.to('room:' + room).emit('chat:typing', { room, name: socket.data.chatName || 'Someone' });
  });

  socket.on('chat:read', (data) => {
    const room = socket.data.chatRoom;
    if (!room) return;
    socket.to('room:' + room).emit('chat:read', { room, key: String(data?.key || '') });
  });

  socket.on('chat:react', (data) => {
    const room = socket.data.chatRoom;
    if (!room) return;
    socket.to('room:' + room).emit('chat:react', {
      room, key: String(data?.key || ''), messageId: String(data?.messageId || ''),
      emoji: String(data?.emoji || ''), name: socket.data.chatName || 'Someone',
    });
  });

  socket.on('appointment:invite', (data) => {
    const room = socket.data.chatRoom;
    if (!room) return;
    socket.to('room:' + room).emit('appointment:invite', {
      room, key: String(data?.key || ''), title: String(data?.title || '').slice(0, 80),
      when: String(data?.when || ''), from: socket.data.chatName || 'Someone',
    });
  });

  socket.on('disconnect', () => {
    if (socket.data.chatRoom) {
      socket.to('room:' + socket.data.chatRoom).emit('chat:left', { name: socket.data.chatName, ts: Date.now() });
      try {
        io.in('room:' + socket.data.chatRoom).fetchSockets().then((peers) => {
          socket.to('room:' + socket.data.chatRoom).emit('chat:present', { count: Math.max(0, peers.length - 1) });
        }).catch(() => {});
      } catch {}
    }
  });
});

httpServer.listen(port, () => console.log(`[rolodex] listening on :${port} (http + socket.io)`));
