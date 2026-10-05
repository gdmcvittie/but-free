import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  api,
  getServerUrl,
  getTorrentServerUrl,
  getToken,
  setToken,
  setStoredUser,
  getStoredUser,
  clearAuth,
  isLoggedIn
} from './api.js';

export default function App() {
  // ---- Auth State ----
  const [authToken, setAuthToken] = useState(getToken());
  const [authUserName, setAuthUserName] = useState(getStoredUser()?.name || '');
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());

  // ---- Navigation Stack & State ----
  const [navStack, setNavStack] = useState([]);
  const [breadcrumb, setBreadcrumb] = useState('Home');
  const [gridItems, setGridItems] = useState([]);
  const [freshItems, setFreshItems] = useState([]);
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [freshFocusedIdx, setFreshFocusedIdx] = useState(0);
  const [sidebarIdx, setSidebarIdx] = useState(0);
  const [activeSidebar, setActiveSidebar] = useState(0);
  const [focusTarget, setFocusTarget] = useState('fresh'); // 'grid' | 'fresh' | 'ip' | 'sidebar' | 'pairing' | 'dialog' | 'player'
  const [numColumns, setNumColumns] = useState(6);

  // ---- Pairing ----
  const [showPairing, setShowPairing] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingStatusText, setPairingStatusText] = useState('');
  const pairingPollTimerRef = useRef(null);
  const pairingPollCountRef = useRef(0);

  // ---- Modal Dialog, Notification & Player ----
  const [dialog, setDialog] = useState(null); // { title, message, buttons, buttonIdx, onSelect }
  const [notification, setNotification] = useState(null); // { title, msg }
  const [player, setPlayer] = useState(null); // { url, title, offset, isLive }
  const [isLiveChannel, setIsLiveChannel] = useState(false);

  // ---- Drive Library (Google Drive content) ----
  const [driveLibrary, setDriveLibrary] = useState({ shows: {}, showsList: [], showsPosters: {}, movies: [], continueWatching: [] });
  const driveLibraryRef = useRef(driveLibrary);

  // ---- Favorites ----
  const [favorites, setFavorites] = useState([]);


  // ---- Refs ----
  const allFreeTvChannelsRef = useRef([]);
  const currentPopularItemRef = useRef(null);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const currentPlayFilePathRef = useRef('');
  const currentPlayItemMetaRef = useRef({ type: 'video', show: '', season: null, episode: null, posterPath: '' });
  const currentTorrentStreamIdRef = useRef('');
  const currentTorrentFileIndexRef = useRef('0');
  const torrentWarmupAbortRef = useRef(null);
  const playerRef = useRef(null);
  const progressTimerRef = useRef(null);
  const notifTimerRef = useRef(null);
  const enterPressTimeRef = useRef(0);
  const navStackRef = useRef(navStack);
  navStackRef.current = navStack;

  // ---- Helpers ----
  const safeStr = (v) => (v === null || v === undefined ? '' : String(v));
  const safeInt = (v) => {
    if (!v) return 0;
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  };

  // Prefer 720p (and smaller) torrents. Lower tier = more preferred.
  const getResolutionTier = (str) => {
    const s = safeStr(str).toLowerCase();
    if (/(2160|4k|uhd|8k)/.test(s)) return 2;
    if (/(1080|fhd)/.test(s)) return 1;
    if (/(720|480|576|hdtv|webrip|web-dl|\bsd\b)/.test(s)) return 0;
    return 1;
  };

  // Rank torrents: resolution dominates, then seed/peer count breaks ties.
  const torrentScore = (r) => {
    const tier = getResolutionTier(`${safeStr(r?.title)} ${safeStr(r?.quality)}`);
    return tier * 100000 - (safeInt(r?.seeds) * 2 + safeInt(r?.peers));
  };

  // Parse season and episode from title strings
  const parseSeasonEpisode = (title) => {
    if (!title || typeof title !== 'string') return { season: 0, episode: 0, found: false };
    const clean = title.trim();

    // Pattern 1: S01E02 or S1E2 or S01.E02
    const sMatch = clean.match(/[Ss](\d{1,3})[\s._-]*[Ee](\d{1,3})/);
    if (sMatch) return { season: parseInt(sMatch[1], 10), episode: parseInt(sMatch[2], 10), found: true };

    // Pattern 2: 1x02 or 01x02
    const xMatch = clean.match(/\b(\d{1,2})x(\d{1,3})\b/i);
    if (xMatch) return { season: parseInt(xMatch[1], 10), episode: parseInt(xMatch[2], 10), found: true };

    // Pattern 3: Season 1 Episode 2
    const seMatch = clean.match(/Season\s*(\d{1,3}).*?Episode\s*(\d{1,3})/i);
    if (seMatch) return { season: parseInt(seMatch[1], 10), episode: parseInt(seMatch[2], 10), found: true };

    // Fallback: S01 or Season 1
    let s = 0;
    const sOnly = clean.match(/[Ss]eason\s*(\d{1,3})|[Ss](\d{1,3})\b/);
    if (sOnly) s = parseInt(sOnly[1] || sOnly[2], 10);

    // Fallback: E02 or Episode 2
    let e = 0;
    const eOnly = clean.match(/[Ee]pisode\s*(\d{1,3})|[Ee](\d{1,3})\b/);
    if (eOnly) e = parseInt(eOnly[1] || eOnly[2], 10);

    return { season: s, episode: e, found: s > 0 || e > 0 };
  };

  // Filter out COMPLETE whole-season or batch torrents
  const isCompleteTorrentBatch = (title) => {
    if (!title || typeof title !== 'string') return false;
    const up = title.toUpperCase();
    if (up.includes('COMPLETE') || up.includes('SEASON PACK') || up.includes('BOXSET') || up.includes('ENTIRE SEASON')) {
      return true;
    }
    if (/[Ss]\d+[\s._-]*[-~–—/][\s._-]*[Ss]?\d+/.test(up)) return true;
    if (/[Ee]\d+[\s._-]*[-~–—/][\s._-]*[Ee]?\d+/.test(up)) return true;
    return false;
  };

  const sortTvTorrentsByEpisode = (torrents) => {
    return (torrents || []).slice().sort((a, b) => {
      const epA = parseSeasonEpisode(a.title || '').episode;
      const epB = parseSeasonEpisode(b.title || '').episode;
      if (epA !== epB) return epA - epB;
      return torrentScore(a) - torrentScore(b);
    });
  };


  const formatDurationStr = (duration) => {
    if (!duration) return '';
    const totalSecs = Math.floor(duration);
    const mins = Math.floor(totalSecs / 60);
    if (mins > 60) {
      const hrs = Math.floor(mins / 60);
      const remMins = mins % 60;
      return `${hrs}h ${remMins}m`;
    }
    return `${mins}m`;
  };

  const showNotification = useCallback((titleText, msgText) => {
    setNotification({ title: titleText, msg: msgText });
    if (notifTimerRef.current) clearTimeout(notifTimerRef.current);
    notifTimerRef.current = setTimeout(() => {
      setNotification(null);
    }, 5000);
  }, []);

  const isHlsUrl = useCallback((url) => {
    const u = safeStr(url).toLowerCase();
    return u.includes('.m3u8') || u.includes('/api/freetv/stream') || u.includes('drive-hls') || u.includes('/api/stream/torrent-hls/');
  }, []);

  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch (_) {}
      hlsRef.current = null;
    }
  }, []);

  // Tell the cloud transcoder and torrent streamer to stop and clear the current torrent stream.
  const stopActiveTorrentStream = useCallback(() => {
    if (torrentWarmupAbortRef.current) {
      try {
        torrentWarmupAbortRef.current.abort();
      } catch (_) {}
      torrentWarmupAbortRef.current = null;
    }
    const streamId = currentTorrentStreamIdRef.current;
    const fileIndex = currentTorrentFileIndexRef.current || '0';
    currentTorrentStreamIdRef.current = '';
    currentTorrentFileIndexRef.current = '0';
    if (!streamId) return;
    // Notify cloud server to terminate FFmpeg HLS transcode and notify torrent streamer
    api.stopTorrentHls(streamId, fileIndex).catch(() => {});
    // Direct stop torrent streamer as fallback
    fetch(`${getTorrentServerUrl()}/api/torrent/stream/${encodeURIComponent(streamId)}/stop`, { method: 'POST' }).catch(() => {});
  }, []);

  // ---- Navigation ----
  const pushState = useCallback((newBreadcrumb) => {
    setNavStack((prev) => [
      ...prev,
      {
        breadcrumb,
        gridItems,
        focusedIdx,
        numColumns
      }
    ]);
    setBreadcrumb(newBreadcrumb);
    setFocusedIdx(0);
    setFocusTarget('grid');
    setNumColumns(6);
  }, [breadcrumb, gridItems, focusedIdx, numColumns]);

  const popState = useCallback(() => {
    if (navStack.length === 0) return false;
    const prev = navStack[navStack.length - 1];
    setNavStack((s) => s.slice(0, s.length - 1));
    setBreadcrumb(prev.breadcrumb);
    setGridItems(prev.gridItems);
    setFocusedIdx(prev.focusedIdx || 0);
    setNumColumns(prev.numColumns || 6);
    if (prev.breadcrumb === 'Home' && (!prev.gridItems || prev.gridItems.length === 0)) {
      setFocusTarget('fresh');
    } else {
      setFocusTarget('grid');
    }
    return true;
  }, [navStack]);

  // ---- Home Screen ----
  const loadHomeFresh = useCallback(async () => {
    try {
      const data = await api.getWhatsOn();
      const items = [];
      if (data && data.items) {
        for (const [idx, item] of data.items.entries()) {
          if (!item) continue;
          const title = safeStr(item.title) || 'Untitled';
          const tType = safeStr(item.type);
          const yStr = safeStr(item.year);
          const yearStr = yStr && yStr !== '0' ? ` (${yStr})` : '';
          const provider = safeStr(item.provider);
          const poster = api.resolvePosterUrl(item.image, 'images/no-poster.jpg');
          items.push({
            id: `fresh_${idx}`,
            title,
            subtitle: `${tType}${yearStr}`,
            description: provider ? `${title} - ${provider}` : title,
            posterUrl: poster,
            HDPosterUrl: poster,
            targetType: 'popular_item',
            itemTitle: title,
            itemType: tType
          });
        }
      }
      setFreshItems(items);
      setFreshFocusedIdx(0);
    } catch (_) {
      // Fresh rail is optional
    }
  }, []);

  const showHomeScreen = useCallback(() => {
    destroyHls();
    stopActiveTorrentStream();
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    setPlayer(null);
    setNavStack([]);
    setBreadcrumb('Home');
    setGridItems([]);
    setFocusedIdx(0);
    setFocusTarget('fresh');
    setFreshFocusedIdx(0);
    setActiveSidebar(0);
    loadHomeFresh();
  }, [destroyHls, loadHomeFresh, stopActiveTorrentStream]);

  // ---- Drive Library ----
  const loadDriveLibrary = useCallback(async () => {
    if (!loggedIn) return;
    try {
      const data = await api.getOnDemand();
      if (data) {
        driveLibraryRef.current = data;
        setDriveLibrary(data);
      }
    } catch (_) {
      // Drive library is non-critical
    }
  }, [loggedIn]);

  // ---- Favorites ----
  const loadFavorites = useCallback(async () => {
    if (!loggedIn) return;
    try {
      const data = await api.getFavorites();
      if (data && Array.isArray(data.favorites)) setFavorites(data.favorites);
    } catch (_) {}
  }, [loggedIn]);

  // ---- Auth ----
  const handleSignOut = useCallback(() => {
    clearAuth();
    setAuthToken('');
    setAuthUserName('');
    setLoggedIn(false);
    setActiveSidebar(0);
    showHomeScreen();
  }, [showHomeScreen]);

  // ---- Pairing Flow ----
  const stopPairingPoll = useCallback(() => {
    if (pairingPollTimerRef.current) {
      clearInterval(pairingPollTimerRef.current);
      pairingPollTimerRef.current = null;
    }
    pairingPollCountRef.current = 0;
  }, []);

  const startPairingPoll = useCallback((code) => {
    stopPairingPoll();
    pairingPollCountRef.current = 0;
    const timer = setInterval(async () => {
      pairingPollCountRef.current += 1;
      if (pairingPollCountRef.current > 150) {
        stopPairingPoll();
        setPairingStatusText('Pairing code expired. Go back to Sign In to try again.');
        return;
      }
      try {
        const data = await api.getPairingStatus(code);
        if (data && data.status === 'complete') {
          const tokenRes = await api.getPairingToken(code);
          if (tokenRes && tokenRes.success && tokenRes.token) {
            stopPairingPoll();
            setToken(tokenRes.token);
            setStoredUser({ name: '' });
            setAuthToken(tokenRes.token);
            setLoggedIn(true);
            setShowPairing(false);
            showHomeScreen();
            loadFavorites();
            loadDriveLibrary();
            showNotification('Signed In', 'FREEVEE is connected.');
          } else {
            stopPairingPoll();
            setPairingStatusText('Failed to retrieve session token');
          }
        } else if (data && data.status === 'expired') {
          stopPairingPoll();
          setPairingStatusText('Pairing code expired. Go back to Sign In to try again.');
        }
      } catch (_) {
        // Transient network error - keep polling
      }
    }, 2000);
    pairingPollTimerRef.current = timer;
  }, [stopPairingPoll, showHomeScreen, loadFavorites, loadDriveLibrary, showNotification]);

  const showLoginScreen = useCallback(() => {
    setShowPairing(true);
    setPairingCode('');
    setPairingStatusText('Loading pairing code...');
    setFocusTarget('pairing');
    api
      .getPairingCode()
      .then((data) => {
        if (data && data.code) {
          setPairingCode(data.code);
          setPairingStatusText(`Open ${getServerUrl()}/device on your phone and enter code ${data.code}`);
          startPairingPoll(data.code);
        } else {
          setPairingStatusText('Failed to generate pairing code');
        }
      })
      .catch(() => {
        setPairingStatusText('Error generating pairing code');
      });
  }, [startPairingPoll]);

  const exitPairing = useCallback(() => {
    stopPairingPoll();
    setShowPairing(false);
    setFocusTarget('fresh');
    showHomeScreen();
  }, [stopPairingPoll, showHomeScreen]);

  // ---- Drive Sections ----
  const openDriveGrid = useCallback(() => {
    if (!loggedIn) {
      showLoginScreen();
      return;
    }
    setActiveSidebar(1);
    pushState('Home > Drive');
    setBreadcrumb('Loading Drive library...');
    loadDriveLibrary().then(() => {
      const lib = driveLibraryRef.current;
      const items = [];
      if (lib.showsList && lib.showsList.length > 0) {
        items.push({
          id: 'drive_tv_root',
          title: 'TV Shows',
          subtitle: `${lib.showsList.length} Shows`,
          description: 'Browse your TV show library from Google Drive',
          posterUrl: 'images/tv-shows.jpg',
          targetType: 'drive_tv_root'
        });
      }
      if (lib.movies && lib.movies.length > 0) {
        items.push({
          id: 'drive_movies_root',
          title: 'Movies',
          subtitle: `${lib.movies.length} Movies`,
          description: 'Browse your movie library from Google Drive',
          posterUrl: 'images/movies.jpg',
          targetType: 'drive_movies_root'
        });
      }
      if (lib.continueWatching && lib.continueWatching.length > 0) {
        items.push({
          id: 'drive_cw_root',
          title: 'Continue Watching',
          subtitle: `${lib.continueWatching.length} Items`,
          description: 'Resume watching where you left off',
          posterUrl: 'images/continue-watching.jpg',
          targetType: 'drive_continue_watching'
        });
      }
      if (items.length === 0) {
        setGridItems([]);
        setBreadcrumb('Drive library is empty. Set up folders in the web app.');
        return;
      }
      setGridItems(items);
      setBreadcrumb(`Home > Drive (${items.length} Sections)`);
      setFocusedIdx(0);
    });
  }, [loggedIn, showLoginScreen, pushState, loadDriveLibrary]);

  const openDriveShowsGrid = useCallback(() => {
    const lib = driveLibraryRef.current;
    if (!lib.showsList || lib.showsList.length === 0) return;
    pushState('Home > Drive > TV Shows');
    const items = lib.showsList.map((showName) => {
      const seasons = lib.shows[showName] || {};
      let totalEps = 0;
      for (const sKey in seasons) totalEps += (seasons[sKey] || []).length;
      if (totalEps === 0) return null;
      const poster = lib.showsPosters?.[showName] || 'images/tv-shows.jpg';
      return {
        id: `dshow_${showName}`,
        title: showName,
        subtitle: `${totalEps} Episodes`,
        description: `${showName} - ${Object.keys(seasons).length} seasons, ${totalEps} episodes`,
        posterUrl: api.resolvePosterUrl(poster, 'images/tv-shows.jpg'),
        targetType: 'drive_show',
        showName
      };
    }).filter(Boolean);
    setGridItems(items);
    setBreadcrumb(`Home > Drive > TV Shows (${items.length})`);
    setFocusedIdx(0);
  }, [pushState]);

  const openDriveShowSeasons = useCallback((showName) => {
    const lib = driveLibraryRef.current;
    const seasons = lib.shows[showName] || {};
    pushState(`Home > Drive > ${showName}`);
    const poster = lib.showsPosters?.[showName] || 'images/tv-shows.jpg';
    const sortedKeys = Object.keys(seasons).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    // Find latest episode in library across all seasons
    let latestEpObj = null;
    let latestSeasonNum = -1;
    let latestEpNum = -1;
    for (const sKey of sortedKeys) {
      const sNum = parseInt(sKey, 10);
      const eps = seasons[sKey] || [];
      for (const ep of eps) {
        const eNum = ep.episode || 0;
        if (sNum > latestSeasonNum || (sNum === latestSeasonNum && eNum > latestEpNum)) {
          latestSeasonNum = sNum;
          latestEpNum = eNum;
          latestEpObj = ep;
        }
      }
    }

    const items = [];

    // Prepend "★ Latest Episode" card at index 0 with star.jpg
    if (latestEpObj && latestSeasonNum > 0) {
      const eNum = latestEpObj.episode || 1;
      const sStr = String(latestSeasonNum).padStart(2, '0');
      const eStr = String(eNum).padStart(2, '0');
      const epTitle = latestEpObj.title || `Episode ${eNum}`;
      const fullTitle = `S${sStr}E${eStr} - ${epTitle}`;

      let driveId = latestEpObj.driveId || '';
      const mediaPath = latestEpObj.path || '';
      if (!driveId && mediaPath.startsWith('drive://')) driveId = mediaPath.slice(7);

      items.push({
        id: `latest_drive_${showName}`,
        title: `★ Latest: ${fullTitle}`,
        subtitle: 'Quick Play · Latest Episode',
        description: `Play latest episode: ${fullTitle}`,
        posterUrl: 'images/star.jpg',
        targetType: 'drive_episode',
        showName,
        seasonNum: String(latestSeasonNum),
        episodeNum: eNum,
        itemTitle: fullTitle,
        mediaPath,
        driveId,
        filename: latestEpObj.filename || ''
      });
    }

    for (const sKey of sortedKeys) {
      const eps = seasons[sKey] || [];
      if (eps.length === 0) continue;
      items.push({
        id: `dseason_${showName}_${sKey}`,
        title: `Season ${sKey}`,
        subtitle: `${eps.length} Episodes`,
        description: `${showName} - Season ${sKey} (${eps.length} episodes)`,
        posterUrl: api.resolvePosterUrl(poster, 'images/tv-shows.jpg'),
        targetType: 'drive_season',
        showName,
        seasonNum: sKey
      });
    }

    setGridItems(items);
    setBreadcrumb(`Home > Drive > ${showName} (${sortedKeys.length} Seasons)`);
    setFocusedIdx(0);
  }, [pushState]);

  const openDriveSeasonEpisodes = useCallback((showName, seasonNum) => {
    const lib = driveLibraryRef.current;
    const eps = lib.shows[showName]?.[seasonNum] || [];
    if (eps.length === 0) return;
    pushState(`Home > Drive > ${showName} > Season ${seasonNum}`);
    const sorted = [...eps].sort((a, b) => (a.episode || 0) - (b.episode || 0));
    const poster = lib.showsPosters?.[showName] || 'images/tv-shows.jpg';
    const items = sorted.map((ep, idx) => {
      const eNum = ep.episode || idx + 1;
      const eNumStr = String(eNum).padStart(2, '0');
      const eTitle = ep.title || `Episode ${eNum}`;
      const fullTitle = `S${seasonNum}E${eNumStr} - ${eTitle}`;
      const epPoster = ep.thumbnailUrl || poster;
      return {
        id: `dep_${showName}_${seasonNum}_${idx}`,
        title: fullTitle,
        subtitle: `Episode ${eNum}`,
        description: `${showName} - ${fullTitle}`,
        posterUrl: api.resolvePosterUrl(epPoster, 'images/tv-shows.jpg'),
        targetType: 'drive_episode',
        showName,
        seasonNum,
        episodeNum: String(eNum),
        itemTitle: fullTitle,
        mediaPath: ep.path || '',
        driveId: ep.driveId || '',
        filename: ep.filename || '',
        posterPath: epPoster
      };
    });
    setGridItems(items);
    setBreadcrumb(`Home > Drive > ${showName} > S${seasonNum} (${items.length} Episodes)`);
    setFocusedIdx(0);
  }, [pushState]);

  const openDriveMoviesGrid = useCallback(() => {
    const lib = driveLibraryRef.current;
    if (!lib.movies || lib.movies.length === 0) return;
    pushState('Home > Drive > Movies');
    const items = lib.movies.map((movie, idx) => {
      const mTitle = movie.title || movie.filename || 'Untitled';
      const yStr = movie.year ? ` (${movie.year})` : '';
      return {
        id: `dmov_${idx}`,
        title: mTitle,
        subtitle: `Movie${yStr}`,
        description: `${mTitle}${yStr}`,
        posterUrl: api.resolvePosterUrl(movie.posterUrl || movie.thumbnailUrl, 'images/movies.jpg'),
        targetType: 'drive_movie',
        itemTitle: mTitle,
        mediaPath: movie.path || '',
        driveId: movie.driveId || '',
        filename: movie.filename || '',
        posterPath: movie.posterUrl || movie.thumbnailUrl || ''
      };
    });
    setGridItems(items);
    setBreadcrumb(`Home > Drive > Movies (${items.length})`);
    setFocusedIdx(0);
  }, [pushState]);

  const openDriveContinueWatching = useCallback(() => {
    const lib = driveLibraryRef.current;
    pushState('Home > Drive > Continue Watching');
    const items = (lib.continueWatching || []).map((item, idx) => {
      const title = item.title || item.filename || 'Untitled';
      const showName = item.show || '';
      let typeLabel = item.type === 'tv' ? 'TV' : (item.type || 'Video');
      let epStr = '';
      if (showName) {
        typeLabel = 'TV';
        const sNum = safeInt(item.season);
        const eNum = safeInt(item.episode);
        if (sNum > 0 && eNum > 0) epStr = ` S${sNum}E${String(eNum).padStart(2, '0')}`;
      }
      let pct = 0;
      const dur = safeInt(item.duration);
      const cur = safeInt(item.currentTime);
      if (dur > 0) pct = Math.round((cur / dur) * 100);
      let driveId = item.driveId || '';
      const mediaPath = item.path || '';
      if (!driveId && mediaPath.startsWith('drive://')) driveId = mediaPath.slice(7);
      return {
        id: `dcw_${idx}`,
        title,
        subtitle: `${typeLabel}${epStr}`,
        description: `${title} (${pct}% watched)`,
        posterUrl: api.resolvePosterUrl(item.posterPath, 'images/no-poster.jpg'),
        targetType: 'drive_episode',
        itemTitle: title,
        mediaPath,
        driveId,
        showName,
        seasonNum: item.season,
        episodeNum: item.episode,
        posterPath: item.posterPath || '',
        currentTime: item.currentTime || 0
      };
    });
    setGridItems(items);
    setBreadcrumb(`Home > Drive > Continue Watching (${items.length})`);
    setFocusedIdx(0);
  }, [pushState]);

  const toggleFavorite = useCallback(
    async (item) => {
      if (!loggedIn || !item) {
        showLoginScreen();
        return;
      }
      const title = safeStr(item.itemTitle || item.title);
      if (!title) return;
      let favType = 'movie';
      if (item.showName || item.itemType === 'tv') favType = 'tv';
      else if (item.itemType) favType = item.itemType;
      const favItem = {
        title,
        type: favType,
        image: item.posterUrl || item.posterPath || item.HDPosterUrl || undefined,
        show: item.showName || undefined,
        path: item.mediaPath || item.path || undefined,
        driveId: item.driveId || undefined
      };
      try {
        const data = await api.toggleFavorite(favItem);
        if (data && Array.isArray(data.favorites)) setFavorites(data.favorites);
        showNotification('Faves', data && data.isFavorite ? 'Added to favorites' : 'Removed from favorites');
      } catch (_) {
        showNotification('Faves', 'Could not update favorites');
      }
    },
    [loggedIn, showLoginScreen, showNotification]
  );

  const openFavoritesGrid = useCallback(async () => {
    if (!loggedIn) {
      showLoginScreen();
      return;
    }
    setActiveSidebar(2);
    pushState('Home > Faves');
    setBreadcrumb('Loading favorites...');
    try {
      const data = await api.getFavorites();
      const favs = (data && data.favorites) || [];
      if (favs.length === 0) {
        setGridItems([]);
        setBreadcrumb('No favorites yet. Heart items from the Drive section to add them here.');
        return;
      }
      const items = favs.map((fav, idx) => {
        const favTitle = fav.title || 'Untitled';
        let poster = 'images/no-poster.jpg';
        if (fav.image) {
          if (String(fav.image).toLowerCase().startsWith('http')) poster = fav.image;
          else poster = api.resolvePosterUrl(fav.image, 'images/no-poster.jpg');
        }
        const favType = fav.type || 'movie';
        let driveId = fav.driveId || '';
        const mediaPath = fav.path || '';
        if (!driveId && mediaPath.startsWith('drive://')) driveId = mediaPath.slice(7);
        return {
          id: `fave_${idx}`,
          title: favTitle,
          subtitle: favType,
          description: favTitle,
          posterUrl: poster,
          targetType: 'fave_item',
          itemTitle: favTitle,
          itemType: favType,
          mediaPath,
          driveId,
          showName: fav.show || '',
          posterPath: fav.image || ''
        };
      });
      setGridItems(items);
      setBreadcrumb(`Home > Faves (${items.length})`);
      setFocusedIdx(0);
    } catch (_) {
      setBreadcrumb('Error loading favorites');
    }
  }, [loggedIn, showLoginScreen, pushState]);

  // ---- Torrents ----
  const promptPopularNoTorrents = useCallback((item) => {
    const title = safeStr(item?.itemTitle || item?.title || 'Item');
    setBreadcrumb(`No torrents found for ${title}`);
    setDialog({
      title: 'No Torrents Found',
      message: `No torrents were found for ${title}.`,
      buttons: ['OK'],
      buttonIdx: 0,
      onSelect: (idx) => {
        setDialog(null);
        setFocusTarget('grid');
      }
    });
    setFocusTarget('dialog');
  }, []);

  const playTorrentStream = useCallback(async (linkUrl, itemTitle) => {
    if (!linkUrl) return;
    setBreadcrumb(`Connecting to torrent swarm for ${itemTitle}...`);
    try {
      const data = await api.startTorrentStream(linkUrl);
      if (data && data.success && (data.streamUrl || data.streamId)) {
        let streamId = data.streamId || '';
        let fileIndex = data.fileIndex !== undefined ? String(data.fileIndex) : '0';

        if (!streamId && data.streamUrl) {
          const match = String(data.streamUrl).match(/\/api\/torrent\/serve\/([^/?]+)(?:\/([^/?]+))?/);
          if (match) {
            streamId = match[1];
            if (match[2]) fileIndex = match[2];
          }
        }

        currentTorrentStreamIdRef.current = streamId;
        currentTorrentFileIndexRef.current = fileIndex;
        const title = itemTitle || data.title || 'Torrent Stream';

        // Roku-cloud mirror: Route stream through cloud server HLS transcoder
        const hlsUrl = api.torrentHlsStreamUrl(streamId, fileIndex);

        // Pre-buffering / warmup step (with 90s timeout) so FFmpeg produces initial segment
        setBreadcrumb('Preparing stream... (buffering initial video)');
        const controller = new AbortController();
        torrentWarmupAbortRef.current = controller;
        const timeoutId = setTimeout(() => controller.abort(), 90000);

        try {
          const warmupRes = await fetch(hlsUrl, {
            method: 'GET',
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          torrentWarmupAbortRef.current = null;

          if (!warmupRes.ok && warmupRes.status !== 302) {
            const errText = await warmupRes.text().catch(() => '');
            setBreadcrumb(`Stream prep failed (${warmupRes.status}): ${errText || 'Transcoder error'}`);
            return;
          }

          setBreadcrumb(`Starting playback: ${title}`);
          setIsLiveChannel(false);
          currentPlayFilePathRef.current = '';
          setPlayer({ url: hlsUrl, title, offset: 0, isLive: false });
          setFocusTarget('player');
        } catch (prepErr) {
          clearTimeout(timeoutId);
          torrentWarmupAbortRef.current = null;
          if (prepErr.name === 'AbortError') {
            setBreadcrumb('Stream prep timed out (peers/transcoding took >90s)');
          } else {
            setBreadcrumb(`Stream prep error: ${prepErr.message || 'Connection failed'}`);
          }
        }
      } else {
        setBreadcrumb(data?.error || 'Torrent stream initialization failed');
      }
    } catch (_) {
      setBreadcrumb('Error initializing torrent stream on server');
    }
  }, []);

  const openPopularTvSeasonTorrentsGrid = useCallback((showTitle, seasonNum, torrents) => {
    pushState(`Home > Fresh > ${showTitle} > Season ${seasonNum}`);
    const showPoster = currentPopularItemRef.current?.HDPosterUrl || currentPopularItemRef.current?.posterUrl || 'images/no-poster.jpg';

    // Filter out COMPLETE batch torrents
    const filteredTorrents = (torrents || []).filter(t => !isCompleteTorrentBatch(safeStr(t.title)));

    // Sort by Episode ascending (E01, E02...) with quality score tie-breaker
    const sortedTorrents = sortTvTorrentsByEpisode(filteredTorrents);

    // Track latest episode in this season
    let latestTorrent = null;
    let latestEp = -1;
    for (const t of sortedTorrents) {
      const ep = parseSeasonEpisode(safeStr(t.title)).episode;
      if (ep > latestEp) {
        latestEp = ep;
        latestTorrent = t;
      }
    }

    const items = [];

    // Prepend "★ Latest Episode" card if multiple episodes exist
    if (latestTorrent && latestEp > 0 && sortedTorrents.length > 1) {
      const sStr = String(seasonNum).padStart(2, '0');
      const eStr = String(latestEp).padStart(2, '0');
      const qStr = safeStr(latestTorrent.quality);
      let sub = 'Quick Play · Latest Episode';
      if (qStr) sub += ` · ${qStr}`;
      sub += ` · ${safeInt(latestTorrent.seeds)} seeds`;

      items.push({
        id: `latest_season_ep_${latestEp}`,
        title: `★ Latest: S${sStr}E${eStr}`,
        subtitle: sub,
        description: `Play latest episode: ${safeStr(latestTorrent.title)}`,
        posterUrl: 'images/star.jpg',
        targetType: 'torrent_item',
        link: safeStr(latestTorrent.link || latestTorrent.magnet),
        itemTitle: safeStr(latestTorrent.title)
      });
    }

    sortedTorrents.forEach((t, idx) => {
      const tTitle = safeStr(t.title) || 'Torrent';
      const ep = parseSeasonEpisode(tTitle).episode;
      const sStr = String(seasonNum).padStart(2, '0');
      const eStr = ep > 0 ? String(ep).padStart(2, '0') : '';
      const displayTitle = eStr ? `S${sStr}E${eStr} · ${tTitle}` : tTitle;

      items.push({
        id: `t_${idx}`,
        title: displayTitle,
        subtitle: `${safeInt(t.seeds)} seeds, ${safeInt(t.peers)} peers`,
        description: tTitle,
        posterUrl: showPoster,
        targetType: 'torrent_item',
        link: safeStr(t.link || t.magnet),
        itemTitle: tTitle
      });
    });

    setGridItems(items);
    setBreadcrumb(`Home > Fresh > ${showTitle} > S${seasonNum} (${sortedTorrents.length} Episodes)`);
    setFocusedIdx(0);
  }, [pushState]);

  const showPopularTvSeasonsGrid = useCallback(
    (results) => {
      const showTitle = safeStr(currentPopularItemRef.current?.itemTitle || currentPopularItemRef.current?.title || 'TV Show');
      const showPoster = currentPopularItemRef.current?.HDPosterUrl || currentPopularItemRef.current?.posterUrl || 'images/no-poster.jpg';
      const seasonsMap = {};
      const seasonsList = [];
      let latestTorrent = null;
      let latestSeason = -1;
      let latestEpisode = -1;

      for (const r of results || []) {
        const tTitle = safeStr(r.title);
        if (isCompleteTorrentBatch(tTitle)) continue;

        const epInfo = parseSeasonEpisode(tTitle);
        if (epInfo.episode <= 0) continue; // must be individual episode

        let sNum = epInfo.season > 0 ? epInfo.season : 1;
        const sKey = String(sNum);
        if (!seasonsMap[sKey]) {
          seasonsMap[sKey] = [];
          seasonsList.push(sNum);
        }
        seasonsMap[sKey].push(r);

        if (sNum > latestSeason || (sNum === latestSeason && epInfo.episode > latestEpisode)) {
          latestSeason = sNum;
          latestEpisode = epInfo.episode;
          latestTorrent = r;
        } else if (sNum === latestSeason && epInfo.episode === latestEpisode) {
          if (!latestTorrent || torrentScore(r) < torrentScore(latestTorrent)) {
            latestTorrent = r;
          }
        }
      }

      if (seasonsList.length === 0) {
        promptPopularNoTorrents(currentPopularItemRef.current);
        return;
      }
      seasonsList.sort((a, b) => a - b);

      pushState(`Home > Fresh > ${showTitle}`);
      const items = [];

      // Prepend "★ Latest Episode" card at index 0 with star.jpg
      if (latestTorrent && latestSeason > 0 && latestEpisode > 0) {
        const sStr = String(latestSeason).padStart(2, '0');
        const eStr = String(latestEpisode).padStart(2, '0');
        const qStr = safeStr(latestTorrent.quality);
        let sub = `Quick Play · S${sStr}E${eStr}`;
        if (qStr) sub += ` · ${qStr}`;
        sub += ` · ${safeInt(latestTorrent.seeds)} seeds`;

        items.push({
          id: `latest_${latestSeason}_${latestEpisode}`,
          title: `★ Latest: S${sStr}E${eStr}`,
          subtitle: sub,
          description: `Play latest episode: ${safeStr(latestTorrent.title)}`,
          posterUrl: 'images/star.jpg',
          targetType: 'torrent_item',
          link: safeStr(latestTorrent.link || latestTorrent.magnet),
          itemTitle: safeStr(latestTorrent.title)
        });
      }

      for (const sNum of seasonsList) {
        const sKey = String(sNum);
        const tList = seasonsMap[sKey] || [];
        items.push({
          id: `season_${sKey}`,
          title: `Season ${sKey}`,
          subtitle: `${tList.length} Episodes`,
          description: `${showTitle} - Season ${sKey} (${tList.length} episode torrents)`,
          posterUrl: showPoster,
          targetType: 'popular_tv_season',
          showTitle,
          seasonNum: sKey,
          torrents: tList
        });
      }

      setGridItems(items);
      setBreadcrumb(`Home > Fresh > ${showTitle} (${seasonsList.length} Seasons)`);
      setFocusedIdx(0);
    },
    [pushState, promptPopularNoTorrents]
  );

  const searchPopularTorrent = useCallback(
    async (item) => {
      const title = safeStr(item?.itemTitle || item?.title);
      const tType = safeStr(item?.itemType) || 'movie';
      currentPopularItemRef.current = item;
      setBreadcrumb(`Searching torrents for ${title}...`);
      try {
        const data = await api.torrentSearch(tType, title);
        if (!data || !data.results || data.results.length === 0) {
          promptPopularNoTorrents(item);
          return;
        }
        if (tType === 'tv') {
          showPopularTvSeasonsGrid(data.results);
          return;
        }
        let best = null;
        let bestScore = Infinity;
        for (const r of data.results) {
          const score = torrentScore(r);
          if (score < bestScore) {
            bestScore = score;
            best = r;
          }
        }
        if (!best || !best.link) {
          promptPopularNoTorrents(item);
          return;
        }
        playTorrentStream(best.link, best.title);
      } catch (_) {
        promptPopularNoTorrents(item);
      }
    },
    [promptPopularNoTorrents, showPopularTvSeasonsGrid, playTorrentStream]
  );

  const searchQueryTorrent = useCallback(
    async (searchQuery, item) => {
      currentPopularItemRef.current = item;
      setBreadcrumb(`Searching torrents for ${searchQuery}...`);
      try {
        const data = await api.torrentSearch('tv', searchQuery);
        if (!data || !data.results || data.results.length === 0) {
          promptPopularNoTorrents(item);
          return;
        }
        let best = null;
        let bestScore = Infinity;
        for (const r of data.results) {
          const score = torrentScore(r);
          if (score < bestScore) {
            bestScore = score;
            best = r;
          }
        }
        if (!best || !best.link) {
          promptPopularNoTorrents(item);
          return;
        }
        playTorrentStream(best.link, best.title);
      } catch (_) {
        promptPopularNoTorrents(item);
      }
    },
    [promptPopularNoTorrents, playTorrentStream]
  );

  // ---- Services ----
  const openServicesGrid = useCallback(async () => {
    setActiveSidebar(loggedIn ? 3 : 1);
    pushState('Home > Services');
    setBreadcrumb('Loading Streaming Services...');
    try {
      const data = await api.getServices();
      const svcs = (data && data.services) || [];
      const skipIds = ['pluto', 'roku', 'tubi', 'plex'];
      const items = svcs
        .filter((svc) => {
          const id = safeStr(svc.id).toLowerCase();
          const name = safeStr(svc.name).toLowerCase();
          return !skipIds.some((sk) => id.includes(sk) || name.includes(sk));
        })
        .map((svc) => ({
          id: `svc_${svc.id}`,
          title: svc.name,
          subtitle: 'Streaming Catalog',
          description: svc.description || `Browse latest movies and TV shows from ${svc.name}`,
          posterUrl: api.resolvePosterUrl(`/api/services/poster/${svc.id}`, 'images/no-poster.jpg'),
          targetType: 'service_root',
          serviceId: svc.id,
          serviceName: svc.name
        }));
      setGridItems(items);
      setBreadcrumb(`Home > Services (${items.length} Networks)`);
      setFocusedIdx(0);
    } catch (_) {
      setBreadcrumb('Failed to load streaming services');
    }
  }, [pushState, loggedIn]);

  const openServiceCatalogGrid = useCallback(
    async (serviceId, serviceName) => {
      pushState(`Home > Services > ${serviceName}`);
      setBreadcrumb(`Loading ${serviceName}...`);
      try {
        const data = await api.getServiceCatalog(serviceId);
        const catalog = (data && data.items) || [];
        const items = catalog.map((item, idx) => {
          const isMovie = item.type === 'movie';
          const yStr = safeStr(item.year);
          const yearStr = yStr && yStr !== '0' ? ` (${yStr})` : '';
          const fallback = 'images/no-poster.jpg';
          const poster = item.image ? api.resolvePosterUrl(item.image, fallback) : fallback;
          return {
            id: `svc_${serviceId}_${idx}`,
            title: item.title,
            subtitle: `${isMovie ? 'Movie' : 'TV Series'}${yearStr}`,
            description: item.description || `${item.title} on ${serviceName}`,
            posterUrl: poster,
            targetType: isMovie ? 'service_movie_item' : 'service_tv_item',
            itemTitle: item.title,
            itemType: item.type,
            serviceName,
            posterPath: poster
          };
        });
        setGridItems(items);
        setBreadcrumb(`Home > Services > ${serviceName} (${items.length} Titles)`);
        setFocusedIdx(0);
      } catch (_) {
        setBreadcrumb(`Failed to load ${serviceName} catalog`);
      }
    },
    [pushState]
  );

  const openServiceTvSeasonsGrid = useCallback(
    async (showTitle, showPoster) => {
      pushState(`Home > Services > ${showTitle}`);
      setBreadcrumb(`Loading seasons for ${showTitle}...`);
      try {
        const data = await api.getTvDetails(showTitle);
        if (data && data.success && data.seasons && data.seasons.length > 0) {
          let poster = showPoster || 'images/no-poster.jpg';
          if (data.poster) poster = data.poster;

          // Sort seasons numerically ascending
          const sortedSeasons = [...data.seasons].sort((a, b) => (a.seasonNumber || 0) - (b.seasonNumber || 0));

          // Find latest episode in the season list
          let latestEp = null;
          let latestSeasonNum = -1;
          let latestEpNum = -1;
          for (const season of sortedSeasons) {
            const sNum = season.seasonNumber || 1;
            for (const ep of season.episodes || []) {
              const eNum = ep.episodeNumber || 0;
              if (sNum > latestSeasonNum || (sNum === latestSeasonNum && eNum > latestEpNum)) {
                latestSeasonNum = sNum;
                latestEpNum = eNum;
                latestEp = ep;
              }
            }
          }

          const items = [];

          // Prepend "★ Latest Episode" card with star.jpg
          if (latestEp && latestSeasonNum > 0 && latestEpNum > 0) {
            const sStr = String(latestSeasonNum).padStart(2, '0');
            const eStr = String(latestEpNum).padStart(2, '0');
            const epName = latestEp.name || `Episode ${latestEpNum}`;
            const fullTitle = `S${sStr}E${eStr} - ${epName}`;

            items.push({
              id: `latest_svc_${showTitle}`,
              title: `★ Latest: ${fullTitle}`,
              subtitle: 'Quick Play · Latest Episode',
              description: `${showTitle} ${fullTitle}`,
              posterUrl: 'images/star.jpg',
              targetType: 'service_tv_episode',
              showTitle,
              seasonNum: String(latestSeasonNum),
              episodeNum: String(latestEpNum),
              episodeName: epName,
              fullTitle,
              itemTitle: `${showTitle} S${latestSeasonNum}E${eStr}`,
              searchQuery: `${showTitle} S${latestSeasonNum}E${eStr}`
            });
          }

          for (const season of sortedSeasons) {
            const sNum = season.seasonNumber || 1;
            const sName = season.name || `Season ${sNum}`;
            const eps = [...(season.episodes || [])].sort((a, b) => (a.episodeNumber || 0) - (b.episodeNumber || 0));
            items.push({
              id: `svcseason_${showTitle}_${sNum}`,
              title: sName,
              subtitle: `${eps.length} Episodes`,
              description: `${showTitle} - ${sName} (${eps.length} episodes)`,
              posterUrl: api.resolvePosterUrl(poster, 'images/no-poster.jpg'),
              targetType: 'service_tv_season',
              showTitle,
              seasonNum: String(sNum),
              seasonName: sName,
              episodes: eps,
              showPoster: poster
            });
          }

          setGridItems(items);
          setBreadcrumb(`${showTitle} (${sortedSeasons.length} Seasons)`);
          setFocusedIdx(0);
          return;
        }
        searchPopularTorrent({ itemTitle: showTitle, itemType: 'tv' });
      } catch (_) {
        searchPopularTorrent({ itemTitle: showTitle, itemType: 'tv' });
      }
    },
    [pushState, searchPopularTorrent]
  );

  const openServiceTvEpisodesGrid = useCallback(
    (showTitle, seasonNum, seasonName, episodes, showPoster) => {
      if (!episodes || episodes.length === 0) return;
      pushState(`Home > ${showTitle} > ${seasonName}`);
      const sortedEps = [...episodes].sort((a, b) => (a.episodeNumber || 0) - (b.episodeNumber || 0));
      const items = sortedEps.map((ep, idx) => {
        const eNum = ep.episodeNumber || 1;
        const eNumStr = String(eNum).padStart(2, '0');
        const epName = ep.name || `Episode ${eNum}`;
        const fullTitle = `S${seasonNum}E${eNumStr} - ${epName}`;
        let poster = showPoster || 'images/no-poster.jpg';
        if (ep.stillUrl) poster = ep.stillUrl;
        let sub = `Episode ${eNum}`;
        if (ep.runtime > 0) sub = `${ep.runtime} mins`;
        else if (ep.airdate) sub = ep.airdate;
        return {
          id: `svcep_${idx}`,
          title: fullTitle,
          subtitle: sub,
          description: ep.overview || `${showTitle} ${fullTitle}`,
          posterUrl: api.resolvePosterUrl(poster, 'images/no-poster.jpg'),
          targetType: 'service_tv_episode',
          showTitle,
          seasonNum,
          episodeNum: String(eNum),
          episodeName: epName,
          fullTitle,
          itemTitle: `${showTitle} S${seasonNum}E${eNumStr}`,
          searchQuery: `${showTitle} S${seasonNum}E${eNumStr}`
        };
      });
      setGridItems(items);
      setBreadcrumb(`Home > ${showTitle} > ${seasonName} (${sortedEps.length} Episodes)`);
      setFocusedIdx(0);
    },
    [pushState]
  );

  // ---- Free TV ----
  const openFreeTvGrid = useCallback(async () => {
    setActiveSidebar(loggedIn ? 4 : 2);
    pushState('Home > Free TV');
    setBreadcrumb('Loading Free TV...');
    try {
      const data = await api.getFreeTvChannels();
      const channels = (data && data.channels) || [];
      if (channels.length === 0) {
        setBreadcrumb('Home > Free TV (0 Channels)');
        setGridItems([]);
        return;
      }
      const counts = { roku: 0, pluto: 0, tubi: 0 };
      for (const ch of channels) {
        const p = safeStr(ch.provider).toLowerCase();
        if (p.includes('roku')) counts.roku++;
        else if (p.includes('pluto')) counts.pluto++;
        else if (p.includes('tubi')) counts.tubi++;
      }
      const providers = [];
      if (counts.roku > 0) {
        providers.push({
          id: 'Roku Channel',
          title: 'Roku Channel',
          count: counts.roku,
          posterUrl: 'images/roku.jpg',
          desc: 'Live streaming FAST channels from The Roku Channel'
        });
      }
      if (counts.pluto > 0) {
        providers.push({
          id: 'Pluto TV',
          title: 'Pluto TV',
          count: counts.pluto,
          posterUrl: 'images/pluto.jpg',
          desc: 'Live streaming FAST channels from Pluto TV'
        });
      }
      if (counts.tubi > 0) {
        providers.push({
          id: 'Tubi',
          title: 'Tubi TV',
          count: counts.tubi,
          posterUrl: 'images/tubi.jpg',
          desc: 'Live streaming FAST channels from Tubi'
        });
      }
      allFreeTvChannelsRef.current = channels;
      const items = providers.map((prov) => ({
        id: `ftv_prov_${prov.id}`,
        title: prov.title,
        subtitle: `${prov.count} Channels`,
        description: prov.desc,
        posterUrl: prov.posterUrl,
        targetType: 'freetv_provider',
        providerName: prov.id
      }));
      setGridItems(items);
      setBreadcrumb('Home > Free TV (Select Provider)');
      setFocusedIdx(0);
    } catch (_) {
      setBreadcrumb('Error fetching Free TV channels');
    }
  }, [pushState, loggedIn]);

  const openFreeTvProviderGrid = useCallback(
    (providerName) => {
      const channels = allFreeTvChannelsRef.current || [];
      if (channels.length === 0) {
        openFreeTvGrid();
        return;
      }
      pushState(`Home > Free TV > ${providerName}`);
      const items = channels
        .filter((ch) => {
          const p = safeStr(ch.provider).toLowerCase();
          if (providerName === 'Roku Channel') return p.includes('roku');
          if (providerName === 'Pluto TV') return p.includes('pluto');
          if (providerName === 'Tubi') return p.includes('tubi');
          return true;
        })
        .map((ch) => {
          const chId = ch.id || `freetv_${ch.plutoId}`;
          const logo = ch.logo || ch.featuredImage || 'images/no-poster.jpg';
          return {
            id: chId,
            title: ch.name,
            subtitle: ch.currentProgram?.title ? `Now: ${ch.currentProgram.title}` : ch.category || '',
            description: ch.currentProgram?.description || ch.summary || 'Live streaming on Free TV',
            posterUrl: logo,
            targetType: 'freetv_channel',
            channel: ch
          };
        });
      setGridItems(items);
      setBreadcrumb(`Home > Free TV > ${providerName} (${items.length} Channels)`);
      setFocusedIdx(0);
    },
    [pushState, openFreeTvGrid]
  );

  // ---- Playback / Progress Tracking ----
  const submitPlaybackProgress = useCallback(
    (currentTime, duration) => {
      const filePath = currentPlayFilePathRef.current;
      if (!filePath || !loggedIn) return;
      const meta = currentPlayItemMetaRef.current || {};
      const title = playerRef.current?.title || meta.title || 'Video';
      api
        .sendPlaybackProgress({
          path: filePath,
          currentTime: Math.floor(currentTime),
          duration: Math.floor(duration),
          title,
          type: meta.type || 'video',
          show: meta.show || undefined,
          season: meta.season !== null && meta.season !== undefined ? meta.season : undefined,
          episode: meta.episode !== null && meta.episode !== undefined ? meta.episode : undefined,
          posterPath: meta.posterPath || undefined
        })
        .catch(() => {});
    },
    [loggedIn]
  );

  const startProgressTimer = useCallback(() => {
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      const video = videoRef.current;
      if (!video || isLiveChannel) return;
      const pos = video.currentTime || 0;
      if (pos < 5) return;
      const dur = video.duration || 0;
      if (dur > 0 && pos > dur * 0.95) return;
      submitPlaybackProgress(pos, dur);
    }, 10000);
  }, [isLiveChannel, submitPlaybackProgress]);

  const setDriveItemMeta = useCallback((item) => {
    currentPlayItemMetaRef.current = {
      type: 'video',
      show: '',
      season: null,
      episode: null,
      posterPath: safeStr(item?.posterPath || item?.posterUrl || item?.HDPosterUrl || '')
    };
    if (item?.showName) {
      currentPlayItemMetaRef.current.type = 'tv';
      currentPlayItemMetaRef.current.show = item.showName;
    }
    if (item?.seasonNum !== undefined && item?.seasonNum !== null) {
      currentPlayItemMetaRef.current.season = item.seasonNum;
    }
    if (item?.episodeNum !== undefined && item?.episodeNum !== null) {
      currentPlayItemMetaRef.current.episode = item.episodeNum;
    }
  }, []);

  const playDriveItem = useCallback(
    (item) => {
      if (!item) return;
      let driveId = safeStr(item.driveId);
      const mediaPath = safeStr(item.mediaPath);
      let title = safeStr(item.itemTitle || item.title);
      if (!title) title = 'Video';
      let offset = safeInt(item.currentTime);
      if (!driveId && mediaPath.startsWith('drive://')) driveId = mediaPath.slice(7);

      if (driveId) {
        stopActiveTorrentStream();
        setDriveItemMeta(item);
        const streamUrl = api.driveStreamUrl(driveId);
        currentPlayFilePathRef.current = mediaPath || `drive://${driveId}`;
        setIsLiveChannel(false);
        setPlayer({ url: streamUrl, title, offset, isLive: false });
        setFocusTarget('player');
        startProgressTimer();
      }
    },
    [setDriveItemMeta, startProgressTimer, stopActiveTorrentStream]
  );

  const playFreeTvStream = useCallback(
    (channel) => {
      const streamUrl = api.freeTvStreamUrl(channel);
      if (!streamUrl) return;
      stopActiveTorrentStream();
      setIsLiveChannel(true);
      currentPlayFilePathRef.current = '';
      setPlayer({ url: streamUrl, title: `${channel.name || 'Free TV'} (Live)`, offset: 0, isLive: true });
      setFocusTarget('player');
    },
    [stopActiveTorrentStream]
  );

  const closePlayerAndSaveProgress = useCallback(async () => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    stopActiveTorrentStream();
    const filePath = currentPlayFilePathRef.current;
    if (filePath) {
      const video = videoRef.current;
      const pos = video ? video.currentTime || 0 : 0;
      const dur = video ? video.duration || 0 : 0;
      currentPlayFilePathRef.current = '';
      await submitPlaybackProgress(pos, dur);
    }
    destroyHls();
    setPlayer(null);
    setFocusTarget('grid');
  }, [submitPlaybackProgress, destroyHls, stopActiveTorrentStream]);

  const handleVideoEnded = useCallback(async () => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    const filePath = currentPlayFilePathRef.current;
    if (filePath) {
      const video = videoRef.current;
      const dur = video ? video.duration || 0 : 0;
      currentPlayFilePathRef.current = '';
      await submitPlaybackProgress(dur || 1, dur || 1);
    }
    if (isLiveChannel) {
      return;
    }
    stopActiveTorrentStream();
    destroyHls();
    setPlayer(null);
    setFocusTarget('grid');
  }, [submitPlaybackProgress, isLiveChannel, destroyHls, stopActiveTorrentStream]);

  // Initialize HLS / native playback when the player changes
  useEffect(() => {
    if (!player) return;
    const video = videoRef.current;
    if (!video) return;
    const url = player.url;
    playerRef.current = player;
    destroyHls();

    const hlsUrl = isHlsUrl(url);

    const handleError = () => {
      console.error('Playback error', video.error);
      showNotification('Playback Error', 'Unable to play video stream. Please check connection or file format.');
      closePlayerAndSaveProgress();
    };

    video.addEventListener('error', handleError);

    if (hlsUrl) {
      const initHls = () => {
        if (window.Hls && window.Hls.isSupported()) {
          const hls = new window.Hls({
            enableWorker: true,
            lowLatencyMode: false,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 6,
            backBufferLength: 30,
            maxBufferLength: 30,
            manifestLoadingTimeOut: 30000,
            manifestLoadingMaxRetry: 4,
            levelLoadingTimeOut: 30000,
            levelLoadingMaxRetry: 4,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 5
          });
          hlsRef.current = hls;
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
            const p = video.play();
            if (p !== undefined) p.catch(() => {
              video.muted = true;
              video.play().catch(() => {});
            });
          });
          hls.on(window.Hls.Events.ERROR, (_, data) => {
            if (data.fatal) {
              if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
              else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
              else {
                hls.destroy();
                showNotification('Playback Error', 'Unable to play video stream.');
                closePlayerAndSaveProgress();
              }
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          video.play().catch(() => {});
        } else {
          showNotification('Playback Error', 'HLS streaming is not supported by this browser.');
          closePlayerAndSaveProgress();
        }
      };

      if (window.Hls) {
        initHls();
      } else {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
        script.async = true;
        script.onload = initHls;
        script.onerror = () => {
          showNotification('Playback Error', 'Could not load HLS player engine.');
          closePlayerAndSaveProgress();
        };
        document.head.appendChild(script);
      }
    } else {
      video.src = url;
      if (player.offset > 0) {
        video.currentTime = player.offset;
      }
      const p = video.play();
      if (p !== undefined) p.catch(() => {
        video.muted = true;
        video.play().catch(() => {});
      });
    }

    return () => {
      video.removeEventListener('error', handleError);
      destroyHls();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopPairingPoll();
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
      destroyHls();
    };
  }, [stopPairingPoll, destroyHls]);

  // ---- Item Selection Dispatcher ----
  const handleItemSelect = useCallback(
    (item) => {
      if (!item) return;
      const tType = item.targetType;

      if (tType === 'section_header') {
        return;
      } else if (tType === 'service_root') {
        openServiceCatalogGrid(item.serviceId, item.serviceName);
      } else if (tType === 'service_movie_item') {
        searchPopularTorrent(item);
      } else if (tType === 'service_tv_item') {
        openServiceTvSeasonsGrid(item.itemTitle, item.posterPath);
      } else if (tType === 'service_tv_season') {
        openServiceTvEpisodesGrid(item.showTitle, item.seasonNum, item.seasonName, item.episodes, item.showPoster);
      } else if (tType === 'service_tv_episode') {
        searchQueryTorrent(item.searchQuery, item);
      } else if (tType === 'popular_item') {
        searchPopularTorrent(item);
      } else if (tType === 'popular_tv_season') {
        openPopularTvSeasonTorrentsGrid(item.showTitle, item.seasonNum, item.torrents);
      } else if (tType === 'torrent_item') {
        playTorrentStream(item.link, item.itemTitle || item.title);
      } else if (tType === 'freetv_provider') {
        openFreeTvProviderGrid(item.providerName);
      } else if (tType === 'freetv_channel') {
        playFreeTvStream(item.channel);
      } else if (tType === 'drive_tv_root') {
        openDriveShowsGrid();
      } else if (tType === 'drive_movies_root') {
        openDriveMoviesGrid();
      } else if (tType === 'drive_continue_watching') {
        openDriveContinueWatching();
      } else if (tType === 'drive_show') {
        openDriveShowSeasons(item.showName);
      } else if (tType === 'drive_season') {
        openDriveSeasonEpisodes(item.showName, item.seasonNum);
      } else if (tType === 'drive_episode') {
        playDriveItem(item);
      } else if (tType === 'drive_movie') {
        playDriveItem(item);
      } else if (tType === 'fave_item') {
        playDriveItem(item);
      }
    },
    [
      openServiceCatalogGrid, openServiceTvSeasonsGrid, openServiceTvEpisodesGrid,
      searchPopularTorrent, searchQueryTorrent, openPopularTvSeasonTorrentsGrid,
      playTorrentStream, openFreeTvProviderGrid, playFreeTvStream,
      openDriveShowsGrid, openDriveMoviesGrid, openDriveContinueWatching,
      openDriveShowSeasons, openDriveSeasonEpisodes, playDriveItem
    ]
  );

  // ---- Auto-scroll focused item into view ----
  useEffect(() => {
    if (focusTarget === 'grid') {
      const el = document.querySelector('.poster-grid .poster-card.focused');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    } else if (focusTarget === 'fresh') {
      const el = document.querySelector('.cw-grid .poster-card.focused');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [focusedIdx, freshFocusedIdx, focusTarget]);

  // ---- Sidebar definition & activation ----
  const navDefs = [
    { id: 'home', label: 'Home', icon: '🏠' }
  ];
  if (loggedIn) {
    navDefs.push({ id: 'drive', label: 'Drive', icon: '💾' });
    navDefs.push({ id: 'faves', label: 'Faves', icon: '❤️' });
  }
  navDefs.push({ id: 'services', label: 'Services', icon: '🎬' });
  navDefs.push({ id: 'freetv', label: 'Free TV', icon: '📻' });
  navDefs.push({ id: loggedIn ? 'signout' : 'signin', label: loggedIn ? 'Sign Out' : 'Sign In', icon: '👤' });
  const navItemCount = navDefs.length;

  const activateSidebarItem = useCallback(
    (idx) => {
      const def = navDefs[idx];
      if (!def) return;
      if (def.id === 'home') showHomeScreen();
      else if (def.id === 'drive') openDriveGrid();
      else if (def.id === 'faves') openFavoritesGrid();
      else if (def.id === 'services') openServicesGrid();
      else if (def.id === 'freetv') openFreeTvGrid();
      else if (def.id === 'signin') showLoginScreen();
      else if (def.id === 'signout') handleSignOut();
    },
    [navDefs, showHomeScreen, openDriveGrid, openFavoritesGrid, openServicesGrid, openFreeTvGrid, showLoginScreen, handleSignOut]
  );

  // ---- Keyboard & D-Pad Remote Listener ----
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (player) {
        if (e.key === 'Escape' || e.key === 'Backspace') {
          e.preventDefault();
          closePlayerAndSaveProgress();
        } else if ((e.key === 'Enter' || e.key === ' ') && !isLiveChannel) {
          e.preventDefault();
          const video = videoRef.current;
          if (video) {
            if (video.paused) video.play();
            else video.pause();
          }
        }
        return;
      }

      if (dialog) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          setDialog((d) => ({ ...d, buttonIdx: 0 }));
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          setDialog((d) => ({ ...d, buttonIdx: d.buttons.length - 1 }));
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          dialog.onSelect(dialog.buttonIdx);
        } else if (e.key === 'Escape' || e.key === 'Backspace') {
          e.preventDefault();
          dialog.onSelect(dialog.buttons.length - 1);
        }
        return;
      }

      if (showPairing) {
        if (e.key === 'Escape' || e.key === 'Backspace') {
          e.preventDefault();
          exitPairing();
        }
        return;
      }

      let cols = numColumns || 6;
      const allCards = Array.from(document.querySelectorAll('.poster-grid .poster-card:not(.section-header)'));
      if (allCards.length > 0) {
        const firstTop = allCards[0].offsetTop;
        const countInRow = allCards.filter((c) => c.offsetTop === firstTop).length;
        if (countInRow > 0) cols = countInRow;
      }
      let railCols = cols;
      const railCards = Array.from(document.querySelectorAll('.cw-grid .poster-card'));
      if (railCards.length > 1) {
        const railFirstTop = railCards[0].offsetTop;
        const railCount = railCards.filter((c) => c.offsetTop === railFirstTop).length;
        if (railCount > 0) railCols = railCount;
      }
      const count = gridItems.length;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (focusTarget === 'grid') {
          if (focusedIdx % cols === 0) {
            setFocusTarget('sidebar');
            setSidebarIdx(0);
          } else {
            setFocusedIdx((i) => Math.max(0, i - 1));
          }
        } else if (focusTarget === 'fresh') {
          if (freshFocusedIdx === 0) {
            setFocusTarget('sidebar');
            setSidebarIdx(0);
          } else {
            setFreshFocusedIdx((i) => Math.max(0, i - 1));
          }
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (focusTarget === 'sidebar') {
          if (count > 0) {
            setFocusTarget('grid');
          } else if (freshItems.length > 0) {
            setFocusTarget('fresh');
            setFreshFocusedIdx(0);
          }
        } else if (focusTarget === 'grid') {
          setFocusedIdx((i) => Math.min(count - 1, i + 1));
        } else if (focusTarget === 'fresh') {
          setFreshFocusedIdx((i) => Math.min(freshItems.length - 1, i + 1));
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (focusTarget === 'sidebar') {
          setSidebarIdx((i) => Math.max(0, i - 1));
        } else if (focusTarget === 'grid') {
          if (focusedIdx - cols < 0) {
            if (navStack.length === 0) setFocusTarget('ip');
          } else {
            setFocusedIdx((i) => Math.max(0, i - cols));
          }
        } else if (focusTarget === 'fresh') {
          if (freshFocusedIdx - railCols < 0) {
            if (navStack.length === 0 && gridItems.length === 0) {
              setFocusTarget('sidebar');
            } else {
              setFocusTarget('grid');
              setFocusedIdx((i) => Math.max(0, count - cols));
            }
          } else {
            setFreshFocusedIdx((i) => Math.max(0, i - railCols));
          }
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (focusTarget === 'sidebar') {
          setSidebarIdx((i) => Math.min(navItemCount - 1, i + 1));
        } else if (focusTarget === 'ip') {
          if (navStack.length === 0 && gridItems.length === 0 && freshItems.length > 0) {
            setFocusTarget('fresh');
            setFreshFocusedIdx(0);
          } else {
            setFocusTarget('grid');
            setFocusedIdx(0);
          }
        } else if (focusTarget === 'grid') {
          if (focusedIdx + cols >= count) {
            if (navStack.length === 0 && freshItems.length > 0) {
              setFocusTarget('fresh');
              setFreshFocusedIdx(0);
            }
          } else {
            setFocusedIdx((i) => Math.min(count - 1, i + cols));
          }
        } else if (focusTarget === 'fresh') {
          setFreshFocusedIdx((i) => Math.min(freshItems.length - 1, i + railCols));
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (e.key === 'Enter') enterPressTimeRef.current = Date.now();
        if (focusTarget === 'ip') {
          if (loggedIn) {
            setDialog({
              title: authUserName ? `Signed in as ${authUserName}` : 'FREEVEE',
              message: 'This TV is paired with the FREEVEE server.',
              buttons: ['OK', 'Sign Out'],
              buttonIdx: 0,
              onSelect: (idx) => {
                setDialog(null);
                setFocusTarget('grid');
                if (idx === 1) handleSignOut();
              }
            });
            setFocusTarget('dialog');
          } else {
            showLoginScreen();
          }
        } else if (focusTarget === 'sidebar') {
          activateSidebarItem(sidebarIdx);
        } else if (focusTarget === 'grid' && gridItems[focusedIdx]) {
          handleItemSelect(gridItems[focusedIdx]);
        } else if (focusTarget === 'fresh' && freshItems[freshFocusedIdx]) {
          handleItemSelect(freshItems[freshFocusedIdx]);
        }
      } else if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        if (focusTarget === 'ip' || focusTarget === 'fresh') {
          if (navStack.length === 0 && gridItems.length === 0) setFocusTarget('sidebar');
          else setFocusTarget('grid');
        } else if (focusTarget === 'sidebar') {
          if (navStack.length > 0) popState();
        } else {
          popState();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    gridItems, freshItems, focusedIdx, freshFocusedIdx, sidebarIdx, focusTarget, dialog, player,
    showPairing, navStack, numColumns, popState, handleItemSelect, closePlayerAndSaveProgress,
    isLiveChannel, loggedIn, authUserName, handleSignOut, showLoginScreen, exitPairing,
    navItemCount, activateSidebarItem
  ]);

  // Keyup handler for toggling favorites (long-press Enter or Menu key on Fire TV remote)
  useEffect(() => {
    const handleKeyUp = (e) => {
      if (player || dialog || showPairing) return;
      const isMenuKey = e.key === 'ContextMenu' || e.key === 'm' || e.key === 'M';
      const isLongPressEnter = e.key === 'Enter' && (Date.now() - enterPressTimeRef.current >= 450);
      if (isMenuKey || isLongPressEnter) {
        enterPressTimeRef.current = 0;
        let item = null;
        if (focusTarget === 'grid') item = gridItems[focusedIdx];
        else if (focusTarget === 'fresh') item = freshItems[freshFocusedIdx];
        if (item) {
          const isFavable =
            item.targetType === 'drive_episode' ||
            item.targetType === 'drive_movie' ||
            item.targetType === 'fave_item' ||
            item.targetType === 'service_movie_item' ||
            item.targetType === 'service_tv_item';
          if (isFavable) {
            e.preventDefault();
            toggleFavorite(item);
          }
        }
      }
    };
    window.addEventListener('keyup', handleKeyUp);
    return () => window.removeEventListener('keyup', handleKeyUp);
  }, [player, dialog, showPairing, focusTarget, gridItems, freshItems, focusedIdx, freshFocusedIdx, toggleFavorite]);

  // ---- Startup ----
  useEffect(() => {
    if (loggedIn) {
      loadFavorites();
      loadDriveLibrary();
    }
    showHomeScreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Derived ----
  const currentFocusedItem = focusTarget === 'fresh'
    ? freshItems[freshFocusedIdx]
    : gridItems[focusedIdx];

  const isHome = navStack.length === 0 && !player;
  const chipLabel = loggedIn ? (authUserName || 'Cloud') : 'Sign In';

  return (
    <div className="app-root">
      {/* Full-Screen Poster Background (Home Only) */}
      {isHome && currentFocusedItem?.posterUrl && (
        <div className="full-bg-layer">
          <div className="full-bg-image" style={{ backgroundImage: `url(${currentFocusedItem.posterUrl})` }} />
          <div className="full-bg-overlay" />
        </div>
      )}

      {/* Notification Banner */}
      {notification && (
        <div className="notif-banner">
          <div className="notif-title">{notification.title}</div>
          <div className="notif-msg">{notification.msg}</div>
        </div>
      )}

      {/* Pairing / Sign In Screen */}
      {showPairing && (
        <div className="pairing-screen">
          <div className="pairing-card pairing-layout">
            <div className="pairing-left">
              <div className="pairing-logo">📺</div>
              <div className="pairing-title">Sign In to FREEVEE</div>
              <div className="pairing-subtitle">On your phone or computer, open</div>
              <div className="pairing-url">{getServerUrl()}/device</div>
              {pairingCode ? (
                <>
                  <div className="pairing-code-label">and enter this code</div>
                  <div className="pairing-code">{pairingCode}</div>
                </>
              ) : null}
              <div className="pairing-status">{pairingStatusText}</div>
              <div className="pairing-hint">Press Back to cancel</div>
            </div>
            <div className="pairing-right">
              <img src="images/device-qr.png" alt="Scan to pair your TV" className="pairing-qr" />
              <div className="pairing-qr-hint">Scan with your phone to pair</div>
            </div>
          </div>
        </div>
      )}

      {/* Left Navigation Sidebar */}
      <aside className={`tv-sidebar ${focusTarget === 'sidebar' ? 'expanded' : ''}`}>
        <div className="sidebar-logo">
          📺 <span>FREEVEE</span>
        </div>
        <nav className="sidebar-nav">
          {navDefs.map((def, idx) => (
            <button
              key={def.id}
              className={`nav-item ${activeSidebar === idx ? 'active' : ''} ${focusTarget === 'sidebar' && sidebarIdx === idx ? 'focused' : ''}`}
              onClick={() => activateSidebarItem(idx)}
            >
              <span className="nav-icon">{def.icon}</span>
              <span className="nav-label">{def.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* Main Viewport */}
      <div className="tv-main-viewport">
        {/* Header */}
        <header className="tv-header">
          <div className="breadcrumb-label">{breadcrumb}</div>
          <button
            className={`ip-chip ${focusTarget === 'ip' ? 'focused' : ''}`}
            onClick={() => {
              if (loggedIn) {
                setDialog({
                  title: authUserName ? `Signed in as ${authUserName}` : 'FREEVEE',
                  message: 'This TV is paired with the FREEVEE server.',
                  buttons: ['OK', 'Sign Out'],
                  buttonIdx: 0,
                  onSelect: (idx) => {
                    setDialog(null);
                    setFocusTarget('grid');
                    if (idx === 1) handleSignOut();
                  }
                });
                setFocusTarget('dialog');
              } else {
                showLoginScreen();
              }
            }}
          >
            {chipLabel}
          </button>
        </header>

        {/* Scrollable Viewport */}
        <main className="grid-container">
          {/* Hero Spotlight Billboard (Home Screen Only) */}
          {isHome && (
            <div className="hero-billboard">
              <div className="hero-content">
                <div className="hero-title">{currentFocusedItem?.title || 'FREEVEE'}</div>
                <div className="hero-desc">
                  {currentFocusedItem?.description || 'Browse movies, TV shows, and live channels streamed directly to your TV.'}
                </div>
                <div className="hero-buttons">
                  <button
                    className="hero-btn primary"
                    onClick={() => currentFocusedItem && handleItemSelect(currentFocusedItem)}
                  >
                    ▶ Play Now
                  </button>
                </div>
              </div>
            </div>
          )}

          {!isHome && gridItems.length > 0 && (
            <div className={`poster-grid cols-${numColumns}`}>
              {gridItems.map((item, idx) => (
                <div
                  key={item.id || idx}
                  className={`poster-card size-${numColumns === 5 ? '215' : '165'} ${item.targetType === 'section_header' ? 'section-header' : ''} ${focusTarget === 'grid' && focusedIdx === idx ? 'focused' : ''}`}
                  onClick={() => {
                    setFocusedIdx(idx);
                    setFocusTarget('grid');
                    handleItemSelect(item);
                  }}
                >
                  <div className="poster-image-wrap">
                    <img src={item.posterUrl} alt={item.title} loading="lazy" />
                  </div>
                  <div className="poster-title">{item.title}</div>
                  {item.subtitle && <div className="poster-sub">{item.subtitle}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Fresh Rail (home screen only) */}
          {navStack.length === 0 && focusTarget !== 'player' && !player && freshItems.length > 0 && (
            <section className="cw-section">
              <div className="cw-title">What's On</div>
              <div className="cw-grid">
                {freshItems.map((item, idx) => (
                  <div
                    key={item.id || idx}
                    className={`poster-card size-165 ${focusTarget === 'fresh' && freshFocusedIdx === idx ? 'focused' : ''}`}
                    onClick={() => {
                      setFreshFocusedIdx(idx);
                      setFocusTarget('fresh');
                      handleItemSelect(item);
                    }}
                  >
                    <div className="poster-image-wrap">
                      <img src={item.posterUrl} alt={item.title} loading="lazy" />
                    </div>
                    <div className="poster-title">{item.title}</div>
                    {item.subtitle && <div className="poster-sub">{item.subtitle}</div>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>

      {/* Modal Dialog */}
      {dialog && (
        <div className="modal-backdrop">
          <div className="dialog-box">
            <div className="dialog-title">{dialog.title}</div>
            <div className="dialog-message">{dialog.message}</div>
            <div className="dialog-buttons">
              {dialog.buttons.map((btnLabel, bIdx) => (
                <button
                  key={bIdx}
                  className={`dialog-btn ${dialog.buttonIdx === bIdx ? 'focused' : ''}`}
                  onClick={() => dialog.onSelect(bIdx)}
                >
                  {btnLabel}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Video Player */}
      {player && (
        <div className="player-screen">
          <div className="player-header">
            <button className="back-btn" onClick={closePlayerAndSaveProgress}>← Back</button>
            <div style={{ color: '#fff', fontSize: '18px', fontWeight: 'bold' }}>{player.title}</div>
          </div>
          <video
            ref={videoRef}
            className="player-video"
            autoPlay
            controls
            playsInline
            onEnded={handleVideoEnded}
          />
        </div>
      )}
    </div>
  );
}
