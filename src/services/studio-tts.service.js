'use strict';

/**
 * Rolodex-server TTS proxy — LOCKED to the same Piper TTS engine Zyppar uses.
 * Zyppar's "Qwen" is actually a local Piper API server (scripts/qwen-tts-server.txt)
 * running at 127.0.0.1:8080 (/opt/qwen-tts on the droplet), exposing:
 *   POST /v1/audio/speech  → audio/mpeg
 *   GET  /health
 * Config lives in rolodex-server's own .env:
 *   QWEN_TTS_ENDPOINT        (default http://127.0.0.1:8080/v1/audio/speech)
 *   QWEN_TTS_API_KEY         (optional, Piper needs none)
 *   QWEN_TTS_MODEL           (default qwen3-tts-flash; Piper ignores it)
 *   ROLODEX_TTS_GOOGLE_FALLBACK  (default 1 — only used if Piper is down; set 0
 *                                 to lock strictly to Piper)
 *
 * Never writes to Mongo. synthesize() tries Piper first, then the no-key Google
 * Translate fallback, then throws so the frontend can fall back to device TTS.
 */

const DEFAULT_QWEN_ENDPOINT = 'http://127.0.0.1:8080/v1/audio/speech';
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

/** Qwen→Piper personality catalog — mirrors the Piper server's QWEN_MAP
 *  (scripts/qwen-tts-server.txt) so Rolodex uses the same voice names. */
