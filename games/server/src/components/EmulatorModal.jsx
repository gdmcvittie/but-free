import React, { useEffect, useRef, useState } from 'react';
import { X, Maximize2, Minimize2, Gamepad2, Volume2, RotateCcw, Save } from 'lucide-react';

export default function EmulatorModal({ game, onClose }) {
  const containerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loading, setLoading] = useState(true);

  // Map console IDs to EmulatorJS core names
  const CORE_MAP = {
    snes: 'snes',
    nes: 'nes',
    gba: 'gba',
    gb: 'gb',
    gbc: 'gb',
    sega: 'segaMD',
    genesis: 'segaMD',
    n64: 'n64',
    psx: 'psx',
    ps1: 'psx',
    nds: 'nds',
    pce: 'pce',
    gg: 'segaGG',
    sms: 'segaMS',
    pico8: 'pico8',
    arcade: 'arcade'
  };

  useEffect(() => {
    if (!game) return;
    setLoading(true);

    const core = CORE_MAP[game.console] || 'snes';
    const romUrl = `/api/games/stream/${game.driveId}?filename=${encodeURIComponent(game.filename || 'rom.bin')}`;

    // Clean up any existing iframe or emulator container
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
      
      const iframe = document.createElement('iframe');
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = 'none';
      iframe.allow = 'autoplay; gamepad; fullscreen; keyboard';
      
      // Load self-contained EmulatorJS runner inside iframe
      const runnerHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
            #game { width: 100%; height: 100%; }
          </style>
        </head>
        <body>
          <div id="game"></div>
          <script>
            window.EJS_player = '#game';
            window.EJS_core = '${core}';
            window.EJS_gameUrl = '${romUrl}';
            window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
            window.EJS_startOnLoaded = true;
            window.EJS_color = '#8b5cf6';
          </script>
          <script src="https://cdn.emulatorjs.org/stable/data/loader.js"></script>
        </body>
        </html>
      `;

      iframe.srcdoc = runnerHtml;
      iframe.onload = () => setLoading(false);
      containerRef.current.appendChild(iframe);
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [game]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.parentElement?.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  if (!game) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xl flex flex-col items-center justify-center animate-in fade-in duration-200">
      {/* Top Controls Bar */}
      <div className="w-full bg-slate-950/80 border-b border-white/10 px-6 py-3 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-purple-600/30 border border-purple-500/40 flex items-center justify-center text-purple-300">
            <Gamepad2 className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white font-heading truncate max-w-md">{game.title}</h2>
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <span className="uppercase text-purple-400 font-bold">{game.consoleName || game.console}</span>
              <span>•</span>
              <span>Google Drive Stream</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
            title="Fullscreen"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button
            onClick={onClose}
            className="p-2 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-300 hover:text-red-200 border border-red-500/30 transition"
            title="Exit Game"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Emulator Canvas Container */}
      <div className="relative flex-1 w-full bg-black flex items-center justify-center overflow-hidden">
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 text-slate-400 gap-3 z-0">
            <div className="w-12 h-12 rounded-2xl bg-purple-600/20 border border-purple-500/40 flex items-center justify-center text-purple-400 animate-pulse">
              <Gamepad2 className="w-6 h-6" />
            </div>
            <div className="text-sm font-semibold text-white">Loading Emulator & ROM...</div>
            <div className="text-xs text-slate-500">Streaming from your Google Drive Games library</div>
          </div>
        )}
        <div ref={containerRef} className="w-full h-full relative z-10" />
      </div>
    </div>
  );
}
