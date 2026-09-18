#!/usr/bin/env node
// BUILD 270/271 COMPANION: verify the nginx body cap after raising it.
// Run on the droplet:  cd /opt/rolodex-server && node verify-body-cap.cjs
// EXPECT: "HTTP 200 — cap raised" (413 = still capped; check
// /etc/nginx/conf.d/90-body-cap.conf exists and nginx was reloaded).
const https = require('https');
const MB = 1024 * 1024;
function post(bytes) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ deviceId: 'probe-cap', contacts: [{ contactId: 'b', isMockData: false, name: { display: 'x' }, image: { base64String: 'A'.repeat(bytes) } }], loops: [] });
    const req = https.request({ hostname: 'zyppar.com', path: '/api/loopkeeper/sync', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let b = ''; res.on('data', (d) => b += d); res.on('end', () => resolve({ bytes, status: res.statusCode }));
    });
    req.on('error', (e) => resolve({ bytes, status: 'ERR: ' + String(e).slice(0, 60) }));
    req.end(payload);
  });
}
(async () => {
  const r2 = await post(Math.round(2 * MB));
  console.log(`2.0 MB -> HTTP ${r2.status}${r2.status === 200 ? '  — cap raised ✓' : '  — still capped (check /etc/nginx/conf.d/90-body-cap.conf + sudo systemctl reload nginx)'}`);
  if (r2.status === 200) {
    const r8 = await post(Math.round(8 * MB));
    console.log(`8.0 MB -> HTTP ${r8.status}${r8.status === 200 ? '  — full decks with covers ride ✓' : ''}`);
  }
  process.exit(0);
})();
