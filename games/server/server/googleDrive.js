import { GoogleAuth } from './googleAuth.js';
import * as Database from './database.js';

// Console detection rules by file extension
const EXTENSION_CONSOLE_MAP = {
  sfc: 'snes',
  smc: 'snes',
  snes: 'snes',
  nes: 'nes',
  gba: 'gba',
  gb: 'gb',
  gbc: 'gbc',
  md: 'sega',
  gen: 'sega',
  smd: 'sega',
  bin: 'sega',
  iso: 'psx',
  cue: 'psx',
  chd: 'psx',
  pbp: 'psx',
  n64: 'n64',
  z64: 'n64',
  v64: 'n64',
  nds: 'nds',
  pce: 'pce',
  gg: 'gg',
  sms: 'sms',
  p8: 'pico8',
  zip: 'snes' // fallback or detected from subfolder
};

// Map console names to Libretro thumbnail repository names
const LIBRETRO_SYSTEM_NAMES = {
  snes: 'Nintendo - Super Nintendo Entertainment System',
  nes: 'Nintendo - Nintendo Entertainment System',
  gba: 'Nintendo - Game Boy Advance',
  gb: 'Nintendo - Game Boy',
  gbc: 'Nintendo - Game Boy Color',
  sega: 'Sega - Mega Drive - Genesis',
  genesis: 'Sega - Mega Drive - Genesis',
  psx: 'Sony - PlayStation',
  ps1: 'Sony - PlayStation',
  n64: 'Nintendo - Nintendo 64',
  nds: 'Nintendo - Nintendo DS',
  pce: 'NEC - PC Engine - TurboGrafx 16',
  gg: 'Sega - Game Gear',
  sms: 'Sega - Master System - Mark III'
};

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(bytes);
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx++;
  }
  return `${size.toFixed(unitIdx === 0 ? 0 : 1)} ${units[unitIdx]}`;
}

export function cleanGameTitle(rawName) {
  if (!rawName) return 'Unknown Game';
  // Strip extension
  let clean = rawName.replace(/\.[^/.]+$/, '').trim();
  // Strip typical scene / region tags
  clean = clean
    .replace(/\s*\((USA|Europe|Japan|En,Ja|World|Beta|Rev\s*\d+|v\d+\.\d+|Proto|Demo|Unl|Sample)[^)]*\)/gi, '')
    .replace(/\s*\[(!|b\d+|h\d+|t\d+|o\d+|p\d+|f\d+|a\d+)[^\]]*\]/gi, '')
    .replace(/\s+-\s+(USA|Europe|Japan)$/i, '')
    .trim();
  return clean || rawName;
}

