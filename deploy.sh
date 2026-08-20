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
# 2026-08-20 FIX: the server repo may still be on an old local branch (master)
# while origin uses main. Re-point the LOCAL branch to the origin branch, so
# the version-bump commit lands on $BRANCH and `git push origin $BRANCH`
# actually has a matching ref (previously: 'src refspec main does not match any').
git checkout -B "$BRANCH" "origin/$BRANCH"
git pull origin "$BRANCH"

echo "Installing dependencies (yarn only)..."
yarn

# 2026-08-20 AUTOMATIC VERSION BUMP: every deploy.sh run advances version.txt
# (and package.json) by one patch, commits it, and pushes it back to origin.
# This is what makes the app's Update check see a NEW version after a deploy —
# no more manual `nano version.txt`.
NEW_VERSION=$(node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const parts = String(p.version || '0.0.0').split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  const nv = parts.join('.');
  p.version = nv;
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  fs.writeFileSync('version.txt', nv);
  console.log(nv);
")
echo "Bumping rolodex-server version to $NEW_VERSION"
git add package.json version.txt
git -c user.name="rolodex-deploy" -c user.email="deploy@rolodex.local" commit -m "chore: bump rolodex-server version to $NEW_VERSION" || true
git push origin "$BRANCH" || echo "WARNING: version bump committed locally but push failed — run 'git push origin $BRANCH' manually."

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
