// 2026-09-20 BUILD 106 THE ADMIN SECRET, CHANNELLED (founder: "Have we at
// backend channelled the TESTER_ADMIN_KEY into config.ts and called it from
// there as is server policy? Our code is just not right."). THE ONE MODULE
// that owns the admin secret: every key-gated endpoint calls
// config.checkAdminKey(...) — no endpoint reads the env inline, so the
// secret has exactly one home, one read path, and one policy.
// NOTE: the INVESTORS portal word (INVESTOR_KEY) is a DIFFERENT secret —
// a device-local gate for the portal — and is deliberately NOT accepted here.
const fs = require('fs');

function envRead(name) {
  if (process.env[name]) return process.env[name];
  // Same read path as index.js envVar: process.env first, then the .env the
  // deploy script maintains (process.env alone never sees the repo .env —
  // no dotenv in this server).
  const candidates = ['D:/TODOs/db-tools-tmp/zyppar.env', '.env'];
  for (const p of candidates) {
    try {
      const t = fs.readFileSync(p, 'utf8');
      const m = t.match(new RegExp('^' + name + '=["\']?([^\r\n"\']+)', 'm'));
      if (m) return m[1];
    } catch { /* try next */ }
  }
  return '';
}

function testerAdminKey() {
  return envRead('TESTER_ADMIN_KEY');
}

/** THE ONE GATE. Returns { ok: true } or { ok: false, status, error }. */
function checkAdminKey(candidate) {
  const expected = testerAdminKey();
  if (!expected) {
    return { ok: false, status: 500, error: 'TESTER_ADMIN_KEY is not set on the server — add it to .env' };
  }
  if (String(candidate || '') !== expected) {
    return { ok: false, status: 401, error: 'forbidden' };
  }
  return { ok: true };
}

module.exports = { testerAdminKey, checkAdminKey };
