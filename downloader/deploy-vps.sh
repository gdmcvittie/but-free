#!/usr/bin/env bash
# ==============================================================================
# butFREE Unified Downloader & Streaming Hub - IONOS VPS Deployment Script
# Supports:
#   • Fraudio: Audiobook torrent downloads & Google Drive background uploads
#   • Fraudio: YouTube Music downloads & audio transcoding (MP3/M4A)
#   • Freevee: WebTorrent live video streaming & on-the-fly transcoding
# ==============================================================================
set -e

echo "=== [1/6] Updating system packages on IONOS VPS ==="
sudo apt-get update -y
sudo apt-get install -y curl wget git build-essential ufw ffmpeg python3

echo "=== [2/6] Installing Node.js LTS (v22+) ==="
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node version: $(node -v)"
echo "NPM version:  $(npm -v)"

# Install PM2 process manager globally if missing
if ! command -v pm2 &> /dev/null; then
  echo "Installing PM2 globally..."
  sudo npm install -g pm2
fi

echo "=== [3/6] Setting up Unified Downloader Directory ==="
APP_DIR="/opt/butfree-downloader"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER:$USER" "$APP_DIR"

# Copy files into deployment directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r "$SCRIPT_DIR"/* "$APP_DIR/"

cd "$APP_DIR"
echo "=== [4/6] Installing Dependencies & Binaries ==="
npm install --production
node setup-bin.js

# Ensure .env exists with production defaults
if [ ! -f "$APP_DIR/.env" ]; then
  if [ -f "$APP_DIR/.env.example" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  else
    cat > "$APP_DIR/.env" << 'EOF'
PORT=4000
DOWNLOADER_PORT=4000
NODE_KEY=change_this_shared_downloader_key_45678
DOWNLOADER_SECRET_KEY=change_this_shared_downloader_key_45678
DASHBOARD_KEY=change_this_shared_downloader_key_45678
MAX_CONCURRENT=2
MAX_STREAM_IDLE_MINUTES=10
CACHE_DIR=./downloads
EOF
  fi
fi

echo "=== [5/6] Starting Daemon via PM2 ==="
pm2 delete butfree-downloader 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

# Setup PM2 startup script so it survives reboots
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "$HOME" || true

echo "=== [6/6] Configuring Firewall (UFW) ==="
sudo ufw allow OpenSSH
sudo ufw allow 4000/tcp
sudo ufw --force enable || true

SERVER_IP=$(curl -s -4 ifconfig.me || hostname -I | awk '{print $1}')

echo ""
echo "====================================================================="
echo "🎉 butFREE Unified Downloader & Streaming Hub is LIVE on port 4000!"
echo "====================================================================="
echo "Live Web Dashboard: http://${SERVER_IP}:4000/dashboard"
echo "Health Check API:   http://${SERVER_IP}:4000/health"
echo ""
echo "In your butfree.online root .env file, configure:"
echo "  DOWNLOADER_URL=http://${SERVER_IP}:4000"
echo "  TORRENT_STREAM_SERVER=http://${SERVER_IP}:4000"
echo "  TORRENT_NODE_URL=http://${SERVER_IP}:4000"
echo "  DOWNLOADER_SECRET_KEY=change_this_shared_downloader_key_45678"
echo "  TORRENT_NODE_KEY=change_this_shared_downloader_key_45678"
echo "====================================================================="
