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
const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { CHAT_DIRECTIVE } = require('./chat-directive');
const { AGENT_SUBDIRECTIVES } = require('./agents-directive');

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
  // 2026-08-19 THE 7-DAY TRIAL: tracked server-side from the device's first
  // sync (first use). Reopenable on demand via /trial/reopen — never auto-renewed.
  trialStartedAt: { type: Date, default: null },
  trialEndsAt: { type: Date, default: null },
  trialReopens: { type: Number, default: 0 },
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

// 2026-08-19 CHAT WITH ROLODEXAI — user suggestions delivered to the investors'
// extended room (the -x2 password space). The summary is the gleaned direction.
// 2026-08-28 CLOSED BETA: optional numeric testerId (the invite code) so the
// founder can see WHICH tester sent feedback — still no name/phone/email.
const InvestorFeedback = conn.model('InvestorFeedback', new mongoose.Schema({
  deviceId: { type: String, default: '' },
  deviceName: { type: String, default: '' },
  messages: { type: [String], default: [] },
  summary: { type: String, required: true },
  testerId: { type: Number, default: null },
}, { timestamps: true }));

// 2026-08-28 CLOSED BETA (15 TESTERS) — anonymous acceptance + practice ledger.
// A tester accepts via their personal deeplink (numeric code, zero PII: no
// name, no phone, no email — the UA string is recorded only to spot weird
// double-claims). The app then tags analytics events with the same numeric
// code, so the founder dashboard can measure compliance (installed /
// practicing / silent) without ever knowing who the tester is. Codes are the
// only secret; a leaked code can be rotated by editing TESTER_CODES.
const TESTER_CODES = [
  480213, 507894, 615238, 729461, 834175,
  950326, 163482, 278519, 381647, 495273,
  526819, 649152, 763485, 817294, 936528,
  // 2026-08-28 COHORT 15 -> 20 (founder): a code is a PERMANENT slot (accept
  // claims testerId = index+1 and the practice ledger keys on it), so a passed
  // invitee's code can never be safely reissued — the replacement and the
  // original would share one ledger column. Five spare codes absorb passes
  // instead: no expiry to communicate, no reuse, no collision. Existing
  // codes/links stay exactly as they are; slots 16-20 are pure additions.
  204817, 316529, 427638, 538741, 658274,
]; // slot N = index + 1

const TesterAccept = conn.model('TesterAccept', new mongoose.Schema({
  testerId: { type: Number, required: true, unique: true, index: true },
  code: { type: Number, required: true },
  ua: { type: String, default: '' },
}, { timestamps: true }));

const testerDaySchema = new mongoose.Schema({
  testerId: { type: Number, required: true, index: true },
  day: { type: String, required: true }, // YYYY-MM-DD (UTC)
  launches: { type: Number, default: 0 },
  captures: { type: Number, default: 0 },
  sends: { type: Number, default: 0 },
  closes: { type: Number, default: 0 },
  videos: { type: Number, default: 0 },
  confidante: { type: Number, default: 0 },
  feedback: { type: Number, default: 0 },
}, { timestamps: true });
testerDaySchema.index({ testerId: 1, day: 1 }, { unique: true });
const TesterDay = conn.model('TesterDay', testerDaySchema);

// 2026-08-23 ANONYMOUS PRODUCT ANALYTICS — no contacts, no PII. The frontend
// sends lightweight event names (app_launch, session_start/end, card_added,
// message_sent, loop_closed, billing_started, …) with a stable deviceId so we
// can compute DAU/WAU/MAU, sessions, retention cohorts, activation and
// conversion without ever receiving contact data.
const AnalyticsEvent = conn.model('AnalyticsEvent', new mongoose.Schema({
  deviceId: { type: String, default: '', index: true },
  event: { type: String, required: true, index: true },
  props: { type: mongoose.Schema.Types.Mixed, default: {} },
  sessionId: { type: String, default: '' },
  ts: { type: Date, default: Date.now, index: true },
}, { timestamps: true }));

// 2026-08-25 COMMUNITY TRANSLATIONS — anonymous translation suggestions from
// the in-app Help Translate portal. No email, no name, no device id: only the
// language code + the keys the user chose to improve. Approved=false until a
// maintainer reviews and merges them into the shipped locale files.
const TranslationSuggestion = conn.model('TranslationSuggestion', new mongoose.Schema({
  lang: { type: String, required: true, index: true },
  keys: { type: mongoose.Schema.Types.Mixed, default: {} },
  source: { type: String, default: 'portal' },
  approved: { type: Boolean, default: false },
  rejected: { type: Boolean, default: false },
}, { timestamps: true }));

const app = express();
app.use(express.json({ limit: '5mb' }));

