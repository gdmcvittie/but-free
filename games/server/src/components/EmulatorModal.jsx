import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Nostalgist } from 'nostalgist';
import {
  X, Play, Pause, RotateCcw, Maximize2, Minimize2,
  Save, FolderInput, Heart, Download, Globe, Loader2
} from 'lucide-react';
import { fetchJson } from '../utils/api';
import { cacheGameForOffline, getCachedRom, isAndroidOfflineMode } from '../utils/offlineGames';

// ---------------------------------------------------------------------------------------------
// In-browser emulator player using Nostalgist + locally bundled libretro WASM cores
// (public/cores/*.js + *.wasm, same engine stack as the my-games client).
// ROM bytes stream from the user's Google Drive via /api/games/stream/:driveId.
// Save states: IndexedDB (instant) + server sync (/api/games/:id/savestate).
// ---------------------------------------------------------------------------------------------

const DB_NAME = 'Freeplay_SaveStates_DB';
const STORE_NAME = 'savestates';

const LOCAL_CORES = new Set([
  'fceumm', 'snes9x', 'mgba', 'gambatte', 'mednafen_pce_fast',
  'genesis_plus_gx', 'gearsystem', 'picodrive', 'fbneo', 'fbalpha2012_neogeo'
]);

const CORE_FOR_CONSOLE = {
  nes: 'fceumm',
  snes: 'snes9x',
  gb: 'mgba',
  gbc: 'mgba',
  gba: 'mgba',
  sega: 'genesis_plus_gx',
  genesis: 'genesis_plus_gx',
  megadrive: 'genesis_plus_gx',
  gg: 'gearsystem',
  gamegear: 'gearsystem',
  sms: 'gearsystem',
  mastersystem: 'gearsystem',
  pce: 'mednafen_pce_fast',
  tg16: 'mednafen_pce_fast',
  neo: 'fbalpha2012_neogeo',
  neogeo: 'fbalpha2012_neogeo',
  arcade: 'fbalpha2012_neogeo'
};

function hasConnectedGamepad() {
  try {
    if (window.FreeplayAndroid?.hasController?.()) return true;
    return typeof navigator.getGamepads === 'function'
      && Array.from(navigator.getGamepads()).some((pad) => pad && pad.connected);
  } catch {
    return false;
  }
}

function openSaveStateDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function getLocalSaveState(userId, gameId) {
  if (!gameId) return null;
  try {
    const db = await openSaveStateDB();
    const key = `${userId || 'anon'}_${gameId}`;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setLocalSaveState(userId, gameId, blob) {
  if (!gameId || !blob) return;
  try {
    const db = await openSaveStateDB();
    const key = `${userId || 'anon'}_${gameId}`;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(blob, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

export default function EmulatorModal({ game, user, onClose, onToggleFavorite }) {
  const screenMountRef = useRef(null);
  const canvasRef = useRef(null);
  const nostalgistRef = useRef(null);
  const containerRef = useRef(null);

  const [isLoading, setIsLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadStage, setLoadStage] = useState('Connecting to Google Drive...');
  const [error, setError] = useState(null);
  const [isPaused, setIsPaused] = useState(false);
  const [toast, setToast] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768 || window.innerHeight <= 500);
  const [orientation, setOrientation] = useState(() => window.innerHeight > window.innerWidth ? 'portrait' : 'landscape');
  const [hasPhysicalGamepad, setHasPhysicalGamepad] = useState(hasConnectedGamepad);

  const isWebGame = !!(game?.isWebGame || game?.console === 'web' || (game?.webUrl || '').startsWith('http'));
  const isPcGame = !isWebGame && (game?.console === 'pc' || game?.isPcGame);
  const isNeoGame = !isWebGame && !isPcGame && ['neo', 'neogeo', 'neo geo', 'arcade'].includes((game?.console || '').toLowerCase());

  const showToast = useCallback((message) => {
    setToast(message);
    setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768 || window.innerHeight <= 500);
      setOrientation(window.innerHeight > window.innerWidth ? 'portrait' : 'landscape');
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  useEffect(() => {
    const onPadConnected = () => setHasPhysicalGamepad(true);
    const onPadDisconnected = () => {
      setHasPhysicalGamepad(hasConnectedGamepad());
    };
    const onNativeControllerChanged = (event) => {
      setHasPhysicalGamepad(!!event.detail?.connected || hasConnectedGamepad());
    };
    window.addEventListener('gamepadconnected', onPadConnected);
    window.addEventListener('gamepaddisconnected', onPadDisconnected);
    window.addEventListener('freeplay:controllerchange', onNativeControllerChanged);
    return () => {
      window.removeEventListener('gamepadconnected', onPadConnected);
      window.removeEventListener('gamepaddisconnected', onPadDisconnected);
      window.removeEventListener('freeplay:controllerchange', onNativeControllerChanged);
    };
  }, []);

  useEffect(() => {
    window.__freeplayAndroidKey = (type, key, code, keyCode) => {
      const browserPadConnected = typeof navigator.getGamepads === 'function'
        && Array.from(navigator.getGamepads()).some((pad) => pad && pad.connected);
      if (browserPadConnected) return;
      const event = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true });
      try { Object.defineProperty(event, 'keyCode', { value: keyCode, configurable: true }); } catch { /* legacy engine */ }
      try { Object.defineProperty(event, 'which', { value: keyCode, configurable: true }); } catch { /* legacy engine */ }
      const canvas = document.querySelector('.game-canvas');
      if (canvas) {
        try { canvas.focus({ preventScroll: true }); } catch { canvas.focus(); }
        canvas.dispatchEvent(event);
      } else {
        window.dispatchEvent(event);
      }
    };
    return () => { delete window.__freeplayAndroidKey; };
  }, []);

  useEffect(() => {
    const bridge = window.FreeplayAndroid;
    if (!bridge?.setImmersiveMode) return undefined;
    bridge.setImmersiveMode(!isWebGame && !isPcGame && hasPhysicalGamepad);
    return () => bridge.setImmersiveMode(false);
  }, [hasPhysicalGamepad, isWebGame, isPcGame]);

  // -------------------------------------------------------------
  // Keyboard event dispatcher (virtual on-screen buttons route here)
  // -------------------------------------------------------------
  const activeTouchButtons = useRef(new Set());

  const keyCodeMap = {
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    KeyZ: 90, KeyX: 88, KeyA: 65, KeyS: 83, KeyQ: 81, KeyW: 87,
    ShiftLeft: 16, ShiftRight: 16, Enter: 13
  };

  const dispatchKeyEvent = useCallback((type, key, code) => {
    const keyCode = keyCodeMap[code] || 0;
    const init = {
      key, code, keyCode, which: keyCode, charCode: keyCode,
      bubbles: true, cancelable: true, composed: true, view: window
    };

    let ev;
    try {
      ev = new KeyboardEvent(type, init);
    } catch {
      ev = document.createEvent('Event');
      ev.initEvent(type, true, true);
    }

    try { Object.defineProperty(ev, 'keyCode', { value: keyCode, configurable: true, writable: true }); } catch {}
    try { Object.defineProperty(ev, 'which', { value: keyCode, configurable: true, writable: true }); } catch {}
    try { Object.defineProperty(ev, 'code', { value: code, configurable: true, writable: true }); } catch {}
    try { Object.defineProperty(ev, 'key', { value: key, configurable: true, writable: true }); } catch {}

    if (canvasRef.current) {
      if (document.activeElement !== canvasRef.current) {
        try { canvasRef.current.focus(); } catch {}
      }
      canvasRef.current.dispatchEvent(ev);
    } else {
      window.dispatchEvent(ev);
    }
  }, []);

  const createVirtualButtonProps = useCallback((key, code) => {
    const btnId = `${key}_${code}`;
    const handlePress = (e) => {
      if (e) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      }
      if (!activeTouchButtons.current.has(btnId)) {
        activeTouchButtons.current.add(btnId);
        dispatchKeyEvent('keydown', key, code);
      }
    };
    const handleRelease = (e) => {
      if (e) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      }
      if (activeTouchButtons.current.has(btnId)) {
        activeTouchButtons.current.delete(btnId);
        dispatchKeyEvent('keyup', key, code);
      }
    };
    return {
      onMouseDown: handlePress,
      onMouseUp: handleRelease,
      onMouseLeave: handleRelease,
      onTouchStart: handlePress,
      onTouchEnd: handleRelease,
      onTouchCancel: handleRelease
    };
  }, [dispatchKeyEvent]);

  // -------------------------------------------------------------
  // Save / load states (IndexedDB + server sync)
  // -------------------------------------------------------------
  const handleSaveState = useCallback(async () => {
    if (!nostalgistRef.current || !game) return;
    try {
      const state = await nostalgistRef.current.saveState();
      if (state && state.state) {
        await setLocalSaveState(user?.id, game.id, state.state);
        try {
          await fetch(`/api/games/${game.id}/savestate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: state.state
          });
        } catch { /* server sync is best-effort */ }
        showToast('State saved & synced');
      }
    } catch {
      showToast('Failed to save state');
    }
  }, [game, user, showToast]);

  const loadStateBlob = useCallback(async () => {
    let blob = await getLocalSaveState(user?.id, game?.id);
    if (!blob) {
      try {
        const res = await fetch(`/api/games/${game.id}/savestate`);
        if (res.ok && res.status === 200) {
          blob = await res.blob();
          if (blob && blob.size > 0) await setLocalSaveState(user?.id, game.id, blob);
        }
      } catch { /* 204 = none */ }
    }
    return blob;
  }, [game, user]);

  const handleLoadState = useCallback(async () => {
    if (!nostalgistRef.current || !game) return;
    const blob = await loadStateBlob();
    if (blob && blob.size > 0) {
      try {
        await nostalgistRef.current.loadState(blob);
        showToast('State loaded');
      } catch {
        showToast('Failed to load state');
      }
    } else {
      showToast('No saved state found');
    }
  }, [game, loadStateBlob, showToast]);

  const handleTogglePause = useCallback(() => {
    if (!nostalgistRef.current) return;
    try {
      if (isPaused) {
        nostalgistRef.current.resume();
        setIsPaused(false);
      } else {
        nostalgistRef.current.pause();
        setIsPaused(true);
      }
    } catch { /* ignore */ }
  }, [isPaused]);

  const handleReset = useCallback(() => {
    if (!nostalgistRef.current) return;
    try {
      nostalgistRef.current.restart();
      setIsPaused(false);
    } catch { /* ignore */ }
  }, []);

  // -------------------------------------------------------------
  // Physical gamepad shortcuts: L1+R1+X save / L1+R1+Y load / Esc quit
  // -------------------------------------------------------------
  useEffect(() => {
    if (isWebGame || isPcGame) return;
    let animFrame = null;
    let lastComboTime = 0;

    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const pad of pads) {
        if (!pad || !pad.connected) continue;
        if (!hasPhysicalGamepad) setHasPhysicalGamepad(true);

        const isDown = (idx) => {
          const btn = pad.buttons[idx];
          return btn && (btn.pressed || btn.value > 0.5);
        };
        const now = Date.now();

        if (isDown(4) && isDown(5) && isDown(0)) {
          if (now - lastComboTime > 1200) { lastComboTime = now; handleSaveState(); }
        }
        if (isDown(4) && isDown(5) && isDown(1)) {
          if (now - lastComboTime > 1200) { lastComboTime = now; handleLoadState(); }
        }
        if (isDown(4) && isDown(5) && isDown(12)) {
          if (now - lastComboTime > 1000) { lastComboTime = now; onClose(); return; }
        }
      }
      animFrame = requestAnimationFrame(poll);
    };

    animFrame = requestAnimationFrame(poll);
    return () => { if (animFrame) cancelAnimationFrame(animFrame); };
  }, [isWebGame, isPcGame, hasPhysicalGamepad, handleSaveState, handleLoadState, onClose]);

  // -------------------------------------------------------------
  // PC game: no emulation, offer Drive download instead
  // -------------------------------------------------------------
  const [pcDriveInfo, setPcDriveInfo] = useState(null);
  useEffect(() => {
    if (!isPcGame || !game?.id) return;
    fetchJson(`/api/games/${game.id}/drive-link`)
      .then((data) => setPcDriveInfo(data))
      .catch(() => setPcDriveInfo(null));
    setIsLoading(false);
    setLoadStage('');
  }, [isPcGame, game]);

  // -------------------------------------------------------------
  // Launch emulator (retro consoles only)
  // -------------------------------------------------------------
  useEffect(() => {
    if (!game || isWebGame || isPcGame) return;
    let isMounted = true;

    async function startEmulator() {
      try {
        setIsLoading(true);
        setError(null);
        setLoadProgress(0);
        setLoadStage('Checking offline library...');

        const targetCore = CORE_FOR_CONSOLE[(game.console || '').toLowerCase()] || 'fceumm';

        let blob = await getCachedRom(user?.id, game.id);
        if (blob) {
          if (isMounted) {
            setLoadProgress(100);
            setLoadStage('Loading downloaded game...');
          }
        } else {
          if (isAndroidOfflineMode() || !navigator.onLine) {
            throw new Error('This game is not saved for offline play yet. Connect to the internet, then favorite or play it once to download it.');
          }
          setLoadStage('Downloading ROM from Google Drive...');
          blob = await cacheGameForOffline(game, user?.id);
          if (!(blob instanceof Blob)) throw new Error('Could not download this game from Google Drive. Check your connection and try again.');
          if (isMounted) setLoadProgress(100);
        }

        if (!isMounted) return;
        setLoadProgress(100);
        setLoadStage('Initializing engine...');

        // Canonical Neo Geo driver map matching arcade ROM sets
        const NEOGEO_DRIVER_MAP = {
          'burning fight': 'burningf',
          'burning_fight': 'burningf',
          'burningf': 'burningf',
          'metal slug': 'mslug',
          'metal slug 2': 'mslug2',
          'metal slug x': 'mslugx',
          'metal slug 3': 'mslug3',
          'metal slug 4': 'mslug4',
          'metal slug 5': 'mslug5',
          'the king of fighters 94': 'kof94',
          'the king of fighters 95': 'kof95',
          'the king of fighters 96': 'kof96',
          'the king of fighters 97': 'kof97',
          'the king of fighters 98': 'kof98',
          'the king of fighters 99': 'kof99',
          'the king of fighters 2000': 'kof2000',
          'the king of fighters 2001': 'kof2001',
          'the king of fighters 2002': 'kof2002',
          'the king of fighters 2003': 'kof2003',
          'king of fighters 94': 'kof94',
          'king of fighters 95': 'kof95',
          'king of fighters 96': 'kof96',
          'king of fighters 97': 'kof97',
          'king of fighters 98': 'kof98',
          'king of fighters 99': 'kof99',
          'king of fighters 2000': 'kof2000',
          'king of fighters 2001': 'kof2001',
          'king of fighters 2002': 'kof2002',
          'king of fighters 2003': 'kof2003',
          'samurai shodown': 'samsho',
          'samurai shodown 2': 'samsho2',
          'samurai shodown 3': 'samsho3',
          'samurai shodown 4': 'samsho4',
          'samurai shodown 5': 'samsho5',
          'samurai shodown 5 special': 'samsh5sp',
          'samurai spirits': 'samsho',
          'fatal fury': 'fatfury1',
          'fatal fury 2': 'fatfury2',
          'fatal fury special': 'fatfursp',
          'fatal fury 3': 'fatfury3',
          'real bout fatal fury': 'rbff1',
          'real bout fatal fury special': 'rbffspec',
          'real bout fatal fury 2': 'rbff2',
          'garou': 'garou',
          'garou mark of the wolves': 'garou',
          'shock troopers': 'shocktro',
          'shock troopers 2nd squad': 'shocktr2',
          'neo turf masters': 'turfmast',
          'blazing star': 'blazstar',
          'pulstar': 'pulstar',
          'windjammers': 'wjammers',
          'twinkle star sprites': 'twinspri',
          'puzzle bobble': 'puzzledp',
          'bust a move': 'pbobblen',
          'sengoku': 'sengoku',
          'sengoku 2': 'sengoku2',
          'sengoku 3': 'sengoku3',
          'top hunter': 'tophuntr',
          'waku waku 7': 'wakuwak7',
          'magician lord': 'maglord',
          'art of fighting': 'aof',
          'art of fighting 2': 'aof2',
          'art of fighting 3': 'aof3',
          'world heroes': 'wh1',
          'world heroes 2': 'wh2',
          'world heroes 2 jet': 'wh2j',
          'world heroes perfect': 'whp',
          'super sidekicks': 'ssideki',
          'super sidekicks 2': 'ssideki2',
          'super sidekicks 3': 'ssideki3',
          'neo bomberman': 'neobombe',
          'strikers 1945 plus': 's1945p',
          'spinmaster': 'spinmast',
          'street hoop': 'strhoop',
          'baseball stars 2': 'bstars2',
          'baseball stars professional': 'bstars',
          'cyber lip': 'cyberlip',
          'ninja commando': 'ncommand',
          'nightmare in the dark': 'nitd',
          'matrimelee': 'matrim',
          'rage of the dragons': 'rotd',
          'snk vs capcom': 'svc',
          'kizuna encounter': 'kizuna',
          'the last blade': 'lastblad',
          'the last blade 2': 'lastbld2',
          'breakers revenge': 'breakrev',
          'blues journey': 'bjourney',
          'captain tomaday': 'ctomada',
          'double dragon': 'doubledr',
          'galaxy fight': 'galaxyfg',
          'ghost pilots': 'gpilot',
          'kabuki klash': 'kabukikl',
          'karnovs revenge': 'karnovr',
          'king of the monsters': 'kotm',
          'king of the monsters 2': 'kotm2',
          'league bowling': 'lbowling',
          'money idol exchanger': 'miexchng',
          'mutation nation': 'mutnat',
          'nam 1975': 'nam1975',
          'neo drift out': 'neodrift',
          'neo mr do': 'neomrdo',
          'ninja combat': 'ncombat',
          'over top': 'overtop',
          'panic bomber': 'panicbom',
          'pop n bounce': 'popbounc',
          'power spikes 2': 'pspikes2',
          'prehistoric isle 2': 'preisl2',
          'puzzle de pon': 'puzzledp',
          'puzz loop 2': 'pzlloop2',
          'ragnagard': 'ragnagrd',
          'robo army': 'roboarmy',
          'savage reign': 'savagere',
          'soccer brawl': 'socbrawl',
          'stake winner': 'stakewin',
          'stake winner 2': 'stakewn2',
          'super dodge ball': 'sdodgeb',
          'thrash rally': 'trally',
          'top players golf': 'tpgolf',
          'viewpoint': 'viewpoin',
          'voltage fighter gowcaizer': 'gowcaizr',
          'zed blade': 'zedblade',
          'zupapa': 'zupapa'
        };

        const isNeoGeo = targetCore === 'fbalpha2012_neogeo' || targetCore === 'fbneo' || (game.console || '').toLowerCase() === 'neo' || (game.console || '').toLowerCase() === 'neogeo' || (game.console || '').toLowerCase() === 'arcade';

        let safeFileName = '';
        if (isNeoGeo) {
          const IGNORED_TERMS = new Set(['neo', 'neogeo', 'arcade', 'game', 'rom', 'zip', 'default', 'file']);
          let resolvedDriver = '';

          const rawFile = (game.filename || game.fileName || '').toLowerCase().replace(/\.(zip|neo|bin)$/i, '').trim();
          if (rawFile && rawFile.length <= 8 && /^[a-z0-9_]+$/.test(rawFile) && !IGNORED_TERMS.has(rawFile)) {
            if (Object.values(NEOGEO_DRIVER_MAP).includes(rawFile)) {
              resolvedDriver = rawFile;
            } else if (NEOGEO_DRIVER_MAP[rawFile]) {
              resolvedDriver = NEOGEO_DRIVER_MAP[rawFile];
            }
          }

          if (!resolvedDriver) {
            const candidateStrings = [
              game.cleanTitle || '',
              game.title || '',
              game.filename || '',
              game.fileName || ''
            ].filter(Boolean);

            for (const rawStr of candidateStrings) {
              const clean = rawStr.toLowerCase().replace(/\.(zip|neo|bin)$/i, '').replace(/[^a-z0-9]/g, '');
              if (!clean || IGNORED_TERMS.has(clean)) continue;

              for (const [key, driver] of Object.entries(NEOGEO_DRIVER_MAP)) {
                const normKey = key.replace(/[^a-z0-9]/g, '');
                if (clean === normKey) {
                  resolvedDriver = driver;
                  break;
                }
              }
              if (resolvedDriver) break;

              for (const [key, driver] of Object.entries(NEOGEO_DRIVER_MAP)) {
                const normKey = key.replace(/[^a-z0-9]/g, '');
                if (normKey.length >= 4 && clean.includes(normKey)) {
                  resolvedDriver = driver;
                  break;
                }
              }
              if (resolvedDriver) break;

              if (clean.length >= 6) {
                for (const [key, driver] of Object.entries(NEOGEO_DRIVER_MAP)) {
                  const normKey = key.replace(/[^a-z0-9]/g, '');
                  if (normKey.includes(clean)) {
                    resolvedDriver = driver;
                    break;
                  }
                }
              }
              if (resolvedDriver) break;
            }
          }

          if (!resolvedDriver && rawFile && rawFile.length <= 8 && /^[a-z0-9_]+$/.test(rawFile)) {
            resolvedDriver = rawFile;
          }

          safeFileName = `${resolvedDriver || 'mslug'}.zip`;
        } else {
          const fn = game.filename || `${(game.cleanTitle || game.title || 'game')}.bin`;
          const dotIdx = fn.lastIndexOf('.');
          if (dotIdx <= 0) {
            safeFileName = `${fn}.sfc`;
          } else {
            const base = fn.slice(0, dotIdx).replace(/[^a-zA-Z0-9_\- ]/g, '_').trim() || 'game';
            safeFileName = `${base}${fn.slice(dotIdx).toLowerCase()}`;
          }
        }

        const romFile = new File([blob], safeFileName);

        const resolveCoreJs = (core) => `/cores/${core}_libretro.js`;
        const resolveCoreWasm = (core) => `/cores/${core}_libretro.wasm`;

        let neogeoBiosFile = null;
        let neogeoBiosBlob = null;
        if (isNeoGeo) {
          for (const biosUrl of ['/bios/neogeo.zip', '/cores/neogeo.zip', '/neogeo.zip', 'https://raw.githubusercontent.com/Abdess/retroarch_system/libretro/neogeo.zip', 'https://raw.githubusercontent.com/OpenEmu/OpenEmu-Update/master/Bios/neogeo.zip']) {
            try {
              const bRes = await fetch(biosUrl);
              if (bRes.ok) {
                const bBlob = await bRes.blob();
                if (bBlob && bBlob.size > 1000) {
                  neogeoBiosBlob = bBlob;
                  neogeoBiosFile = new File([bBlob], 'neogeo.zip');
                  break;
                }
              }
            } catch { /* continue */ }
          }
        }

        const mount = screenMountRef.current;
        const rect = mount ? mount.getBoundingClientRect() : null;
        const targetW = rect && rect.width > 50 ? Math.round(rect.width) : (window.innerWidth || 390);
        const targetH = rect && rect.height > 50 ? Math.round(rect.height) : Math.round((window.innerHeight || 800) * 0.6);

        let canvas = mount ? mount.querySelector('canvas') : null;
        if (!canvas) {
          canvas = document.createElement('canvas');
          canvas.className = 'game-canvas';
          canvas.width = targetW;
          canvas.height = targetH;
          if (mount) {
            mount.innerHTML = '';
            mount.appendChild(canvas);
          }
        }
        canvasRef.current = canvas;

        const biosList = (isNeoGeo && neogeoBiosFile) ? [neogeoBiosFile] : (isNeoGeo ? ['/cores/neogeo.zip', '/neogeo.zip'] : undefined);
        const romList = (isNeoGeo && neogeoBiosFile) ? [romFile, neogeoBiosFile] : romFile;

        // Button layout mapping (supports Konkr Pocket Fit / handheld ABXY buttons)
        const isHandheldOrKonkr = /Android|Mobile|Linux arm/i.test(navigator.userAgent) || ('ontouchstart' in window);
        const gamepadButtonConfig = isHandheldOrKonkr ? {
          input_player1_a_btn: '2',
          input_player1_b_btn: '3',
          input_player1_x_btn: '0',
          input_player1_y_btn: '1'
        } : {
          input_player1_a_btn: '0',
          input_player1_b_btn: '1',
          input_player1_x_btn: '2',
          input_player1_y_btn: '3'
        };

        const launchConfig = {
          core: targetCore,
          ...(LOCAL_CORES.has(targetCore) ? { resolveCoreJs, resolveCoreWasm } : {}),
          ...(biosList ? { bios: biosList } : {}),
          rom: romList,
          element: canvas,
          beforeLaunch: async (nostalgistInstance) => {
            try {
              const Module = nostalgistInstance?.getEmscriptenModule?.() || nostalgistInstance?.getEmscripten?.()?.Module;
              const FS = nostalgistInstance?.getEmscriptenFS?.() || Module?.FS;

              if (Module && Module.callMain) {
                const origCallMain = Module.callMain;
                Module.callMain = function(args) {
                  if (isNeoGeo) {
                    const contentPath = `/home/web_user/retroarch/userdata/content/${safeFileName}`;
                    const configPath = '/home/web_user/retroarch/userdata/retroarch.cfg';
                    return origCallMain.call(this, ['-c', configPath, contentPath]);
                  }
                  return origCallMain.call(this, args);
                };
              }

              if (FS && isNeoGeo) {
                const writeSafe = (targetPath, data) => {
                  try {
                    const lastSlash = targetPath.lastIndexOf('/');
                    if (lastSlash > 0) {
                      const dir = targetPath.substring(0, lastSlash);
                      try { FS.mkdirTree(dir); } catch (_) {}
                    }
                    FS.writeFile(targetPath, data);
                  } catch (_) {}
                };

                const romBuf = await blob.arrayBuffer();
                const romData = new Uint8Array(romBuf);
                writeSafe(`/home/web_user/retroarch/userdata/content/${safeFileName}`, romData);

                if (neogeoBiosBlob) {
                  const biosBuf = await neogeoBiosBlob.arrayBuffer();
                  const biosData = new Uint8Array(biosBuf);
                  writeSafe('/home/web_user/retroarch/userdata/system/neogeo.zip', biosData);
                  writeSafe('/home/web_user/retroarch/userdata/content/neogeo.zip', biosData);
                } else {
                  writeSafe('/home/web_user/retroarch/userdata/content/neogeo.zip', romData);
                }
              }
            } catch (fsErr) {
              console.warn('[Emulator] beforeLaunch FS injection warning:', fsErr);
            }
          },
          retroarchConfig: {
            system_directory: '/home/web_user/retroarch/userdata/system',
            content_directory: '/home/web_user/retroarch/userdata/content',
            rgui_browser_directory: '/home/web_user/retroarch/userdata/content',
            video_smooth: false,
            input_player1_up: 'up',
            input_player1_down: 'down',
            input_player1_left: 'left',
            input_player1_right: 'right',
            input_player1_a: 'x',
            input_player1_b: 'z',
            input_player1_x: 's',
            input_player1_y: 'a',
            input_player1_l: 'q',
            input_player1_r: 'w',
            input_player1_select: 'rshift',
            input_player1_start: 'enter',
            ...gamepadButtonConfig
          },
          style: {
            width: '100%',
            height: '100%',
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            imageRendering: 'pixelated',
            display: 'block',
            outline: 'none',
            border: 'none',
            boxShadow: 'none',
            background: '#000'
          }
        };

        let nostalgist;
        try {
          nostalgist = await Nostalgist.launch(launchConfig);
        } catch (launchErr) {
          // Fallback chain: gb/gbc -> gambatte, sega -> picodrive, neo -> fbneo alternate, else Nostalgist CDN cores
          const cLower = (game.console || '').toLowerCase();
          let retry = null;
          if ((cLower === 'gb' || cLower === 'gbc') && targetCore !== 'gambatte') {
            retry = { ...launchConfig, core: 'gambatte' };
          } else if (['sega', 'genesis', 'gg', 'sms'].includes(cLower)) {
            retry = { ...launchConfig, core: 'picodrive' };
          } else if (cLower === 'neo' || cLower === 'neogeo' || cLower === 'arcade' || isNeoGeo) {
            const alternateNeoCore = targetCore === 'fbneo' ? 'fbalpha2012_neogeo' : 'fbneo';
            retry = { ...launchConfig, core: alternateNeoCore };
          } else {
            retry = { ...launchConfig };
            delete retry.resolveCoreJs;
            delete retry.resolveCoreWasm;
          }
          try {
            nostalgist = await Nostalgist.launch(retry);
          } catch {
            throw launchErr;
          }
        }

        if (!isMounted) {
          nostalgist.exit();
          return;
        }

        try {
          const actualCanvas = nostalgist.getCanvas?.() || canvas;
          if (actualCanvas && screenMountRef.current && actualCanvas.parentElement !== screenMountRef.current) {
            screenMountRef.current.innerHTML = '';
            screenMountRef.current.appendChild(actualCanvas);
          }
        } catch { /* ignore */ }

        nostalgistRef.current = nostalgist;
        setIsLoading(false);

        setTimeout(() => {
          try {
            const c = nostalgist.getCanvas?.() || canvasRef.current;
            c?.focus?.({ preventScroll: true });
          } catch { /* ignore */ }
        }, 200);

        // Auto-restore saved state
        try {
          const savedBlob = await loadStateBlob();
          if (savedBlob && savedBlob.size > 0 && isMounted) {
            await nostalgist.loadState(savedBlob);
            showToast('Restored save state');
          }
        } catch { /* ignore */ }
      } catch (err) {
        console.error('[Emulator] Launch failed:', err);
        if (isMounted) {
          setError(err.message || 'Failed to initialize the emulator engine.');
          setIsLoading(false);
        }
      }
    }

    startEmulator();

    return () => {
      isMounted = false;
      if (nostalgistRef.current) {
        try { nostalgistRef.current.exit(); } catch { /* ignore */ }
        nostalgistRef.current = null;
      }
    };
  }, [game, isWebGame, isPcGame, loadStateBlob, showToast]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!game) return null;

  const isFav = !!game.isFavorite;

  // -------------------------------------------------------------
  // WEB GAME (HTML5 iframe via embed proxy)
  // -------------------------------------------------------------
  if (isWebGame) {
    const rawUrl = game.playUrl || game.webUrl;
    const embedUrl = `/api/web-game/embed?url=${encodeURIComponent(rawUrl)}`;
    return (
      <div
        ref={containerRef}
        className="rom-emulator-overlay fixed inset-0 bg-black flex flex-col"
        style={{ backgroundColor: '#000000', zIndex: 99999 }}
      >
        <div className="flex items-center justify-between px-4 py-2.5 bg-slate-950 border-b border-white/10" style={{ backgroundColor: '#020617' }}>
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-300 shrink-0">
              <Globe className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-white truncate max-w-[240px]">{game.title}</h2>
              <div className="text-[11px] text-slate-400">HTML5 Web Game</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onToggleFavorite && (
              <button
                onClick={() => onToggleFavorite(game.id)}
                className={`icon-btn icon-btn-sm ${isFav ? 'active' : ''}`}
                title="Favorite"
              >
                <Heart className={`w-4 h-4 ${isFav ? 'fill-amber-400' : ''}`} />
              </button>
            )}
            <button
              onClick={onClose}
              className="icon-btn icon-btn-sm danger"
              title="Exit"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <iframe
          src={embedUrl}
          title={game.title}
          className="flex-1 w-full border-0 bg-black"
          style={{ backgroundColor: '#000000' }}
          allow="autoplay; fullscreen *; gamepad; accelerometer; gyroscope; cross-origin-isolated"
          allowFullScreen
        />
      </div>
    );
  }

  // -------------------------------------------------------------
  // PC GAME (Drive download instead of emulation)
  // -------------------------------------------------------------
  if (isPcGame) {
    return (
      <div
        ref={containerRef}
        className="rom-emulator-overlay fixed inset-0 bg-black flex items-center justify-center p-6"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.95)', zIndex: 99999 }}
      >
        <div className="glass-panel max-w-md w-full p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-heading font-bold text-lg text-white">{game.title}</h2>
            <button onClick={onClose} className="icon-btn icon-btn-sm danger" title="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            This is a PC game stored in your Google Drive. PC titles can't be emulated in the browser —
            download the installer files and run them on your computer.
          </p>
          <div className="text-[11px] text-slate-500 flex items-center gap-2">
            <FolderInput className="w-3.5 h-3.5" />
            <span>{game.fileCount ? `${game.fileCount} file(s)` : game.filename || ''} • {game.sizeFormatted || ''}</span>
          </div>
          <div className="space-y-2 pt-2">
            {pcDriveInfo?.directUrl && !pcDriveInfo?.links?.length && (
              <a href={pcDriveInfo.directUrl} target="_blank" rel="noreferrer" className="btn btn-primary w-full">
                <Download className="w-4 h-4" />
                <span>Download from Drive</span>
              </a>
            )}
            {pcDriveInfo?.links?.length > 0 && (
              <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                {pcDriveInfo.links.map((l) => (
                  <a
                    key={l.url}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/80 border border-white/5 hover:border-purple-500/40 text-xs text-slate-300 transition"
                  >
                    <Download className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                    <span className="truncate">{l.name}</span>
                  </a>
                ))}
              </div>
            )}
            {pcDriveInfo?.folderViewUrl && (
              <a href={pcDriveInfo.folderViewUrl} target="_blank" rel="noreferrer" className="btn btn-secondary w-full">
                <FolderInput className="w-4 h-4" />
                <span>Open folder in Google Drive</span>
              </a>
            )}
            {!pcDriveInfo && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Loading Drive links...</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // RETRO EMULATION VIEW
  // -------------------------------------------------------------
  const renderDPad = () => (
    <div className="retro-dpad">
      <div />
      <button className="retro-dpad-btn" {...createVirtualButtonProps('ArrowUp', 'ArrowUp')}>▲</button>
      <div />
      <button className="retro-dpad-btn" {...createVirtualButtonProps('ArrowLeft', 'ArrowLeft')}>◀</button>
      <div style={{ background: '#111827', borderRadius: '4px' }} />
      <button className="retro-dpad-btn" {...createVirtualButtonProps('ArrowRight', 'ArrowRight')}>▶</button>
      <div />
      <button className="retro-dpad-btn" {...createVirtualButtonProps('ArrowDown', 'ArrowDown')}>▼</button>
      <div />
    </div>
  );

  const renderActionButtons = () => (
    <div className="retro-action-cluster">
      <div />
      <button className="retro-action-btn" {...createVirtualButtonProps('s', 'KeyS')}>X</button>
      <div />
      <button className="retro-action-btn" {...createVirtualButtonProps('a', 'KeyA')}>Y</button>
      <div />
      <button className="retro-action-btn" {...createVirtualButtonProps('x', 'KeyX')}>A</button>
      <div />
      <button className="retro-action-btn" {...createVirtualButtonProps('z', 'KeyZ')}>B</button>
      <div />
    </div>
  );

  const headerBar = (className = '') => (
    <div className={`freeplay-game-toolbar ${className}`}>
      <div className="freeplay-game-toolbar-actions">
        <button onClick={handleTogglePause} disabled={isLoading} className="icon-btn icon-btn-sm" title={isPaused ? 'Resume' : 'Pause'} aria-label={isPaused ? 'Resume' : 'Pause'}>
          {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
        </button>
        <button onClick={handleReset} disabled={isLoading} className="icon-btn icon-btn-sm" title="Reset" aria-label="Reset">
          <RotateCcw className="w-4 h-4" />
        </button>
        <button onClick={handleSaveState} disabled={isLoading} className="icon-btn icon-btn-sm" title="Save State" aria-label="Save state">
          <Save className="w-4 h-4" />
        </button>
        <button onClick={handleLoadState} disabled={isLoading} className="icon-btn icon-btn-sm" title="Load State" aria-label="Load state">
          <FolderInput className="w-4 h-4" />
        </button>
        <button onClick={toggleFullscreen} className="icon-btn icon-btn-sm" title="Fullscreen" aria-label="Fullscreen">
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
        {onToggleFavorite && (
          <button
            onClick={() => onToggleFavorite(game.id)}
            className={`icon-btn icon-btn-sm ${isFav ? 'active' : ''}`}
            title={isFav ? 'Remove Favorite' : 'Add Favorite'}
            aria-label={isFav ? 'Remove favorite' : 'Add favorite'}
          >
            <Heart className={`w-4 h-4 ${isFav ? 'fill-amber-400' : ''}`} />
          </button>
        )}
      </div>
      <div className="freeplay-game-toolbar-exit">
        <button onClick={onClose} className="icon-btn icon-btn-sm danger" title="Exit Game" aria-label="Exit game">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  const screenArea = (
    <div className="relative flex-1 w-full bg-black flex items-center justify-center overflow-hidden min-h-0">
      {isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 gap-4 z-20">
          <div className="w-10 h-10 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <div className="text-sm font-semibold text-white">{loadStage}</div>
          <div className="w-56 h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div className="h-full bg-gradient-to-br from-purple-500 to-indigo-600 transition-all duration-200" style={{ width: `${loadProgress}%` }} />
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950 z-30 p-6">
          <div className="text-center max-w-sm">
            <h3 className="font-heading font-bold text-base text-red-400 mb-2">Emulation Error</h3>
            <p className="text-xs text-slate-400 mb-4 leading-relaxed">{error}</p>
            <button onClick={onClose} className="btn btn-secondary btn-sm">Close Game</button>
          </div>
        </div>
      )}
      <div ref={screenMountRef} className="game-screen-mount w-full h-full" tabIndex={-1} />
      {toast && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-xl bg-purple-600/90 text-white text-xs font-semibold shadow-lg backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );

  // Portrait handheld layout: screen above the Game Boy-style controls.
  if (isMobile && orientation === 'portrait' && !hasPhysicalGamepad) {
    return (
      <div ref={containerRef} className="gb-portrait-chassis">
        {headerBar('gb-portrait-header')}
        <div className="gb-portrait-screen-bezel">
          <div className="gb-screen-top-bar">
            <span className="gb-screen-status"><i className="gb-power-led" /> POWER</span>
            <span className="gb-screen-status">STEREO SOUND</span>
          </div>
          <div className="gb-screen-body">{screenArea}</div>
          <div className="gb-screen-brand">FREEPLAY RETRO</div>
        </div>
        <div className="gb-portrait-controls">
          <div className="gb-shoulder-bar">
            <button className="retro-shoulder-btn" {...createVirtualButtonProps('q', 'KeyQ')}>L</button>
            <button className="retro-shoulder-btn" {...createVirtualButtonProps('w', 'KeyW')}>R</button>
          </div>
          <div className="gb-main-controls">
            {renderDPad()}
            {renderActionButtons()}
          </div>
          <div className="gb-meta-controls">
            <button className="retro-meta-btn" {...createVirtualButtonProps('Shift', 'ShiftLeft')}>{isNeoGame ? 'INSERT COIN' : 'SELECT'}</button>
            <button className="retro-meta-btn" {...createVirtualButtonProps('Enter', 'Enter')}>START</button>
          </div>
        </div>
      </div>
    );
  }

  // Landscape handheld layout: GBA-style controls on either side of the screen.
  if (isMobile && orientation === 'landscape' && !hasPhysicalGamepad) {
    return (
      <div ref={containerRef} className="gba-landscape-chassis">
        {headerBar('gba-floating-header')}
        <div className="gba-left-wing">
          <button className="retro-shoulder-btn gba-shoulder-btn" {...createVirtualButtonProps('q', 'KeyQ')}>L</button>
          {renderDPad()}
          <button className="retro-meta-btn" {...createVirtualButtonProps('Shift', 'ShiftLeft')}>{isNeoGame ? 'INSERT COIN' : 'SELECT'}</button>
        </div>
        <div className="gba-center-screen">
          <div className="gba-screen-bezel">{screenArea}</div>
        </div>
        <div className="gba-right-wing">
          <button className="retro-shoulder-btn gba-shoulder-btn" {...createVirtualButtonProps('w', 'KeyW')}>R</button>
          {renderActionButtons()}
          <button className="retro-meta-btn" {...createVirtualButtonProps('Enter', 'Enter')}>START</button>
        </div>
      </div>
    );
  }

  // Desktop and physical-controller layout: full-screen canvas, no touch controls.
  return (
    <div ref={containerRef} className="freeplay-gamepad-stage">
      {headerBar('freeplay-game-toolbar-overlay')}
      <div className="freeplay-gamepad-screen">{screenArea}</div>
    </div>
  );
}
