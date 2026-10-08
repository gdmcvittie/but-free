// =============================================================================
// ITCH.IO INTEGRATION - ported from my-games-server (server.js)
// Store browsing (HTML scrape), account (API key), purchased library,
// upload listing & signed CDN URL resolution.
//
// No local disk writes: resolved file URLs are handed to the Downloader node
// which fetches them and uploads into the user's Google Drive.
// =============================================================================

export const ITCH_CONSOLE_TAGS = {
  all: 'tag-rom',
  pc: 'platform-windows',
  windows: 'platform-windows',
  web: 'platform-web',
  gb: 'tag-gameboy-rom',
  gbc: 'tag-gameboy-color',
  gba: 'tag-gameboy-advance',
  nes: 'tag-nes-rom',
  snes: 'tag-snes-rom',
  sega: 'tag-sega-genesis',
  genesis: 'tag-sega-genesis',
  pce: 'tag-turbografx',
  turbografx: 'tag-turbografx',
  tg16: 'tag-turbografx'
};

const ITCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function decodeHtmlEntitiesLite(str) {
  if (!str) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, '\u2013')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// -------------------------------------------------------------
// Store search results page parsing (game_cell blocks)
// -------------------------------------------------------------

export function parseItchGamesHtml(html, defaultConsole = 'gb') {
  const games = [];
  if (!html) return games;

  const cellSplits = html.split(/<div\s+[^>]*class="[^"]*\bgame_cell\b[^"]*"[^>]*>/i);

  for (let i = 1; i < cellSplits.length; i++) {
    const chunk = cellSplits[i];

    const idMatch = chunk.match(/data-game_id="(\d+)"/i) || (cellSplits[i - 1] && cellSplits[i - 1].match(/data-game_id="(\d+)"[^>]*$/i));
    const gameId = idMatch ? idMatch[1] : `game_${i}`;

    const titleMatch = chunk.match(/<a[^>]*class="[^"]*title game_link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
                       chunk.match(/<div[^>]*class="[^"]*game_title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const url = titleMatch ? titleMatch[1] : '';
    const rawTitle = titleMatch ? titleMatch[2].replace(/<[^>]+>/g, '').trim() : '';

    if (!url || !rawTitle) continue;

    const authorMatch = chunk.match(/<div[^>]*class="[^"]*game_author[^"]*"[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i) ||
                        chunk.match(/<div[^>]*class="[^"]*game_author[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const author = authorMatch ? (authorMatch[2] || authorMatch[1]).replace(/<[^>]+>/g, '').trim() : 'itch.io Creator';
    const authorUrl = authorMatch && authorMatch[1] && authorMatch[1].startsWith('http') ? authorMatch[1] : '';

    const textMatch = chunk.match(/<div[^>]*class="[^"]*game_text[^"]*"[^>]*title="([^"]*)"/i) ||
                      chunk.match(/<div[^>]*class="[^"]*game_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const description = textMatch ? (textMatch[1] || textMatch[2] || '').replace(/<[^>]+>/g, '').trim() : '';

    const genreMatch = chunk.match(/<div[^>]*class="[^"]*game_genre[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const genre = genreMatch ? genreMatch[1].replace(/<[^>]+>/g, '').trim() : (defaultConsole === 'web' ? 'Web Game' : 'Retro Game');

    let coverUrl = '';
    const lazyMatch = chunk.match(/data-lazy_src="([^"]+)"/i);
    const screenshotMatch = chunk.match(/data-screenshot_url="([^"]+)"/i);
    const originalMatch = chunk.match(/data-original="([^"]+)"/i);
    const srcMatch = chunk.match(/src="([^"]+)"/i);
    const bgMatch = chunk.match(/url\(['"]?(https?:\/\/[^'")]+)['"]?\)/i);
    if (lazyMatch && lazyMatch[1]) coverUrl = lazyMatch[1];
    else if (screenshotMatch && screenshotMatch[1]) coverUrl = screenshotMatch[1];
    else if (originalMatch && originalMatch[1]) coverUrl = originalMatch[1];
    else if (srcMatch && srcMatch[1] && !srcMatch[1].endsWith('.svg') && !srcMatch[1].startsWith('data:')) coverUrl = srcMatch[1];
    else if (bgMatch && bgMatch[1]) coverUrl = bgMatch[1];

    if (coverUrl) coverUrl = coverUrl.replace(/&amp;/g, '&').trim();

    let isPaid = false;
    let price = 'Free';
    const priceValMatch = chunk.match(/<div[^>]*class="[^"]*price_value[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const priceTagMatch = chunk.match(/<div[^>]*class="[^"]*price_tag[^"]*"[^>]*title="([^"]*)"/i) ||
                          chunk.match(/<a[^>]*class="[^"]*price_tag[^"]*"[^>]*title="([^"]*)"/i);

    if (priceValMatch) {
      const pText = priceValMatch[1].trim();
      if (pText && pText !== '$0' && !pText.toLowerCase().includes('free')) {
        isPaid = true;
        price = pText;
      }
    } else if (priceTagMatch) {
      const pTitle = priceTagMatch[1];
      if (pTitle && !pTitle.includes('$0') && pTitle.includes('$')) {
        const dollarMatch = pTitle.match(/\$[\d.]+/);
        if (dollarMatch) {
          isPaid = true;
          price = dollarMatch[0];
        }
      }
    }

    let detectedConsole = defaultConsole;
    const lowerTitle = rawTitle.toLowerCase();
    const lowerChunk = chunk.toLowerCase();

    if (lowerTitle.includes('game boy color') || lowerTitle.includes('gbc') || lowerChunk.includes('tag-gameboy-color') || lowerChunk.includes('gbc-rom')) detectedConsole = 'gbc';
    else if (lowerTitle.includes('game boy advance') || lowerTitle.includes('gba') || lowerChunk.includes('tag-gameboy-advance') || lowerChunk.includes('gba-rom')) detectedConsole = 'gba';
    else if (lowerTitle.includes('game boy') || lowerTitle.includes('gameboy') || lowerTitle.includes('gb studio') || lowerTitle.includes('gbstudio') || lowerTitle.includes('gb rom') || lowerChunk.includes('tag-gameboy-rom') || lowerChunk.includes('gb-rom')) detectedConsole = 'gb';
    else if (lowerTitle.includes('super nintendo') || lowerTitle.includes('snes') || lowerTitle.includes('super famicom') || lowerChunk.includes('tag-snes-rom')) detectedConsole = 'snes';
    else if (lowerTitle.includes('nes') || lowerTitle.includes('famicom') || lowerChunk.includes('tag-nes-rom')) detectedConsole = 'nes';
    else if (lowerTitle.includes('genesis') || lowerTitle.includes('megadrive') || lowerTitle.includes('mega drive') || lowerTitle.includes('sega') || lowerChunk.includes('tag-sega-genesis')) detectedConsole = 'sega';
    else if (lowerTitle.includes('pc engine') || lowerTitle.includes('turbografx') || lowerTitle.includes('tg16') || lowerTitle.includes('pce') || lowerChunk.includes('tag-turbografx')) detectedConsole = 'pce';
    else if (lowerTitle.includes('neo geo') || lowerTitle.includes('neogeo') || lowerChunk.includes('tag-neogeo') || lowerChunk.includes('tag-neo-geo')) detectedConsole = 'neo';
    else if (lowerTitle.includes('nintendo 64') || lowerTitle.includes('n64')) detectedConsole = 'n64';
    else if (lowerTitle.includes('nintendo ds') || lowerTitle.includes('nds')) detectedConsole = 'nds';

    const hasWebFlag = lowerChunk.includes('web_flag') ||
                       lowerChunk.includes('platform_web') ||
                       lowerChunk.includes('html5') ||
                       lowerChunk.includes('play in browser') ||
                       lowerChunk.includes('playable in browser') ||
                       defaultConsole === 'web';

    const hasDownloadFlag = lowerChunk.includes('icon-download') ||
                            lowerChunk.includes('downloadable') ||
                            lowerChunk.includes('download') ||
                            lowerChunk.includes('data-upload_id') ||
                            lowerChunk.includes('-rom') ||
                            SUPPORTED_ITCH_ROM_EXTS.test(lowerChunk);

    if (defaultConsole === 'web' || (!detectedConsole && hasWebFlag)) {
      if (!lowerTitle.includes('gb') && !lowerTitle.includes('nes') && !lowerTitle.includes('snes') && !lowerTitle.includes('gba') && !lowerTitle.includes('genesis')) {
        detectedConsole = 'web';
      }
    }

    const proxiedCover = coverUrl ? ('/api/proxy-image?url=' + encodeURIComponent(coverUrl)) : '';
    const isWebGame = detectedConsole === 'web' || hasWebFlag;

    games.push({
      id: gameId,
      title: rawTitle,
      author,
      authorUrl,
      url,
      webUrl: url,
      coverUrl: coverUrl || proxiedCover,
      rawCoverUrl: coverUrl,
      proxyCoverUrl: proxiedCover,
      description,
      genre,
      isPaid,
      price,
      console: detectedConsole,
      consoleName: detectedConsole === 'web' ? 'Web Games' : (detectedConsole === 'pc' ? 'PC Games' : detectedConsole.toUpperCase()),
      gameType: detectedConsole === 'web' ? 'web' : undefined,
      isWebGame,
      hasWebPlay: hasWebFlag,
      isWebPlayable: hasWebFlag,
      hasDownloadableRom: hasDownloadFlag || detectedConsole !== 'web'
    });
  }

  return games;
}