function listVoices() {
  return [
    { id: 'qwen-morgan', name: 'Morgan', language: 'en', gender: 'male', description: 'Deep storyteller — documentary and epic narration.', archetype: 'Storyteller', defaultEmotion: 'calm', speedHint: { min: 0.8, max: 1.1, default: 0.9 } },
    { id: 'qwen-atlas', name: 'Atlas', language: 'en', gender: 'male', description: 'Warm anchor — news and business.', archetype: 'Anchor', defaultEmotion: 'neutral', speedHint: { min: 0.9, max: 1.2, default: 1.0 } },
    { id: 'qwen-orion', name: 'Orion', language: 'en', gender: 'male', description: 'Energetic guide — motivation and tutorials.', archetype: 'Guide', defaultEmotion: 'happy', speedHint: { min: 1.0, max: 1.4, default: 1.15 } },
    { id: 'qwen-onyx', name: 'Onyx', language: 'en', gender: 'male', description: 'Noir detective — thrillers and intimate podcasts.', archetype: 'Noir', defaultEmotion: 'calm', speedHint: { min: 0.7, max: 1.0, default: 0.85 } },
    { id: 'qwen-luna', name: 'Luna', language: 'en', gender: 'female', description: 'Gentle companion — wellness and bedtime.', archetype: 'Companion', defaultEmotion: 'calm', speedHint: { min: 0.75, max: 1.0, default: 0.85 } },
    { id: 'qwen-aria', name: 'Aria', language: 'en', gender: 'female', description: 'Crisp presenter — podcasts and education.', archetype: 'Presenter', defaultEmotion: 'neutral', speedHint: { min: 0.95, max: 1.2, default: 1.05 } },
    { id: 'qwen-sage', name: 'Sage', language: 'en', gender: 'female', description: 'Warm mentor — advice and reflection.', archetype: 'Mentor', defaultEmotion: 'calm', speedHint: { min: 0.8, max: 1.1, default: 0.95 } },
    { id: 'qwen-ember', name: 'Ember', language: 'en', gender: 'female', description: 'Firebrand — conviction and passion.', archetype: 'Firebrand', defaultEmotion: 'happy', speedHint: { min: 1.05, max: 1.4, default: 1.2 } },
    { id: 'qwen-echo', name: 'Echo', language: 'en', gender: 'neutral', description: 'Clean universal — the Confidante default.', archetype: 'Universal', defaultEmotion: 'neutral', speedHint: { min: 0.9, max: 1.2, default: 1.0 } },
    { id: 'qwen-fr-lumiere', name: 'Lumière', language: 'fr', gender: 'female', description: 'French artist — poetry and romance.', archetype: 'Artist', defaultEmotion: 'calm', speedHint: { min: 0.85, max: 1.15, default: 0.95 } },
    { id: 'qwen-es-fuego', name: 'Fuego', language: 'es', gender: 'female', description: 'Spanish storyteller — vibrant narratives.', archetype: 'Storyteller', defaultEmotion: 'happy', speedHint: { min: 0.9, max: 1.3, default: 1.1 } },
    { id: 'qwen-de-stern', name: 'Stern', language: 'de', gender: 'male', description: 'German authority — technical and formal.', archetype: 'Authority', defaultEmotion: 'neutral', speedHint: { min: 0.9, max: 1.15, default: 1.0 } },
    { id: 'qwen-pt-rio', name: 'Rio', language: 'pt', gender: 'male', description: 'Portuguese anchor — community and briefs.', archetype: 'Anchor', defaultEmotion: 'neutral', speedHint: { min: 0.9, max: 1.2, default: 1.0 } },
    { id: 'qwen-it-roma', name: 'Roma', language: 'it', gender: 'female', description: 'Italian storyteller.', archetype: 'Storyteller', defaultEmotion: 'calm', speedHint: { min: 0.85, max: 1.15, default: 0.95 } },
    { id: 'qwen-nl-amstel', name: 'Amstel', language: 'nl', gender: 'neutral', description: 'Dutch presenter.', archetype: 'Presenter', defaultEmotion: 'neutral', speedHint: { min: 0.9, max: 1.2, default: 1.0 } },
    { id: 'qwen-sw-sauti', name: 'Sauti', language: 'sw', gender: 'female', description: 'Swahili storyteller.', archetype: 'Storyteller', defaultEmotion: 'calm', speedHint: { min: 0.85, max: 1.15, default: 0.95 } },
    { id: 'qwen-zh-dragon', name: 'Dragon', language: 'zh', gender: 'male', description: 'Chinese scholar (English fallback voice).', archetype: 'Scholar', defaultEmotion: 'neutral', speedHint: { min: 0.85, max: 1.15, default: 1.0 } },
    { id: 'qwen-zh-lotus', name: 'Lotus', language: 'zh', gender: 'female', description: 'Chinese companion (English fallback voice).', archetype: 'Companion', defaultEmotion: 'calm', speedHint: { min: 0.8, max: 1.1, default: 0.95 } },
    { id: 'qwen-ja-sakura', name: 'Sakura', language: 'ja', gender: 'female', description: 'Japanese companion (English fallback voice).', archetype: 'Companion', defaultEmotion: 'calm', speedHint: { min: 0.8, max: 1.05, default: 0.9 } },
    { id: 'qwen-ko-seoul', name: 'Seoul', language: 'ko', gender: 'female', description: 'Korean presenter (English fallback voice).', archetype: 'Presenter', defaultEmotion: 'neutral', speedHint: { min: 0.9, max: 1.2, default: 1.0 } },
    { id: 'qwen-ar-sahara', name: 'Sahara', language: 'ar', gender: 'male', description: 'Arabic scholar (English fallback voice).', archetype: 'Scholar', defaultEmotion: 'neutral', speedHint: { min: 0.8, max: 1.1, default: 0.95 } },
    { id: 'qwen-hi-ganga', name: 'Ganga', language: 'hi', gender: 'female', description: 'Hindi companion (English fallback voice).', archetype: 'Companion', defaultEmotion: 'happy', speedHint: { min: 0.85, max: 1.2, default: 1.0 } },
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
    engine: 'piper',
    qwen,
    google: googleFallbackEnabled(),
    configured: true,
    endpoint,
    googleFallback: googleFallbackEnabled(),
    detail: qwen ? 'HTTP 200' : 'Piper unreachable at ' + endpoint + ' — Google Translate fallback ' + (googleFallbackEnabled() ? 'enabled' : 'disabled'),
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
