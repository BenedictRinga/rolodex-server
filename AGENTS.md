# AGENTS.md — Rolodex Server (AI build instructions)

This file tells AI assistants working on this repo what to keep consistent.

## Repo rules
- YARN ONLY. Never use npm here.
- Before committing: `node --check src/index.js`.
- Bump `package.json` `build` counter with every user-visible backend change.
- The server talks to the fresh `rolodex` Mongo database; never touch the `zyppar` db.

## The Chat with RolodexAI directive — MUST stay fresh
The canonical AI directive for the in-app support/feedback chat lives in:

**`src/chat-directive.js`**

It is imported by `POST /api/rolodex/chat` as the system prompt. It is the
single source of truth for what the Confidante knows about RolodexAI.

### When you change the app, you MUST also update this file in the same commit
- Adding/removing a feature, setting, plan, price, trial rule, storage option,
  platform status, or capability → edit the **"WHAT ROLODEXAI ACTUALLY IS"**
  section first.
- Changing how the chat window behaves (help mode, feedback mode, free-chat
  limits, handoff links) → update **HELP MODE / FEEDBACK MODE / OTHER MATTERS /
  FREE-CHAT LIMIT**.
- If the user-facing name of a feature changes, update it here AND in the
  frontend (see the frontend repo's `AGENTS.md`).

### Keep these in sync in the same commit
- Frontend Chat with RolodexAI modal copy (`rolodex-app/src/app/components/chat-with-rolodex/`)
- Frontend Settings list (`rolodex-app/src/app/components/rolodex/rolodex.component.html`)
- Frontend About/Investors copy (`rolodex-app/src/app/components/about-rolodex/`)
- `package.json` `build` in BOTH repos
