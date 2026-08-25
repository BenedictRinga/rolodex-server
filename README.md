# Rolodex Server — LoopKeeper Backend

Node/Express + Mongoose + Socket.io backend for **LoopKeeper** (`rolodex-app`).
Talks to the fresh `rolodex` Mongo database (never `zyppar`).

## Repo map

```
src/
  index.js                     # Express app + Socket.io + all routes/models
  chat-directive.js            # canonical AI system prompt for POST /chat
  controllers/
    updates.controller.js      # update check endpoints
  routes/
    updates.routes.js          # mounted at /api/rolodex/updates
  services/
    updates.service.js         # version/update logic
    studio-tts.service.js      # TTS helpers (audio)
deploy/                        # nginx snippets, deployment notes
AGENTS.md                      # AI build instructions — READ FIRST
package.json                   # build counter (currently 23), YARN ONLY
```

## Data models (defined in `src/index.js`)

| Model | Purpose |
|---|---|
| `DeviceState` | Per-device sync state: contacts, settings, sample data |
| `RolodexUser` | Optional identity record (invites/trial) |
| `InvestorRequest` | Investor portal access requests |
| `InvestorFeedback` | Collated user feedback/suggestions (summary only, no raw chat) |
| `AnalyticsEvent` | Anonymous analytics events (deviceId, event, props, ts) |

## REST API map

Base path: `/api/rolodex` (legacy alias `/api/openloop` may still appear)

| Route | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /version` | App version check |
| `GET /updates/check` | Update availability |
| `POST /sync` | Device state sync (contacts/settings) |
| `GET /state/:deviceId` | Fetch device state |
| `POST /analytics/events` | Anonymous analytics batch ingest |
| `POST /translations/contribute` | Anonymous community translation suggestions |
| `GET /translations/summary` | Community translation totals, by language, latest |
| `GET /investor/summary` | DAU/WAU/MAU, sessions, retention, activation |
| `GET /live` | Live investor peek |
| `POST /feedback` | Store feedback summary |
| `GET /feedback` | Investor feedback list |
| `POST /chat` | AI Assistant chat (stateless, no-store, never persisted) |
| `GET/POST /ai/status`, `/agent/status`, `/agent/compose` | AI agent endpoints |
| `POST /ai/compose` | Draft/assist composition |
| `POST /tts`, `/tts/stream`, `GET /tts/voices` | Text-to-speech |
| `POST /billing/checkout` | Stripe checkout |
| `POST /invites`, `GET /invites/:token`, `/og` | Invites + OG cards |
| `GET /users/lookup` | Phone lookup (user-initiated only) |
| `POST /trial/reopen` | Trial re-open |

## Socket.io

- Path: **`/socket-rolodex/`** (avoids clashing with Zyppar's `/socket.io`)
- Events: `chat:join`, `chat:message`, `chat:typing`, `chat:ack`, `chat:present`,
  `webrtc:join`, `webrtc:signal`, `webrtc:leave`
- Used by LoopKeeper room chat + WebRTC relay.

## AI/chat privacy rules

- `POST /chat` is **stateless**: never persisted, never logged,
  `Cache-Control: no-store`.
- `POST /feedback` stores **summary only**; raw conversation is discarded.
- The system prompt lives in `src/chat-directive.js` — update it whenever app
  capabilities change.
- No PII to server unless the user voluntarily provides it; analytics are
  anonymous device events only.

## Build/deploy rules (see AGENTS.md)

- **YARN ONLY** — never npm here.
- Before committing: `node --check src/index.js`
- Bump `package.json` `build` with every user-visible change.
- Deploy: `git pull origin main && pm2 restart rolodex-server`

## How to extend

1. Add models/routes in `src/index.js` (keep it small — this repo is intentionally minimal).
2. If the AI chat needs to know about it, update `src/chat-directive.js` in the same commit.
3. Mirror frontend changes in `rolodex-app` and bump **both** build counters.
4. For AI agents: the Ox Alpha brief package references this repo — read this README first.
