import React, { useState } from 'react';
import { X, Gamepad2, ShieldCheck, HardDrive, Sparkles, Loader2 } from 'lucide-react';
import { fetchJson } from '../utils/api';

export default function AuthModal({ isOpen, onClose }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson('/api/auth/google/url');
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('Google authorization URL was not returned by server');
      }
    } catch (err) {
      setError(err.message || 'Failed to initialize Google login');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="glass-modal w-full max-w-md rounded-2xl overflow-hidden p-6 relative animate-in fade-in zoom-in-95 duration-200">
        <button
          onClick={onClose}
          className="icon-btn icon-btn-sm absolute top-4 right-4"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Modal Brand Header */}
        <div className="text-center pt-2 pb-6">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white mx-auto mb-3 shadow-lg shadow-purple-500/30">
            <Gamepad2 className="w-8 h-8" />
          </div>
          <h2 className="font-heading font-extrabold text-2xl text-white">Connect Google Drive</h2>
          <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
            Sign in with Google to stream your ROM collection and download retro games directly to your Drive.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-xs text-red-300">
            {error}
          </div>
        )}

        {/* Features Checklist */}
        <div className="space-y-3 mb-6 bg-slate-900/60 p-4 rounded-xl border border-white/5 text-xs text-slate-300">
          <div className="flex items-center gap-3">
            <HardDrive className="w-4 h-4 text-cyan-400 shrink-0" />
            <span>Store ROMs in your own private Google Drive</span>
          </div>
          <div className="flex items-center gap-3">
            <Gamepad2 className="w-4 h-4 text-purple-400 shrink-0" />
            <span>Zero install — play retro games directly in browser</span>
          </div>
          <div className="flex items-center gap-3">
            <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
            <span>High-speed automated torrent & ROM downloader</span>
          </div>
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>Secure OAuth 2.0 with minimal permissions</span>
          </div>
        </div>

        {/* Primary Action Button */}
        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="btn-google"
        >
          {loading ? (
            <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
          ) : (
            <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
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
          <span>{loading ? 'Connecting to Google...' : 'Continue with Google'}</span>
        </button>
      </div>
    </div>
  );
}
