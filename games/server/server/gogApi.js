// =============================================================================
// GOG.COM INTEGRATION - ported from my-games-server (stream/gog-routes.js)
// Account connect (OAuth code paste flow), purchased library, store catalog
// (new releases / deals) and offline installer downlink resolution.
//
// Auth is stored PER USER (user.integrations.gog) instead of the single-user
// config.json, and downloads resolve to a final CDN URL which is handed to
// the Downloader node for the actual fetch + Google Drive upload.
// =============================================================================

const GOG_CLIENT_ID = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

export const GOG_LOGIN_URL = `https://login.gog.com/auth?client_id=${GOG_CLIENT_ID}&layout=galaxy&redirect_uri=${encodeURIComponent(GOG_REDIRECT_URI)}&response_type=code`;

const GOG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export function formatGogImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let url = rawUrl.trim();
  if (!url) return '';

  url = url.replace(/\\\/+/g, '/');

  if (url.startsWith('//')) {
    url = 'https:' + url;
  } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url.replace(/^\/+/, '');
  }

  const hasExt = /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(url);
  if (!hasExt) {
    const qIdx = url.indexOf('?');
    if (qIdx !== -1) {
      url = url.substring(0, qIdx) + '.jpg' + url.substring(qIdx);
    } else {
      url = url + '.jpg';
    }
  }

  return url;
}

// gogAuth: { accessToken, refreshToken, expiresAt, userId, username, avatar }
export async function ensureGogToken(gogAuth, onTokenRenewed) {
  if (!gogAuth || !gogAuth.refreshToken) return null;

  const now = Math.floor(Date.now() / 1000);
  if (gogAuth.accessToken && gogAuth.expiresAt > (now + 180)) {
    return gogAuth.accessToken;
  }

  try {
    const params = new URLSearchParams({
      client_id: GOG_CLIENT_ID,
      client_secret: GOG_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: gogAuth.refreshToken
    });

    const res = await fetch(`https://auth.gog.com/token?${params.toString()}`, {
      headers: { 'User-Agent': 'butfree-games/1.0' }
    });

    if (!res.ok) {
      console.warn(`[GOG] Failed to refresh token (HTTP ${res.status})`);
      return null;
    }

    const tokenData = await res.json();
    const renewed = {
      ...gogAuth,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || gogAuth.refreshToken,
      expiresAt: now + (tokenData.expires_in || 3600)
    };
    if (typeof onTokenRenewed === 'function') {
      await onTokenRenewed(renewed);
    }
    console.log('[GOG] Token refreshed successfully');
    return renewed.accessToken;
  } catch (err) {
    console.error('[GOG] Error refreshing token:', err.message);
    return null;
  }
}

