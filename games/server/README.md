# FREEPLAY - Cloud Retro Arcade Server

FREEPLAY is the retro gaming cloud platform for the **[butfree.online](https://butfree.online)** umbrella. It turns personal Google Drive storage into a cloud-only retro gaming powerhouse with instant in-browser emulation and automated torrent/ROM downloading.

---

## 🎮 Key Features

- **Google Drive Native (BYOS - Bring Your Own Storage)**:
  - Select your "Games" folder from Google Drive using the in-app folder browser.
  - Automatically scans and indexes retro ROMs across consoles (`.sfc`, `.nes`, `.gba`, `.gb`, `.gbc`, `.md`, `.iso`, `.chd`, `.pbp`, `.n64`, `.nds`, `.pce`, `.gg`, `.p8`, `.zip`).
  - Automatically matches and displays 3D box art for your collection from Libretro's named box art catalog.

- **Instant In-Browser Emulation**:
  - Zero local installations needed — play directly in any modern desktop or mobile browser.
  - Powered by EmulatorJS with full gamepad and keyboard controller support.
  - Efficient HTTP 206 byte-range streaming directly from Google Drive.

- **Central VPS Downloader Integration**:
  - Dispatches torrents, magnets, and ROM collections to the shared high-speed Downloader server (`http://download.butfree.online:4000`).
  - Downloads are automatically uploaded directly into your personal Google Drive Games folder.
  - Instant webhook trigger (`/api/webhook/download-complete`) automatically refreshes your library when a download completes.

- **Consistent butfree UI Aesthetics**:
  - Styled with the modern, sleek dark glassmorphism theme shared with **ComixoloFree** and **Fraudio**.
  - System filter pills, instant title searching, starred favorites view, and live queue monitoring.

---

## 🛠️ Architecture

```
                                      ┌────────────────────────────────────┐
                                      │        Google Drive API v3         │
                                      │  (User ROMs, Saves, Boxart)        │
                                      └─────────────────▲──────────────────┘
                                                        │
                                    ┌───────────────────┴───────────────────┐
                                    │                                       │
                                    │ (Byte-range stream)                   │ (Direct upload)
                                    │                                       │
┌────────────────────────┐    HTTP  │         ┌───────────────────────────┐ │
│     Web Browser /      ├──────────┴────────►│     FREEPLAY Server       │ │
│ EmulatorJS (React 19)  │                    │   (:5500 / games.butfree) │ │
└────────────────────────┘                    └─────────────▲─────────────┘ │
                                                            │               │
                                           (Webhook on done)│   (Dispatch)  │
                                                            │               ▼
                                              ┌─────────────┴─────────────────┐
                                              │    Central Downloader VPS     │
                                              │      (:4000 / download.butfree)│
                                              └───────────────────────────────┘
```

---

## 🚀 Running Locally

From `games/server`:
```bash
# Development (Express backend on 5500 + Vite client on 5176)
npm run dev

# Production Build
npm run build
npm start
```

Or from the monorepo root:
```bash
# Build games client
npm run build:games

# Build all umbrella apps
npm run build
```

---

## ⚙️ Environment Variables

- `PORT_GAMES`: Server port (default: `5500`)
- `GOOGLE_CLIENT_ID`: Google OAuth 2.0 Client ID
- `GOOGLE_CLIENT_SECRET`: Google OAuth 2.0 Client Secret
- `GOOGLE_REDIRECT_URI_GAMES`: `https://games.butfree.online/auth/google/callback`
- `DOWNLOADER_URL`: Central Downloader server URL (default: `http://download.butfree.online:4000`)
- `DOWNLOADER_SECRET_KEY`: Shared node key for authenticating with Downloader
- `SESSION_SECRET`: Secret key for signing session cookies
