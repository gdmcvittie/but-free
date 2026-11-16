# Fraudio Plugin for Compás Player

Fraudio integration plugin for **Compás Player** (CompásOS firmware for HiBy DAPs, including HiBy R1, R3 II, and R3 Pro II).

This is a native CompásOS Lua port of the Fraudio client originally built for SonixOS (`hibee`). It enables seamless cloud music streaming, offline library synchronization from Google Drive, and search/download capabilities for YouTube Music, AudioBookBay, and podcasts.

---

## Features

### ☁️ Google Drive Music & Audiobook Cloud
- **Direct Remote Streaming:** Stream tracks and audiobooks directly from your linked Google Drive library over Wi-Fi without taking up SD card storage.
- **Library Browsing:** Browse your personal cloud library organized by:
  - **Albums:** Full album views with track counts, "Play Album", and "Download Album".
  - **Artists:** Artist views with their albums and songs.
  - **All Songs:** Searchable / scrollable list of all synced music tracks.
  - **Audiobooks:** Dedicated audiobook section with author and narrator metadata.
- **Offline Sync & Downloads:** Download individual tracks, entire albums, audiobooks, or trigger a full library sync to your SD card (`/Music/FRAUDIO/` and `/Audiobooks/FRAUDIO/`). Compás Player automatically indexes newly saved files into your local music library.

### 🔑 4-Character Device Pairing
- **Zero-Typing Handshake:** Request a 4-character pairing code on your device screen (e.g. `H7K2`).
- Open **[music.butfree.online/device](https://music.butfree.online/device)** on any phone, tablet, or PC, sign in with your Google account, and enter the 4-character code.
- The player automatically detects authorization, secures a persistent 10-year device token in `plugin.secrets`, and connects your cloud library.
- Easy unpair and re-pair options in Settings.

### 🔍 Integrated Search & Server Downloader
- **YouTube Music:** Search songs, albums, and artists. Queue downloads on the Fraudio backend and stream or download finished files directly to SD.
- **AudioBookBay (Audiobooks):** Search audiobooks with author, narrator, and series info. Triggers automated server-side download and processing, then transfers completed `.m4b` / `.mp3` files down to the DAP.
- **Podcasts:** Search podcast directories, browse RSS feed episode lists, and stream or download episodes to `/Podcasts/FRAUDIO/`.

### 🎛️ Native Compás Player Integration
- Appears in:
  - **Stream Media** tile grid (quick one-tap access).
  - **Music** menu (`Music > Fraudio`).
  - **Settings** menu (`Settings > System > Additional Tools > Fraudio Settings`).
- Uses native `plugin.play_remote` and `plugin.queue_remote_list` APIs with full track metadata (title, artist, album, duration, codec).
- Multi-language localization support (`en`, `es`, `de`).

---

## File Structure

```
/music/compas-plugin/
├── Fraudio.lua    # Main CompásOS plugin script
├── store.json     # Compás Plugin Store metadata manifest
└── README.md      # Documentation and installation guide
```

---

## Installation

### Method 1: Manual SD Card Installation
1. Connect your DAP's micro-SD card to your computer (or mount it via USB Storage mode).
2. Copy `Fraudio.lua` into the `.plugins` folder on the root of your SD card:
   ```
   <SD Card>/.plugins/Fraudio.lua
   ```
3. Safely unmount the SD card and insert it into your player.
4. On your player, go to **Settings > System > Plugins** and tap **Refresh Plugins** (or restart the player).
5. "Fraudio" will now appear in your **Stream Media** screen and **Music** menu.

### Method 2: Compás Tools / Plugin Store
1. In Compás Player, navigate to **Settings > System > Plugin Manager > Plugin Store**.
2. Search for **Fraudio** and tap **Install**.
3. Or use the desktop companion app **Compás Tools** to install the package to your connected device.

---

## Usage

### Pairing with your Google Drive
1. Tap the **Fraudio** tile in **Stream Media** (or open **Music > Fraudio**).
2. Tap **Pair Device with Google Drive**.
3. A 4-character code (e.g. `E4T9`) and a link will appear.
4. On your phone or computer browser, go to `https://music.butfree.online/device` (or the QR code / URL shown).
5. Sign in with Google, enter the 4-character code, and click **Pair Device**.
6. The player will toast `Paired with your_email@gmail.com!` and automatically load your Google Drive audio library.

### Custom Server Configuration
If you run a self-hosted instance of Fraudio:
1. Open **Settings > System > Additional Tools > Fraudio Settings**.
2. Tap **Server URL** and enter your instance URL (e.g. `https://my-fraudio.example.com`).
3. Tap **Test Server Connection** to verify connectivity with `/api/device/ping`.
