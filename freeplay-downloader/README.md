# Freeplay Downloader

A slimmed-down version of `my-games-server` that keeps **only** the PC
FitGirl / Steam repack downloading features:

- 🔥 **FitGirl repack browser** — live RSS feed search, "Exclude update posts" filter
- 🗓️ **Steam popular releases** — trending games with one-click FitGirl availability badges
- 🧲 **Torrent downloads** — magnets, `.torrent` files, torrent hash; selective file downloads
- 🌐 **Direct mirror downloads** — FuckingFast landing-page auto-resolution, DataNodes detection, retries/backoff
- 🔍 **Link scraper** — deep-scans any release page for magnets, torrents and hoster mirrors
- 📥 **1-at-a-time download queue** — everything lands in your chosen downloads folder
- 📦 **Auto-extract** — `.zip`/`.rar`/`.7z` (incl. multi-part) archives are extracted and deleted when a download finishes
- 🔗 **Deep links** — any app can launch `freeplayDL://<url>` to enqueue a magnet/direct link

## Stack

Same stack as `my-games-server`: **Node.js + Express** backend, **Electron**
desktop shell, vanilla JS/React-style single-page UI served from
`public/index.html`.

## Usage

```bash
npm install
npm start            # plain Node server on http://localhost:5055
npm run electron:dev # Electron shell (auto deep-link registration)
```

On first run, pick a **Downloads Folder** on the setup card — all downloads go
there (each game gets its own sub-folder).

### Deep links

```
freeplayDL://magnet:?xt=urn:btih:...
freeplayDL://https://fuckingfast.co/abc#game.part1.rar
freeplayDL://download?url=<url-encoded>&title=My+Game
```

The desktop app registers itself as the handler for `freeplayDL://` on
Windows/macOS. When a link arrives, it is POSTed to `/api/deep-link/add`,
queued, and surfaced as a toast + queue update in the UI.

## Build

```bash
npm run build        # electron-builder → portable exe + NSIS installer in dist_electron/
```

The post-build script zips the exe into `freeplay-downloader-latest-win64.zip`.

## API surface (all under `/api`)

| Route | Purpose |
| --- | --- |
| `/api/pc-rss/feed` | Fetch & parse any RSS/Atom feed (enclosures, magnets, mirrors, thumbnails) |
| `/api/pc-rss/popular-games` | Steam popular/last-week releases |
| `/api/pc-rss/check-fitgirl` / `-batch` | FitGirl availability badges |
| `/api/pc-rss/scrape-links` | Deep-scan a page for download links |
| `/api/pc-rss/torrent/add` `/add-batch` `/inspect` `/select-files` `/delete` `/update-url` `/queue` | Download queue |
| `/api/pc-rss/open-folder` | Open the downloads folder in Explorer |
| `/api/downloads-folder` GET/POST + `/pick` | Configure the downloads folder |
| `/api/deep-link/add` | Process `freeplayDL://` links |
| `/api/events` | SSE live queue progress |
| `/api/proxy-image` | Thumbnail proxy |
| `/api/health` | Status/info |

Config + queue state live in `config.json` / `torrent_queue.json` next to the
exe (portable mode) or in the project folder during development.