// 2026-08-20 CORS: the PWA lives on zyppar.com/rolodex but the API may be
// called from localhost dev or a different origin — update checks (and every
// other route) must answer preflight, or fetch dies with ERR_FAILED and the
// app wrongly reports "up to date".
// 2026-08-21 FIX: the droplet nginx already adds its own
// Access-Control-Allow-Origin (echoing the request origin). Express must NOT
// also send "*" — two ACAO headers (or "*, <origin>") are rejected by browsers,
// which broke POST /tts from localhost dev and mobile PWA. Only set ACAO when
// the request is hitting Express DIRECTLY (localhost dev), where nginx is not
// in front to add it.
app.use((req, res, next) => {
  const host = String(req.headers.host || '');
  const isDirectExpress = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  if (isDirectExpress) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  } else {
    // Behind nginx: nginx owns the ACAO header. Only mirror methods/headers so
    // preflight still passes when nginx forwards it.
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// 2026-08-21 OPENLOOP REBRAND → 2026-08-26 LOOPKEEPER CANONICAL: the frontend
// now calls /api/loopkeeper/… (canonical). /api/openloop/… and /api/rolodex/…
// remain backward-compatible aliases — already-shared invite OG URLs and
// deployed PWAs keep working; openloop is DEPRECATED and must not be used in
// new code or new share links.
app.use((req, _res, next) => {
  const m = req.url.match(/^\/api\/(openloop|loopkeeper)(?=\/|$)/);
  if (m) {
    req.url = '/api/rolodex' + req.url.slice(('/api/' + m[1]).length);
    req.originalUrl = req.url;
  }
  next();
});

// 2026-08-20 ZYPPAR-STYLE UPDATES: /api/loopkeeper/updates/check reads
// version.txt (the app's apiBase is /api/loopkeeper; /api/openloop/updates
// still reaches this route through the alias middleware above).
const updateRoutes = require('./routes/updates.routes.js');
app.use('/api/rolodex/updates', updateRoutes);

app.get('/api/rolodex/health', (_req, res) => {
  res.json({ ok: true, db: conn.readyState === 1 ? 'connected' : 'connecting', at: new Date().toISOString() });
});

// 2026-08-20 STUDIO TTS: rolodex-server's OWN Qwen proxy for StudioPlayback /
// StudioBridge. Config is rolodex's own .env (QWEN_TTS_ENDPOINT etc.) with a
// localhost:8080 default — NO reading of the zyppar-server env.
// 2026-08-21 complements the Zyppar /library/tts/* surface: synthesize,
// stream, voices, health — all under /api/rolodex/tts*.
const studioTts = require('./services/studio-tts.service.js');

function ttsPayload(req) {
  return {
    text: String(req.body?.text || '').slice(0, 4000),
    voice: String(req.body?.voice || 'qwen-default').slice(0, 40),
    speed: Number(req.body?.speed) || 1,
  };
}

app.post('/api/rolodex/tts', async (req, res) => {
  try {
    const { text, voice, speed } = ttsPayload(req);
    if (!text.trim()) return res.status(400).json({ error: 'text required' });
    if (!studioTts.configured()) {
      return res.status(501).json({ error: 'TTS not connected — add QWEN_TTS_ENDPOINT' });
    }
    const audio = await studioTts.synthesize(text, { voice, speed });
    if (!audio) return res.status(501).json({ error: 'TTS empty' });
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-TTS-Provider', 'qwen');
    res.set('X-TTS-Latency-Ms', String(Date.now()));
    res.send(audio);
  } catch (e) {
    res.status(502).json({ error: 'TTS failed: ' + (e?.message || 'unknown') });
  }
});

// Streaming-shaped TTS (full MP3 body + Zyppar headers) — the frontend
// StudioQwenTtsService.synthesizeStreaming() calls this endpoint.
app.post('/api/rolodex/tts/stream', async (req, res) => {
  try {
    const { text, voice, speed } = ttsPayload(req);
    if (!text.trim()) return res.status(400).json({ error: 'text required' });
    if (!studioTts.configured()) {
      return res.status(501).json({ error: 'TTS not connected — add QWEN_TTS_ENDPOINT' });
    }
    const audio = await studioTts.synthesize(text, { voice, speed });
    if (!audio) return res.status(501).json({ error: 'TTS empty' });
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-TTS-Provider', 'qwen');
    res.set('X-TTS-Streaming', 'full');
    res.set('X-TTS-Latency-Ms', String(Date.now()));
    res.send(audio);
  } catch (e) {
    res.status(502).json({ error: 'TTS stream failed: ' + (e?.message || 'unknown') });
  }
});

app.get('/api/rolodex/tts/voices', (_req, res) => {
  res.json({ providers: [{ provider: 'qwen', voices: studioTts.listVoices() }] });
});

app.get('/api/rolodex/tts/health', async (_req, res) => {
  const health = await studioTts.health();
  res.json({ health, timestamp: new Date().toISOString() });
});

// 2026-08-16: the update check — the app polls this and compares against its
// bundled version; a critical difference shows a polite notice in Settings.
// 2026-08-16 BILLING: Stripe Checkout for the two tiers.
// Basic () = contact manager + the Assistant (5 AI interventions/month);
// 2026-08-18 MULTI-GATEWAY BILLING: Stripe (cards/global), Paystack (Nigeria),
// Flutterwave (Kenya / M-Pesa), Paddle (global merchant-of-record). The app
// sends { plan, gateway, email }; the server returns the hosted checkout URL.
// Without a gateway key the endpoint answers 501 so the modal can show the
// connect state honestly per gateway.
app.post('/api/rolodex/billing/checkout', async (req, res) => {
  try {
    const plan = String(req.body?.plan || '');
    const gateway = String(req.body?.gateway || 'stripe');
    const email = String(req.body?.email || '').trim();
    const plans = {
      basic: {
        name: 'LoopKeeper Basic', id: 'rolodex-basic',
        amount: 100, // USD cents (Stripe)
        kobo: 100000, // NGN kobo (Paystack) = ₦1,000
        kes: 100, // KES whole shillings (Flutterwave/M-Pesa)
        paddlePriceId: envVar('PADDLE_BASIC_PRICE_ID'),
      },
      confidante: {
        name: 'LoopKeeper Confidante', id: 'rolodex-confidante',
        amount: 500, // USD cents (Stripe)
        kobo: 500000, // NGN kobo (Paystack) = ₦5,000
        kes: 500, // KES whole shillings (Flutterwave/M-Pesa)
        paddlePriceId: envVar('PADDLE_CONFIDANTE_PRICE_ID'),
      },
    };
    const cfg = plans[plan];
    if (!cfg) return res.status(400).json({ error: 'Unknown plan' });

    const origin = req.headers.origin || 'https://zyppar.com';
    const successUrl = origin + '/loopkeeper/?checkout=success&plan=' + plan + '&gateway=' + gateway;
    const cancelUrl = origin + '/loopkeeper/?checkout=cancelled';

    // ── Stripe ──────────────────────────────────────────────────────────────
    if (gateway === 'stripe') {
      if (!envVar('STRIPE_SECRET_KEY')) {
        return res.status(501).json({ error: 'Stripe is not connected - add STRIPE_SECRET_KEY' });
      }
      const stripe = new (require('stripe'))(envVar('STRIPE_SECRET_KEY'));
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
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      return res.json({ url: session.url, gateway });
    }

    // ── Paystack (Nigeria) ──────────────────────────────────────────────────
    if (gateway === 'paystack') {
      if (!envVar('PAYSTACK_SECRET_KEY')) {
        return res.status(501).json({ error: 'Paystack is not connected - add PAYSTACK_SECRET_KEY' });
      }
      const r = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + envVar('PAYSTACK_SECRET_KEY') },
        body: JSON.stringify({
          email: email || 'guest@rolodex.local',
          amount: cfg.kobo,
          currency: 'NGN',
          metadata: { planId: cfg.id, plan, gateway: 'paystack' },
          callback_url: successUrl,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data?.status) return res.status(502).json({ error: 'Paystack upstream: ' + (data?.message || r.status) });
      return res.json({ url: data?.data?.authorization_url, gateway });
    }

    // ── Flutterwave (Kenya / M-Pesa + cards) ────────────────────────────────
    if (gateway === 'flutterwave') {
      if (!envVar('FLUTTERWAVE_SECRET_KEY')) {
        return res.status(501).json({ error: 'Flutterwave is not connected - add FLUTTERWAVE_SECRET_KEY' });
      }
      const currency = String(req.body?.currency || 'KES').toUpperCase();
      const r = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + envVar('FLUTTERWAVE_SECRET_KEY') },
        body: JSON.stringify({
          tx_ref: 'rolodex-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          amount: currency === 'KES' ? cfg.kes : cfg.amount / 100,
          currency,
          redirect_url: successUrl,
          customer: { email: email || 'guest@rolodex.local', name: String(req.body?.name || 'LoopKeeper user').slice(0, 80) },
          customizations: { title: cfg.name, description: cfg.id },
          payment_options: currency === 'KES' ? 'mpesa,card' : 'card',
        }),
      });
      const data = await r.json();
      if (!r.ok || !data?.status) return res.status(502).json({ error: 'Flutterwave upstream: ' + (data?.message || r.status) });
      return res.json({ url: data?.data?.link, gateway });
    }

    // ── Paddle (global merchant of record) ──────────────────────────────────
    if (gateway === 'paddle') {
      if (!envVar('PADDLE_API_KEY')) {
        return res.status(501).json({ error: 'Paddle is not connected - add PADDLE_API_KEY' });
      }
      if (!cfg.paddlePriceId) {
        return res.status(501).json({ error: 'Paddle price not configured - add PADDLE_BASIC_PRICE_ID / PADDLE_CONFIDANTE_PRICE_ID' });
      }
      const paddleBase = envVar('PADDLE_ENVIRONMENT') === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
      const body = {
        items: [{ price_id: cfg.paddlePriceId, quantity: 1 }],
        custom_data: { planId: cfg.id, plan, gateway: 'paddle' },
        success_url: successUrl,
      };
      if (email) body.customer = { email };
      const r = await fetch(paddleBase + '/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + envVar('PADDLE_API_KEY') },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      const checkoutUrl = data?.data?.checkout?.url;
      if (!r.ok || !checkoutUrl) return res.status(502).json({ error: 'Paddle upstream: ' + (data?.error?.code || r.status) });
      return res.json({ url: checkoutUrl, gateway });
    }

    return res.status(400).json({ error: 'Unknown gateway: ' + gateway });
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
      if (!envVar('DEEPSEEK_API_KEY')) return res.status(501).json({ error: 'DeepSeek key not configured on the LoopKeeper server' });
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + envVar('DEEPSEEK_API_KEY') },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: 'You are LoopKeeper, a confidential secretary. You proffer messages; the user hits Send. Keep it warm, human, one paragraph, in the user\'s voice.' },
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
      if (!envVar('GROK_API_KEY')) return res.status(501).json({ error: 'Grok key not configured on the LoopKeeper server' });
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + envVar('GROK_API_KEY') },
        body: JSON.stringify({
          model: 'grok-2-latest',
          messages: [
            { role: 'system', content: 'You are LoopKeeper, a confidential secretary. You proffer messages; the user hits Send. Keep it warm, human, one paragraph, in the user\'s voice.' },
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
    // 2026-08-28 GLM ENGINE (build 37): Z.AI's GLM through the founder's
    // OpenRouter key (env OPENROUTER_API_KEY, model overridable via
    // OPENROUTER_MODEL). Same transient-briefing privacy as the other engines.
    if (engine === 'glm') {
      if (!envVar('OPENROUTER_API_KEY')) return res.status(501).json({ error: 'OpenRouter key not configured on the LoopKeeper server' });
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + envVar('OPENROUTER_API_KEY'),
          'HTTP-Referer': 'https://zyppar.com',
          'X-Title': 'LoopKeeper',
        },
        body: JSON.stringify({
          model: envVar('OPENROUTER_MODEL') || 'z-ai/glm-5.3-flash',
          messages: [
            { role: 'system', content: 'You are LoopKeeper, a confidential secretary. You proffer messages; the user hits Send. Keep it warm, human, one paragraph, in the user\'s voice.' },
            { role: 'user', content: briefing },
          ],
          max_tokens: 220,
          temperature: 0.7,
        }),
      });
      if (!r.ok) return res.status(502).json({ error: 'GLM upstream ' + r.status });
      const data = await r.json();
      const draft = data?.choices?.[0]?.message?.content?.trim();
      if (!draft) return res.status(502).json({ error: 'GLM empty reply' });
      return res.json({ draft });
    }
    return res.status(400).json({ error: 'Unknown engine' });
  } catch (e) {
    res.status(500).json({ error: 'AI compose failed: ' + (e?.message || 'unknown') });
  }
});

// 2026-08-19 REAL CHAT WITH ROLODEXAI — a genuine conversation, not presets.
// The user talks to the Confidante (DeepSeek/Grok through ROLODEX's keys) about
// improving LoopKeeper OR getting help using it. Conversation history is passed
// through transiently and never stored. If no engine is configured/reachable
// the reply is an honest fallback (the frontend then offers the free
// DeepSeek/Grok chats).
// 2026-08-19 AI CHAT — stateless privacy: messages are forwarded to the
// upstream AI (DeepSeek/xAI) in memory only. NEVER persisted, NEVER logged.
app.post('/api/rolodex/chat', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const engine = String(req.body?.engine || 'deepseek');
    const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages = rawMessages
      .slice(0, 30)
      .map((m) => ({
        role: ['system', 'user', 'assistant'].includes(m?.role) ? m.role : 'user',
        content: String(m?.content || '').slice(0, 2000),
      }))
      .filter((m) => m.content);
    if (!messages.length) return res.status(400).json({ error: 'messages required' });
    // 2026-08-27 CHAT IN THE USER'S LANGUAGE: an Arabic-UI user must never get
    // English back just because the directive was written in English. The
    // client may pass lang explicitly (polish + Confidante do); every other
    // caller is covered by the browser's own Accept-Language header.
    const lang = String(req.body?.lang || req.headers['accept-language'] || '')
      .slice(0, 32).split(',')[0].trim() || 'en';
    const system = {
      role: 'system',
      content: CHAT_DIRECTIVE
        + `\n\nLANGUAGE RULE (this request): the user's app/device language is "${lang}".`
        + ' Write your ENTIRE reply in that language. If the user\'s latest message'
        + ' is clearly written in a different language, mirror THAT language instead.'
        + ' Never answer in English merely by default — English only when it IS the'
        + " user's language. Proper names stay exactly as the user wrote them.",
    };
    const apiMessages = [system, ...messages];

    const call = async (key, base, model) => {
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages: apiMessages, max_tokens: 320, temperature: 0.7 }),
      });
      if (!r.ok) throw new Error('upstream ' + r.status);
      const data = await r.json();
      return String(data?.choices?.[0]?.message?.content || '').trim();
    };

    let reply = '';
    let usedEngine = '';
    // 2026-08-28 GLM (build 37): a requested engine is tried first, then the
    // ladder walks DeepSeek → GLM → Grok so a single configured key keeps the
    // Confidante alive.
    if (engine === 'glm' && envVar('OPENROUTER_API_KEY')) {
      try { reply = await call(envVar('OPENROUTER_API_KEY'), 'https://openrouter.ai/api/v1/chat/completions', envVar('OPENROUTER_MODEL') || 'z-ai/glm-5.3-flash'); usedEngine = 'glm'; } catch { /* try next */ }
    }
    if (engine === 'grok' && envVar('GROK_API_KEY')) {
      try { reply = await call(envVar('GROK_API_KEY'), 'https://api.x.ai/v1/chat/completions', 'grok-2-latest'); usedEngine = 'grok'; } catch { /* try next */ }
    }
    if (!reply && envVar('DEEPSEEK_API_KEY')) {
      try { reply = await call(envVar('DEEPSEEK_API_KEY'), 'https://api.deepseek.com/chat/completions', 'deepseek-chat'); usedEngine = 'deepseek'; } catch { /* try next */ }
    }
    if (!reply && engine !== 'glm' && envVar('OPENROUTER_API_KEY')) {
      try { reply = await call(envVar('OPENROUTER_API_KEY'), 'https://openrouter.ai/api/v1/chat/completions', envVar('OPENROUTER_MODEL') || 'z-ai/glm-5.3-flash'); usedEngine = 'glm'; } catch { /* fallback */ }
    }
    if (!reply && engine !== 'grok' && envVar('GROK_API_KEY')) {
      try { reply = await call(envVar('GROK_API_KEY'), 'https://api.x.ai/v1/chat/completions', 'grok-2-latest'); usedEngine = 'grok'; } catch { /* fallback */ }
    }

    if (!reply) {
      return res.json({
        reply: "The live Confidante isn't reachable right now. You can still tell me the frustration and the direction and I'll log it — or open a free DeepSeek/Grok chat below and continue there.",
        fallback: true,
        engine: '',
      });
    }
    res.json({ reply, fallback: false, engine: usedEngine });
  } catch (e) {
    res.status(500).json({ error: 'Chat failed: ' + (e?.message || 'unknown') });
  }
});

