'use strict';

/**
 * Optional Qwen TTS proxy for Rolodex Studio playback.
 * Same endpoint shape as Zyppar's Qwen client (QWEN_TTS_ENDPOINT).
 * Never writes to Mongo. If the endpoint is unset, synthesize() returns null
 * so the app falls back to device TTS.
 */

function envVar(name) {
  if (process.env[name]) return process.env[name];
  const fs = require('fs');
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

function configured() {
  return !!envVar('QWEN_TTS_ENDPOINT');
}

async function synthesize(text, options = {}) {
  const endpoint = envVar('QWEN_TTS_ENDPOINT');
  if (!endpoint || !String(text || '').trim()) return null;
  const safeText = String(text)
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ' ')
    .replace(/[\uD800-\uDFFF]/g, '')
    .slice(0, 4000);
  const payload = {
    model: envVar('QWEN_TTS_MODEL') || 'qwen3-tts-flash',
    input: safeText,
    voice: options.voice || 'qwen-default',
    speed: options.speed ?? 1.0,
    response_format: 'mp3',
  };
  const headers = { 'Content-Type': 'application/json' };
  const key = envVar('QWEN_TTS_API_KEY');
  if (key) headers.Authorization = 'Bearer ' + key;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error('Qwen TTS ' + r.status + (err ? ': ' + err.slice(0, 180) : ''));
  }
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { configured, synthesize };
