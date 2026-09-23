// 2026-09-23 BUILD 124 THE WRITE GATE (founder: "Add jwt middleware to limit
// writes"). One module owns token minting + verification; the middleware
// rides BEFORE the write routes.
//
// SHAPE (no new dependency — Node's own crypto, HMAC-SHA256, the JWT two-
// segment core): header.payload.signature, base64url. The claim set is
// minimal and anonymous: { did, iat, exp }. NOTHING identifies a person —
// the same privacy law as the analytics pipeline.
//
// THE HANDSHAKE: GET /api/rolodex/auth/token?deviceId=... mints a 7-day
// token for that anonymous id (rate-limited per IP; the id is random). The
// client sends Authorization: Bearer <token> on WRITES. The middleware
// verifies the signature + expiry AND that the token's did matches the
// request's deviceId (a stolen token is bound to one device id — useless
// against another slot).
//
// WHAT IT GATES (server 124): the three USER-DATA writes that persist —
//   POST /sync            (the deck, loops, followUps, trial state)
//   POST /analytics/events
//   POST /crashes
// Admin-key-gated endpoints (roster, noise, purge, translations/approve)
// keep their stronger shared-secret gate and are NOT double-gated.
// Deliberately OPEN (landing/one-shot/public surfaces): invites (a share
// link must work from a cold browser), invites/og, tester/accept + tester/
// visit (the tester.html door), investor/verify, translations/contribute,
// billing/checkout (Stripe's own flow), crashes (the reporter rides
// unauthenticated by design — its ledger is the evidence), tts (studio).
//
// GRACE: if the server has no AUTH_SECRET configured, the middleware
// FAILS OPEN (the demo must not die) and logs once — set AUTH_SECRET in
// .env to arm it. This keeps the deploy order safe: deploy server, then
// the app (which fetches tokens), then set the secret.
const crypto = require('crypto');

const AUTH_SECRET = (function readSecret() {
  const candidates = ['D:/TODOs/db-tools-tmp/zyppar.env', '.env'];
  for (const p of candidates) {
    try {
      const m = fs.readFileSync(p, 'utf8').match(/^AUTH_SECRET=["']?([^\r\n"']+)/m);
      if (m) return m[1];
    } catch { /* try next */ }
  }
  return process.env.AUTH_SECRET || '';
})();

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sign(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', AUTH_SECRET).update(head + '.' + body).digest();
  return head + '.' + body + '.' + b64url(mac);
}
function verify(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const mac = crypto.createHmac('sha256', AUTH_SECRET).update(parts[0] + '.' + parts[1]).digest();
    const got = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (mac.length !== got.length || !crypto.timingSafeEqual(mac, got)) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload || !payload.did || (payload.exp && Date.now() / 1000 > payload.exp)) return null;
    return payload;
  } catch { return null; }
}

/** The mint: one token per anonymous deviceId, 7 days, HMAC-signed. */
function mintToken(deviceId) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ did: String(deviceId || '').slice(0, 80), iat: now, exp: now + 7 * 86400 });
}

/** THE MIDDLEWARE. Verifies Bearer <jwt> and binds it to the request's
 *  deviceId. Arms ONLY when AUTH_SECRET is set; fails open (logged) when
 *  the secret is absent so a keyless deploy never kills the demo. */
function requireWriteAuth(req, res, next) {
  if (!AUTH_SECRET) {
    if (!requireWriteAuth.warned) {
      requireWriteAuth.warned = true;
      console.warn('[auth] AUTH_SECRET not set — the write gate is OPEN (set AUTH_SECRET in .env to arm it)');
    }
    return next();
  }
  const h = String(req.headers?.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const payload = token ? verify(token) : null;
  const bodyDid = String(req.body?.deviceId || req.query?.deviceId || '');
  if (!payload) return res.status(401).json({ error: 'write token required' });
  if (bodyDid && payload.did !== bodyDid) return res.status(403).json({ error: 'token does not match this device' });
  req.authDid = payload.did;
  return next();
}

module.exports = { mintToken, requireWriteAuth, authSecretSet: !!AUTH_SECRET };