app.get('/api/rolodex/version', (_req, res) => {
  res.json({
    version: require('../package.json').version || '0.0.0',
    build: Number(require('../package.json').build) || 0,
    at: new Date().toISOString(),
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-08-19 THE CONFIDANTE AGENT — backend scaffold.
 * The frontend talks to one agent surface; the agent decomposes into
 * sub-agents (Context, Composer, Delivery, Loop, Network, Billing) backed by
 * the context warehouse. This scaffold exposes status + a compose entry point
 * so the composer can grow server-side without breaking the current flow.
 * ──────────────────────────────────────────────────────────────────────────── */
app.get('/api/rolodex/agent/status', (_req, res) => {
  res.json({
    agent: 'confidante',
    version: '0.1-scaffold',
    subAgents: ['context', 'composer', 'delivery', 'loop', 'network', 'billing'],
    contextWarehouse: true,
    engines: {
      deepseek: !!envVar('DEEPSEEK_API_KEY'),
      grok: !!envVar('GROK_API_KEY'),
      glm: !!envVar('OPENROUTER_API_KEY'),
    },
  });
});

app.post('/api/rolodex/agent/compose', async (req, res) => {
  try {
    const {
      contact = {},
      occasion = 'follow-up',
      instruction = '',
      currentDraft = '',
      senderName = 'Me',
    } = req.body || {};
    const name = String(contact?.name?.display || contact?.name || 'this contact').slice(0, 60);
    const contextBits = [
      `Write to ${name}`,
      contact?.organization?.company ? `Company: ${contact.organization.company}` : '',
      contact?.organization?.jobTitle ? `Role: ${contact.organization.jobTitle}` : '',
      contact?.rolodex?.topic ? `Topic: ${contact.rolodex.topic}` : '',
      contact?.rolodex?.followUp ? `Follow-up: ${contact.rolodex.followUp}` : '',
      instruction ? `User instruction: ${String(instruction).slice(0, 1200)}` : '',
    ].filter(Boolean).join('. ');
    const sysPrompt = AGENT_SUBDIRECTIVES[String(req.body?.subAgent || 'composer')] || 'You are LoopKeeper, a confidential secretary. Proffer messages; the user hits Send. Keep it warm, human, one paragraph.';
    const briefing = currentDraft
      ? `Refine this draft for ${name}. ${contextBits}\nCurrent draft:\n${currentDraft}\nReturn only the improved message.`
      : `The user is ${senderName}. ${contextBits}. Occasion: ${occasion}. Return a warm, human, one-paragraph message in the user's voice.`;
    const engine = String(req.body?.engine || 'deepseek');
    if (engine === 'grok' && envVar('GROK_API_KEY')) {
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + envVar('GROK_API_KEY') },
        body: JSON.stringify({ model: 'grok-2-latest', messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: briefing }], max_tokens: 220, temperature: 0.7 }),
      });
      if (r.ok) {
        const data = await r.json();
        const draft = data?.choices?.[0]?.message?.content?.trim();
        if (draft) return res.json({ draft, agent: 'confidante', subAgent: 'composer' });
      }
    }
    if (engine === 'deepseek' && envVar('DEEPSEEK_API_KEY')) {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + envVar('DEEPSEEK_API_KEY') },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: briefing }], max_tokens: 220, temperature: 0.7 }),
      });
      if (r.ok) {
        const data = await r.json();
        const draft = data?.choices?.[0]?.message?.content?.trim();
        if (draft) return res.json({ draft, agent: 'confidante', subAgent: 'composer' });
      }
    }
    // Fallback: echo the current draft or a simple on-device-style draft.
    const fallback = currentDraft || `Hi ${name}, I was thinking of you — let's catch up soon.`;
    return res.json({ draft: fallback, agent: 'confidante', subAgent: 'composer', fallback: true });
  } catch (e) {
    res.status(500).json({ error: 'Agent compose failed: ' + (e?.message || 'unknown') });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-08-19 LINK PREVIEW — tiny OG scraper.
 * Returns title/image/description/domain for a URL. No heavy dependency:
 * a plain fetch + regex over the HTML head. Used by the chat/link-preview UI.
 * ──────────────────────────────────────────────────────────────────────────── */
app.get('/api/rolodex/link-preview', async (req, res) => {
  try {
    const url = String(req.query?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid URL' });

    // 2026-08-25 LOOPKEEPER BRAND GUARD: LoopKeeper URLs must NEVER preview as
    // Zyppar. The static OG card is authoritative and immune to nginx/deploy
    // drift on /loopkeeper/ — chat and Settings previews always read LoopKeeper.
    // Covers the clean path and the invite deeplink (query string is ignored).
    try {
      const u = new URL(url);
      const isLoopKeeperPath = u.hostname === 'zyppar.com' && (u.pathname === '/loopkeeper/' || u.pathname.startsWith('/loopkeeper') || u.pathname.startsWith('/openloop'));
      if (isLoopKeeperPath) {
        return res.json({
          url,
          host: u.hostname,
          title: 'LoopKeeper — Close the loop you keep meaning to close',
          image: 'https://zyppar.com/loopkeeper/assets/loopkeeper/og-1200x630.png',
          description: 'Follow-through for the few who matter — nudge, draft, send, streak.',
        });
      }
    } catch { /* malformed URL falls through to the generic scraper */ }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LoopKeeper/1.0)' } });
    clearTimeout(timer);
    const html = await r.text();
    const grab = (re) => { const m = html.match(re); return m?.[1] ? String(m[1]).replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim().slice(0, 300) : ''; };
    const title = grab(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || grab(/<title[^>]*>([^<]+)<\/title>/i);
    const image = grab(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    const description = grab(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
      || grab(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    res.json({ url, host, title, image, description });
  } catch (e) {
    res.status(502).json({ error: 'Link preview failed: ' + (e?.message || 'unknown') });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-08-19 THE DROPBOX MOMENT — invites.
 * When the counterparty does NOT have Rolodex, the appointment/message is
 * delivered through the channels they already use (WhatsApp / email / SMS /
 * X / copy-link). The share URL carries a short token; clicking it opens the
 * PWA, which fetches the invite and shows the landing card.
 * 2026-08-27 PERSISTENCE GAP CLOSED: the map is now mirrored to disk
 * (data/invites.json) — a restart or crash no longer wipes pending invites.
 * Disk failures fall back silently to memory-only (the old behavior).
 * ──────────────────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
// fs + path are already required at the top of this file.
const invites = new Map(); // token -> { from, room, kind, title, when, text, createdAt }
const INVITE_TTL_MS = 48 * 3600_000;
const INVITES_FILE = path.join(__dirname, '..', 'data', 'invites.json');

function inviteToken() {
  return crypto.randomBytes(4).toString('hex');
}

// 2026-08-27 LOAD on boot — TTL-filtered, corrupt-file tolerant.
try {
  if (fs.existsSync(INVITES_FILE)) {
    const raw = JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8'));
    const now = Date.now();
    let loaded = 0;
    for (const [t, inv] of Object.entries(raw || {})) {
      if (inv && typeof inv.createdAt === 'number' && now - inv.createdAt <= INVITE_TTL_MS) {
        invites.set(t, inv);
        loaded++;
      }
    }
    console.log(`[invites] restored ${loaded} pending invite(s) from disk`);
  }
} catch (err) {
  console.error('[invites] restore failed (memory-only):', err.message);
}

let invitesSaveTimer = null;
function saveInvitesSoon() {
  if (invitesSaveTimer) return; // already scheduled — debounce
  invitesSaveTimer = setTimeout(() => {
    invitesSaveTimer = null;
    try {
      fs.mkdirSync(path.dirname(INVITES_FILE), { recursive: true });
      fs.writeFileSync(INVITES_FILE, JSON.stringify(Object.fromEntries(invites)), 'utf8');
    } catch (err) {
      console.error('[invites] save failed (continuing memory-only):', err.message);
    }
  }, 2000);
  invitesSaveTimer.unref?.();
}
// Flush immediately on shutdown paths.
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => {
    try {
      if (invites.size) {
        fs.mkdirSync(path.dirname(INVITES_FILE), { recursive: true });
        fs.writeFileSync(INVITES_FILE, JSON.stringify(Object.fromEntries(invites)), 'utf8');
      }
    } catch { /* best effort at exit */ }
  });
}

setInterval(() => {
  const now = Date.now();
  let expiredAny = false;
  for (const [t, inv] of invites) {
    if (now - inv.createdAt > INVITE_TTL_MS) { invites.delete(t); expiredAny = true; }
  }
  if (expiredAny) saveInvitesSoon();
}, 3600_000).unref();

app.post('/api/rolodex/invites', (req, res) => {
  const { from = '', room = '', kind = 'message', title = '', when = '', text = '' } = req.body || {};
  if (!from || !room) return res.status(400).json({ error: 'from + room required' });
  const token = inviteToken();
  invites.set(token, { from: String(from).slice(0, 60), room: String(room).slice(0, 60), kind: kind === 'appointment' ? 'appointment' : 'message', title: String(title).slice(0, 120), when: String(when).slice(0, 32), text: String(text).slice(0, 600), createdAt: Date.now() });
  saveInvitesSoon();
  res.json({ ok: true, token, url: 'https://zyppar.com/loopkeeper/?invite=' + token, ogUrl: 'https://zyppar.com/api/loopkeeper/invites/' + token + '/og' });
});

app.get('/api/rolodex/invites/:token', (req, res) => {
  const inv = invites.get(String(req.params.token || ''));
  if (!inv) return res.status(404).json({ error: 'Invite expired or not found' });
  res.json({ ok: true, invite: { ...inv, token: req.params.token } });
});

// 2026-08-18 THE OG-TAGGED LANDING - the SHAREAPP moment. This is the URL the
// share text carries. WhatsApp / email / X fetch it and see the branded card in
// the preview (logo + "You have a message on LoopKeeper"); a human tap gets a
// branded splash and is carried into the PWA invite landing automatically.
app.get('/api/rolodex/invites/:token/og', (req, res) => {
  const token = String(req.params.token || '');
  const inv = invites.get(token);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(inviteOgPage(inv, token));
});


/* ────────────────────────────────────────────────────────────────────────────
 * 2026-08-27 CRASH INTAKE — the audit gap "no crash reporting" closed without
 * an external vendor. The app's crash reporter batches window errors +
 * unhandled rejections here; each event lands as one JSON line in
 * data/crashes.jsonl (read via SSH: `tail data/crashes.jsonl`). Privacy-first:
 * no raw IPs, no query strings (invite tokens never reach the log), every
 * field length-capped, hard rate limit per client.
 * ──────────────────────────────────────────────────────────────────────────── */
const CRASHES_FILE = path.join(__dirname, '..', 'data', 'crashes.jsonl');
const CRASH_SALT = crypto.randomBytes(16).toString('hex'); // per-process — hashes are not trackable across restarts
const crashRateHits = new Map(); // ipHash -> [timestamps]
function crashIpHash(ip) {
  return crypto.createHash('sha1').update(CRASH_SALT + String(ip || '')).digest('hex').slice(0, 10);
}
const clampStr = (v, n) => String(v == null ? '' : v).slice(0, n);
app.post('/api/rolodex/crashes', (req, res) => {
  const ipHash = crashIpHash(req.socket?.remoteAddress);
  const now = Date.now();
  const hits = (crashRateHits.get(ipHash) || []).filter((t) => now - t < 60_000);
  if (hits.length >= 5) return res.status(429).json({ error: 'slow down' });
  hits.push(now);
  crashRateHits.set(ipHash, hits);

  const body = req.body && Array.isArray(req.body.events) ? req.body.events : [];
  if (!body.length) return res.status(400).json({ error: 'events[] required' });
  const events = body.slice(0, 20).map((e) => ({
    receivedAt: new Date().toISOString(),
    device: ipHash,
    ts: Number(e.ts) || now,
    type: e.type === 'unhandledrejection' ? 'unhandledrejection' : 'error',
    msg: clampStr(e.msg, 500),
    stack: clampStr(e.stack, 2000),
    ver: clampStr(e.ver, 24),
    plat: clampStr(e.plat, 12),
    lang: clampStr(e.lang, 12),
    page: clampStr(e.page, 120),
    ua: clampStr(e.ua, 180),
  }));
  try {
    fs.mkdirSync(path.dirname(CRASHES_FILE), { recursive: true });
    fs.appendFileSync(CRASHES_FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    res.json({ ok: true, accepted: events.length });
  } catch (err) {
    console.error('[crashes] append failed:', err.message);
    res.status(500).json({ error: 'persist failed' });
  }
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
// 2026-08-18 AI STATUS: lets the app show a live green light + which engine
// the server can actually deliver (DeepSeek/Grok/GLM keys configured or not).
app.get('/api/rolodex/ai/status', (_req, res) => {
  res.json({
    ok: true,
    onDevice: true, // the on-device engine always works, even offline
    deepseekConfigured: !!envVar('DEEPSEEK_API_KEY'),
    grokConfigured: !!envVar('GROK_API_KEY'),
    glmConfigured: !!envVar('OPENROUTER_API_KEY'),
    ttsConfigured: studioTts.configured(),
  });
});

app.post('/api/rolodex/sync', async (req, res) => {
  try {
    const { deviceId, contacts = [], followUps = [], deviceName = '', room = '', ownerPhone = '', ownerName = '' } = req.body || {};
    if (!deviceId) return res.status(400).json({ message: 'deviceId required' });
    // 2026-08-18 THE AGENT'S COURTESY: a brand-new device gets a welcome from
    // LoopKeeper on its very first connection - even free users (trial period).
    const existing = await DeviceState.findOne({ deviceId }).lean();
    const isNewDevice = !existing;
    // 2026-08-19 THE 7-DAY TRIAL: starts on first use (first sync) and is never
    // auto-renewed. The server is the source of truth; the client's own trial
    // values are only adopted when the server has none yet.
    const clientTrialStart = Number(req.body?.trial?.startedAt) || 0;
    const clientTrialEnd = Number(req.body?.trial?.endsAt) || 0;
    const now = new Date();
    const trialStartedAt = existing?.trialStartedAt || (clientTrialStart > 0 ? new Date(clientTrialStart) : now);
    const trialEndsAt = existing?.trialEndsAt || (clientTrialEnd > Date.now() ? new Date(clientTrialEnd) : new Date(now.getTime() + 7 * 86400_000));
    // 2026-08-18 THE USERS DB: the sync registers the device's identity
    if (ownerPhone) {
      await RolodexUser.updateOne(
        { phone: String(ownerPhone).trim() },
        { $set: { deviceId, room: String(room || '').trim().toUpperCase().slice(0, 24), name: String(ownerName || deviceName || '').slice(0, 60), lastSeenAt: new Date() } },
        { upsert: true }
      );
    }
    const names = (contacts || [])
      .map(contactDisplayName)
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
          trialStartedAt,
          trialEndsAt,
          sample: {
            first: contactDisplayName((contacts || [])[0]) || '(unnamed)',
            dueToday: (followUps || []).filter((f) => f && f.overdue === true).length,
          },
        },
      },
      { upsert: true }
    );
    res.json({
      ok: true,
      deviceId,
      syncedAt: new Date().toISOString(),
      trial: {
        startedAt: trialStartedAt.toISOString(),
        endsAt: trialEndsAt.toISOString(),
        reopens: existing?.trialReopens || 0,
      },
      // 2026-08-18 THE AGENT SPEAKS FIRST: only on a brand-new device.
      ...(isNewDevice ? {
        welcome: "Karibu sana! I'm LoopKeeper, your Confidante. Your contacts stay yours — I'm here to remember the tiny loops and proffer the messages. Add the 4 W's (When / Where / Who / Why) on a card and I'll start drafting in your voice. You're on a 7-day Confidante trial."
      } : {}),
    });
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
      trial: {
        startedAt: d.trialStartedAt || null,
        endsAt: d.trialEndsAt || null,
        reopens: d.trialReopens || 0,
      },
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
    res.setHeader('Cache-Control', 'no-store');
    res.send(peekPage(devices, total));
  } catch (err) {
    res.status(500).send(`<h1>live unavailable</h1><p>${err.message}</p>`);
  }
});

// 2026-08-19 THE INVESTOR SUMMARY — the JSON the Investor page charts draw
// from. Deliberately raw and captioned: counts are the numbers devices last
// pushed, never deduplicated or projected.
app.get('/api/rolodex/investor/summary', async (_req, res) => {
  try {
    const now = Date.now();
    const hourAgo = new Date(now - 3600_000);
    const dayAgo = new Date(now - 24 * 3600_000);
    const [totalsAgg] = await DeviceState.aggregate([
      {
        $group: {
          _id: null,
          contacts: { $sum: '$contactsCount' },
          followUps: { $sum: '$followUpsCount' },
          activeLastHour: { $sum: { $cond: [{ $gte: ['$lastSyncAt', hourAgo] }, 1, 0] } },
          activeLast24h: { $sum: { $cond: [{ $gte: ['$lastSyncAt', dayAgo] }, 1, 0] } },
        },
      },
    ]);
    const devices = await DeviceState.find({}).sort({ lastSyncAt: -1 }).limit(500).lean();
    const roomMap = new Map();
    for (const d of devices) {
      const room = String(d.room || '').trim().toUpperCase() || '(no room)';
      const entry = roomMap.get(room) || { room, deviceCount: 0, contacts: 0, followUps: 0, lastSyncAt: null };
      entry.deviceCount += 1;
      entry.contacts += d.contactsCount || 0;
      entry.followUps += d.followUpsCount || 0;
      if (!entry.lastSyncAt || d.lastSyncAt > entry.lastSyncAt) entry.lastSyncAt = d.lastSyncAt;
      roomMap.set(room, entry);
    }
    const rooms = Array.from(roomMap.values())
      .sort((a, b) => (b.contacts || 0) - (a.contacts || 0))
      .slice(0, 10);
    const timeline = [];
    for (let i = 23; i >= 0; i--) {
      const start = new Date(now - (i + 1) * 3600_000);
      const end = new Date(now - i * 3600_000);
      const count = devices.filter((d) => d.lastSyncAt && d.lastSyncAt >= start && d.lastSyncAt < end).length;
      timeline.push({ bucketStart: start.toISOString(), count });
    }
    const topDevices = devices.slice(0, 10).map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName || d.deviceId,
      room: d.room || '',
      lastSyncAt: d.lastSyncAt,
      contactsCount: d.contactsCount || 0,
      followUpsCount: d.followUpsCount || 0,
      recentNames: (d.contactNames || []).slice(0, 4),
    }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      generatedAt: new Date().toISOString(),
      totals: {
        devices: await DeviceState.countDocuments(),
        contacts: totalsAgg?.contacts || 0,
        followUps: totalsAgg?.followUps || 0,
        activeLastHour: totalsAgg?.activeLastHour || 0,
        activeLast24h: totalsAgg?.activeLast24h || 0,
      },
      rooms,
      timeline,
      topDevices,
      // 2026-08-23 REAL PRODUCT ANALYTICS: anonymous event stream, not sync stamps.
      analytics: await computeAnalyticsSummary(),
      // 2026-08-25 COMMUNITY TRANSLATIONS: anonymous contributions from the portal.
      translations: {
        total: await TranslationSuggestion.countDocuments(),
        byLang: await TranslationSuggestion.aggregate([
          { $group: { _id: '$lang', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 50 },
        ]),
        latest: await TranslationSuggestion.find()
          .sort({ createdAt: -1 })
          .limit(10)
          .select('lang keys createdAt')
          .lean(),
      },
    });
  } catch (err) {
    console.error('[rolodex/investor/summary]', err.message);
    res.status(500).json({ error: 'summary failed: ' + (err?.message || 'unknown') });
  }
});

// ── 2026-08-23 ANONYMOUS PRODUCT ANALYTICS ───────────────────────────────────
// The investor portal now reports real presence/frequency/time/retention from
// lightweight events. No contacts, no PII — only deviceId + event names.

app.post('/api/rolodex/analytics/events', async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || '').slice(0, 80);
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : [];
    if (!deviceId || !events.length) return res.status(400).json({ error: 'deviceId + events required' });
    const docs = events
      .map((e) => ({
        deviceId,
        event: String(e?.event || '').slice(0, 60),
        props: e?.props && typeof e.props === 'object' ? e.props : {},
        sessionId: String(e?.sessionId || '').slice(0, 60),
        ts: e?.ts ? new Date(e.ts) : new Date(),
      }))
      .filter((e) => e.event);
    if (docs.length) {
      await AnalyticsEvent.insertMany(docs);
      // 2026-08-28 TESTER PRACTICE LEDGER: events carrying a numeric testerId
      // (a closed-beta invite code) are rolled up per day. Numbers only.
      await rollupTesterDays(docs);
    }
    res.json({ ok: true, accepted: docs.length });
  } catch (err) {
    res.status(500).json({ error: 'analytics ingest failed: ' + (err?.message || 'unknown') });
  }
});

// 2026-08-28 TESTER PRACTICE LEDGER — roll numeric-testerId events into a
// per-day ledger so the founder dashboard can show streaks and compliance
// without ever holding PII. The app sends the invite CODE (6 digits); the
// ledger keys on the slot (1-15).
async function rollupTesterDays(docs) {
  try {
    const perDay = new Map();
    for (const e of docs) {
      const code = Number(e.props?.testerId);
      const slot = TESTER_CODES.indexOf(code);
      if (slot < 0) continue;
      const testerId = slot + 1;
      const day = new Date(e.ts).toISOString().slice(0, 10);
      const key = testerId + '|' + day;
      const row = perDay.get(key) || { testerId, day, launches: 0, captures: 0, sends: 0, closes: 0, videos: 0, confidante: 0, feedback: 0 };
      if (e.event === 'app_launch') row.launches++;
      else if (e.event === 'loop_captured') row.captures++;
      else if (e.event === 'message_sent') row.sends++;
      else if (e.event === 'loop_closed') row.closes++;
      else if (e.event === 'video_clip_sent') row.videos++;
      else if (e.event === 'confidante_message') row.confidante++;
      else if (e.event === 'feedback_sent') row.feedback++;
      perDay.set(key, row);
    }
    for (const row of perDay.values()) {
      const { testerId, day, ...inc } = row;
      await TesterDay.findOneAndUpdate({ testerId, day }, { $inc: inc }, { upsert: true });
    }
  } catch (err) {
    console.error('[tester rollup]', err.message);
  }
}

// 2026-08-28 TESTER DEEPLINK ACCEPT — POST { code } from tester.html.
// First accept claims the slot; later accepts are idempotent (they re-return
// the original acceptedAt so a re-clicked link never resets anything).
app.post('/api/rolodex/tester/accept', async (req, res) => {
  try {
    const code = Number(req.body?.code);
    const slot = TESTER_CODES.indexOf(code);
    if (!code || slot < 0) return res.status(404).json({ error: 'unknown code' });
    const testerId = slot + 1;
    const existing = await TesterAccept.findOne({ testerId }).lean();
    if (existing) {
      return res.json({ ok: true, testerId, acceptedAt: existing.createdAt, alreadyAccepted: true });
    }
    const doc = await TesterAccept.create({
      testerId,
      code,
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
    });
    res.json({ ok: true, testerId, acceptedAt: doc.createdAt });
  } catch (err) {
    console.error('[rolodex/tester/accept]', err.message);
    res.status(500).json({ error: 'accept failed: ' + (err?.message || 'unknown') });
  }
});

// 2026-08-28 TESTER ROSTER (FOUNDER ONLY) — who accepted, who installed, who
// is practicing the 15-min/day habit, who went silent. Guarded by the
// TESTER_ADMIN_KEY env; if the env is not set the roster is disabled entirely
// (no accidental public exposure).
app.get('/api/rolodex/tester/roster', async (req, res) => {
  try {
    const key = String(req.query.key || '');
    // 2026-08-28 FIX: must go through envVar() like every other secret —
    // process.env alone never sees the repo .env file (no dotenv), so the
    // founder's TESTER_ADMIN_KEY=... line was silently ignored (401 forever).
    const expected = String(envVar('TESTER_ADMIN_KEY') || '');
    if (!expected || key !== expected) return res.status(401).json({ error: 'forbidden' });
    const [accepts, days, feedbacks] = await Promise.all([
      TesterAccept.find({}).lean(),
      TesterDay.find({}).lean(),
      InvestorFeedback.find({}, 'testerId createdAt').lean(),
    ]);
    const acceptMap = new Map(accepts.map((a) => [a.testerId, a]));
    const dayMap = new Map();
    for (const d of days) {
      const list = dayMap.get(d.testerId) || [];
      list.push(d);
      dayMap.set(d.testerId, list);
    }
    const fbCount = new Map();
    for (const f of feedbacks) {
      if (!f.testerId) continue;
      fbCount.set(f.testerId, (fbCount.get(f.testerId) || 0) + 1);
    }
    const dayMs = (s) => new Date(s + 'T00:00:00Z').getTime();
    const todayMs = dayMs(new Date().toISOString().slice(0, 10));
    const testers = TESTER_CODES.map((code, i) => {
      const slot = i + 1;
      const acc = acceptMap.get(slot);
      const list = (dayMap.get(slot) || []).sort((a, b) => (a.day < b.day ? -1 : 1));
      const totals = list.reduce((t, d) => ({
        launches: t.launches + (d.launches || 0),
        captures: t.captures + (d.captures || 0),
        sends: t.sends + (d.sends || 0),
        closes: t.closes + (d.closes || 0),
        videos: t.videos + (d.videos || 0),
        confidante: t.confidante + (d.confidante || 0),
        feedback: t.feedback + (d.feedback || 0),
      }), { launches: 0, captures: 0, sends: 0, closes: 0, videos: 0, confidante: 0, feedback: 0 });
      // Last 14 days grid (Play-gate proxy window), oldest → newest.
      const grid = [];
      for (let k = 13; k >= 0; k--) {
        const day = new Date(todayMs - k * 86400_000).toISOString().slice(0, 10);
        const row = list.find((d) => d.day === day);
        const practiced = !!row && ((row.captures || 0) + (row.sends || 0) + (row.closes || 0)) > 0;
        grid.push({ day, active: !!row, practiced });
      }
      const allPracticeDays = list.filter((d) => ((d.captures || 0) + (d.sends || 0) + (d.closes || 0)) > 0).length;
      const last = list.length ? list[list.length - 1] : null;
      const daysSinceLastSeen = last ? Math.round((todayMs - dayMs(last.day)) / 86400_000) : null;
      let status = 'awaiting';
      if (acc && last) status = allPracticeDays > 0 ? 'practicing' : 'installed';
      else if (acc) status = 'accepted';
      // Nudges: the moments the founder promised to catch — never installed
      // within 48h of accepting, or silent for 3+ days.
      let nudge = null;
      if (acc && !last && acc.createdAt && (Date.now() - new Date(acc.createdAt).getTime()) > 48 * 3600_000) nudge = 'install';
      else if (last && (daysSinceLastSeen || 0) >= 3) nudge = 'checkin';
      return {
        slot,
        code,
        status,
        nudge,
        acceptedAt: acc?.createdAt || null,
        firstSeenDay: list.length ? list[0].day : null,
        lastSeenDay: last?.day || null,
        daysSinceLastSeen,
        activeDays: list.length,
        practiceDays: allPracticeDays,
        feedbackNotes: fbCount.get(slot) || 0,
        totals,
        grid,
      };
    });
    const claimed = testers.filter((t) => t.acceptedAt).length;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      generatedAt: new Date().toISOString(),
      summary: {
        claimed,
        installed: testers.filter((t) => t.status === 'installed' || t.status === 'practicing').length,
        practicing: testers.filter((t) => t.status === 'practicing').length,
        nudges: testers.filter((t) => t.nudge).length,
      },
      testers,
    });
  } catch (err) {
    console.error('[rolodex/tester/roster]', err.message);
    res.status(500).json({ error: 'roster failed: ' + (err?.message || 'unknown') });
  }
});