export const SUPPORTED_ITCH_ROM_EXTS = /\.(gb|gbc|gba|nes|sfc|smc|fig|gen|md|smd|pce|nds|cso|pbp|iso|cue|chd|n64|z64|neo|zip|7z|bin|exe|rar)$/i;

const ASSET_AND_NON_GAME_KEYWORDS = [
  'asset pack', 'assets pack', 'asset-pack', 'game asset', 'game assets',
  'tileset', 'tilemap', 'tile set', 'spritesheet', 'sprite pack', 'sprites',
  'soundtrack', 'sound pack', 'sfx pack', 'music pack', 'audio pack', 'sound effect', 'ost', 'vgm pack',
  '3d model', '3d models', 'low poly', 'blender', 'texture pack', 'textures',
  'unity pack', 'unreal pack', 'godot pack', 'godot plugin', 'engine plugin',
  'font pack', 'pixel font', 'gui pack', 'ui pack', 'ui kit',
  'artbook', 'art book', 'comic', 'zine', 'tabletop', 'ttrpg', 'rpg maker',
  'd&d', 'dnd', 'rulebook', 'source code', 'wallpaper'
];

export function isAssetOrNonGameProject(g) {
  if (!g) return true;
  if (g.classification && g.classification.toLowerCase() !== 'game') {
    return true;
  }
  const text = `${g.title || ''} ${g.short_text || ''} ${g.url || ''} ${g.description || ''}`.toLowerCase();
  for (const kw of ASSET_AND_NON_GAME_KEYWORDS) {
    if (text.includes(kw)) {
      const hasExplicitRomTag = text.includes('.gb') || text.includes('.gbc') || text.includes('.gba') || text.includes('.nes') || text.includes('.sfc') || text.includes('.smc') || text.includes('.md') || text.includes('.gen') || text.includes('.pce') || text.includes('.neo') || text.includes('playable rom') || text.includes('gb studio game') || text.includes('nes rom') || text.includes('html5');
      if (!hasExplicitRomTag) return true;
    }
  }
  return false;
}

