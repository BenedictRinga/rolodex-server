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
git reset --hard origin/main
git pull origin main

echo "Installing dependencies (yarn only)..."
yarn

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

echo "rolodex-server update complete!"
