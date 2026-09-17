// 2026-09-17 BUILD 86 THE POLISHINGUSERALPHA AGENT (founder: a tone tap on a
// user-owned draft must be treated as AI ASSISTANCE — "sending the
// user-modified or initiated words to backend for polish, similar to a track
// on beta section" — with "complementary persistence tools to assist it",
// seeded for the founder's future training / own datacenter).
//
// THE AGENT'S ONE JOB: take the user's OWN words — written by their hand at
// the chat dialog — and reshape them into the requested tone WITHOUT touching
// their meaning, their facts, the names, or any personal detail. These are
// not template words; they are sacred. The agent never reintroduces template
// phrasing and never answers with anything but the polished message.
//
// THE PERSISTENCE TOOL: every polish pair (the user's before, the agent's
// after, the tone, the language, the engine, the latency) appends to
// data/polish-alpha.jsonl — NO user identifiers, NO device ids (privacy
// hardening holds; the words themselves live only on the founder's own
// droplet). This ledger is the seed corpus for the founder's stated future:
// training PolishingUserAlpha on their own datacenter.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEDGER_PATH = path.join(DATA_DIR, 'polish-alpha.jsonl');

const SYSTEM_PROMPT = [
  'You are PolishingUserAlpha, LoopKeeper\'s polish agent for the user\'s OWN words.',
  'The user wrote this message THEMSELVES at the chat dialog — these are not template words; they are sacred.',
  'Reshape them into the requested tone WITHOUT changing their meaning, their facts, the names, or any personal detail.',
  'Keep it warm, human, one short paragraph, in the user\'s voice and exactly their level of formality.',
  'Never reintroduce template phrasing. Never add greetings or sign-offs the user did not write.',
  'Return ONLY the polished message — no preamble, no quotes, no explanation.',
].join(' ');

// 2026-09-17 BUILD 87 THE SLANTS ARE THE AGENT'S OWN (founder: "The slant
// cannot be ignored in favor of a generic AI agent intervention"): each tone
// carries its precise LoopKeeper meaning — the agent does not guess what
// "short" means, it KNOWS. The route appends the requested slant's
// definition to the system prompt verbatim.
const TONE_SLANTS = {
  short: 'SHORT — tighter and briefer: cut every word not doing work; keep the warmth; aim for a fraction of the original length.',
  light: 'LIGHT — lighter and brighter: gentle, easy warmth; a touch of lightness is welcome, never silly; soften any heaviness.',
  honest: 'HONEST — plainer and more candid: say the true thing directly, no hedging, no filler, no apologies beyond what the user wrote; keep it kind.',
  formal: 'FORMAL — more composed and respectful: measured sentences, no slang, no contractions where formality reads better.',
};

/** The requested slant's exact definition, or SHORT's for an unknown tone. */
function slantFor(tone) {
  return TONE_SLANTS[String(tone || '').toLowerCase()] || TONE_SLANTS.short;
}

/** THE PERSISTENCE TOOL — append one polish pair to the training-corpus seed.
 *  Best-effort by design: the polish itself never depends on the ledger. */
function recordPair(rec) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LEDGER_PATH, JSON.stringify(rec) + '\n');
    return true;
  } catch { return false; }
}

/** Read the corpus (diagnostics / future training pipelines). */
function readCorpus(limit = 200) {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return raw.slice(-limit).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

module.exports = { SYSTEM_PROMPT, TONE_SLANTS, slantFor, recordPair, readCorpus, LEDGER_PATH };