export function detectConsoleFromTitleAndTags(title = '', shortText = '', url = '', traits = []) {
  const combined = `${title} ${shortText} ${url} ${Array.isArray(traits) ? traits.join(' ') : ''}`.toLowerCase();

  if (combined.includes('html5') || combined.includes('web game') || combined.includes('browser game') || combined.includes('webgl') || combined.includes('platform-web') || combined.includes('play in browser')) return 'web';
  if (combined.includes('game boy color') || combined.includes('gameboy color') || combined.includes('gbc rom') || combined.includes(' gbc') || combined.includes('[gbc]') || combined.includes('(gbc)')) return 'gbc';
  if (combined.includes('game boy advance') || combined.includes('gameboy advance') || combined.includes('gba rom') || combined.includes(' gba') || combined.includes('[gba]') || combined.includes('(gba)')) return 'gba';
  if (combined.includes('game boy') || combined.includes('gameboy') || combined.includes('gb studio') || combined.includes('gbstudio') || combined.includes('gb rom') || combined.includes('dmg-01') || combined.includes('dmg01') || combined.includes('game boy original') || combined.includes('for game boy') || combined.includes('for the game boy') || combined.includes('gb homebrew')) return 'gb';
  if (combined.includes('super nintendo') || combined.includes('super famicom') || combined.includes('snes') || combined.includes('super nes') || combined.includes('sfc rom')) return 'snes';
  if (combined.includes('nintendo entertainment system') || combined.includes('famicom') || combined.includes('nes rom') || combined.includes(' nes ') || combined.includes('[nes]') || combined.includes('(nes)') || combined.includes('nes homebrew')) return 'nes';
  if (combined.includes('genesis') || combined.includes('megadrive') || combined.includes('mega drive') || combined.includes('sega mega') || combined.includes('sega genesis') || combined.includes('sega cd') || combined.includes('sega 16-bit')) return 'sega';
  if (combined.includes('pc engine') || combined.includes('turbografx') || combined.includes('tg16') || combined.includes('pce') || combined.includes('turbo grafx')) return 'pce';
  if (combined.includes('neo geo') || combined.includes('neogeo') || combined.includes('snk neo') || combined.includes('neo-geo')) return 'neo';
  if (combined.includes('nintendo ds') || combined.includes('nds rom') || combined.includes(' nds ') || combined.includes('[nds]')) return 'nds';
  if (combined.includes('nintendo 64') || combined.includes('n64') || combined.includes('ultra 64')) return 'n64';
  if (combined.includes('playstation 1') || combined.includes('playstation one') || combined.includes('psx') || combined.includes('ps1') || combined.includes('psone')) return 'psx';
  if (combined.includes('game gear') || combined.includes('gamegear')) return 'gg';
  if (combined.includes('master system') || combined.includes('sega master system')) return 'sms';
  if (combined.includes('windows') || combined.includes('platform-windows') || combined.includes('p_windows') || combined.includes('pc game') || combined.includes('win32') || combined.includes('win64')) return 'pc';

  return null;
}

