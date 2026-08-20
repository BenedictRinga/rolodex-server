#!/bin/bash
# Script: deploy.sh (rolodex-server) — mirrors /opt/zyppar-server/update.sh
# One-command deploy: fetch → reset --hard → pull → yarn → env → pm2 restart.
# The fresh `rolodex` database lives on the SAME paid cluster (dbName 'rolodex'
# in src/index.js) — no new MongoDB account needed; the paid URI is copied from
# the Zyppar backend's .env on first run.

# Exit on any error
set -e
DEPLOY_DIR="/opt/rolodex-server"
cd "$DEPLOY_DIR" || exit 1

# 2026-08-20 VERSION BUMP: remember the version BEFORE git reset --hard wipes
# the local working copy, so each deploy increments (0.3.1 → 0.3.2 → 0.3.3 …)
# instead of always bumping from the repo's committed value.
PREV_VERSION=$(cat version.txt 2>/dev/null || echo "0.0.0")

echo "Resetting local changes and pulling updates from origin main..."
git fetch origin
# Prefer main; fall back to master for repos pushed before the rename.
if git rev-parse --verify origin/main >/dev/null 2>&1; then
  BRANCH="main"
else
  BRANCH="master"
fi
echo "Using branch: $BRANCH"
git reset --hard "origin/$BRANCH"
git pull origin "$BRANCH"

echo "Installing dependencies (yarn only)..."
yarn

# 2026-08-20 AUTOMATED VERSION.TXT BUMP: one patch per deploy, local working
# copy only. NOT committed, NOT pushed — commits originate from the local
# machine. This is what lets the app see a new version after every deploy.sh.
NEW_VERSION=$(node -e "
  const v = process.argv[1].trim().split('.').map(Number);
  v[2] = (v[2] || 0) + 1;
  console.log(v.join('.'));
" "$PREV_VERSION")
echo "$NEW_VERSION" > version.txt
echo "Bumped version.txt to $NEW_VERSION"

# Ensure .env exists with a Mongo URI: prefer MONGO_DB_URI_ROLODEX (a future
# dedicated account), else reuse the paid URI (fresh rolodex db on the cluster).
if ! grep -qE "^(MONGO_DB_URI_ROLODEX|MONGO_DB_URI_PAID)=" .env 2>/dev/null; then
  if [ -f "/opt/zyppar-server/.env" ] && grep -q "MONGO_DB_URI_PAID=" /opt/zyppar-server/.env; then
    echo "Reusing the paid Mongo URI — the rolodex db is separate (dbName 'rolodex')."
    grep "MONGO_DB_URI_PAID=" /opt/zyppar-server/.env >> .env
  else
    echo "ERROR: no Mongo URI found. Set MONGO_DB_URI_ROLODEX in $DEPLOY_DIR/.env"
    exit 1
  fi
fi

echo "Restarting rolodex-server via pm2..."
pm2 restart rolodex-server --update-env 2>/dev/null || pm2 start src/index.js --name rolodex-server
pm2 save

# 2026-08-18 AI KEYS: the app never brings a key — Rolodex holds them here.
if ! grep -qE "^DEEPSEEK_API_KEY=" .env 2>/dev/null; then
  echo "NOTE: DEEPSEEK_API_KEY is not set in .env — the DeepSeek confidante will fall back to the on-device engine until you add it (one line, then pm2 restart rolodex-server --update-env)."
fi

echo "rolodex-server update complete!"