// 2026-08-25 COMMUNITY TRANSLATION INGEST — anonymous, capped, PII-free.
app.post('/api/rolodex/translations/contribute', async (req, res) => {
  try {
    const lang = String(req.body?.lang || '').slice(0, 20);
    const keysRaw = req.body?.keys && typeof req.body.keys === 'object' ? req.body.keys : {};
    const keys = {};
    let count = 0;
    for (const [k, v] of Object.entries(keysRaw)) {
      if (count >= 200) break;
      const key = String(k || '').slice(0, 120);
      const val = String(v || '').trim().slice(0, 500);
      if (key.startsWith('loopkeeper.') && val) {
        keys[key] = val;
        count++;
      }
    }
    if (!lang || !count) return res.status(400).json({ error: 'lang + keys required' });
    const doc = await TranslationSuggestion.create({ lang, keys, source: 'portal' });
    res.json({ ok: true, id: String(doc._id), accepted: count });
  } catch (err) {
    res.status(500).json({ error: 'translation ingest failed: ' + (err?.message || 'unknown') });
  }
});

// 2026-08-25 COMMUNITY TRANSLATION SUMMARY — for the Investors portal + review.
app.get('/api/rolodex/translations/summary', async (req, res) => {
  try {
    const total = await TranslationSuggestion.countDocuments();
    const byLang = await TranslationSuggestion.aggregate([
      { $group: { _id: '$lang', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 50 },
    ]);
    const latest = await TranslationSuggestion.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .select('lang keys createdAt')
      .lean();
    res.json({ ok: true, total, byLang, latest });
  } catch (err) {
    res.status(500).json({ error: 'translation summary failed: ' + (err?.message || 'unknown') });
  }
});

// 2026-08-25 REVIEW QUEUE — pending/approved/rejected suggestions for a lang.
app.get('/api/rolodex/translations/suggestions', async (req, res) => {
  try {
    const lang = String(req.query?.lang || '').slice(0, 20);
    const status = String(req.query?.status || 'pending');
    const limit = Math.min(Number(req.query?.limit) || 100, 500);
    const q = {};
    if (lang) q.lang = lang;
    if (status === 'pending') { q.approved = false; q.rejected = false; }
    else if (status === 'approved') { q.approved = true; }
    else if (status === 'rejected') { q.rejected = true; }
    const items = await TranslationSuggestion.find(q)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('lang keys source approved rejected createdAt')
      .lean();
    res.json({ ok: true, status, items });
  } catch (err) {
    res.status(500).json({ error: 'translation suggestions failed: ' + (err?.message || 'unknown') });
  }
});

// 2026-08-25 APPROVE / REJECT — maintainer review actions.
app.post('/api/rolodex/translations/:id/approve', async (req, res) => {
  try {
    const doc = await TranslationSuggestion.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'not found' });
    doc.approved = true;
    doc.rejected = false;
    await doc.save();
    res.json({ ok: true, id: String(doc._id) });
  } catch (err) {
    res.status(500).json({ error: 'approve failed: ' + (err?.message || 'unknown') });
  }
});

