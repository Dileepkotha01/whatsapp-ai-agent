#!/bin/bash
# ============================================================
#  Ekaralu WhatsApp Bot — SURGICAL Production Deployment
#  Ensures zero-interference and crash-proof operation.
# ============================================================

set -e

PM2_APP_NAME="agent-ekaralu-listings"

echo "┌──────────────────────────────────────────────────────┐"
echo "│      Ekaralu Bot — Surgical Deploy Starting          │"
echo "└──────────────────────────────────────────────────────┘"

# ── 1. Dependency Checks ─────────────────────────────────────
echo "▶ [1/4] Checking environment..."
if [ ! -f ".env" ]; then
  echo "❌ ERROR: .env file not found! Please create it before deploying."
  exit 1
fi

# ── 2. Clean up "Zombie" Browser Processes ───────────────────
# This prevents TargetCloseError on resource-limited VPS
echo "▶ [2/4] Cleaning up orphaned browser processes..."
pkill -f "chromium" || true
pkill -f "chrome" || true
pkill -f "puppeteer" || true

# ── 3. Install/Update localized dependencies ──────────────────
echo "▶ [3/4] Installing project dependencies..."
mkdir -p logs sessions public/uploads
npm install --production --quiet

# ── 4. Isolated PM2 Lifecycle ────────────────────────────────
echo "▶ [4/4] Restarting specific bot instance: $PM2_APP_NAME"

# Check if app is already running
if pm2 show "$PM2_APP_NAME" > /dev/null 2>&1; then
    echo "  → App found. Performing safe restart..."
    # We use restart here to ensure config changes in ecosystem.config.js are applied
    pm2 restart ecosystem.config.js --only "$PM2_APP_NAME"
else
    echo "  → App not found in PM2. Starting for the first time..."
    pm2 start ecosystem.config.js --only "$PM2_APP_NAME"
fi

# Save the current process list (including your other active backends)
pm2 save

echo ""
echo "✅ Bot is updated and running in isolation."
echo "Any zombie chromium processes were cleaned up to free RAM."
echo ""
echo "To view logs for just this bot, run:"
echo "pm2 logs $PM2_APP_NAME"
