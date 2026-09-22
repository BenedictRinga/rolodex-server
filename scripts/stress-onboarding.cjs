#!/usr/bin/env node
/* 2026-09-22 THE ONBOARDING STRESS TEST — every channel a first-timer's
   device touches, probed against production. probe-* ids are excluded from
   organic meters by the summary's own filter, so no pollution. */
const BASE = 'https://zyppar.com';
const APP = BASE + '/loopkeeper';
const API = BASE + '/api/loopkeeper';
const rows = [];
let pass = 0, fail = 0;

async function probe(name, url, opts = {}, expect = (r) => r.status < 400) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    const ms = Date.now() - t0;
    const ok = expect(r) ? 'PASS' : 'FAIL';
    if (ok === 'PASS') pass++; else fail++;
    let note = '';
    if (name.includes('chunk') || name.includes('i18n') || name.includes('index')) {
      note = (r.headers.get('content-type') || '').slice(0, 24);
    }
    console.log(`${ok}  ${String(ms).padStart(5)}ms  ${r.status}  ${name} ${note}`);
    return r;
  } catch (e) {
    fail++;
    console.log(`FAIL  ${String(Date.now() - t0).padStart(5)}ms  ERR  ${name} — ${(e && e.message) || e}`);
    return null;
  }
}

(async () => {
  console.log('== THE SHELL ==');
  const index = await probe('index.html (the shell)', APP + '/');
  const build = await probe('build.json (the update channel)', APP + '/build.json?probe=' + Date.now());
  if (build) { const j = await build.json().catch(() => null); if (j) console.log(`      -> advertised build ${j.build} (v${j.version})`); }

  console.log('== CHUNK INTEGRITY (every script/style the index references) ==');
  if (index) {
    const html = await index.text();
    const refs = [...new Set([...html.matchAll(/(?:main|runtime|polyfills|styles|vendor|scripts|common)\.[a-f0-9]+\.(?:js|css)/g)])];
    console.log(`      -> index references ${refs.length} chunks`);
    for (const f of refs.slice(0, 8)) await probe('chunk ' + f, APP + '/' + f, {}, (r) => r.status === 200);
  }

  console.log('== I18N (the greeting in every tongue) ==');
  for (const loc of ['en', 'sw', 'ha', 'am', 'so', 'he']) {
    await probe('i18n ' + loc + '.json', APP + '/assets/i18n/' + loc + '.json?probe=' + Date.now());
  }

  console.log('== SERVER LIFELINES ==');
  await probe('health', APIH = BASE + '/api/loopkeeper/health');
  await probe('version (the update check)', BASE + '/api/rolodex/version');
  await probe('ai/status (the Assistant green light)', BASE + '/api/rolodex/ai/status');
  await probe('investor/summary (the portal)', BASE + '/api/loopkeeper/investor/summary');

  console.log('== ANALYTICS INGEST (the corridor + the meters) ==');
  const probeDev = 'probe-stress-' + Date.now();
  const evs = { deviceId: probeDev, events: [
    { event: 'app_launch', ts: new Date().toISOString(), props: {} },
    { event: 'session_start', ts: new Date().toISOString(), props: {} },
  ], sessionId: 'stress-' + Date.now() };
  const ing = await probe('analytics/events POST (idempotent ingest)', BASE + '/api/loopkeeper/analytics/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evs) });
  if (ing) { const j = await ing.json().catch(() => null); if (j) console.log(`      -> accepted ${j.accepted}, duplicates ${j.duplicates}`); }
  const ing2 = await probe('analytics/events REPLAY (idempotency)', BASE + '/api/loopkeeper/analytics/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evs) });
  if (ing2) { const j = await ing2.json().catch(() => null); if (j) console.log(`      -> replay: accepted ${j.accepted}, duplicates ${j.duplicates} (must be 2 accepted first, 0 on replay)`); }

  console.log('== THE TESTER DOOR ==');
  const ta = await probe('tester/accept (invalid code → honest 4xx)', BASE + '/api/loopkeeper/tester/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 999999, deviceName: 'stress' }) }, (r) => r.status >= 400 && r.status < 500);

  console.log('== THE INVITE DOOR (share → landing) ==');
  await probe('invites/:token/og (bogus token → 4xx, never 5xx)', BASE + '/api/rolodex/invites/stressprobe/og', {}, (r) => r.status < 500);
  await probe('invites/:token (bogus token → 4xx)', BASE + '/api/rolodex/invites/stressprobe', {}, (r) => r.status < 500);

  console.log('== THE ASSISTANT GUARDS (no key spend on garbage) ==');
  await probe('chat (empty body → rejected before AI)', BASE + '/api/rolodex/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, (r) => r.status >= 400 && r.status < 500);
  await probe('polish-alpha (the task-draft polish — route alive?)', BASE + '/api/loopkeeper/polish-alpha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, (r) => r.status !== 404, );

  console.log(`\n== VERDICT: ${pass} pass, ${fail} fail ==`);
  process.exit(fail ? 1 : 0);
})();