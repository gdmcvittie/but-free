# FREEVEE - Fire TV App

A Fire TV (10-foot UI web app) build of the FREEVEE service. It mirrors the roku-cloud app feature-for-feature, but runs in the Fire TV browser / WebView, so Google Drive content plays **directly** (native byte-range streaming) with no transcoding needed.

## Features

- **Pairing login**: Sign in by pairing the TV with your FREEVEE account through the cloud web app (`/device`). Displays a 6-digit code and polls until you complete sign-in on your phone/computer.
- **Home**: Browse popular movies and TV shows ("What's On").
- **Drive**: Browse your Google Drive library - TV Shows, Movies, and Continue Watching - streamed directly from Drive.
- **Faves**: Cloud-synced favorites. Long-press Enter or press Menu on a Drive/Services item to heart it.
- **Services**: Browse streaming service catalogs (Netflix, Prime, Disney, etc.) and find torrents to play them.
- **Free TV**: Live FAST channels (Pluto TV, Tubi, Roku Channel, Plex) via HLS.
- **Torrents**: Multi-source torrent search with best-match playback through the torrent streaming server.

## Server Configuration

This app connects to:
- **Main Server**: `https://tv.butfree.online`
- **Torrent Server**: `http://download.butfree.online`

Unlike the Roku build, there is no HLS transcode fallback for Drive content - the browser plays Drive files directly via `/api/stream/drive/:fileId`.

## Development

```bash
npm install
npm run dev       # vite dev server on port 5175
npm run build     # outputs to dist/
```

## Android / Fire TV APK

The `android/` folder is a Fire TV WebView wrapper. It loads the built web app from the APK's assets (`http://appassets.androidplatform.net/firetv-cloud/index.html`) and connects to `https://tv.butfree.online`.

Build the APK with the repo toolchain (gradle + JDK + Android SDK under `toolchain/`):

```bash
npm run build:tv            # compiles web app, syncs assets, and runs gradle assembleDebug
```

The APK is emitted to `dist/apks/firetv.apk` and `tv/server/public/tv/downloads/firetv.apk`.

## Deployment

The cloud server serves the built app at `/firetv` and `/firetv-cloud`:

```bash
npm run build:tv
npm start
```

Open `https://tv.butfree.online/firetv` on your Fire TV browser or install the `firetv.apk` package.