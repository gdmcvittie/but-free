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
  // PC / archive parts (only classified as pc unless a console folder hint wins)
  exe: 'pc',
  msi: 'pc',
  '7z': 'pc',
  rar: 'pc',
  zip: 'snes', // legacy fallback or detected from subfolder
  bin: 'sega' // detected from folder context for PC installers
};

// Folder-name variants -> console key (used for subfolder hints at any depth)
const FOLDER_CONSOLE_HINTS = [
  { names: ['snes', 'super nintendo', 'super famicom'], console: 'snes' },
  { names: ['nes', 'famicom'], console: 'nes' },
  { names: ['gba', 'game boy advance', 'gameboy advance'], console: 'gba' },
  { names: ['gbc', 'game boy color', 'gameboy color'], console: 'gbc' },
  { names: ['gb', 'game boy', 'gameboy', 'game gear boy'], console: 'gb' },
  { names: ['genesis', 'sega', 'mega drive', 'megadrive'], console: 'sega' },
  { names: ['psx', 'ps1', 'playstation'], console: 'psx' },
  { names: ['n64', 'nintendo 64'], console: 'n64' },
  { names: ['nds', 'ds'], console: 'nds' },
  { names: ['pce', 'pc engine', 'turbografx', 'tg16'], console: 'pce' },
  { names: ['gg', 'game gear'], console: 'gg' },
  { names: ['sms', 'master system'], console: 'sms' },
  { names: ['neo', 'neogeo', 'neo geo'], console: 'neo' },
  { names: ['pico8', 'pico-8', 'pico'], console: 'pico8' },
  { names: ['pc', 'pc games', 'gog', 'gog.com', 'epic', 'itch', 'itch.io'], console: 'pc' }
];

// File extensions that mark a Drive folder as a PC game installation
const PC_FILE_EXTS = new Set(['exe', 'msi', '7z', 'rar', 'zip', 'bin', 'iso', 'img', '001', 'dat']);