// -------------------------------------------------------------
// Store browsing
// -------------------------------------------------------------

export async function fetchItchStoreGames({ platform = 'all', query = '', sort = 'new-and-popular', page = 1 } = {}) {
  const plat = (platform || 'all').toLowerCase();
  let targetUrl = '';
  const consoleTag = ITCH_CONSOLE_TAGS[plat] || 'tag-gameboy-rom';
  const sortMap = { 'new-and-popular': 'new-and-popular', 'top-rated': 'top-rated', 'latest': 'newest', 'newest': 'newest', 'popular': 'popular' };
  const itchSort = sortMap[sort] || sort;

  if (plat === 'web') {
    if (query) {
      targetUrl = `https://itch.io/search?q=${encodeURIComponent(query)}&platform-web=1&page=${page}`;
    } else {
      targetUrl = itchSort === 'popular'
        ? `https://itch.io/games/platform-web?page=${page}`
        : `https://itch.io/games/${itchSort}/platform-web?page=${page}`;
    }
  } else if (plat === 'pc' || plat === 'windows') {
    if (query) {
      targetUrl = `https://itch.io/search?q=${encodeURIComponent(query)}&platform-windows=1&downloadable=&page=${page}`;
    } else {
      targetUrl = itchSort === 'popular'
        ? `https://itch.io/games/platform-windows?downloadable=&page=${page}`
        : `https://itch.io/games/${itchSort}/platform-windows?downloadable=&page=${page}`;
    }
  } else if (query) {
    targetUrl = `https://itch.io/search?q=${encodeURIComponent(query + (plat !== 'all' ? ' ' + plat : ' rom'))}&downloadable=&page=${page}`;
  } else {
    targetUrl = itchSort === 'popular'
      ? `https://itch.io/games/${consoleTag}?downloadable=&page=${page}`
      : `https://itch.io/games/${itchSort}/${consoleTag}?downloadable=&page=${page}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  const itchRes = await fetch(targetUrl, {
    signal: controller.signal,
    headers: {
      'User-Agent': ITCH_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    }
  });
  clearTimeout(timeout);

  if (!itchRes.ok) {
    throw new Error(`itch.io responded with HTTP ${itchRes.status}`);
  }

  const html = await itchRes.text();
  const defaultConsole = (plat === 'pc' || plat === 'windows') ? 'pc' : (plat === 'web' ? 'web' : (plat !== 'all' ? plat : 'gb'));
  const parsedGames = parseItchGamesHtml(html, defaultConsole);

  let games = parsedGames;
  if (plat === 'pc' || plat === 'windows') {
    games = parsedGames.filter(g => !isAssetOrNonGameProject(g)).map(g => ({
      ...g, console: 'pc', consoleName: 'PC Games', isWebGame: false
    }));
  } else if (plat === 'web') {
    games = parsedGames.map(g => {
      const isRetroConsole = g.console && g.console !== 'web' && g.console !== 'all';
      return {
        ...g,
        console: isRetroConsole ? g.console : 'web',
        consoleName: isRetroConsole ? g.console.toUpperCase() : 'Web Games',
        isWebGame: !isRetroConsole
      };
    });
  } else {
    games = parsedGames.filter(g => !isAssetOrNonGameProject(g));
  }

  return { platform: plat, sort, page, games };
}

// -------------------------------------------------------------
// Account & purchased library (itch.io API with bearer key)
// -------------------------------------------------------------

export async function itchApi(apiKey, pathSuffix, { signal } = {}) {
  const res = await fetch(`https://api.itch.io/${pathSuffix.replace(/^\//, '')}`, {
    signal,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'butfree-games/1.0'
    }
  });
  if (!res.ok) {
    const err = new Error(`itch.io API responded with HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function fetchItchProfile(apiKey) {
  const data = await itchApi(apiKey, 'profile', { signal: AbortSignal.timeout(8000) });
  const user = data.user || {};
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    coverUrl: user.cover_url || '',
    url: user.url || `https://${user.username}.itch.io`,
    gamer: user.gamer || false,
    developer: user.developer || false
  };
}

