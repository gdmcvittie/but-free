import React, { useState } from 'react';
import { Cloud, TriangleAlert, Folder, BookOpen, Zap, Lock } from 'lucide-react';
import { apiUrl } from './api';

interface LoginGateProps {
  authError?: string | null;
  onClearAuthError?: () => void;
}

export default function LoginGate({ authError, onClearAuthError }: LoginGateProps) {
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const displayedError = authError || localError;

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setLocalError(null);
    if (onClearAuthError) onClearAuthError();

    try {
      const res = await fetch(apiUrl('/api/auth/google/url'));
      if (!res.ok) {
        throw new Error(`Authentication server returned error ${res.status}`);
      }
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('Google authorization URL was not provided by the server.');
      }
    } catch (err: any) {
      console.error('[LoginGate] Sign in failed:', err);
      setLocalError(err.message || 'Unable to connect to Google OAuth service. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="login-gate-container">
      <div className="login-gate-backdrop-glow" />

      <div className="login-gate-card">
        {/* Top Header Badge */}

        {/* Brand Title */}
        <div className="login-gate-brand">
          <div className="login-gate-logo-icon">
            <Cloud size={40}/>
          </div>
          <h1 className="login-gate-title">COMIXOLOFREE</h1>
        </div>

        <p className="login-gate-lead">
          Authentication is required to view this server. Please sign in with your Google account to access your comic library, cloud reader, and downloads.
        </p>

        {/* Error Notification */}
        {displayedError && (
          <div className="login-gate-error-banner" role="alert">
            <div className="login-gate-error-content">
              <span className="login-gate-error-icon"><TriangleAlert size={16}/></span>
              <div className="login-gate-error-text">
                <strong>Sign-in notice:</strong> {displayedError}
              </div>
            </div>
            {onClearAuthError && (
              <button
                type="button"
                className="login-gate-error-dismiss"
                onClick={() => {
                  setLocalError(null);
                  onClearAuthError();
                }}
                aria-label="Dismiss error"
              >
                ✕
              </button>
            )}
          </div>
        )}

        {/* Primary Action Button */}
        <div className="login-gate-action-area">
          <button
            type="button"
            className="login-gate-google-btn"
            onClick={handleGoogleSignIn}
            disabled={loading}
          >
            {loading ? (
              <div className="login-gate-spinner" />
            ) : (
              <svg className="login-gate-google-icon" viewBox="0 0 24 24" width="22" height="22">
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
            <span className="login-gate-google-text">
              {loading ? 'Connecting to Google OAuth...' : 'Sign in with Google'}
            </span>
          </button>
        </div>

        {/* Feature Highlights */}
        <div className="login-gate-features">
          <div className="login-gate-feature-item">
            <span className="login-gate-feature-icon"><Folder size={16}/></span>
            <div className="login-gate-feature-desc">
              <strong>Google Drive Sync</strong>
              <span>Stream CBR, CBZ, and Omnibus comics directly from your cloud folders.</span>
            </div>
          </div>
          <div className="login-gate-feature-item">
            <span className="login-gate-feature-icon"><BookOpen size={16}/></span>
            <div className="login-gate-feature-desc">
              <strong>Cross-Device Progress</strong>
              <span>Pick up right where you left off on any mobile device or desktop.</span>
            </div>
          </div>
          <div className="login-gate-feature-item">
            <span className="login-gate-feature-icon"><Zap size={16}/></span>
            <div className="login-gate-feature-desc">
              <strong>Integrated Cloud Scraper</strong>
              <span>Search, download, and compress issues straight into your library.</span>
            </div>
          </div>
        </div>

        {/* Security & Privacy Footnote */}
        <div className="login-gate-footer">
          <p className="login-gate-privacy">
            <Lock size={14}/> Secured via OAuth 2.0. Permissions are strictly scoped to comic reading and selected Drive folders.
          </p>
        </div>
      </div>
    </div>
  );
}