app.post('/api/rolodex/translations/:id/reject', async (req, res) => {
  try {
    const doc = await TranslationSuggestion.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'not found' });
    doc.rejected = true;
    doc.approved = false;
    await doc.save();
    res.json({ ok: true, id: String(doc._id) });
  } catch (err) {
    res.status(500).json({ error: 'reject failed: ' + (err?.message || 'unknown') });
  }
});

// 2026-08-25 EXPORT APPROVED — aggregated keys per language for merging into
// the shipped locale files (later-approved wins).
app.get('/api/rolodex/translations/export', async (req, res) => {
  try {
    const lang = String(req.query?.lang || '').slice(0, 20);
    const q = { approved: true };
    if (lang) q.lang = lang;
    const docs = await TranslationSuggestion.find(q).sort({ createdAt: 1 }).lean();
    const merged = {};
    for (const d of docs) {
      if (d.keys && typeof d.keys === 'object') {
        for (const [k, v] of Object.entries(d.keys)) {
          if (k.startsWith('loopkeeper.') && String(v || '').trim()) merged[k] = String(v).trim();
        }
      }
    }
    const byLang = {};
    for (const d of docs) {
      byLang[d.lang] = (byLang[d.lang] || 0) + Object.keys(d.keys || {}).length;
    }
    res.json({ ok: true, lang: lang || 'all', keyCount: Object.keys(merged).length, byLang, keys: merged });
  } catch (err) {
    res.status(500).json({ error: 'translation export failed: ' + (err?.message || 'unknown') });
  }
});

