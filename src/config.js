// 2026-09-20 BUILD 106 THE ADMIN SECRET, CHANNELLED (founder: "Have we at
// backend channelled the TESTER_ADMIN_KEY into config.ts and called it from
// there as is server policy? Our code is just not right."). THE ONE MODULE
// that owns the admin secret: every key-gated endpoint calls
// config.checkAdminKey(...) — no endpoint reads the env inline, so the
// secret has exactly one home, one read path, and one policy.
// NOTE: the INVESTORS portal word (INVESTOR_KEY) is a DIFFERENT secret —
// a device-local gate for the portal — and is deliberately NOT accepted here.
// 2026-09-23 BUILD 123 THE FILE IS THE SOURCE (founder, after ~24h of the
// gate 401ing while /opt/rolodex-server/.env already held the right key):
// a pm2-held stale process env — from a dump-resurrect after a reboot, or
// any restart without --update-env — SHADOWED the edited .env, because this
// read checked process.env FIRST. For the admin secret the .env FILE is the
// deliberate source: it is read FIRST and wins on EVERY gate check (this
// module reads fresh per call, so an .env edit takes effect immediately —
// no restart needed at all when no stale env is held). process.env is the
// fallback, never the shadow.
const fs = require('fs');

function envRead(name) {
  const candidates = ['D:/TODOs/db-tools-tmp/zyppar.env', '.env'];
  for (const p of candidates) {
    try {
      const t = fs.readFileSync(p, 'utf8');
      const m = t.match(new RegExp('^' + name + '=["\']?([^\r\n"\']+)', 'm'));
      if (m) return m[1];
    } catch { /* try next */ }
  }
  if (process.env[name]) return process.env[name];
  return '';
}

// BUILD 123: the boot log names the SOURCE, never the value — a stale-env
// shadow is now one `pm2 logs` glance instead of a day of mystery.
(function logAdminSource() {
  let fromFile = '';
  for (const p of ['D:/TODOs/db-tools-tmp/zyppar.env', '.env']) {
    try {
      const m = fs.readFileSync(p, 'utf8').match(/^TESTER_ADMIN_KEY=["']?([^\r\n"']+)/m);
      if (m) { fromFile = m[1]; break; }
    } catch { /* try next */ }
  }
  const fromEnv = process.env.TESTER_ADMIN_KEY || '';
  const source = fromFile ? '.env file' : (fromEnv ? 'process env (STALE RISK — set the file)' : 'NOT SET — admin doors answer 500');
  if (fromFile && fromEnv && fromFile !== fromEnv) console.log('[admin] TESTER_ADMIN_KEY: .env file WINS (a held process env differs — file-first per build 123)');
  else console.log('[admin] TESTER_ADMIN_KEY source: ' + source);
})();

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