export async function fetchItchMyLibrary(apiKey, inLibraryCheck = null) {
  const libraryMap = new Map();
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 25) {
    let data;
    try {
      data = await itchApi(apiKey, `profile/owned-keys?page=${page}`, { signal: AbortSignal.timeout(12000) });
    } catch (err) {
      if (err.status === 401) {
        const e = new Error('itch.io API Key is invalid or expired.');
        e.status = 401;
        throw e;
      }
      break;
    }

    const ownedKeys = data.owned_keys || [];
    if (ownedKeys.length === 0) {
      hasMore = false;
      break;
    }

    for (const item of ownedKeys) {
      const g = item.game;
      if (!g) continue;
      if (isAssetOrNonGameProject(g)) continue;

      const detectedConsole = detectConsoleFromTitleAndTags(g.title, g.short_text, g.url, g.traits);
      if (!detectedConsole) continue;

      const gameId = String(g.id);
      const rawCover = g.cover_url || '';
      const lib = inLibraryCheck ? inLibraryCheck(g.title, gameId) : { inLibrary: false, game: null };

      libraryMap.set(gameId, {
        id: gameId,
        downloadKeyId: item.id,
        title: g.title || 'Untitled Game',
        url: g.url || '',
        coverUrl: rawCover,
        author: (g.user && (g.user.display_name || g.user.username)) || 'itch.io Creator',
        authorUrl: g.user && g.user.url ? g.user.url : '',
        description: g.short_text || '',
        publishedAt: g.published_at || g.created_at || null,
        purchasedAt: item.created_at || null,
        console: detectedConsole,
        inLibrary: lib.inLibrary,
        localGameId: lib.game ? lib.game.id : null,
        isOwned: true
      });
    }

    if (ownedKeys.length < 15 || (data.per_page && ownedKeys.length < data.per_page)) {
      hasMore = false;
    } else {
      page++;
    }
  }

  // Include created games (developer accounts)
  try {
    const myData = await itchApi(apiKey, 'profile/games', { signal: AbortSignal.timeout(9000) });
    for (const g of myData.games || []) {
      const gameId = String(g.id);
      if (libraryMap.has(gameId)) continue;
      if (isAssetOrNonGameProject(g)) continue;
      const detectedConsole = detectConsoleFromTitleAndTags(g.title, g.short_text, g.url, g.traits);
      if (!detectedConsole) continue;
      const lib = inLibraryCheck ? inLibraryCheck(g.title, gameId) : { inLibrary: false, game: null };

      libraryMap.set(gameId, {
        id: gameId,
        downloadKeyId: null,
        title: g.title || 'Untitled Game',
        url: g.url || '',
        coverUrl: g.cover_url || '',
        author: (g.user && (g.user.display_name || g.user.username)) || 'Me (Developer)',
        authorUrl: g.user && g.user.url ? g.user.url : '',
        description: g.short_text || '',
        publishedAt: g.published_at || g.created_at || null,
        purchasedAt: g.created_at || null,
        console: detectedConsole,
        inLibrary: lib.inLibrary,
        localGameId: lib.game ? lib.game.id : null,
        isDeveloper: true,
        isOwned: true
      });
    }
  } catch (_) {}

  return Array.from(libraryMap.values());
}

export const ITCH_DOWNLOADABLE_EXTS = new Set([
  '.gb', '.gbc', '.gba', '.nes', '.smc', '.sfc', '.fig', '.gen', '.md', '.smd',
  '.bin', '.pce', '.nds', '.cso', '.pbp', '.iso', '.cue', '.chd', '.n64', '.z64',
  '.neo', '.zip', '.7z', '.rar', '.exe', '.msi'
]);

export function listItchUploads(apiKey, gameId, downloadKeyId = null) {
  let suffix = `games/${gameId}/uploads`;
  if (downloadKeyId) suffix += `?download_key_id=${encodeURIComponent(downloadKeyId)}`;
  return itchApi(apiKey, suffix, { signal: AbortSignal.timeout(12000) });
}

