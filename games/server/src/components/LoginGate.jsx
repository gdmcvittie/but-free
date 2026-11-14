import React, { useState } from 'react';
import { Gamepad2, HardDrive, Play, Sparkles, ShieldCheck, Loader2 } from 'lucide-react';
import { fetchJson } from '../utils/api';

export default function LoginGate({ authError, onClearAuthError }) {
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState(null);

  const displayedError = authError || localError;

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setLocalError(null);
    if (onClearAuthError) onClearAuthError();

    try {
      const data = await fetchJson('/api/auth/google/url');
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('Google authorization URL was not returned by server');
      }
    } catch (err) {
      setLocalError(err.message || 'Unable to connect to Google OAuth service. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#181818] flex items-center justify-center p-4 relative overflow-hidden">
      <div className="glass-panel w-full max-w-md rounded-sm p-7 border border-[#383838] bg-[#222222] relative z-10 shadow-2xl space-y-5 animate-in fade-in duration-200">
        {/* Brand Header */}
        <div className="text-center space-y-2.5">
          <div className="adobe-app-badge mx-auto" style={{ width: 44, height: 44, borderRadius: 6 }}>
            <span className="adobe-app-badge-text" style={{ fontSize: 20 }}>Fp</span>
          </div>
          <div>
            <div className="font-extrabold text-2xl tracking-wide flex items-center justify-center gap-1.5 text-white">
              <span>FREEPLAY</span>
            </div>
            <p className="text-[10px] uppercase font-bold text-[#31a8ff] tracking-widest font-mono mt-0.5">Cloud Asset Workstation</p>
          </div>
          <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
            Authentication required. Connect your Google account to mount your Google Drive ROM collection into the Freeplay workstation.
          </p>
        </div>

        {/* Error notification */}
        {displayedError && (
          <div className="p-3 rounded-sm bg-[#2c1a1a] border border-red-500/40 text-xs text-red-300 flex items-center justify-between font-mono">
            <span>{displayedError}</span>
            <button
              onClick={() => {
                setLocalError(null);
                if (onClearAuthError) onClearAuthError();
              }}
              className="icon-btn icon-btn-sm"
            >
              ✕
            </button>
          </div>
        )}

        {/* Sign In Button */}
        <div>
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="btn-google"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin text-[#31a8ff]" />
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
            )}
            <span>{loading ? 'Connecting to OAuth...' : 'Sign in with Google'}</span>
          </button>
        </div>

        {/* Highlight Features */}
        <div className="space-y-2 pt-1 text-xs text-slate-300">
          <div className="p-2.5 rounded-sm bg-[#1a1a1a] border border-[#333333] flex items-center gap-3">
            <HardDrive className="w-4 h-4 text-[#31a8ff] shrink-0" />
            <div>
              <strong className="text-white block text-[11.5px]">Google Drive Cloud Storage</strong>
              <span className="text-slate-400 text-[10.5px]">Direct streaming access to your cloud ROM folders without saving locally.</span>
            </div>
          </div>

          <div className="p-2.5 rounded-sm bg-[#1a1a1a] border border-[#333333] flex items-center gap-3">
            <Play className="w-4 h-4 text-[#31a8ff] shrink-0" />
            <div>
              <strong className="text-white block text-[11.5px]">In-Browser Workstation Engine</strong>
              <span className="text-slate-400 text-[10.5px]">Play PS1, N64, NDS, GBA, SNES and arcade titles in your desktop browser.</span>
            </div>
          </div>
        </div>

        {/* Security Footer */}
        <div className="text-center pt-2 border-t border-white/5">
          <p className="text-[11px] text-slate-500 flex items-center justify-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Secured via OAuth 2.0. Permissions restricted to your selected Games folder.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