export async function connectGogAccount(codeInput) {
  if (!codeInput || typeof codeInput !== 'string') {
    throw new Error('Authorization code or URL is required');
  }

  let cleanCode = codeInput.trim();
  if (cleanCode.includes('code=')) {
    const match = cleanCode.match(/[?&]code=([^&#\s]+)/);
    if (match) cleanCode = match[1];
  }

  if (!cleanCode) {
    throw new Error('Could not extract authorization code from input');
  }

  const params = new URLSearchParams({
    client_id: GOG_CLIENT_ID,
    client_secret: GOG_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: cleanCode,
    redirect_uri: GOG_REDIRECT_URI
  });

  const tokenRes = await fetch(`https://auth.gog.com/token?${params.toString()}`, {
    headers: { 'User-Agent': 'butfree-games/1.0' }
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error(`[GOG] Token exchange failed (HTTP ${tokenRes.status}):`, errText);
    throw new Error(`GOG authorization failed (HTTP ${tokenRes.status}). Codes expire within 60 seconds; please try logging in again.`);
  }

  const tokenData = await tokenRes.json();
  const now = Math.floor(Date.now() / 1000);
  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;
  const userId = tokenData.user_id || '';

  let username = 'GOG Gamer';
  let avatar = '';

  try {
    const userRes = await fetch('https://embed.gog.com/userData.json', {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': GOG_UA }
    });
    if (userRes.ok) {
      const userData = await userRes.json();
      if (userData && userData.username) username = userData.username;
      if (userData && userData.avatar) avatar = formatGogImageUrl(userData.avatar);
    }
  } catch (userErr) {
    console.warn('[GOG] Note: could not fetch profile metadata:', userErr.message);
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: now + (tokenData.expires_in || 3600),
    userId,
    username,
    avatar
  };
}

// -------------------------------------------------------------
// Purchased library
// -------------------------------------------------------------

export async function fetchGogLibrary(token) {
  const allGames = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= 20) {
    const libRes = await fetch(`https://embed.gog.com/account/getFilteredProducts?mediaType=1&page=${page}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': GOG_UA }
    });

    if (!libRes.ok) {
      throw new Error(`Failed to fetch GOG library (HTTP ${libRes.status})`);
    }

    const data = await libRes.json();
    totalPages = data.totalPages || 1;

    for (const p of data.products || []) {
      allGames.push({
        id: p.id,
        title: p.title,
        slug: p.slug,
        url: p.url ? `https://www.gog.com${p.url}` : '',
        coverUrl: formatGogImageUrl(p.image || ''),
        category: p.category || 'PC Game',
        rating: p.rating ? (p.rating / 10).toFixed(1) : null,
        worksOn: p.worksOn || { Windows: true },
        isWindowsSupported: Boolean(p.worksOn && p.worksOn.Windows),
        isDlc: checkIfDlc(p)
      });
    }
    page++;
  }

  return allGames;
}

// -------------------------------------------------------------
// Store catalog (new releases & deals) - public, no auth needed
// -------------------------------------------------------------

export async function fetchGogCatalog({ tab = 'new', page = 1, search = '' } = {}) {
  let products = [];
  let totalPages = 1;

  try {
    let catalogUrl = `https://catalog.gog.com/v1/catalog?limit=48&page=${page}&productType=in:game&locale=en-US&countryCode=US&currencyCode=USD`;
    if (tab === 'sales') {
      catalogUrl += '&order=desc:trending&discounted=eq:true';
    } else {
      catalogUrl += '&order=desc:storeReleaseDate&releaseStatuses=in:new-arrival';
    }
    if (search) {
      catalogUrl += `&query=like:${encodeURIComponent(search)}`;
    }

    const catRes = await fetch(catalogUrl, {
      headers: { 'User-Agent': GOG_UA },
      signal: AbortSignal.timeout(8000)
    });

    if (catRes.ok) {
      const catData = await catRes.json();
      if (catData && Array.isArray(catData.products) && catData.products.length > 0) {
        totalPages = catData.pages || 1;
        products = catData.products.map(p => {
          const coverRaw = p.coverVertical || p.image || p.coverHorizontal || '';
          let priceStr = '';
          let discountStr = '';
          if (p.price) {
            if (p.price.isFree) {
              priceStr = 'Free';
            } else if (p.price.finalMoney) {
              priceStr = `$${p.price.finalMoney.amount}`;
            } else if (p.price.final) {
              priceStr = p.price.final;
            }
            if (p.price.discount) {
              discountStr = `-${p.price.discount}%`;
            }
          }

          const category = Array.isArray(p.genres)
            ? p.genres.map(g => (typeof g === 'string' ? g : g.name || '')).filter(Boolean).join(', ')
            : (p.category || 'PC Game');

          return {
            id: p.id,
            title: p.title,
            slug: p.slug,
            url: p.slug ? `https://www.gog.com/en/game/${p.slug}` : (p.url ? `https://www.gog.com${p.url}` : ''),
            coverUrl: formatGogImageUrl(coverRaw),
            category: category || 'PC Game',
            price: priceStr,
            discount: discountStr,
            rating: p.reviewsRating ? (p.reviewsRating / 10).toFixed(1) : null,
            isDlc: checkIfDlc(p)
          };
        });
      }
    }
  } catch (catErr) {
    console.warn('[GOG] catalog.gog.com query failed, falling back to ajax:', catErr.message);
  }

  if (products.length === 0) {
    let ajaxUrl = `https://embed.gog.com/games/ajax/filtered?mediaType=game&page=${page}`;
    if (tab === 'sales') {
      ajaxUrl += '&price=discounted&sort=bestselling';
    } else {
      ajaxUrl += '&sort=date';
    }
    if (search) {
      ajaxUrl += `&search=${encodeURIComponent(search)}`;
    }

    try {
      const ajaxRes = await fetch(ajaxUrl, {
        headers: { 'User-Agent': GOG_UA },
        signal: AbortSignal.timeout(8000)
      });

      if (ajaxRes.ok) {
        const ajaxData = await ajaxRes.json();
        totalPages = ajaxData.totalPages || 1;

        products = (ajaxData.products || []).map(p => {
          let priceStr = '';
          let discountStr = '';
          if (p.price) {
            if (p.price.isFree || p.price.amount === '0.00' || p.price.amount === 0) {
              priceStr = 'Free';
            } else if (p.price.amount) {
              priceStr = `$${p.price.amount}`;
            }
            if (p.price.isDiscounted && p.price.discountPercentage) {
              discountStr = `-${p.price.discountPercentage}%`;
            }
          }

          return {
            id: p.id,
            title: p.title,
            slug: p.slug,
            url: p.url ? `https://www.gog.com${p.url}` : (p.slug ? `https://www.gog.com/en/game/${p.slug}` : ''),
            coverUrl: formatGogImageUrl(p.image || ''),
            category: p.category || 'PC Game',
            price: priceStr,
            discount: discountStr,
            rating: p.rating ? (p.rating / 10).toFixed(1) : null,
            isDlc: checkIfDlc(p)
          };
        });
      }
    } catch (ajaxErr) {
      console.warn('[GOG] ajax catalog fallback failed:', ajaxErr.message);
    }
  }

  return { tab, page, totalPages, products };
}

// -------------------------------------------------------------
// Game details: offline installer downlinks (requires auth token)
// -------------------------------------------------------------

export async function fetchGogGameDetails(token, gameId) {
  const detailsRes = await fetch(`https://embed.gog.com/account/gameDetails/${gameId}.json`, {
    headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': GOG_UA }
  });

  if (!detailsRes.ok) {
    throw new Error(`Failed to fetch game details (HTTP ${detailsRes.status}). Is this game in your GOG library?`);
  }

  const data = await detailsRes.json();
  const rawDownloads = data.downloads || [];
  const installers = [];

  if (Array.isArray(rawDownloads)) {
    for (const item of rawDownloads) {
      if (!item) continue;
      let language = 'English';
      let platforms = {};
      if (Array.isArray(item)) {
        language = item[0] || 'English';
        platforms = item[1] || {};
      } else if (typeof item === 'object') {
        language = item.language || 'English';
        platforms = item.platforms || item;
      }

      const winFiles = platforms.windows || platforms.win || platforms.installers || [];
      const filesArray = Array.isArray(winFiles) ? winFiles : [winFiles];

      for (const f of filesArray) {
        if (!f) continue;
        const rawDownlink = f.manualUrl || f.downlink || f.downloaderUrl || f.url || f.href || '';
        let resolvedDownlink = rawDownlink;
        if (resolvedDownlink && resolvedDownlink.startsWith('/')) {
          resolvedDownlink = `https://embed.gog.com${resolvedDownlink}`;
        }
        let installerFileName = (f.name || data.title || 'setup.exe').replace(/[\\/:*?"<>|]/g, '').trim();
        if (!/\.(exe|bin|zip|rar|7z|msi)$/i.test(installerFileName)) {
          installerFileName = installerFileName.replace(/\.\d+$/, '');
          if (/\bpart\s*[2-9]|\.bin\b/i.test(installerFileName)) {
            installerFileName += '.bin';
          } else {
            installerFileName += '.exe';
          }
        }

        installers.push({
          name: f.name || data.title,
          fileName: installerFileName,
          size: f.size || '',
          version: f.version || '',
          downlink: resolvedDownlink,
          language,
          os: 'windows'
        });
      }
    }
  }

  return {
    gameId,
    title: data.title,
    backgroundImage: formatGogImageUrl(data.backgroundImage || data.bg || ''),
    installers
  };
}

// -------------------------------------------------------------
// Resolve a downlink to the final public CDN URL (auth-scoped
// embed.gog.com URL -> redirect chain -> signed CDN link).
// The Downloader node can then fetch the CDN URL without auth.
// -------------------------------------------------------------

export async function resolveGogDownloadUrl(token, downlink) {
  if (!token) throw new Error('GOG account not connected');
  let finalDownlink = String(downlink || '').trim();
  if (!finalDownlink) throw new Error('Missing GOG downlink URL');
  if (finalDownlink.startsWith('/')) {
    finalDownlink = `https://embed.gog.com${finalDownlink}`;
  }

  let currentUrl = finalDownlink;
  let cdnUrl = '';

  for (let hop = 0; hop < 6; hop++) {
    const dlRes = await fetch(currentUrl, {
      redirect: 'manual',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': GOG_UA
      }
    });

    if (dlRes.status >= 300 && dlRes.status < 400) {
      const loc = dlRes.headers.get('location');
      if (!loc) break;
      currentUrl = loc.startsWith('/') ? new URL(loc, currentUrl).href : loc;
      cdnUrl = currentUrl;
    } else if (dlRes.ok) {
      const contentType = dlRes.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await dlRes.json();
        cdnUrl = json.downlink || json.url || json.manualUrl || currentUrl;
      } else {
        cdnUrl = currentUrl;
      }
      break;
    } else {
      throw new Error(`Failed to resolve download URL (HTTP ${dlRes.status})`);
    }
  }

  if (!cdnUrl) {
    throw new Error('Could not resolve GOG download link');
  }
  return cdnUrl;
}

// -------------------------------------------------------------
// DLC heuristics (ported)
// -------------------------------------------------------------

export function checkIfDlc(p) {
  if (!p) return false;
  if (p.isDlc === true || p.is_dlc === true) return true;
  if (p.productType && String(p.productType).toLowerCase() === 'dlc') return true;
  if (p.type && String(p.type).toLowerCase() === 'dlc') return true;
  if (p.category && String(p.category).toLowerCase().includes('dlc')) return true;
  if (Array.isArray(p.tags) && p.tags.some(t => String(t).toLowerCase() === 'dlc')) return true;

  const title = (p.title || '').toLowerCase();
  if (/\b(dlc|season pass|expansion pass|soundtrack|ost|artbook|art book|wallpaper pack|goodies pack|upgrade pack|add-on|addon)\b/i.test(title)) {
    return true;
  }
  if (/(\s-\s|:\s|\(|\/)(dlc|expansion|expansion pack|add-on)(\s|\)|\/|$)/i.test(title)) {
    return true;
  }
  return false;
}