export function pickBestItchUpload(uploads, consoleId = 'pc') {
  if (!uploads || uploads.length === 0) return null;

  const isPc = consoleId === 'pc' || consoleId === 'windows';

  if (isPc) {
    const scored = uploads.map(u => {
      let score = 0;
      const lowerName = (u.filename || u.display_name || '').toLowerCase();
      const ext = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.')) : '';

      const traits = (Array.isArray(u.traits) ? u.traits.join(' ') : (u.type || '')).toLowerCase();
      const hasWin = traits.includes('windows') || traits.includes('p_windows') ||
                     lowerName.includes('win') || lowerName.includes('windows') || ext === '.exe';
      const hasMacLinuxAndroid = lowerName.includes('mac') || lowerName.includes('osx') ||
                                 lowerName.includes('linux') || lowerName.includes('android') ||
                                 ['.dmg', '.deb', '.rpm', '.apk', '.pkg'].includes(ext) ||
                                 lowerName.endsWith('.tar.gz');

      if (hasWin && !hasMacLinuxAndroid) score += 200;
      if (ext === '.exe') score += 80;
      if (ext === '.zip') score += 50;
      if (ext === '.7z' || ext === '.rar') score += 40;
      if (hasMacLinuxAndroid) score -= 400;
      if (ext === '.pdf' || ext === '.txt' || lowerName.includes('soundtrack') || lowerName.includes('ost') || lowerName.includes('manual') || lowerName.includes('wallpaper')) {
        score -= 500;
      }
      return { upload: u, score };
    });

    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0 && scored[0].score > 0) return scored[0].upload;
    const fallback = scored.find(s => s.score > -200);
    if (fallback) return fallback.upload;
    return uploads[0];
  }

  const romUpload = uploads.find(u => {
    const ext = (u.filename || '').toLowerCase().slice((u.filename || '').lastIndexOf('.'));
    return ITCH_DOWNLOADABLE_EXTS.has(ext) && ext !== '.pdf' && ext !== '.txt';
  });
  return romUpload || uploads[0];
}

// -------------------------------------------------------------
// Resolve a signed CDN binary URL for an OWNED library item
// -------------------------------------------------------------

export async function resolveOwnedItchFileUrl({ apiKey, gameId, downloadKeyId = null, uploadId = null, consoleHint = '' }) {
  let targetUploadId = uploadId;
  let chosenFilename = '';

  if (!targetUploadId) {
    const uploadsData = await listItchUploads(apiKey, gameId, downloadKeyId);
    const uploadsList = uploadsData.uploads || [];
    if (uploadsList.length === 0) {
      throw new Error('No downloadable files found for this game.');
    }

    let selected = null;
    if (consoleHint === 'pc' || consoleHint === 'windows') {
      selected = uploadsList.find(u => {
        const fn = (u.filename || u.display_name || '').toLowerCase();
        const traits = (Array.isArray(u.traits) ? u.traits.join(' ') : (u.type || '')).toLowerCase();
        const isWin = fn.includes('win') || fn.includes('windows') || fn.endsWith('.exe') || traits.includes('windows') || traits.includes('p_windows');
        const isOther = fn.includes('mac') || fn.includes('osx') || fn.includes('linux') || fn.includes('android') || fn.endsWith('.dmg') || fn.endsWith('.deb') || fn.endsWith('.apk');
        return isWin && !isOther;
      });
    }

    if (!selected) {
      const lowerAll = (uploadsList[0] && uploadsList[0].filename ? '' : '');
      selected = uploadsList.find(u => {
        const fn = (u.filename || '').toLowerCase();
        const ext = fn.slice(fn.lastIndexOf('.'));
        return ITCH_DOWNLOADABLE_EXTS.has(ext);
      }) || uploadsList[0];
      void lowerAll;
    }

    targetUploadId = selected.id;
    chosenFilename = selected.filename || selected.display_name || '';
  }

  let dlUrl = `https://api.itch.io/uploads/${targetUploadId}/download`;
  if (downloadKeyId) dlUrl += `?download_key_id=${encodeURIComponent(downloadKeyId)}`;

  const dlRes = await fetch(dlUrl, {
    redirect: 'manual',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'butfree-games/1.0'
    }
  });

  let binaryUrl = '';
  if ([301, 302, 303, 307].includes(dlRes.status)) {
    binaryUrl = dlRes.headers.get('location') || '';
  } else if (dlRes.ok) {
    try {
      const dlData = await dlRes.json();
      if (dlData && dlData.url) binaryUrl = dlData.url;
    } catch (_) {}
  }

  if (!binaryUrl) {
    throw new Error(`Could not resolve download link from itch.io (HTTP ${dlRes.status})`);
  }

  return { fileUrl: binaryUrl, fileName: chosenFilename || `upload_${targetUploadId}`, uploadId: targetUploadId };
}