const IGNORED_FILE_EXTS = new Set(['txt', 'nfo', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'html', 'pdf', 'url', 'srm', 'cfg', 'ini', 'md5', 'sha1', 'sfv', 'doc', 'docx', 'log']);

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

    const driveQueryFiles = async (queryString, extraFields = 'id,name,size,mimeType,modifiedTime,parents') => {
      const results = [];
      let pageToken = null;
      do {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.set('q', queryString);
        url.searchParams.set('fields', `nextPageToken, files(${extraFields})`);
        url.searchParams.set('pageSize', '250');
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (data.files) results.push(...data.files);
        pageToken = data.nextPageToken;
      } while (pageToken);
      return results;
    };

    const folderHint = (name) => {
      const lower = (name || '').toLowerCase().trim();
      for (const entry of FOLDER_CONSOLE_HINTS) {
        if (entry.names.includes(lower)) return entry.console;
      }
      if (lower.includes('snes') || lower.includes('super nintendo')) return 'snes';
      if (lower.includes('gba') || lower.includes('game boy advance')) return 'gba';
      if (lower.includes('gbc') || lower.includes('game boy color')) return 'gbc';
      if (lower.includes('game boy') || lower === 'gb') return 'gb';
      if (lower.includes('genesis') || lower.includes('sega') || lower.includes('mega drive')) return 'sega';
      if (lower.includes('psx') || lower.includes('ps1') || lower.includes('playstation')) return 'psx';
      if (lower.includes('n64') || lower.includes('nintendo 64')) return 'n64';
      if (lower.includes('nes')) return 'nes';
      if (lower.includes('nds')) return 'nds';
      if (lower.includes('pico')) return 'pico8';
      if (lower === 'pc games' || lower === 'pc' || lower.includes('gog') || lower.includes('itch')) return 'pc';
      return null;
    };

    // 1. Enumerate the folder tree (Games root -> level 1 -> level 2)
    const level1Folders = await driveQueryFiles(
      `'${user.gamesFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      'id,name'
    );

    const folderInfo = new Map(); // folderId -> { name, parentId, hint }
    folderInfo.set(user.gamesFolderId, { name: user.gamesFolderName || 'Games', parentId: null, hint: null });

    for (const f of level1Folders) {
      folderInfo.set(f.id, { name: f.name, parentId: user.gamesFolderId, hint: folderHint(f.name) });
    }

    if (level1Folders.length > 0) {
      const l1Ids = level1Folders.map(f => f.id);
      const parentClause = l1Ids.map(id => `'${id}' in parents`).join(' or ');
      const level2Folders = await driveQueryFiles(
        `(${parentClause}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        'id,name,parents'
      );
      for (const f of level2Folders) {
        const parentId = f.parents && f.parents.length ? f.parents[0] : null;
        folderInfo.set(f.id, { name: f.name, parentId, hint: folderHint(f.name) });
      }
    }

    // 2. Query all files under root + any folder (2 levels deep)
    const allFolderIds = Array.from(folderInfo.keys()).filter(id => id !== user.gamesFolderId);
    const searchableParents = [user.gamesFolderId, ...allFolderIds];
    const fileClauses = [];
    let allFiles = [];
    for (let i = 0; i < searchableParents.length; i += 20) {
      const batch = searchableParents.slice(i, i + 20);
      fileClauses.push(`(${batch.map(id => `'${id}' in parents`).join(' or ')})`);
    }
    for (const clause of fileClauses) {
      const files = await driveQueryFiles(
        `(${clause}) and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
      );
      allFiles.push(...files);
    }

    // 3. Infer console for each file by walking the folder chain upward
    const resolveChainHint = (folderId) => {
      let current = folderId;
      const visited = new Set();
      while (current && !visited.has(current)) {
        visited.add(current);
        const info = folderInfo.get(current);
        if (!info) break;
        if (info.hint) return { hint: info.hint, hintFolderId: current };
        current = info.parentId;
      }
      return { hint: null, hintFolderId: null };
    };

    const recognizedGames = [];
    const pcGroups = new Map(); // gameFolderId -> { files: [] }

    for (const file of allFiles) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const parentId = file.parents && file.parents.length ? file.parents[0] : user.gamesFolderId;
      const { hint } = resolveChainHint(parentId);

      if (IGNORED_FILE_EXTS.has(ext)) continue;

      let consoleKey = hint || EXTENSION_CONSOLE_MAP[ext] || null;
      if (!consoleKey) continue;

      // Legacy split-volume suffixes outside of PC groups are noise (the main
      // .rar/.zip in the same folder is the game entry).
      if (consoleKey !== 'pc' && (/\.r\d{2}$/i.test(file.name) || /\.z\d{2}$/i.test(file.name) || /\.\d{3}$/.test(file.name))) {
        continue;
      }

      if (consoleKey === 'pc') {
        // Group all PC parts by their immediate game folder
        const gameFolderId = folderInfo.has(parentId) ? parentId : null;
        if (gameFolderId) {
          if (!pcGroups.has(gameFolderId)) pcGroups.set(gameFolderId, { files: [] });
          pcGroups.get(gameFolderId).files.push(file);
        } else {
          recognizedGames.push({
            id: `gm_${file.id}`,
            driveId: file.id,
            source: 'drive',
            filename: file.name,
            title: cleanGameTitle(file.name),
            console: 'pc',
            isPcGame: true,
            size: Number(file.size || 0),
            sizeFormatted: formatBytes(file.size),
            coverUrl: null,
            addedAt: file.modifiedTime ? new Date(file.modifiedTime).getTime() : Date.now()
          });
        }
        continue;
      }

      const cleanTitle = cleanGameTitle(file.name);
      const coverUrl = getBoxArtUrl(cleanTitle, consoleKey);

      recognizedGames.push({
        id: `gm_${file.id}`,
        driveId: file.id,
        source: 'drive',
        filename: file.name,
        title: cleanTitle,
        console: consoleKey,
        size: Number(file.size || 0),
        sizeFormatted: formatBytes(file.size),
        coverUrl,
        addedAt: file.modifiedTime ? new Date(file.modifiedTime).getTime() : Date.now()
      });
    }

    // 4. Collapse PC game folders into single library entries
    for (const [gameFolderId, group] of pcGroups.entries()) {
      const info = folderInfo.get(gameFolderId);
      const folderName = (info && info.name) || 'PC Game';

      // A folder that literally is a container ("PC Games", "itch.io", ...)
      // keeps its files as individual game entries instead of grouping.
      const isContainerName = /^(pc games|pc|gog|gog\.com|epic|epic games|itch|itch\.io|retro games)$/i.test(folderName.trim());

      const mainFile = [...group.files].sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];

      if (isContainerName) {
        for (const file of group.files) {
          recognizedGames.push({
            id: `gm_${file.id}`,
            driveId: file.id,
            source: 'drive',
            filename: file.name,
            title: cleanGameTitle(file.name),
            console: 'pc',
            isPcGame: true,
            size: Number(file.size || 0),
            sizeFormatted: formatBytes(file.size),
            coverUrl: null,
            addedAt: file.modifiedTime ? new Date(file.modifiedTime).getTime() : Date.now()
          });
        }
        continue;
      }

      const totalSize = group.files.reduce((sum, f) => sum + Number(f.size || 0), 0);
      const title = cleanGameTitle(folderName.replace(/\.(rar|zip|7z)$/i, ''));

      recognizedGames.push({
        id: `gmpc_${gameFolderId}`,
        driveId: gameFolderId,
        driveFileId: mainFile ? mainFile.id : null,
        isFolder: true,
        source: 'drive',
        filename: folderName,
        title,
        console: 'pc',
        isPcGame: true,
        size: totalSize,
        sizeFormatted: formatBytes(totalSize),
        fileCount: group.files.length,
        files: group.files.map(f => ({ name: f.name, driveId: f.id, size: Number(f.size || 0) })),
        coverUrl: null,
        addedAt: mainFile && mainFile.modifiedTime ? new Date(mainFile.modifiedTime).getTime() : Date.now()
      });
    }

    // Save into database (drive-sourced records only; bookmarks survive)
    Database.saveGames(user.id, recognizedGames, 'drive');

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