export function getBoxArtUrl(title, consoleKey) {
  const systemName = LIBRETRO_SYSTEM_NAMES[consoleKey];
  if (!systemName) return null;
  // Libretro thumbnails format: replaces slashes/colons/question marks with underscores
  const sanitizedTitle = title
    .replace(/[&]/g, '_')
    .replace(/[/\\:*?"<>|]/g, '_')
    .trim();
  return `https://thumbnails.libretro.com/${encodeURIComponent(systemName)}/Named_Boxarts/${encodeURIComponent(sanitizedTitle)}.png`;
}

export const GoogleDrive = {
  async listFolders(user, parentId = 'root') {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('fields', 'files(id, name, mimeType, modifiedTime)');
    url.searchParams.set('orderBy', 'name');
    url.searchParams.set('pageSize', '100');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error?.message || 'Failed to list folders');
    }
    return data.files || [];
  },

  async createFolder(user, folderName, parentId = 'root') {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error?.message || 'Failed to create folder');
    }
    return data;
  },

  async scanGamesFolder(user) {
    if (!user.gamesFolderId) {
      throw new Error('No Games folder selected. Please select a Google Drive folder first.');
    }

    const accessToken = await GoogleAuth.getValidAccessToken(user);

    // 1. Find all folders under gamesFolderId (to check console-specific subfolders)
    const subfolderQuery = `'${user.gamesFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const folderRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(subfolderQuery)}&fields=files(id,name)&pageSize=100`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const folderData = await folderRes.json();
    const subfolders = folderData.files || [];

    // Map of folderId -> consoleHint
    const folderConsoleMap = new Map();
    for (const f of subfolders) {
      const lower = f.name.toLowerCase();
      if (lower.includes('snes') || lower.includes('super nintendo')) folderConsoleMap.set(f.id, 'snes');
      else if (lower.includes('gba') || lower.includes('advance')) folderConsoleMap.set(f.id, 'gba');
      else if (lower.includes('gbc') || lower.includes('color')) folderConsoleMap.set(f.id, 'gbc');
      else if (lower.includes('game boy') || lower === 'gb') folderConsoleMap.set(f.id, 'gb');
      else if (lower.includes('genesis') || lower.includes('sega') || lower.includes('mega drive')) folderConsoleMap.set(f.id, 'sega');
      else if (lower.includes('psx') || lower.includes('ps1') || lower.includes('playstation')) folderConsoleMap.set(f.id, 'psx');
      else if (lower.includes('n64') || lower.includes('nintendo 64')) folderConsoleMap.set(f.id, 'n64');
      else if (lower.includes('nes')) folderConsoleMap.set(f.id, 'nes');
      else if (lower.includes('nds') || lower.includes('ds')) folderConsoleMap.set(f.id, 'nds');
      else if (lower.includes('pico')) folderConsoleMap.set(f.id, 'pico8');
      else folderConsoleMap.set(f.id, null);
    }

    // 2. Query all files inside gamesFolderId and all subfolders
    const parentIds = [user.gamesFolderId, ...subfolders.map((f) => f.id)];
    const parentClause = parentIds.map((id) => `'${id}' in parents`).join(' or ');
    const fileQuery = `(${parentClause}) and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;

    let allFiles = [];
    let pageToken = null;

    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', fileQuery);
      url.searchParams.set('fields', 'nextPageToken, files(id, name, size, mimeType, modifiedTime, parents)');
      url.searchParams.set('pageSize', '250');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const data = await res.json();
      if (data.files) {
        allFiles.push(...data.files);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    // 3. Filter for supported game ROM files and build catalog
    const recognizedGames = [];

    for (const file of allFiles) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      let consoleKey = EXTENSION_CONSOLE_MAP[ext];

      // Check if file is inside a console subfolder
      if (file.parents && file.parents.length > 0) {
        for (const p of file.parents) {
          if (folderConsoleMap.has(p) && folderConsoleMap.get(p)) {
            consoleKey = folderConsoleMap.get(p);
            break;
          }
        }
      }

      if (!consoleKey) {
        // Skip files that are clearly not games (e.g. txt, nfo, srm save states, pdf)
        continue;
      }

      const cleanTitle = cleanGameTitle(file.name);
      const coverUrl = getBoxArtUrl(cleanTitle, consoleKey);
      const gameId = `gm_${file.id}`;

      recognizedGames.push({
        id: gameId,
        driveId: file.id,
        filename: file.name,
        title: cleanTitle,
        console: consoleKey,
        size: Number(file.size || 0),
        sizeFormatted: formatBytes(file.size),
        coverUrl,
        addedAt: file.modifiedTime ? new Date(file.modifiedTime).getTime() : Date.now()
      });
    }

    // Save into database
    Database.saveGames(user.id, recognizedGames);

    return {
      count: recognizedGames.length,
      games: recognizedGames
    };
  },

  async streamFile(user, fileId, req, res) {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    const fetchHeaders = {
      Authorization: `Bearer ${accessToken}`
    };

    if (req.headers.range) {
      fetchHeaders.Range = req.headers.range;
    }

    const driveRes = await fetch(driveUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: fetchHeaders
    });

    if (!driveRes.ok && driveRes.status !== 206) {
      throw new Error(`Google Drive stream error: HTTP ${driveRes.status}`);
    }

    // Forward range and content headers to client emulator
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const headersToForward = [
      'content-range',
      'content-length',
      'content-type',
      'last-modified',
      'etag'
    ];

    for (const h of headersToForward) {
      const val = driveRes.headers.get(h);
      if (val) {
        res.setHeader(h, val);
      }
    }

    res.status(driveRes.status);

    if (req.method === 'HEAD') {
      return res.end();
    }

    if (!driveRes.body) {
      return res.end();
    }

    const { Readable } = await import('stream');
    const nodeStream = Readable.fromWeb(driveRes.body);
    nodeStream.pipe(res);

    nodeStream.on('error', (err) => {
      console.warn('[Stream Pipe Error]:', err.message);
      if (!res.headersSent) res.status(500).end();
    });

    req.on('close', () => {
      nodeStream.destroy();
    });
  }
};
