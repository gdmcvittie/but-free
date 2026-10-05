#!/usr/bin/env bash
# ==============================================================================
# FREEVEE Torrent Streamer - Dedicated VPS Node Deployment Script
# ==============================================================================
set -e

echo "=== [1/5] Updating system packages on VPS ==="
sudo apt-get update -y
sudo apt-get install -y curl wget git build-essential ufw

echo "=== [2/5] Installing Node.js LTS (v22+) ==="
# webtorrent@3.x requires Node >= 22. Node 20 is EOL, so install latest LTS.
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node version: $(node -v)"
echo "NPM version:  $(npm -v)"

echo "=== [3/5] Setting up Torrent Streamer Service Directory ==="
NODE_DIR="/opt/torrent-streamer"
sudo mkdir -p "$NODE_DIR"
sudo chown -R $USER:$USER "$NODE_DIR"

if [ -f "./torrent-node.js" ]; then
  cp -r ./* "$NODE_DIR/"
elif [ -d "./torrent-streamer" ]; then
  cp -r ./torrent-streamer/* "$NODE_DIR/"
fi

cd "$NODE_DIR"
npm install --production

if [ ! -f "$NODE_DIR/.env" ]; then
  cp .env.example .env
fi

echo "=== [4/5] Setting up Systemd Service ==="
sudo bash -c "cat > /etc/systemd/system/torrent-streamer.service << EOF
[Unit]
Description=FREEVEE Dedicated Torrent Streamer Node
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$NODE_DIR
ExecStart=/usr/bin/node $NODE_DIR/torrent-node.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=$NODE_DIR/.env

[Install]
WantedBy=multi-user.target
EOF"

sudo systemctl daemon-reload
sudo systemctl enable torrent-streamer
sudo systemctl restart torrent-streamer

echo "=== [5/5] Configuring Firewall (UFW) ==="
sudo ufw allow OpenSSH
sudo ufw allow 42069/tcp
sudo ufw --force enable || true

echo ""
echo "====================================================================="
echo "🎉 Torrent Streamer Node is running on port 42069!"
echo "====================================================================="
echo "Check service logs with:"
echo "  sudo journalctl -u torrent-streamer -f"
echo ""
echo "In your main FREEVEE server's .env file, add:"
echo "  TORRENT_STREAM_SERVER=http://YOUR_VPS_IP:42069"
echo "====================================================================="
