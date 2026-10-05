#!/usr/bin/env bash
# ==============================================================================
# FREEVEE Edition - Debian 13 (Trixie) VPS Deployment Script for IONOS
# ==============================================================================
set -e

echo "=== [1/6] Updating system packages on Debian 13 ==="
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git build-essential nginx certbot python3-certbot-nginx ufw ffmpeg

echo "=== [2/6] Installing Node.js 22 LTS ==="
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node version: $(node -v)"
echo "NPM version:  $(npm -v)"

echo "=== [3/6] Installing FREEVEE Dependencies & Building Frontend ==="
APP_DIR="/var/www/FREEVEE-cloud"
sudo mkdir -p "$APP_DIR"
sudo chown -R $USER:$USER "$APP_DIR"

# Copy files if running from within the repository
if [ -f "./server.js" ] && [ -f "./package.json" ]; then
  cp -r ./* "$APP_DIR/"
fi

cd "$APP_DIR"
npm install --production=false
npm run build

echo "=== Bundling static FFmpeg binary (Drive-HLS transcoding) ==="
node scripts/install-ffmpeg.js

echo "=== [4/6] Configuring Systemd Service ==="
sudo bash -c "cat > /etc/systemd/system/FREEVEE-cloud.service << 'EOF'
[Unit]
Description=FREEVEE Media Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=$APP_DIR/.env

[Install]
WantedBy=multi-user.target
EOF"

sudo systemctl daemon-reload
sudo systemctl enable FREEVEE-cloud
sudo systemctl restart FREEVEE-cloud

echo "=== [5/6] Configuring Firewall (UFW) ==="
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

echo "=== [6/6] Deployment Complete! ==="
echo ""
echo "Next Steps:"
echo "1. Edit $APP_DIR/.env with your Google OAuth credentials and domain."
echo "2. Point your domain (e.g. tv.yourdomain.com) to this VPS IP in your IONOS DNS."
echo "3. Run: sudo certbot --nginx -d your-domain.com to enable free HTTPS."
echo "4. Restart service: sudo systemctl restart FREEVEE-cloud"
echo "5. Check logs: sudo journalctl -u FREEVEE-cloud -f"