// 2026-08-25 ONE-CLICK MERGE — write approved translations into the deployed
// PWA's locale files. Set FRONTEND_DIST to the served www directory (default
// /var/www/rolodex). Merges into each locale's loopkeeper section.
app.post('/api/rolodex/translations/merge', async (req, res) => {
  try {
    const lang = String(req.body?.lang || '').slice(0, 20);
    const q = { approved: true };
    if (lang) q.lang = lang;
    const docs = await TranslationSuggestion.find(q).sort({ createdAt: 1 }).lean();
    const mergedByLang = {};
    for (const d of docs) {
      const per = mergedByLang[d.lang] || (mergedByLang[d.lang] = {});
      if (d.keys && typeof d.keys === 'object') {
        for (const [k, v] of Object.entries(d.keys)) {
          if (k.startsWith('loopkeeper.') && String(v || '').trim()) per[k] = String(v).trim();
        }
      }
    }
    const dist = process.env.FRONTEND_DIST || '/var/www/rolodex';
    const i18nDir = path.join(dist, 'assets', 'i18n');
    if (!fs.existsSync(i18nDir)) {
      return res.status(400).json({ error: `i18n dir not found at ${i18nDir} — set FRONTEND_DIST` });
    }
    const written = {};
    for (const [code, keys] of Object.entries(mergedByLang)) {
      const file = path.join(i18nDir, `${code}.json`);
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        /* new locale file */
      }
      data.loopkeeper = Object.assign({}, data.loopkeeper || {}, keys);
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      written[code] = Object.keys(keys).length;
    }
    res.json({ ok: true, dist, written });
  } catch (err) {
    res.status(500).json({ error: 'translation merge failed: ' + (err?.message || 'unknown') });
  }
});

async function analyticsDistinctDevices(since) {
  return AnalyticsEvent.distinct('deviceId', { ts: { $gte: since } });
}

