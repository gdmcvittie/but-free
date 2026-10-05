# COMIXOLOFREE  Server (Namecheap Shared Hosting + Google Drive)

A cloud-native comic reader and server built specifically for **Namecheap shared hosting** (cPanel Node.js App / Phusion Passenger). It uses the **Google Drive API** for comic storage and reading, **Google OAuth 2.0** for user authentication and sync, and includes full **GetComics** download capabilities (What's New, Search, Direct URL, and My Pull List).

---

## 🚀 Key Features

- **Google Drive Storage & Reading**: No local comic files needed on your web host. Select any folder in your Google Drive as your comic library.
- **In-App Google Drive Folder Picker**: Easily browse your Google Drive folders and select or create a comic folder right from the app.
- **Google OAuth Sign-In**: User accounts, avatars, favorites, and reading progress are seamlessly tied to each user's Google account.
- **GetComics Downloads**: Download issues directly from **What's New**, **Search**, **Direct URL Downloader**, or **My Pull List**; files are automatically saved and organized into your Google Drive folder.
- **Automatic CBZ Compression**: Unpacks downloaded `.cbz` archives, compresses pages to 75% JPEG quality (saving up to 60-75% storage and speeding up reading), and repacks into a clean `.cbz` before uploading to Google Drive.
- **Pure Node.js**: Built with native Node.js `zlib` and pure JS modules (`jpeg-js`, `pngjs`, with optional `sharp`). Zero mandatory C++ native compilation (`node-gyp`), ensuring 100% compatibility with Namecheap cPanel Linux.
- **Cleaned & Streamlined**: Amazon Downloader and Electron desktop browser components have been completely removed.

---

## 🛠️ Prerequisites

1. A **Namecheap Shared Hosting** plan with cPanel ("Setup Node.js App" enabled).
2. A free **Google Cloud Console** account to create OAuth credentials and enable Google Drive API.

---

## 📋 Step 1: Google Cloud Console Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g. `COMIXOLOFREE `).
3. In the left menu, navigate to **APIs & Services > Library**.
4. Search for **Google Drive API** and click **Enable**.
5. Go to **APIs & Services > OAuth consent screen**:
   - Select **External** and click **Create**.
   - Enter an **App name** (e.g. `COMIXOLO Cloud`) and **User support email**.
   - Add the following scopes:
     - `.../auth/userinfo.email`
     - `.../auth/userinfo.profile`
     - `openid`
     - `.../auth/drive` (or `.../auth/drive.file`)
   - Under **Test users**, add your Google email address while the app is in Testing mode.
6. Go to **APIs & Services > Credentials**:
   - Click **+ CREATE CREDENTIALS** > **OAuth client ID**.
   - Application type: **Web application**.
   - **Authorized JavaScript origins**:
     - `https://yourdomain.com` (or `http://localhost:3000` for testing)
   - **Authorized redirect URIs**:
     - `https://yourdomain.com/api/auth/google/callback` (or `http://localhost:3000/api/auth/google/callback`)
   - Click **Create**. Copy your **Client ID** and **Client Secret**.

---

## 🌐 Step 2: Namecheap cPanel Setup

1. Log into your **Namecheap cPanel**.
2. In the **Software** section, click **Setup Node.js App**.
3. Click **Create Application**:
   - **Node.js version**: Choose `18.x`, `20.x`, or higher.
   - **Application mode**: `Production`.
   - **Application root**: `cloud-server` (or directory path in your home folder).
   - **Application URL**: Your domain or subdomain (e.g. `comics.yourdomain.com`).
   - **Application startup file**: `app.js`.
4. Under **Environment variables**, click **Add Variable** and enter:
   - `NODE_ENV`: `production`
   - `GOOGLE_CLIENT_ID`: Your Google OAuth Client ID
   - `GOOGLE_CLIENT_SECRET`: Your Google OAuth Client Secret
   - `GOOGLE_REDIRECT_URI`: `https://yourdomain.com/api/auth/google/callback`
   - `SESSION_SECRET`: Any random secure string
5. Click **Create** to initialize the Node.js environment.

---

## 📦 Step 3: Upload & Build

### Option A: Via Git / cPanel Terminal (Recommended)
1. In cPanel, open **Terminal** (under Advanced).
2. Enter the virtual environment command shown at the top of your Node.js App page in cPanel (e.g. `source /home/USER/nodevenv/cloud-server/20/bin/activate && cd /home/USER/cloud-server`).
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build the React frontend:
   ```bash
   npm run build
   ```
5. In cPanel **Setup Node.js App**, click **Restart**!

### Option B: Pre-build Locally & Upload
1. On your local machine, inside `/cloud-server`:
   ```bash
   npm install
   npm run build
   ```
2. Compress `cloud-server` (including `dist`, `server`, `app.js`, `package.json`, `.htaccess`, but excluding `node_modules`).
3. Upload and extract into your application folder in cPanel File Manager.
4. In cPanel **Setup Node.js App**, click **Run NPM Install**, then click **Restart**!

---

## 📖 Step 4: First-Time Use

1. Open your website (e.g. `https://yourdomain.com`).
2. Click **Sign in with Google**.
3. Once authenticated, the app will prompt you to select your **Google Drive Comic Folder**:
   - Use the in-app folder picker to browse your Google Drive.
   - You can create a new folder named `Comics` or choose an existing one.
4. Click **Select Folder**.
5. Your library will automatically scan and display your comics!
6. Visit **What's New** or **Search** to download new comic releases straight to your Google Drive folder.

---

## 🔧 File Structure

```
cloud-server/
├── app.js               # Passenger cPanel startup script
├── server.js            # Alternative runner
├── package.json         # Scripts and production dependencies
├── .env.example         # Environment template
├── .htaccess            # Apache Passenger configuration
├── server/
│   ├── index.js         # Express app & API routes
│   ├── googleAuth.js    # Google OAuth2 login & session tokens
│   ├── googleDrive.js   # Google Drive v3 API read/write integration
│   ├── scraper.js       # GetComics scraper & mirror resolver
│   ├── pullListManager.js# Automated pull list checking & downloading
│   ├── cbzReader.js     # Pure Node.js CBZ/CBR reader
│   ├── cbzWriter.js     # Pure Node.js CBZ packager
│   ├── cacheManager.js  # Local disk caching for fast reading & covers
│   └── database.js      # Multi-user persistent JSON/SQLite store
└── src/                 # React frontend application
    ├── App.tsx          # Main layout & state
    ├── Sidebar.tsx      # Sidebar with Google avatar & Drive status
    ├── Library.tsx      # Comics library & series grouping
    ├── Reader.tsx       # Multi-mode comic reader (single, double, vertical)
    ├── WhatsNewView.tsx # GetComics latest releases with 1-click Drive download
    ├── SearchView.tsx   # Library & online GetComics search
    ├── DownloadsView.tsx# Direct URL download & My Pull List
    ├── SettingsView.tsx # Google Drive folder selection & preferences
    ├── AuthModal.tsx    # Google login & account modal
    └── DrivePickerModal.tsx # In-app Google Drive folder browser
```
