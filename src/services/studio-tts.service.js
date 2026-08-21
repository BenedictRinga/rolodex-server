'use strict';

/**
 * Rolodex-server OWN TTS proxy — no dependency on the zyppar-server env or
 * process. Config lives in rolodex-server's own .env:
 *   QWEN_TTS_ENDPOINT  (default http://localhost:8080/v1/audio/speech)
 *   QWEN_TTS_API_KEY   (optional)
 *   QWEN_TTS_MODEL     (default qwen3-tts-flash)
 *
 * Never writes to Mongo. If the endpoint is unreachable, synthesize() throws
 * and the frontend falls back to device TTS.
 */

const DEFAULT_QWEN_ENDPOINT = 'http://localhost:8080/v1/audio/speech';

function envVar(name) {
  if (process.env[name]) return process.env[name];
  const fs = require('fs');
  try {
    const t = fs.readFileSync('.env', 'utf8');
    const m = t.match(new RegExp('^' + name + '=[\"\']?([^\r\n\"\']+)', 'm'));
    if (m) return m[1];
  } catch { /* no .env */ }
  return '';
}

function qwenEndpoint() {
  return envVar('QWEN_TTS_ENDPOINT') || DEFAULT_QWEN_ENDPOINT;
}

/** Rolodex owns a TTS endpoint (own env or the local default) — always configured. */
function configured() {
  return !!qwenEndpoint();
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

/** Health: endpoint + a fast reachability probe of the Qwen engine. */
async function health() {
  const endpoint = qwenEndpoint();
  const healthEndpoint = endpoint.replace('/v1/audio/speech', '/health');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(healthEndpoint, { method: 'GET', signal: ctrl.signal });
    clearTimeout(timer);
    return { qwen: r.ok, google: false, configured: true, endpoint, detail: 'HTTP ' + r.status };
  } catch {
    // Fallback: some Qwen deployments don't expose /health — try the main endpoint.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(endpoint, { method: 'GET', signal: ctrl.signal });
      clearTimeout(timer);
      return { qwen: r.ok, google: false, configured: true, endpoint, detail: 'HTTP ' + r.status };
    } catch (e) {
      return { qwen: false, google: false, configured: true, endpoint, detail: (e?.message || 'unreachable') };
    }
  }
}

async function synthesize(text, options = {}) {
  const endpoint = qwenEndpoint();
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

module.exports = { configured, synthesize, listVoices, health, qwenEndpoint };