async function computeAnalyticsSummary() {
  const now = Date.now();
  const h = 3600_000;
  const d = 24 * h;
  const dayAgo = new Date(now - d);
  const weekAgo = new Date(now - 7 * d);
  const monthAgo = new Date(now - 30 * d);

  const [dau, wau, mau] = await Promise.all([
    analyticsDistinctDevices(dayAgo),
    analyticsDistinctDevices(weekAgo),
    analyticsDistinctDevices(monthAgo),
  ]);

  const sessions24h = await AnalyticsEvent.countDocuments({ event: 'session_start', ts: { $gte: dayAgo } });
  const sessions7d = await AnalyticsEvent.countDocuments({ event: 'session_start', ts: { $gte: weekAgo } });
  const sessions30d = await AnalyticsEvent.countDocuments({ event: 'session_start', ts: { $gte: monthAgo } });

  const [avgSession] = await AnalyticsEvent.aggregate([
    { $match: { event: 'session_end', 'props.duration': { $gt: 0 }, ts: { $gte: monthAgo } } },
    { $group: { _id: null, avg: { $avg: '$props.duration' }, count: { $sum: 1 } } },
  ]);

  // Activation: distinct devices that ever hit each milestone.
  const activationEvents = ['card_added', 'followup_created', 'message_sent', 'loop_closed', 'invite_created', 'billing_started', 'billing_succeeded'];
  const activation = {};
  for (const ev of activationEvents) {
    activation[ev.replace(/_/g, '')] = (await AnalyticsEvent.distinct('deviceId', { event: ev })).length;
  }

  // Retention cohorts: last 7 days, first app_launch per device, D1/D7 return.
  const firstSeen = await AnalyticsEvent.aggregate([
    { $match: { event: 'app_launch' } },
    { $group: { _id: '$deviceId', first: { $min: '$ts' } } },
  ]);
  const firstMap = new Map(firstSeen.map((f) => [f._id, new Date(f.first).getTime()]));
  const retention = [];
  for (let i = 6; i >= 0; i--) {
    const start = now - (i + 1) * d;
    const end = now - i * d;
    const devices = firstSeen
      .filter((f) => {
        const t = new Date(f.first).getTime();
        return t >= start && t < end;
      })
      .map((f) => f._id);
    if (!devices.length) {
      retention.push({ day: new Date(start).toISOString().slice(0, 10), size: 0, d1: 0, d7: 0 });
      continue;
    }
    const events = await AnalyticsEvent.find({ deviceId: { $in: devices } }).select('deviceId ts').lean();
    const evMap = new Map();
    for (const e of events) {
      if (!evMap.has(e.deviceId)) evMap.set(e.deviceId, []);
      evMap.get(e.deviceId).push(new Date(e.ts).getTime());
    }
    let d1 = 0;
    let d7 = 0;
    for (const dev of devices) {
      const first = firstMap.get(dev);
      const times = evMap.get(dev) || [];
      if (times.some((t) => t >= first + d && t < first + 2 * d)) d1++;
      if (times.some((t) => t >= first + 7 * d && t < first + 8 * d)) d7++;
    }
    retention.push({ day: new Date(start).toISOString().slice(0, 10), size: devices.length, d1, d7 });
  }

  const topEvents = await AnalyticsEvent.aggregate([
    { $match: { ts: { $gte: weekAgo } } },
    { $group: { _id: '$event', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 12 },
  ]);

  // 2026-08-29 BUILD 144 (founder #3): a DEDICATED investors-portal line for
  // invite failures. The invitee taps "Something didn't work?" on the landing
  // (app build 142) and the anonymous invite_issue event lands here — the
  // funnel's leak, on its own line, not buried in topEvents.
  const [inviteIssues24h, inviteIssues7d, inviteIssues30d] = await Promise.all([
    AnalyticsEvent.countDocuments({ event: 'invite_issue', ts: { $gte: dayAgo } }),
    AnalyticsEvent.countDocuments({ event: 'invite_issue', ts: { $gte: weekAgo } }),
    AnalyticsEvent.countDocuments({ event: 'invite_issue', ts: { $gte: monthAgo } }),
  ]);
  const inviteIssueKinds = await AnalyticsEvent.aggregate([
    { $match: { event: 'invite_issue', ts: { $gte: monthAgo } } },
    { $group: { _id: '$props.kind', count: { $sum: 1 } } },
  ]);

  // 2026-08-29 BUILD 149 (founder: "what part of the world, languages,
  // culture, do they switch languages?"). The app (build 149) stamps every
  // app_launch with coarse categorical locale props — tz (IANA zone, the
  // no-IP geography proxy), tzRegion, deviceLang, appLang — and every
  // deliberate language switch with lang_switched. Aggregate only; nothing
  // identifying, nothing per-user.
  const [topTimezones, topRegions, topAppLangs, topDeviceLangs, langSwitches30d, langSwitchTargets] = await Promise.all([
    AnalyticsEvent.aggregate([
      { $match: { event: 'app_launch', 'props.tz': { $exists: true, $ne: '' }, ts: { $gte: monthAgo } } },
      { $group: { _id: '$props.tz', devices: { $addToSet: '$deviceId' }, count: { $sum: 1 } } },
      { $project: { _id: 1, count: 1, devices: { $size: '$devices' } } },
      { $sort: { devices: -1, count: -1 } },
      { $limit: 8 },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { event: 'app_launch', 'props.tzRegion': { $exists: true, $ne: '' }, ts: { $gte: monthAgo } } },
      { $group: { _id: '$props.tzRegion', devices: { $addToSet: '$deviceId' }, count: { $sum: 1 } } },
      { $project: { _id: 1, count: 1, devices: { $size: '$devices' } } },
      { $sort: { devices: -1, count: -1 } },
      { $limit: 8 },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { event: 'app_launch', 'props.appLang': { $exists: true, $ne: '' }, ts: { $gte: monthAgo } } },
      { $group: { _id: '$props.appLang', devices: { $addToSet: '$deviceId' }, count: { $sum: 1 } } },
      { $project: { _id: 1, count: 1, devices: { $size: '$devices' } } },
      { $sort: { devices: -1, count: -1 } },
      { $limit: 10 },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { event: 'app_launch', 'props.deviceLang': { $exists: true, $ne: '' }, ts: { $gte: monthAgo } } },
      { $group: { _id: '$props.deviceLang', devices: { $addToSet: '$deviceId' }, count: { $sum: 1 } } },
      { $project: { _id: 1, count: 1, devices: { $size: '$devices' } } },
      { $sort: { devices: -1, count: -1 } },
      { $limit: 10 },
    ]),
    AnalyticsEvent.countDocuments({ event: 'lang_switched', ts: { $gte: monthAgo } }),
    AnalyticsEvent.aggregate([
      { $match: { event: 'lang_switched', ts: { $gte: monthAgo } } },
      { $group: { _id: '$props.to', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
  ]);
  const locales = {
    topTimezones: topTimezones.map((t) => ({ tz: t._id || 'unknown', devices: t.devices, launches: t.count })),
    topRegions: topRegions.map((t) => ({ region: t._id || 'unknown', devices: t.devices, launches: t.count })),
    appLanguages: topAppLangs.map((t) => ({ lang: t._id || 'unknown', devices: t.devices, launches: t.count })),
    deviceLanguages: topDeviceLangs.map((t) => ({ lang: t._id || 'unknown', devices: t.devices, launches: t.count })),
    langSwitches30d,
    langSwitchTargets: langSwitchTargets.map((t) => ({ lang: t._id || 'unknown', count: t.count })),
  };

  // 2026-08-29 BUILD 152 (founder: "a record of how often users are sending out
  // messages or sharing the app… how soon after invite, new users respond"):
  // shares by voice/channel + the invite funnel timed by the 48h token.
  const [shareByVoice, shareByChannel, funnelRaw] = await Promise.all([
    AnalyticsEvent.aggregate([
      { $match: { event: 'app_shared', ts: { $gte: monthAgo } } },
      { $group: { _id: '$props.voice', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { event: 'app_shared', ts: { $gte: monthAgo } } },
      { $group: { _id: '$props.channel', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 12 },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { event: { $in: ['invite_created', 'invite_landed', 'invite_accepted'] }, ts: { $gte: monthAgo } } },
      { $project: { event: 1, token: '$props.token', voice: '$props.voice', ts: 1 } },
      { $match: { token: { $exists: true, $ne: null } } },
      { $sort: { ts: 1 } },
      { $group: { _id: '$token', events: { $push: { event: '$event', voice: '$voice', ts: '$ts' } } } },
    ]),
  ]);
  let invites30d = 0, landed30d = 0, accepted30d = 0;
  const hoursToLand = [], hoursToAccept = [];
  const funnelByVoice = {}; // BUILD 152: voice -> { invites, landed, accepted }
  for (const doc of funnelRaw) {
    const first = doc.events?.[0] || {};
    if (first.event !== 'invite_created') continue; // only funnels we saw being born
    invites30d += 1;
    const voice = first.voice || 'unknown';
    if (!funnelByVoice[voice]) funnelByVoice[voice] = { invites: 0, landed: 0, accepted: 0 };
    funnelByVoice[voice].invites += 1;
    const createdTs = new Date(first.ts).getTime();
    const land = (doc.events || []).find((e) => e.event === 'invite_landed');
    const accept = (doc.events || []).find((e) => e.event === 'invite_accepted');
    if (land) {
      landed30d += 1;
      funnelByVoice[voice].landed += 1;
      hoursToLand.push(Math.max(0, (new Date(land.ts).getTime() - createdTs) / 3600000));
    }
    if (accept) {
      accepted30d += 1;
      funnelByVoice[voice].accepted += 1;
      hoursToAccept.push(Math.max(0, (new Date(accept.ts).getTime() - createdTs) / 3600000));
    }
  }
  const median = (arr) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null);
  const sharesTotal = shareByVoice.reduce((a, b) => a + b.count, 0);

  return {
    dau: dau.length,
    wau: wau.length,
    mau: mau.length,
    sessions: { last24h: sessions24h, last7d: sessions7d, last30d: sessions30d },
    avgSessionSeconds: Math.round(Number(avgSession?.avg) || 0),
    sessionsRecorded30d: avgSession?.count || 0,
    activation,
    retention,
    topEvents,
    inviteIssues: {
      last24h: inviteIssues24h,
      last7d: inviteIssues7d,
      last30d: inviteIssues30d,
      kinds: inviteIssueKinds.map((k) => ({ kind: k._id || 'unspecified', count: k.count })),
    },
    // 2026-08-29 BUILD 152: what people send out and share — and the invite
    // funnel timed created → landed → accepted by the ephemeral token.
    shares: {
      total30d: sharesTotal,
      byVoice: shareByVoice.map((v) => ({ voice: v._id || 'auto', count: v.count })),
      byChannel: shareByChannel.map((v) => ({ channel: v._id || 'unknown', count: v.count })),
      funnelByVoice: Object.entries(funnelByVoice).map(([voice, f]) => ({ voice, ...f })),
    },
    inviteFunnel: {
      invites30d,
      landed30d,
      accepted30d,
      medianHoursToLand: median(hoursToLand),
      medianHoursToAccept: median(hoursToAccept),
    },
    locales, // 2026-08-29 BUILD 149: where in the world / which language / do they switch
  };
}

// 2026-08-19 THE TRIAL REOPEN — the owner/investor can re-open the 7-day trial
// for a device when desirable. It never happens automatically.
app.post('/api/rolodex/trial/reopen', async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const now = new Date();
    const endsAt = new Date(now.getTime() + 7 * 86400_000);
    const updated = await DeviceState.findOneAndUpdate(
      { deviceId },
      { $set: { trialStartedAt: now, trialEndsAt: endsAt }, $inc: { trialReopens: 1 } },
      { upsert: true, new: true }
    );
    res.json({
      ok: true,
      trial: {
        startedAt: updated.trialStartedAt,
        endsAt: updated.trialEndsAt,
        reopens: updated.trialReopens || 0,
      },
    });
  } catch (err) {
    console.error('[rolodex/trial/reopen]', err.message);
    res.status(500).json({ error: 'trial reopen failed: ' + (err?.message || 'unknown') });
  }
});

// 2026-08-19 CHAT WITH AI ASSISTANT — user suggestions + frustration land here
// and are read in the Investors portal's extended (-x2) room.
// 2026-08-24 PRIVACY HARDENING: only the AI-gleaned summary is stored. Raw
// conversation text is intentionally discarded, never persisted.
app.post('/api/rolodex/feedback', async (req, res) => {
  try {
    const { deviceId = '', deviceName = '', summary = '' } = req.body || {};
    const cleanMessages = []; // raw messages are never stored
    const cleanSummary = String(summary || '').trim().slice(0, 3000);
    if (!cleanSummary) return res.status(400).json({ error: 'summary required' });
    // 2026-08-28 CLOSED BETA: optional numeric testerId (invite code) so the
    // founder knows which tester's direction this is — never an identity.
    let testerId = Number(req.body?.testerId);
    if (!TESTER_CODES.includes(testerId)) testerId = null;
    await InvestorFeedback.create({
      deviceId: String(deviceId || '').slice(0, 80),
      deviceName: String(deviceName || '').slice(0, 80),
      messages: cleanMessages,
      summary: cleanSummary,
      testerId,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[rolodex/feedback]', err.message);
    res.status(500).json({ error: 'feedback failed: ' + (err?.message || 'unknown') });
  }
});

app.get('/api/rolodex/feedback', async (_req, res) => {
  try {
    const items = await InvestorFeedback.find({}).sort({ createdAt: -1 }).limit(100).lean();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      items: items.map((i) => ({
        id: String(i._id),
        deviceId: i.deviceId || '',
        deviceName: i.deviceName || i.deviceId || '',
        messages: i.messages || [],
        summary: i.summary || '',
        createdAt: i.createdAt,
      })),
    });
  } catch (err) {
    console.error('[rolodex/feedback]', err.message);
    res.status(500).json({ error: 'feedback list failed: ' + (err?.message || 'unknown') });
  }
});

