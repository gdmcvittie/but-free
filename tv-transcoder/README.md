# TV Transcoder

A small PC (Node.js) web app that transcodes videos from your Google Drive into Roku-friendly HLS streams. Run it on your PC and reach it from any browser on your network.

## Features
- Web UI to connect Google Drive (OAuth) and pick a video file.
- Transcode to selectable settings: 360p / 480p / 720p / 1080p (H.264 + AAC, HLS).
- Serves HLS playlists/segments with CORS and Roku-friendly headers.
- JSON feed for your Roku app: `/api/roku/feed` and `/api/roku/stream/:id`.

## Setup

1. Install Node.js 18+.
2. `npm install`
3. Copy `.env.example` to `.env` and fill in Google OAuth credentials (or use the provided `.env`).
4. In Google Cloud Console, add `http://localhost:4300/auth/google/callback` (and/or your LAN URL) to Authorized redirect URIs.
5. `npm start`
6. Open `http://localhost:4300` (or `http://<PC-IP>:4300` from another device).

ffmpeg is auto-detected (bundled in `tv/server/bin` or `downloader/bin`). Override with `FFMPEG_PATH`.

## Roku integration
- Feed URL: `http://<PC-IP>:4300/api/roku/feed`
- Each item has `streamUrl` pointing to `.../media/<jobId>/index.m3u8`.
- In your Roku SceneGraph `Video` node, set `content.url` to the streamUrl and `streamFormat = "hls"`.

Example (BrightScript):
```
video = CreateObject("roSGNode", "Video")
content = CreateObject("roSGNode", "ContentNode")
content.url = "http://192.168.1.50:4300/media/<jobId>/index.m3u8"
content.streamFormat = "hls"
video.content = content
video.control = "play"
```

## Notes
- Jobs persist in `data/jobs.json`; media in `media/<jobId>`.
- Delete a job to free disk space.
- For private Drive files, connect Google Drive first. Public share links can be pasted as a URL source.
