'use strict';

/**
 * Optional Qwen TTS proxy for Rolodex Studio playback.
 * Same endpoint shape as Zyppar's Qwen client (QWEN_TTS_ENDPOINT).
 * Never writes to Mongo. If the endpoint is unset, synthesize() returns null
 * so the app falls back to device TTS.
 *
 * 2026-08-21: env lookup also reads the Zyppar server envs (local + droplet)
 * so rolodex reuses the SAME Qwen TTS engine as /opt/zyppar-server — one TTS
 * engine, two Express apps. Added listVoices()/health() to match the Zyppar
 * /library/tts/* surface (synthesize, stream, voices, health).
 */

function envVar(name) {
  if (process.env[name]) return process.env[name];
  const fs = require('fs');
  const candidates = [
    'D:/TODOs/db-tools-tmp/zyppar.env',
    'D:/MacBook/noGoogle/zypparserver/.env',
    '/opt/zyppar-server/.env',
    '.env',
  ];
  for (const p of candidates) {
    try {
      const t = fs.readFileSync(p, 'utf8');
      const m = t.match(new RegExp('^' + name + '=[\"\']?([^\r\n\"\']+)', 'm'));
      if (m) return m[1];
    } catch { /* try next */ }
  }
  return '';
}

function configured() {
  return !!envVar('QWEN_TTS_ENDPOINT');
}

/** Minimal Qwen personality catalog — mirrors the frontend StudioQwenTtsService. */
function listVoices() {
  return [
    {
      id: 'qwen-echo', name: 'Confidante', language: 'en', gender: 'female',
      description: 'The Confidante default — warm, clear, personal.', archetype: 'Universal',
      defaultEmotion: 'neutral', speedHint: { min: 0.9, max: 1.15, default: 1.0 },
    },
    {
      id: 'qwen-atlas', name: 'Atlas', language: 'en', gender: 'male',
      description: 'Warm authority — for business and news.', archetype: 'Anchor',
      defaultEmotion: 'neutral', speedHint: { min: 0.9, max: 1.2, default: 1.0 },
    },
    {
      id: 'qwen-luna', name: 'Luna', language: 'en', gender: 'female',
      description: 'Gentle, reassuring — for wellness and personal notes.', archetype: 'Companion',
      defaultEmotion: 'calm', speedHint: { min: 0.75, max: 1.0, default: 0.85 },
    },
    {
      id: 'qwen-orion', name: 'Orion', language: 'en', gender: 'male',
      description: 'Energetic and inspiring.', archetype: 'Guide',
      defaultEmotion: 'happy', speedHint: { min: 1.0, max: 1.4, default: 1.15 },
    },
  ];
}

/** Health: configured + a fast reachability probe of the Qwen endpoint. */
async function health() {
  const endpoint = envVar('QWEN_TTS_ENDPOINT');
  if (!endpoint) {
    return { qwen: false, google: false, configured: false, detail: 'QWEN_TTS_ENDPOINT not set' };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(endpoint, { method: 'GET', signal: ctrl.signal });
    clearTimeout(timer);
    return { qwen: r.ok, google: false, configured: true, detail: 'HTTP ' + r.status };
  } catch (e) {
    return { qwen: false, google: false, configured: true, detail: (e?.message || 'unreachable') };
  }
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

module.exports = { configured, synthesize, listVoices, health };