function contactDisplayName(c) {
  if (!c) return '';
  const n = c.name;
  if (typeof n === 'string') return String(n).trim();
  if (n && typeof n === 'object') {
    const direct = String(n.display || n.formatted || n.displayName || n.fullName || n.name || '').trim();
    if (direct) return direct;
    const joined = [n.prefix, n.given || n.givenName, n.middle || n.middleName, n.family || n.familyName, n.suffix]
      .filter((v) => v !== undefined && v !== null && String(v).trim())
      .join(' ')
      .trim();
    if (joined) return joined;
  }
  if (c.firstName) return String([c.firstName, c.lastName || ''].filter(Boolean).join(' ')).trim();
  if (c.displayName) return String(c.displayName).trim();
  if (c.nickname) return String(c.nickname).trim();
  return '';
}

function peekPage(devices, total) {
  const rows = devices
    .map((d) => {
      const iso = d.lastSyncAt ? new Date(d.lastSyncAt).toISOString() : '';
      const names = (d.contactNames || []).slice(0, 4).filter((n) => typeof n === 'string' && n !== '[object Object]').join(', ') || '—';
      return `<tr>
        <td><b>${escapeHtml(d.deviceName || d.deviceId)}</b><br/><span class="dim">${escapeHtml(String(d.deviceId).slice(0, 18))}</span></td>
        <td class="sync-time" data-iso="${escapeHtml(iso)}">—</td>
        <td>${escapeHtml(d.room || '—')}</td>
        <td>${d.contactsCount ?? 0}</td>
        <td>${d.followUpsCount ?? 0}</td>
        <td class="dim">${escapeHtml(names)}</td>
      </tr>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LoopKeeper — Live dashboard</title><style>
body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6e8f0;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;color:#8b93b0;font-weight:400;margin:0 0 8px}
.badge{display:inline-block;background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55;border-radius:20px;padding:3px 10px;font-size:12px;margin-left:8px}
.tab-note{background:#1c2128;border:1px solid #30363d;border-radius:10px;padding:10px 12px;font-size:13px;color:#8b93b0;margin:0 0 18px}
.tab-note b{color:#e6e8f0}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
caption{caption-side:top;text-align:left;font-size:12px;color:#8b93b0;padding:6px 2px 10px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #21262d}th{color:#8b93b0;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.dim{color:#8b93b0;font-size:12px}.live{color:#3fb950;font-weight:600}
.foot{color:#8b93b0;font-size:12px;margin-top:20px}
</style></head><body>
<h1>LoopKeeper <span class="badge live">● LIVE</span></h1>
<h2>Every device that talks to the fresh <code>loopkeeper</code> database — auto-refreshing every 5s.</h2>
<div class="tab-note"><b>You are in the live dashboard (a new browser tab).</b> The LoopKeeper app is still open behind this tab — close this tab or switch back to continue there.</div>
<table>
<caption>Recent names = the first 4 contact display names that device last pushed. Contacts / Follow-ups = the raw counts in that push, not deduplicated people.</caption>
<thead><tr><th>Device</th><th>Last sync</th><th>Room</th><th>Contacts</th><th>Follow-ups</th><th>Recent names</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="dim">Waiting for the first device to sync…</td></tr>'}</tbody></table>
<div class="foot">${total} device(s) synced · <span id="clock">—</span></div>
<script>
function formatTimes(){document.querySelectorAll('.sync-time').forEach(function(el){var iso=el.getAttribute('data-iso');if(iso){try{el.textContent=new Date(iso).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});}catch(e){el.textContent='—';}}});document.getElementById('clock').textContent=new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});}
formatTimes();
setInterval(function(){fetch('/api/rolodex/live',{headers:{Accept:'text/html'},cache:'no-store'}).then(function(r){return r.text();}).then(function(h){var m=h.match(/<tbody>([\\s\\S]*?)<\\/tbody>/);if(m)document.querySelector('tbody').innerHTML=m[1];formatTimes();}).catch(function(){});},5000);
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The SHAREAPP landing: branded OG card for link crawlers + a tiny splash that
// carries the human into the PWA invite. Absolute asset URLs (the page is served
// from /api/rolodex/, not from the Angular app).
function inviteOgPage(inv, token) {
  const base = 'https://zyppar.com/loopkeeper';
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
        ? `${escapeHtml(inv.from)} invited you to ${escapeHtml(inv.title || 'an appointment')} on LoopKeeper`
        : `${escapeHtml(inv.from)} sent you a message on LoopKeeper`)
    : 'You have a message on LoopKeeper';
  const ogDesc = hasInvite
    ? (kind === 'appointment'
        ? `A LoopKeeper appointment is waiting for you${inv.title ? `: ${escapeHtml(inv.title)}` : ''}${whenLabel ? ` — ${whenLabel}` : ''}.`
        : `“${escapeHtml(inv.text || '')}” — your card is ready on LoopKeeper.`)
    : 'Follow-through for the few who matter — nudge, draft, send, streak.';
  const ogImage = 'https://zyppar.com/loopkeeper/assets/loopkeeper/og-1200x630.png';
  const refresh = hasInvite ? `<meta http-equiv="refresh" content="0;url=${pwaUrl}">` : '';
  const body = hasInvite
    ? `<div class="kicker">${kind === 'appointment' ? 'Appointment from' : 'Message from'} ${from}</div>
       <div class="title">${kind === 'appointment' ? escapeHtml(inv.title || 'An appointment') : 'Your card is ready'}</div>
       <div class="dim">${kind === 'appointment' ? (whenLabel || '') : '“' + escapeHtml(inv.text || '') + '”'}</div>
       <a class="btn" href="${pwaUrl}">Open in LoopKeeper</a>`
    : `<div class="kicker">LoopKeeper</div>
       <div class="title">This invite has expired</div>
       <div class="dim">Ask your friend to send it again — or close the loop you keep meaning to close.</div>
       <a class="btn" href="https://play.google.com/store/apps/details?id=com.zyppar.loopkeeper">Get LoopKeeper</a>`;
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh}
<title>${ogTitle}</title>
<meta property="og:site_name" content="LoopKeeper">
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
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#17120E;color:#FAF6F0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}
.shell{max-width:420px;padding:32px}
.logo{width:88px;height:88px;border-radius:22px}
.wordmark{width:200px;margin-top:16px}
.kicker{color:#B8AC9E;font-size:13px;margin-top:20px}
.title{font-size:20px;font-weight:600;margin-top:8px}
.dim{color:#B8AC9E;font-size:14px;margin-top:8px;line-height:1.5}
.btn{display:inline-block;margin-top:24px;background:#FF5A36;color:#17120E;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:14px}
</style>
</head><body>
<div class="shell">
  <img class="logo" src="${ogImage}" alt="LoopKeeper">
  <br><img class="wordmark" src="https://zyppar.com/loopkeeper/assets/loopkeeper/wordmark.svg" alt="LoopKeeper">
  ${body}
  <div class="dim" style="margin-top:28px">Close the loop you keep meaning to close.</div>
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
    // 2026-08-27 [object Object] GUARD: an old build emitting an object as text
    // coerces to this literal — never relay it into other users' threads.
    if (!text || text === '[object Object]') return;
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

  // 2026-08-19 WEBRTC SIGNALING: the server is a dumb relay - it never sees
  // media, only offer/answer/ICE. Peers in the same room exchange signals.
  // 2026-08-22 (build 19): webrtc:join lets two devices that open the modal at
  // the same time decide who sends the offer (lower callerId), avoiding glare.
  socket.on('webrtc:join', (data) => {
    const room = socket.data.chatRoom;
    if (!room) return;
    const callerId = String(data?.callerId || '').slice(0, 64);
    if (!callerId) return;
    socket.data.webrtcCallerId = callerId;
    socket.to('room:' + room).emit('webrtc:join', {
      name: socket.data.chatName || 'Someone',
      callerId,
    });
  });

  socket.on('webrtc:signal', (data) => {
    const room = socket.data.chatRoom;
    if (!room) return;
    const payload = {
      room,
      type: String(data?.type || '').slice(0, 20),
      sdp: data?.sdp ? String(data.sdp).slice(0, 20000) : '',
      candidate: data?.candidate ? String(data.candidate).slice(0, 20000) : '',
      name: socket.data.chatName || 'Someone',
      callerId: String(data?.callerId || socket.data.webrtcCallerId || '').slice(0, 64),
    };
    socket.to('room:' + room).emit('webrtc:signal', payload);
  });

  socket.on('webrtc:leave', (data) => {
    const room = socket.data.chatRoom;
    if (!room) return;
    socket.to('room:' + room).emit('webrtc:leave', {
      name: socket.data.chatName || 'Someone',
      callerId: String(data?.callerId || socket.data.webrtcCallerId || '').slice(0, 64),
    });
  });

  // 2026-08-19 VIDEO CLIP MESSAGING: short reminder/greeting clips ride the
  // room as data URLs (small clips only; production can move to object storage).
  socket.on('video-clip', (data) => {
    const room = socket.data.chatRoom;
    if (!room) return;
    const payload = {
      room,
      name: socket.data.chatName || 'Someone',
      dataUrl: String(data?.dataUrl || '').slice(0, 4_000_000),
      note: String(data?.note || '').slice(0, 300),
      ts: Date.now(),
    };
    socket.to('room:' + room).emit('video-clip', payload);
  });

  socket.on('disconnect', () => {
    if (socket.data.chatRoom) {
      socket.to('room:' + socket.data.chatRoom).emit('chat:left', { name: socket.data.chatName, ts: Date.now() });
      if (socket.data.webrtcCallerId) {
        socket.to('room:' + socket.data.chatRoom).emit('webrtc:leave', {
          name: socket.data.chatName || 'Someone',
          callerId: socket.data.webrtcCallerId,
        });
      }
      try {
        io.in('room:' + socket.data.chatRoom).fetchSockets().then((peers) => {
          socket.to('room:' + socket.data.chatRoom).emit('chat:present', { count: Math.max(0, peers.length - 1) });
        }).catch(() => {});
      } catch {}
    }
  });
});

httpServer.listen(port, () => console.log(`[rolodex] listening on :${port} (http + socket.io)`));
