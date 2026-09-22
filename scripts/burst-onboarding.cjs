#!/usr/bin/env node
/* THE BURST — 20 concurrent ingests + 5 concurrent summaries + 10 tester-door
   hits, all probe-tagged (excluded from organic meters by the summary). */
const BASE = 'https://zyppar.com';
const dev = 'probe-burst-' + Date.now();
const evs = { deviceId: dev, events: [{ event: 'app_launch', ts: new Date().toISOString(), props: {} }], sessionId: 'burst-' + Date.now() };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
const get = (url) => fetch(url, { signal: AbortSignal.timeout(25000) });

(async () => {
  const t0 = Date.now();
  // 20 concurrent ingests (same session, 20 distinct batches)
  const ing = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    post(BASE + '/api/loopkeeper/analytics/events', { ...evs, sessionId: evs.sessionId + '-' + i }).then(r => r.status)));
  // 5 concurrent summaries
  const sum = await Promise.all(Array.from({ length: 5 }, () =>
    get(BASE + '/api/loopkeeper/investor/summary').then(r => r.status)));
  // 10 tester-door hits
  const tst = await Promise.all(Array.from({ length: 10 }, () =>
    post(BASE + '/api/loopkeeper/tester/accept', { code: 999999 }).then(r => r.status)));
  // 10 health beats under load
  const hp = await Promise.all(Array.from({ length: 10 }, () =>
    get(BASE + '/api/loopkeeper/health').then(r => r.status)));
  const ms = Date.now() - t0;
  const ok = (arr, want) => arr.every(s => s === want);
  console.log(`burst complete in ${ms}ms`);
  console.log(`ingest x20: ${ok([ing, ...Array(19).fill(200)], 200) ? 'all 200' : 'MIXED: ' + ing}`);
  console.log(`summary x5: ${ok(sum, 200) ? 'all 200' : 'MIXED: ' + sum}`);
  console.log(`tester x10: ${ok(tst, 404) ? 'all honest-404' : 'MIXED: ' + tst}`);
  console.log(`health x10: ${ok(hp, 200) ? 'all 200' : 'MIXED: ' + hp}`);
  const bad = ![...ing, ...sum, ...hp].every(s => s === 200) || !tst.every(s => s === 404);
  console.log(bad ? 'VERDICT: FAIL' : 'VERDICT: the doors held under the burst');
  process.exit(bad ? 1 : 0);
})();