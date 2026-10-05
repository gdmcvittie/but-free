import { useState } from 'react';
import { api } from './api';

function GoogleIcon({ size = 22 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
    </svg>
  );
}

export default function LoginGate({ authError, onClearAuthError }) {
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState(null);

  const displayedError = authError || localError;

  const handleSignIn = async () => {
    setLoading(true);
    setLocalError(null);
    if (onClearAuthError) onClearAuthError();

    try {
      const data = await api.googleUrl();
      if (!data.url) throw new Error('The server did not return a Google authorization URL.');
      window.location.href = data.url;
    } catch (err) {
      setLocalError(err.message || 'Could not reach the Google OAuth service. Check GOOGLE_CLIENT_ID in .env.');
      setLoading(false);
    }
  };

  return (
    <div className="login-gate-container">
      <div className="login-gate-backdrop-glow" />

      <div className="login-gate-card">

        <div className="login-gate-brand">
          <div className="login-gate-logo-icon" role="img" aria-label="Audio">🎧</div>
          <h1 className="login-gate-title">FRAUDIO</h1>
        </div>

        <p className="login-gate-lead">
          Sign in with Google to point FRAUDIO at your audiobook and music folders in Drive.
          Everything streams from your own storage.
        </p>

        {displayedError && (
          <div className="login-gate-error-banner" role="alert">
            <div>{displayedError}</div>
            {onClearAuthError && (
              <button type="button" className="login-gate-error-dismiss" onClick={onClearAuthError} aria-label="Dismiss">
                ✕
              </button>
            )}
          </div>
        )}

        <button type="button" className="login-gate-google-btn" onClick={handleSignIn} disabled={loading}>
          {loading ? <div className="spinner" /> : <GoogleIcon />}
          <span>{loading ? 'Connecting to Google…' : 'Sign in with Google'}</span>
        </button>

        <div className="login-gate-features">
          <div className="login-gate-feature-item">
            <span className="login-gate-feature-icon">📚</span>
            <div className="login-gate-feature-desc">
              <strong>Two libraries, one app</strong>
              <span>Point FRAUDIO at separate Drive folders for audiobooks and music.</span>
            </div>
          </div>
          <div className="login-gate-feature-item">
            <span className="login-gate-feature-icon">⏱️</span>
            <div className="login-gate-feature-desc">
              <strong>Resumes where you stopped</strong>
              <span>Playback position syncs across every device you sign in on.</span>
            </div>
          </div>
          <div className="login-gate-feature-item">
            <span className="login-gate-feature-icon">📥</span>
            <div className="login-gate-feature-desc">
              <strong>Offline listening</strong>
              <span>Cache books and albums locally, then play without a connection.</span>
            </div>
          </div>
        </div>

        <div className="login-gate-footer">
          <p className="login-gate-privacy">
            🔒 Secured with OAuth 2.0. FRAUDIO never stores your Drive password, and only
            reads the folders you choose.
          </p>
        </div>
      </div>
    </div>
  );
}