// -------------------------------------------------------------
// Free store item: scrape game page, pick best upload, resolve CDN URL.
// Ported from my-games-server /api/itch/download (URL resolution only).
// -------------------------------------------------------------

function extractItchUploadsFromHtml(html) {
  const uploads = [];
  if (!html) return uploads;
  const seenIds = new Set();

  const idRegex = /data-upload_id="(\d+)"/gi;
  let match;
  while ((match = idRegex.exec(html)) !== null) {
    const uploadId = match[1];
    if (seenIds.has(uploadId)) continue;
    seenIds.add(uploadId);

    const start = Math.max(0, match.index - 500);
    const end = Math.min(html.length, match.index + 1200);
    const snippet = html.slice(start, end);

    const nameMatch = snippet.match(/<strong[^>]*class="[^"]*name[^"]*"[^>]*title="([^"]*)"/i) ||
                      snippet.match(/<strong[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/strong>/i) ||
                      snippet.match(/data-file_name="([^"]+)"/i) ||
                      snippet.match(/class="[^"]*upload_name[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

    let fileName = nameMatch ? (nameMatch[1] || nameMatch[2] || '').replace(/<[^>]+>/g, '').trim() : '';
    if (!fileName) {
      const fnFallback = snippet.match(/([a-zA-Z0-9_\-\. ]+\.(?:zip|rar|7z|exe|msi|bin|rom|iso|apk|dmg))/i);
      if (fnFallback) fileName = fnFallback[1].trim();
    }
    if (!fileName) fileName = `file_${uploadId}`;

    const sizeMatch = snippet.match(/<span[^>]*class="[^"]*file_size[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const fileSize = sizeMatch ? sizeMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    uploads.push({ uploadId, fileName, fileSize, htmlSnippet: snippet });
  }

  const linkRegex = /href="[^"]*(?:\/file\/|\/download\/)(\d+)[^"]*"/gi;
  while ((match = linkRegex.exec(html)) !== null) {
    const uploadId = match[1];
    if (seenIds.has(uploadId)) continue;
    seenIds.add(uploadId);

    const start = Math.max(0, match.index - 400);
    const end = Math.min(html.length, match.index + 800);
    const snippet = html.slice(start, end);

    const nameMatch = snippet.match(/<strong[^>]*class="[^"]*name[^"]*"[^>]*title="([^"]*)"/i) ||
                      snippet.match(/<strong[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/strong>/i) ||
                      snippet.match(/([a-zA-Z0-9_\-\. ]+\.(?:zip|rar|7z|exe|msi|bin|rom|iso))/i);

    const fileName = nameMatch ? (nameMatch[1] || nameMatch[2] || '').replace(/<[^>]+>/g, '').trim() : `file_${uploadId}`;
    uploads.push({ uploadId, fileName, fileSize: '', htmlSnippet: snippet });
  }

  return uploads;
}

export async function resolveStoreItchFileUrl({ gameUrl, consoleId = 'gb' }) {
  if (!gameUrl) throw new Error('gameUrl is required');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  const pageRes = await fetch(gameUrl, {
    signal: controller.signal,
    headers: {
      'User-Agent': ITCH_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  clearTimeout(timeout);

  if (!pageRes.ok) {
    throw new Error(`Failed to load game page (HTTP ${pageRes.status})`);
  }

  const setCookies = pageRes.headers.get('set-cookie') || '';
  const html = await pageRes.text();
  let activeCookies = setCookies;

  const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/i) ||
                    html.match(/csrf_token:\s*"([^"]+)"/i) ||
                    html.match(/<meta[^>]*name="csrf_token"[^>]*content="([^"]*)"/i);
  let activeCsrf = csrfMatch ? csrfMatch[1] : '';

  const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                       html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i) ||
                       html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  let pageCoverUrl = ogImageMatch ? ogImageMatch[1].replace(/&amp;/g, '&').trim() : '';

  const genUrlMatch = html.match(/"generate_download_url":"([^"]+)"/i);
  let genUrl = genUrlMatch ? genUrlMatch[1].replace(/\\/g, '') : '';
  if (!genUrl) genUrl = gameUrl.replace(/\/$/, '') + '/download_url';

  let availableUploads = extractItchUploadsFromHtml(html);

  // If uploads are hidden behind the "name your price" modal, fetch the free checkout page
  if (availableUploads.length === 0) {
    try {
      const directRes = await fetch(genUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': ITCH_UA,
          'Cookie': activeCookies,
          'Referer': gameUrl
        },
        body: new URLSearchParams({ csrf_token: activeCsrf })
      });
      if (directRes.ok) {
        const directJson = await directRes.json();
        if (directJson.url) {
          const landingRes = await fetch(directJson.url, {
            headers: { 'User-Agent': ITCH_UA, 'Cookie': activeCookies, 'Referer': gameUrl }
          });
          if (landingRes.ok) {
            const landingHtml = await landingRes.text();
            activeCookies = landingRes.headers.get('set-cookie') || activeCookies;
            const csrf2 = landingHtml.match(/name="csrf_token"\s+value="([^"]+)"/i) || landingHtml.match(/csrf_token:\s*"([^"]+)"/i);
            if (csrf2 && csrf2[1]) activeCsrf = csrf2[1];

            for (const u of extractItchUploadsFromHtml(landingHtml)) {
              if (!availableUploads.some(e => e.uploadId === u.uploadId)) availableUploads.push(u);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[itch.io] Direct download bypass warning:', e.message);
    }
  }

  if (availableUploads.length === 0) {
    const dlLinkMatch = html.match(/href="([^"]*(?:\/download\/|\/purchase)[^"]*)"/i);
    if (dlLinkMatch) {
      let dlPageUrl = dlLinkMatch[1];
      if (dlPageUrl.startsWith('/')) {
        try {
          dlPageUrl = new URL(gameUrl).origin + dlPageUrl;
        } catch (_) {}
      }
      try {
        const dlPageRes = await fetch(dlPageUrl, {
          headers: { 'User-Agent': ITCH_UA, 'Cookie': activeCookies, 'Referer': gameUrl }
        });
        if (dlPageRes.ok) {
          for (const u of extractItchUploadsFromHtml(await dlPageRes.text())) {
            if (!availableUploads.some(e => e.uploadId === u.uploadId)) availableUploads.push(u);
          }
        }
      } catch (_) {}
    }
  }

  const chosenUpload = availableUploads.length > 0 ? pickBestItchUpload(availableUploads, consoleId) : null;
  if (!chosenUpload) {
    return { success: false, isPaid: true, purchaseUrl: gameUrl, message: 'No free downloadable file found for this game (it may require purchase).' };
  }

  let cleanOriginPath = gameUrl.replace(/\/$/, '');
  try {
    const parsedTarget = new URL(gameUrl);
    cleanOriginPath = `${parsedTarget.origin}${parsedTarget.pathname.replace(/\/download\b.*$/i, '').replace(/\/$/, '')}`;
  } catch (_) {}

  const fileUrl = `${cleanOriginPath}/file/${chosenUpload.uploadId}`;
  let cdnDownloadUrl = '';

  // 1. POST /file/:upload_id for the signed redirect
  try {
    const filePostRes = await fetch(fileUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': ITCH_UA,
        'Cookie': activeCookies,
        'Referer': gameUrl
      },
      body: new URLSearchParams({ csrf_token: activeCsrf, source: 'game_download' })
    });

    if ([301, 302, 303, 307].includes(filePostRes.status)) {
      cdnDownloadUrl = filePostRes.headers.get('location') || '';
    } else if (filePostRes.ok) {
      const cType = filePostRes.headers.get('content-type') || '';
      if (cType.includes('application/json')) {
        const fileData = await filePostRes.json();
        if (fileData && fileData.url) cdnDownloadUrl = fileData.url;
      }
    }
  } catch (_) {}

  // 2. Fallback: generate_download_url endpoint
  if (!cdnDownloadUrl) {
    try {
      const dlPostRes = await fetch(genUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': ITCH_UA,
          'Cookie': activeCookies
        },
        body: new URLSearchParams({ upload_id: chosenUpload.uploadId, csrf_token: activeCsrf })
      });
      if (dlPostRes.ok) {
        const dlJson = await dlPostRes.json();
        if (dlJson && dlJson.url && !dlJson.url.includes('/download/')) {
          cdnDownloadUrl = dlJson.url;
        }
      }
    } catch (_) {}
  }

  // 3. Fallback: GET with manual redirect
  if (!cdnDownloadUrl) {
    try {
      const getRes = await fetch(fileUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': ITCH_UA, 'Cookie': activeCookies, 'Referer': gameUrl }
      });
      if ([301, 302, 303, 307].includes(getRes.status)) {
        cdnDownloadUrl = getRes.headers.get('location') || '';
      }
    } catch (_) {}
  }

  if (!cdnDownloadUrl) {
    return { success: false, isPaid: true, purchaseUrl: gameUrl, message: 'Could not resolve binary download URL for this item.' };
  }

  return {
    success: true,
    fileUrl: cdnDownloadUrl,
    fileName: chosenUpload.fileName,
    coverUrl: pageCoverUrl || null,
    upload: chosenUpload
  };
}
