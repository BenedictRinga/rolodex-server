'use strict';

/**
 * Rolodex-server OWN TTS proxy — no dependency on the zyppar-server env or
 * process. Config lives in rolodex-server's own .env:
 *   QWEN_TTS_ENDPOINT        (default http://localhost:8080/v1/audio/speech)
 *   QWEN_TTS_API_KEY         (optional)
 *   QWEN_TTS_MODEL           (default qwen3-tts-flash)
 *   ROLODEX_TTS_GOOGLE_FALLBACK  (default 1 — free no-key Google Translate TTS
 *                                 fallback so MP3 still works when no Qwen engine
 *                                 is running; set 0 to disable)
 *
 * Never writes to Mongo. synthesize() tries Qwen first, then the no-key Google
 * Translate fallback, then throws so the frontend can fall back to device TTS.
 */

const DEFAULT_QWEN_ENDPOINT = 'http://localhost:8080/v1/audio/speech';
const GOOGLE_TRANSLATE_TTS_BASE = 'https://translate.google.com/translate_tts';

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

/** Whether the no-key Google Translate fallback is enabled (default on). */
function googleFallbackEnabled() {
  const v = String(envVar('ROLODEX_TTS_GOOGLE_FALLBACK') || '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no');
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

/** Health: probe the Qwen engine; report whether the Google fallback is enabled. */
async function health() {
  const endpoint = qwenEndpoint();
  const healthEndpoint = endpoint.replace('/v1/audio/speech', '/health');
  const probe = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(url, { method: 'GET', signal: ctrl.signal });
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  const qwen = await probe(healthEndpoint) || await probe(endpoint);
  return {
    qwen,
    google: googleFallbackEnabled(),
    configured: true,
    endpoint,
    googleFallback: googleFallbackEnabled(),
    detail: qwen ? 'HTTP 200' : 'Qwen unreachable — Google Translate fallback ' + (googleFallbackEnabled() ? 'enabled' : 'disabled'),
  };
}

async function synthesize(text, options = {}) {
  const safeText = String(text || '')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ' ')
    .replace(/[\uD800-\uDFFF]/g, '')
    .slice(0, 4000);
  if (!safeText.trim()) return null;

  try {
    return await synthesizeViaQwen(safeText, options);
  } catch (qwenErr) {
    if (googleFallbackEnabled()) {
      try {
        return await synthesizeGoogleTranslate(safeText, options.lang || 'en');
      } catch (googleErr) {
        throw new Error('TTS unavailable: Qwen (' + (qwenErr?.message || 'failed') + '); Google fallback (' + (googleErr?.message || 'failed') + ')');
      }
    }
    throw qwenErr;
  }
}

async function synthesizeViaQwen(text, options) {
  const endpoint = qwenEndpoint();
  const payload = {
    model: envVar('QWEN_TTS_MODEL') || 'qwen3-tts-flash',
    input: text,
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

/** Split long text into <=~180-char sentence-ish chunks for the no-key fallback. */
function splitTtsChunks(text, max = 180) {
  const sentences = String(text || '').match(/[^.!?\n]+[.!?]*\s*/g) || [String(text || '')];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
    if (cur.length >= max) {
      chunks.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

/** No-key Google Translate TTS (MP3). Works when Qwen is not installed. */
async function synthesizeGoogleTranslate(text, lang = 'en') {
  const chunks = splitTtsChunks(text);
  const parts = [];
  for (const chunk of chunks) {
    const url = GOOGLE_TRANSLATE_TTS_BASE +
      '?ie=UTF-8&client=tw-ob&tl=' + encodeURIComponent(lang) +
      '&q=' + encodeURIComponent(chunk);
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://translate.google.com/',
      },
    });
    if (!r.ok) throw new Error('Google Translate TTS ' + r.status);
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(parts);
}

module.exports = { configured, synthesize, listVoices, health, qwenEndpoint, googleFallbackEnabled };
