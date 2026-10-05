# butFREE Unified Downloader & Streaming Hub

A centralized, standalone Node.js media server designed to run on your remote VPS (such as IONOS) to handle all heavy bandwidth and compute jobs for the entire `butfree.online` ecosystem:

1. **Fraudio Audiobooks**: Autonomous WebTorrent peer discovery, download, metadata parsing, and direct background upload to Google Drive with automated token refresh.
2. **Fraudio YouTube Music**: Downloads songs/albums/playlists via `yt-dlp`, transcodes audio to high-quality MP3 (320k) or M4A (256k) via `ffmpeg`, embeds metadata & cover art, and uploads to Google Drive.
3. **Freevee TV & Movie Streaming**: Real-time sequential WebTorrent streaming with instant 512KB pre-buffering, HTTP byte-range seek support (`206 Partial Content`) for Roku, Fire TV, and Web, automatic idle cleanup, and VPS tracker optimization for hosts where outbound UDP is restricted.
4. **On-the-Fly Video Transcoding**: Transcodes high-bitrate or incompatible video formats (H.265, MKV, AVI) into streamable MP4 containers.
5. **Unified Web Dashboard**: Live web interface (`/dashboard`) displaying active video streams, torrent speeds, peer counts, and active/completed Google Drive transfers.

---

## 🚀 Quick Setup on your IONOS VPS

We've provided an automated, one-command deployment script [`deploy-vps.sh`](./deploy-vps.sh):

```bash
# 1. Copy the downloader folder to your VPS
scp -r ./downloader user@YOUR_VPS_IP:/tmp/downloader

# 2. SSH into your VPS and run the deployment script
ssh user@YOUR_VPS_IP
cd /tmp/downloader
chmod +x deploy-vps.sh
./deploy-vps.sh
```

The script will automatically:
- Install Node.js LTS (v22+), `ffmpeg`, `ffprobe`, `python3`, and `pm2`
- Install dependencies and fetch the latest `yt-dlp` binary
- Configure environment defaults
- Start the service under PM2 (`pm2 start ecosystem.config.cjs`) with auto-restart on reboot
- Configure the UFW firewall to allow port `4000`

---

## 🔗 Connecting your Apps (`butfree.online`)

In your monorepo's root `.env` file (`c:\_code\but-free\.env`), update the following settings to point to your VPS IP:

```env
# ---- Downloader & Torrent Node Settings ----
DOWNLOADER_PORT=4000
DOWNLOADER_URL=http://YOUR_VPS_IP:4000
DOWNLOADER_SECRET_KEY=change_this_shared_downloader_key_45678
NODE_KEY=change_this_shared_downloader_key_45678

# Forwarding for Freevee (TV & Movies)
TORRENT_STREAM_SERVER=http://YOUR_VPS_IP:4000

# Forwarding for Fraudio (Audiobooks & Music)
TORRENT_NODE_URL=http://YOUR_VPS_IP:4000
TORRENT_NODE_KEY=change_this_shared_downloader_key_45678
TORRENT_NODE_WEBHOOK_SECRET=change_this_shared_downloader_key_45678
```

Both `fraudio` and `freevee` are configured to automatically fall back to `DOWNLOADER_URL` on port `4000` and use the shared `DOWNLOADER_SECRET_KEY`, so everything "just works" out of the box.

---

## 📡 API Endpoints Overview

### Health & Monitoring
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Root server status, active engines, and stream count |
| `GET` | `/health` or `/api/status` | Detailed JSON status with memory, uptime, and active jobs |
| `GET` | `/dashboard` | Interactive web dashboard |
| `POST` | `/api/restart` | Gracefully reboots the PM2 daemon |

### Freevee TV Streaming
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/torrent/status` | Live status of active video swarms and peer counts |
| `POST` | `/api/torrent/stream` | Starts a streaming video swarm from a magnet URL; returns `streamUrl` |
| `GET/HEAD` | `/api/torrent/serve/:streamId/:fileIndex` | Byte-range video streaming endpoint |
| `GET` | `/api/torrent/stream/:streamId/file/:fileIndex` | Stream endpoint alias for Roku and Fire TV clients |
| `POST` | `/api/torrent/stream/:streamId/stop` | Stops playback and destroys the torrent swarm |
| `GET` | `/api/torrent/cache/size` | Calculates cache size on disk |
| `POST` | `/api/torrent/cache/clear` | Flushes idle video chunks from the disk |

### Fraudio Audiobooks & YouTube
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/download` | Dispatches an audiobook torrent download & Google Drive upload |
| `POST` | `/api/youtube/download` | Dispatches YouTube Music download, MP3/M4A transcode, and Drive upload |
| `GET` | `/api/youtube/tracks` | Resolves tracks from a YouTube Music playlist ID |
| `GET` | `/api/downloads` | Lists all active and recent audio jobs |
| `POST` | `/api/download/:id/cancel` | Cancels an ongoing audio transfer |
| `DELETE` | `/api/download/:id` | Removes a job record |