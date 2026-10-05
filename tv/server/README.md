# FREEVEE Edition ☁️

Cloud-hosted personal streaming server for **FREEVEE** with **Google Drive integration**, **Google OAuth multi-user authentication**, and optimized resource constraints for VPS deployment on **Debian 13 (IONOS / VPS)**.

---

## 🌟 Key Architecture & Highlights

* **Google Drive as Personal Media Storage**:
  * Users connect their Google Drive and select their **TV Shows** and **Movies** folders.
  * Streams media directly via **HTTP Byte-Range (`Range: bytes=...`)** without storing large video files on the VPS disk.
* **Google OAuth 2.0 Login**:
  * Sign in with Google with isolated user libraries, favorites, and continue watching history.
* **Shared Network Catalogs**:
  * Shared What's On / Popular titles and 10+ Streaming Network catalogs (Netflix, Prime Video, Disney+, Paramount+, Apple TV+, Hulu, Peacock, Citytv, Crave, CBC Gem).
* **Resource Optimization Guardrails**:
  * Deployment and local broadcaster tabs removed.
  * Concurrency hard-coded and locked to **1 concurrent stream/download** to protect VPS bandwidth and CPU.

---

## 🛠️ Step 1: Google Cloud Console OAuth Setup

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., `FREEVEE`).
3. Enable the **Google Drive API**:
   * Navigate to **APIs & Services > Library** > Search for **Google Drive API** > Click **Enable**.
4. Configure the **OAuth Consent Screen**:
   * Go to **APIs & Services > OAuth consent screen**.
   * User Type: **External**.
   * App name: `FREEVEE`.
   * Add Scopes: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/drive.readonly`.
5. Create OAuth 2.0 Credentials:
   * Go to **APIs & Services > Credentials** > **Create Credentials** > **OAuth client ID**.
   * Application type: **Web application**.
   * **Authorized JavaScript origins**: `https://your-domain.com` (or `http://localhost:3000` for testing).
   * **Authorized redirect URIs**: `https://your-domain.com/auth/google/callback` (or `http://localhost:3000/auth/google/callback`).
6. Copy your **Client ID** and **Client Secret** into your `.env` file.

---

## 🚀 Step 2: Deployment on Debian 13 (IONOS VPS)

### 1. Upload files to your VPS
```bash
scp -r ./cloud/* root@YOUR_VPS_IP:/var/www/FREEVEE-cloud/
```

### 2. Run the automated deployment script
```bash
ssh root@YOUR_VPS_IP
cd /var/www/FREEVEE-cloud
chmod +x scripts/deploy-ionos.sh
./scripts/deploy-ionos.sh
```

### 3. Configure your `.env` file
```bash
cp .env.example .env
nano .env
```
Fill in:
```ini
PORT=3000
BASE_URL=https://your-domain.com
SESSION_SECRET=a_long_random_session_secret_key
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=https://your-domain.com/auth/google/callback
```

### 4. Configure Nginx Reverse Proxy with SSL
Create `/etc/nginx/sites-available/FREEVEE`:
```nginx
server {
    server_name 74.208.22.119;

    location / {
        proxy_pass http://74.208.22.119:42069;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }
}
```

Enable site & get free SSL with Certbot:
```bash
ln -s /etc/nginx/sites-available/FREEVEE /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d your-domain.com
```

### 5. Restart & Monitor Service
```bash
systemctl restart FREEVEE-cloud
journalctl -u FREEVEE-cloud -f
```

---

## 💻 Local Development / Testing

```bash
cd cloud
npm install
cp .env.example .env   # Fill in Google OAuth credentials
npm run build          # Build Vite React frontend
node server.js         # Start cloud server on http://localhost:3000
```
