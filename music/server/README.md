# FRAUDIO

An audio library that lives in your Google Drive. Point it at an audiobook
folder and a music folder, and it indexes everything, streams it, and tracks
where you left off — with playlists, favourites and offline playback.

It runs as a local Node server, a Vite/React web app, and an Electron shell. You
can run it three ways: browser only, Electron desktop app, or as a small
always-on server on a VPS.

---

## Contents

- [How it fits together](#how-it-fits-together)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Google Cloud Console setup](#google-cloud-console-setup)
- [AudioBookBay account](#audiobookbay-account)
- [Torrent node](#torrent-node)
- [Deployment](#deployment)
- [On-disk layout](#on-disk-layout)
- [Library behaviour](#library-behaviour)
- [Troubleshooting](#troubleshooting)

---

## How it fits together

```
  Electron shell  ──┐
                    ├──>  Express API (PORT 5100)  ──>  Google Drive API
  Browser (5174)  ──┘            │                            ▲
       (Vite proxy)              ├──>  data/library.json       │ uploads
                                 └──>  AudioBookBay  ──────────┘
                                            │
                                            └──> remote torrent node ──> Drive
```

Two independent libraries, one per Drive folder:

| | Audiobooks | Music |
| --- | --- | --- |
| Drive folder | `audiobooksFolderId` | `musicFolderId` |
| Browsing | Author → Series → Book | Artist → Album |
| Continuity | Per-book resume position | Per-track resume position |

Google OAuth is the only identity system. FRAUDIO issues its own signed session
cookie afterwards, so the browser and the Electron window are separate sessions.

---

## Quick start

```bash
npm install
cp .env.example .env      # then fill it in — see Configuration
npm run dev               # http://localhost:5174
```

For the Electron shell:

```bash
npm run electron:dev
```

`electron:dev` runs `npm run build` first, because Electron loads the built SPA
from the Express server rather than from Vite.

| Script | What it does |
| --- | --- |
| `npm run dev` | Express on `5100` + Vite on `5174`, concurrently |
| `npm run dev:server` | Express only |
| `npm run dev:client` | Vite only |
| `npm run build` | Vite production build into `dist/` |
| `npm start` | Express only, serving the built `dist/` |
| `npm run electron:dev` | Build, then launch the Electron shell |
| `npm run electron:build` | Package a portable Windows `.exe` into `dist_electron/` |
| `npm run lint` | oxlint |

The very first launch needs valid Google credentials, or every route 401s and the
UI sits on the sign-in gate.

---

## Prerequisites

- **Node.js 20+.** The project is ESM-only (`"type": "module"`). No `engines`
  field is declared, so npm will not stop you on an old runtime — if you see
  `Cannot use import statement outside a module` or missing `fetch`, you are on
  Node < 18.
- **Google Drive.** Audio must already live in Drive; FRAUDIO does not transcode
  your library. (It does use ffmpeg/yt-dlp when downloading a new release.)
- **ffmpeg + ffprobe.** Music downloads transcode to MP3, which yt-dlp does by
  shelling out to *both* binaries side by side. Run `npm run tools:setup` once:
  it installs `ffmpeg.exe` and `ffprobe.exe` (plus `yt-dlp.exe`) into `bin/`.
  The bundled `@ffmpeg-installer` package provides ffmpeg only, so it is not
  enough on its own. `npm run tools:check` shows what resolved.
- **yt-dlp** is also fetched automatically into `bin/` the first time the music
  download pipeline needs it. `GET /api/health` deliberately does *not* trigger
  the download, so it reports `available: false` until then. That is expected.
- **Internet access** for Google, AudioBookBay, GitHub (yt-dlp) and, if you use
  one, a torrent node.

Check what resolved at runtime:

```bash
curl -s http://localhost:5100/api/health | jq
```

---

## Configuration

Everything is read from `.env` in the project root at startup. `dotenv` resolves
that path against the **process working directory**, so always start FRAUDIO from
the project root.

### Server

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `5100` | Express port. Electron reads this too (`electron-main.js`). |
| `NODE_ENV` | `development` | Cosmetic. |

### Google OAuth

See [Google Cloud Console setup](#google-cloud-console-setup) for the console
side.

| Variable | Default | Notes |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | — | Required. From the OAuth client's "Client ID". |
| `GOOGLE_CLIENT_SECRET` | — | Required. |
| `GOOGLE_REDIRECT_URI` | auto | Leave blank locally. Set when behind a proxy. |
| `SESSION_SECRET` | insecure fallback | **Set this.** See below. |

### AudioBookBay

| Variable | Default | Notes |
| --- | --- | --- |
| `ABB_USERNAME` | — | Account used to scrape the What's New feed. |
| `ABB_PASSWORD` | — | |
| `ABB_BASE_URL` | `https://audiobookbay.lu` | Override if the domain rotates. |

### Torrent node

See [Torrent node](#torrent-node) for the full contract.

| Variable | Default | Notes |
| --- | --- | --- |
| `TORRENT_NODE_URL` | — | Base URL of the node. Enables remote downloads when set. |
| `TORRENT_NODE_KEY` | — | Sent to the node as `x-node-key`. |
| `TORRENT_NODE_WEBHOOK_SECRET` | — | **Required** when a node is configured. |
| `TORRENT_NODE_TIMEOUT_MS` | `20000` | Per-request timeout to the node. |
| `TORRENT_MAX_CONCURRENT` | `1` | Max simultaneous webtorrent downloads. |
| `TORRENT_CACHE_MAX_BYTES` | `21474836480` (20 GB) | Offline cache ceiling. `0` = unlimited. |
| `TORRENT_DELETE_AFTER_UPLOAD` | `true` | Delete the local file once Drive has it. |

### Deployment

| Variable | Default | Notes |
| --- | --- | --- |
| `PUBLIC_URL` | derived from `GOOGLE_REDIRECT_URI` | Public origin the torrent node calls back. |
| `DATA_DIR` | `./data` | Library DB, covers, offline cache, downloads. |
| `BIN_DIR` | `./bin` | Cached yt-dlp binary. |

> `PUBLIC_URL` and `TORRENT_NODE_WEBHOOK_SECRET` were previously undocumented and
> are required for remote downloads. Both are now in `.env.example`.

### `SESSION_SECRET` is not optional

If it is blank, `server/config.js` falls back to the literal string
`fraudio_dev_secret_change_me`. The session cookie payload is
`{ id, email, exp }`, and `verifySessionToken` resolves the user from that `id`
alone. With the published default key, anyone who knows your Google numeric ID
can mint a valid cookie offline and browse your library. It fails closed on
nothing — there is no expiry or binding to check.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Rotating the secret logs everyone out; they just sign in again.

---

## Google Cloud Console setup

FRAUDIO authenticates against Google Drive with OAuth 2.0. There is no Google
SDK involved — the server uses plain `fetch` against Google's token endpoint —
but you still need a Cloud project, the Drive API enabled, and an OAuth client.

### 1. Create or pick a project

<https://console.cloud.google.com/project-picker>

Use a **dedicated** project. Drive scopes are restricted, and keeping this
isolated makes the consent-screen branding and test-user list predictable.
Billing is not required.

### 2. Enable the Google APIs

- **Google Drive API** - <https://console.cloud.google.com/apis/library/google-drive-api>
- **YouTube Data API v3** - <https://console.cloud.google.com/apis/library/youtube.googleapis.com>
  (only needed for the cookie-free "Liked Music" import; harmless to leave off otherwise)

Click **Enable** on each. Without the Drive API, sign-in succeeds but every Drive
call fails with `ACCESS_TOKEN_SCOPE_INSUFFICIENT` or a 403; without the YouTube
API the Liked-videos import returns 403.

### 3. Configure the OAuth consent screen

<https://console.cloud.google.com/apis/credentials/consent>

| Field | Value |
| --- | --- |
| User type | **External** |
| App name | `FRAUDIO` |
| User support email | your address |
| Developer contact email | your address |

Under **Scopes**, add:

```
https://www.googleapis.com/auth/drive
```

FRAUDIO also requests `openid`, `email` and `profile`, but Google adds those
implicitly alongside Drive — do not list them separately.

#### Why this scope is a big deal

`.../auth/drive` is a **restricted scope**. It grants read/write access to the
user's *entire* Drive, not just files they pick:

- Until the app is verified, every sign-in shows a red **"Google hasn't verified
  this app"** warning. Your own test users can click through it.
- While **Publishing status** is *Testing*, you are capped at **100 test users**
  and Google **expires refresh tokens after 7 days**.
- Publishing externally with a restricted scope requires completing Google's
  [OAuth verification](https://support.google.com/cloud/answer/13463073) — a
  screencast, a privacy policy URL, and a justification for full Drive access.

`.../auth/drive.file` would avoid verification entirely, but it only grants
access to files the user opens through a Google Picker. FRAUDIO scans whole
folders on a schedule, so it cannot work that way. **Full Drive scope is
architecturally required.**

For personal use, keep status *Testing* and add yourself as the only test user.

### 4. Add yourself as a test user

Consent screen → **Test users** → **Add users**. Add every account that will sign
in. With a restricted scope in *Testing*, an account that is not on this list
gets `403 access_denied` at the consent screen.

### 5. Create the OAuth client

<https://console.cloud.google.com/apis/credentials> → **Create credentials** →
**OAuth client ID**

| Field | Value |
| --- | --- |
| Application type | **Web application** |
| Name | `FRAUDIO local` |

#### Authorized redirect URIs

Add **one entry per host spelling you actually use**:

```
http://localhost:5100/api/auth/google/callback
http://127.0.0.1:5100/api/auth/google/callback
```

> **Why both?** `server/googleAuth.js` auto-detects the redirect URI from the
> incoming request's `Host` header when `GOOGLE_REDIRECT_URI` is blank. Different
> launch paths spell that host differently:
>
> | How you run FRAUDIO | `Host` header | Resulting redirect URI |
> | --- | --- | --- |
> | `npm run dev` / `npm start` (browser) | `localhost:5100` | `http://localhost:5100/…` |
> | `npm run electron:dev` | `127.0.0.1:5100` | `http://127.0.0.1:5100/…` |
>
> `electron-main.js` loads `http://127.0.0.1:${PORT}`, not `localhost`. Register
> only `localhost` and the Electron build fails with `Error 400:
> redirect_uri_mismatch` while the browser build works fine.

Vite's dev server on `5174` needs **no** entry. The OAuth dance always completes
against the Express server on `PORT`; Vite only proxies `/api` for ordinary
traffic. No JavaScript origin is required either — FRAUDIO never loads
Google-hosted scripts into its own pages.

Behind a reverse proxy, set `GOOGLE_REDIRECT_URI` to a single absolute URI and
register only that. The proxy must forward `Host` / `X-Forwarded-Host` and
`X-Forwarded-Proto`, because `redirectUri()` reads those when the variable is
unset. It works without Express `trust proxy` since the headers are read directly.

Google requires the scheme to be exactly `http` or `https` — no trailing slash,
no query string, case-sensitive path.

---

## AudioBookBay

What's New browsing works unauthenticated. To download you need an account:

1. Sign up at <https://audiobookbay.lu>.
2. Put the username and password in `.env`:

   ```dotenv
   ABB_USERNAME=you@example.com
   ABB_PASSWORD=...
   ```

3. Restart FRAUDIO, then **Settings → AudioBookBay → Sign in**.

The scraper is deliberately simple and the site changes layout periodically. If
What's New comes back empty, check `GET /api/health` → `abb.loggedIn`, and be
prepared to adjust the selectors in `server/abbClient.js`.

---

## Torrent node

Downloading a release means fetching a torrent, extracting the audio, tagging
it, and uploading it to Drive. That is a lot of disk and bandwidth, so FRAUDIO
delegates it to a **remote torrent node** and keeps only the orchestration.

**When `TORRENT_NODE_URL` is unset, FRAUDIO does not run webtorrent locally.**
Downloads are disabled; browsing, streaming and playback all still work. The
config comment describing a local fallback is aspirational — treat remote-only
as the current behaviour.

### Why the node must be able to reach FRAUDIO

The node, not FRAUDIO, performs the Drive upload. It needs two things from
FRAUDIO:

1. A Drive access token, which expires hourly.
2. A callback when a job finishes.

So a remote node must be able to open an inbound connection to FRAUDIO. **If
FRAUDIO is only on `localhost` or a LAN, downloads cannot work.** This is the
single biggest deployment constraint in the project — see
[Deployment](#deployment).

### HTTP contract

FRAUDIO calls the node at `TORRENT_NODE_URL`, authenticating with
`x-node-key: $TORRENT_NODE_KEY`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Reachability probe (6s timeout). Surfaced in Settings. |
| `POST` | `/api/download` | Enqueue a job. |
| `GET` | `/api/downloads?userId=` | List jobs. |
| `GET` | `/api/download/:jobId` | Fetch one job. |
| `POST` | `/api/download/:jobId/cancel` | Cancel a job. |

The node calls FRAUDIO back, authenticating with
`x-node-secret: $TORRENT_NODE_WEBHOOK_SECRET`:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `{PUBLIC_URL}/api/downloads/webhook` | Job finished; writes library entries. |
| `POST` | `{PUBLIC_URL}/api/downloads/token-refresh` | Returns `{ accessToken }`. |

Two independent secrets on purpose: `TORRENT_NODE_KEY` authenticates *FRAUDIO to
the node*, `TORRENT_NODE_WEBHOOK_SECRET` authenticates *the node to FRAUDIO*.
Reusing one value would mean a compromised node could also forge inbound events.

`verifyNodeSecret` fails closed — if the secret is unset, every callback is
rejected rather than accepted anonymously, because these routes write directly
into a user's library. It is header-only, never a query parameter, so it does not
leak into proxy or access logs.

### `PUBLIC_URL`

FRAUDIO sends absolute callback URLs, derived from `PUBLIC_URL` (or, failing
that, the origin of `GOOGLE_REDIRECT_URI`). It refuses obviously unreachable
hosts — `localhost`, `127.0.0.1`, `0.0.0.0`, and anything in `10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, or `*.local`:

```
PUBLIC_URL points at 192.168.1.20, which the torrent node cannot reach.
Set it to a publicly reachable address (or tunnel FRAUDIO).
```

That check catches LAN addresses and loopback. It cannot catch a public IP that
is firewalled, or a dynamic DNS name that has not propagated — if the node cannot
reach you, this validation will not have warned you.

---

## Deployment

### Local, browser only

The default. Nothing to deploy.

```bash
npm run dev
```

Set `GOOGLE_REDIRECT_URI` only if you are doing something unusual; host
auto-detection already handles both `localhost` and `127.0.0.1`.

### Local, Electron desktop app

```bash
npm run electron:dev          # development
npm run electron:build        # portable .exe in dist_electron/
```

The shell imports the Express server into the Electron main process, so there is
no second server to manage. `.env` is read from `process.cwd()` — launching the
packaged app from Explorer may not have the project root as CWD, so set the
variables in the OS environment for a packaged build.

`electron-builder` ships `dist/`, `server/`, `server.js`, `package.json`,
`electron-main.js` and the ffmpeg binary inside an asar, with `dist/**` unpacked
so Vite's asset paths resolve.

### A VPS, for remote downloads

This is the configuration the torrent node actually needs.

1. **Expose FRAUDIO over HTTPS.** Terminate TLS in nginx/Caddy and proxy to
   `127.0.0.1:5100`.
2. **Forward the original host and scheme.** FRAUDIO reads `Host` /
   `X-Forwarded-Host` and `X-Forwarded-Proto` directly, so configure your proxy
   to set them:

   ```nginx
   location / {
     proxy_pass http://127.0.0.1:5100;
     proxy_set_header Host              $host;
     proxy_set_header X-Forwarded-Host  $host;
     proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

   Missing these breaks the OAuth callback (wrong `redirect_uri`) and makes the
   session cookie `Secure`-flagged incorrectly. Streaming works either way; the
   Vite proxy paths are irrelevant in production, since Express serves `dist/`
   directly.
3. **Pin the origin explicitly.** With `PUBLIC_URL` set you avoid host-detection
   ambiguity entirely:

   ```dotenv
   PUBLIC_URL=https://audio.example.com
   GOOGLE_REDIRECT_URI=https://audio.example.com/api/auth/google/callback
   ```

4. **Register that single redirect URI** in the OAuth client, and publish the
   consent screen (or verify it) once more than ~7 test users need access —
   refresh tokens otherwise expire weekly.
5. **Give it storage and a supervisor.** `DATA_DIR` holds the library DB and the
   offline cache; `TORRENT_CACHE_MAX_BYTES` bounds it. Run under systemd, pm2 or
   a Windows service/task scheduler rather than a foreground terminal.

Caddy equivalent:

```caddy
audio.example.com {
    reverse_proxy 127.0.0.1:5100 {
        header_up X-Forwarded-Proto https
        header_up X-Forwarded-Host  {host}
    }
}
```

#### Exposing FRAUDIO on a public IP

It has no TLS of its own and no built-in user management — protection is Google
OAuth plus a 30-day signed session cookie. Behind HTTPS that is reasonable for a
small household. Before putting it on the open internet:

- Terminate TLS. Without it the session cookie travels in clear and Google will
  return `redirect_uri_mismatch` for any `https` redirect URI anyway.
- Consider an extra layer in front (basic auth, an IP allowlist, or a VPN) if the
  library itself is not sensitive.
- Note `app.use(cors())` is unrestricted. `sameSite: 'lax'` on the session cookie
  is what blocks cross-site state changes; do not weaken it to `none`.
- Remember `TORRENT_CACHE_MAX_BYTES` defaults to 20 GB of cache. Disk exhaustion is
  the usual first failure on a small VPS.

---

## On-disk layout

Everything is relative to `DATA_DIR` (default `./data`) and `BIN_DIR`:

```
data/
  users/<userId>/   per-user stores: audiobooks.json, music.json, user.json
  covers/           cached cover art (JPEG) and generated placeholders (SVG)
  offline/          full audio copies for offline playback
  downloads/        torrent staging area, emptied after Drive upload
bin/
  yt-dlp[.exe]      fetched on demand (or by `npm run tools:setup`)
  ffmpeg[.exe]      installed by `npm run tools:setup`
  ffprobe[.exe]     installed by `npm run tools:setup` (yt-dlp needs both)
```

`covers/` is a cache; deleting it is safe and only costs a refetch. Deleting
`offline/` only removes local copies — Drive is still the source of truth.

### Where your data really lives

**Progress, favourites and playlists live in Google Drive**, in a plain JSON file
at the root of each library folder. Nothing is hidden in a subfolder — you can
open, edit, back up or delete them like any other file:

```
Audiobooks/     <- your chosen audiobooks folder
  Author/...
  fraudio-audiobooks.json
Music/          <- your chosen music folder
  Artist/Album/...
  fraudio-music.json
```

Each document is scoped to its own library, so audiobook favourites never leak
into music and vice versa. `fraudio-music.json` carries music progress and
**music favourites**; `fraudio-audiobooks.json` additionally carries app-level
state (settings, AudioBookBay "seen" list, follow list), which is not media-scoped.

```json
{
  "schema": 1,
  "kind": "audiobooks",
  "updatedAt": "2026-10-02T19:47:49.810Z",
  "progress": {
    "1AbCdEfGhIjKlMnOpQrStUvWxYz": { "positionSec": 120, "durationSec": 3600, "updatedAt": "..." }
  },
  "favorites": ["1AbCdEfGhIjKlMnOpQrStUvWxYz"],
  "authorFavorites": ["Some Author"],
  "playlists": {
    "pl_abc123": { "id": "pl_abc123", "name": "Road Trip", "items": ["1AbC..."], "createdAt": "...", "updatedAt": "..." }
  },
  "settings": { "autoScanOnLaunch": true, "coverCacheDays": 30 },
  "abbSeen": [],
  "pullList": { "authors": [], "series": [], "enabled": true }
}
```

Items are keyed by **Google Drive file id**, not by the local `abk_…`/`trk_…` id,
because local ids are regenerated per install — a document keyed by them would be
meaningless on another machine.

The two libraries never share state. Continue Listening, favourites, author/artist
favourites and playlists are all scoped to one library, so a book can only appear in
the audiobooks document and a track only in the music document. Playlists belong to
exactly one library: adding a track to an audiobook playlist is not possible, and a
document can only restore a playlist into the library that wrote it. A playlist saved
before this split that still mixed both libraries is split automatically the first
time the documents load — its books stay in `fraudio-audiobooks.json` and its tracks
move to a music playlist in `fraudio-music.json`.

Writes are debounced (~4s) and happen in the background, so playback never blocks
on Drive. `data/users/<userId>/` keeps a local mirror plus your OAuth tokens, so the
app still starts if Drive is unreachable; state reconciles again on next sync. If
you point FRAUDIO at a different Drive folder, the documents move with it.

Offline-cache records are deliberately **not** mirrored — they describe files on
one specific machine, so they have no meaning anywhere else.

---

## Library behaviour

**Scanning.** Each library (audiobooks, music) has its own Drive folder, and a
scan reconciles *only* that folder: scanning music never deletes audiobook rows
or vice-versa. FRAUDIO scans automatically:

- once per launch, for every connected folder (Settings → "Scan on launch",
  on by default);
- immediately when you connect a Drive folder;
- whenever a download or YouTube Music import lands new files;
- plus the manual **Rescan Drive** button in both sections.

**Favourites.** There are three kinds, and they never cross libraries:
individual items (books, tracks), authors (audiobooks) / artists (music), and
albums (music). Hearts appear on item cards, author/artist rows, album rows, the
album detail modal and the YouTube Music search/artist pages. Favouriting an
album is a single tap; favouriting an artist also matches every track they
appear on in your library.

**Playlists.** A playlist belongs to exactly one library. Individual items get
an "add to playlist" action; album views and album rows have **Album to
playlist** which adds every track of the album at once. Adding a track of the
wrong library is rejected server-side. **Smart playlists** (Settings → YouTube
Music) are keyword rules - "Hip Hop / Rap" with `rap, trap, drill` - that match
whole words against artist, album, title and the file's genre tag. They run
after every import and Drive scan and only ever add, so removing a song by
hand sticks; "Apply to library now" backfills the existing catalogue. The
rule and its matches sync with the music folder's JSON like everything else.

**Sorting.** The Library toolbar has sort chips - title, artist/author, album
or series, duration, recently added, last played - plus a direction toggle.
Album and artist lists sort by name, count, duration and recency. Choices are
remembered per library and per grouping.

**YouTube Music.** Searches fetch songs, artists and albums; albums resolve
their track list through the album's auto-playlist. Downloads land in
`Artist/Album/NN Title.<ext>` under your music folder with embedded tags (and
thumbnails for mp3/m4a). MP3 is the default and *does* transcode - Settings →
YouTube Music → **MP3 quality** picks the LAME setting: VBR `V0`-`V8`
(~245k down to ~100k; default `V4` ≈165k VBR, roughly 40% smaller than the
old max-quality behaviour) or fixed `128k/160k/192k` CBR. Choosing **Opus**
instead downloads YouTube's own best stream untouched (~50% smaller again,
still tagged, no re-encode). A bare year (e.g. `2022`) is never used as an
artist - the file's own tags win, and the album-artist credit keys the folder.

**Playlist import & Liked Music.** What's New → **Playlist** has two importers:

- **Liked Music (recommended, no cookies).** FRAUDIO reads your Liked-videos
  playlist through the YouTube Data API using your existing Google sign-in
  (`youtube.readonly` scope) - YouTube hearts on music appear there too. One
  click queues every liked track into Drive and a FRAUDIO playlist called
  "Liked Music". Needs **YouTube Data API v3** enabled in the Cloud project and,
  if your token predates the new scope, one reconnect via Account → sign in.
- **Paste a playlist URL** (`music.youtube.com/playlist?list=…` or a bare list
  id) and queue the whole thing.

The auto-generated Liked Music list (`list=LM`) is account-private and can't be
shared, so for the *URL* route it needs YouTube cookies, and so do age-gated
tracks. On the desktop app, Settings → YouTube Music → **Sign in** opens a
real YouTube Music window and captures the session (including the httpOnly
cookies a manual export often misses). Elsewhere, export a **Netscape
cookies.txt** ("Get cookies.txt LOCALLY" works; DevTools copy-paste does not)
and set the path under Settings → YouTube Music → Cookies file, or
`YTM_COOKIES_FILE` in `.env`. "Cookies from browser" exists but Chrome locks
its database and Edge DPAPI-encrypts it on Windows, so prefer the capture or a
file. Cookies stay on the machine - never synced to Drive.

---

## Troubleshooting

**`GOOGLE_CLIENT_ID is not configured`**
`.env` is missing it, or you started the server from a different working
directory. `dotenv` resolves `.env` against the process CWD.

**`Error 400: redirect_uri_mismatch`**
The URI Google received does not byte-for-byte match a registered entry. Check
scheme, port, trailing slash, and `localhost` vs `127.0.0.1`. Behind a proxy,
check `X-Forwarded-Proto`/`Host`.

**`Error 403: access_denied` at the consent screen**
Your account is not on the consent screen's **Test users** list.

**`invalid_client` / `invalid_grant` on the token exchange**
The secret does not belong to the client ID beside it. OAuth clients are deleted
independently — re-copy both.

**Signed out after an hour, no refresh token**
Only the first consent returns a refresh token. Revoke the grant at
<https://myaccount.google.com/permissions> and sign in again. In *Testing* mode
Google expires refresh tokens after **7 days** regardless.

**`ACCESS_TOKEN_SCOPE_INSUFFICIENT` or 403s after signing in**
Drive API not enabled, or the OAuth client lives in a different project than the
one the API was enabled on.

**"This Google session predates YouTube access" on the Liked import**
The `youtube.readonly` scope was added after your token was issued. Sign out and
link Google again (consent is `prompt=consent`, so the new scope is granted),
and make sure **YouTube Data API v3** is enabled in the same project.

**`No PUBLIC_URL is set, so the torrent node has no address to call back`**
Set `PUBLIC_URL`, or leave it unset if you do not use a torrent node. Downloads
need it; browsing does not.

**`[Download] TORRENT_NODE_WEBHOOK_SECRET is unset - rejecting node callback`**
The node cannot authenticate inbound callbacks. Set it on **FRAUDIO**, and give
the node the same value.

**Downloads sit pending forever**
The node cannot reach FRAUDIO. Confirm `PUBLIC_URL` resolves publicly, that
`/api/downloads/token-refresh` is reachable from the node, and that
`GET {TORRENT_NODE_URL}/api/status` succeeds from FRAUDIO's host.

**Covers show as a generic mint placeholder**
Drive has no cover art for that item and none in its parent folders. Add a
`Book Title.jpg` next to the audio file, or accept the placeholder.

**`dist/ not found`**
Expected before a build. Run `npm run build`, or use `npm run dev:client`.

**Health shows `ytdlp: { available: true, path: null }`**
Expected. The health probe never triggers the binary download.

---

## Reference

| Resource | URL |
| --- | --- |
| Project picker | <https://console.cloud.google.com/project-picker> |
| Enable Drive API | <https://console.cloud.google.com/apis/library/google-drive-api> |
| Credentials | <https://console.cloud.google.com/apis/credentials> |
| Consent screen | <https://console.cloud.google.com/apis/credentials/consent> |
| Revoke app access | <https://myaccount.google.com/permissions> |
| OAuth scopes | <https://developers.google.com/identity/protocols/oauth2/scopes#drive> |
| OAuth verification | <https://support.google.com/cloud/answer/13463073> |
| AudioBookBay | <https://audiobookbay.lu> |