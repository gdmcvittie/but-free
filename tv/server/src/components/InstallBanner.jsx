import React, { useState, useEffect } from 'react';
import { Download, X } from 'lucide-react';

const STORAGE_KEY = 'FREEVEE-install-dismissed';

function isInstalled() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true
  );
}

export default function InstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isInstalled()) return;
    if (localStorage.getItem(STORAGE_KEY)) return;

    const onBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setVisible(true);
    };

    const onAppInstalled = () => {
      setVisible(false);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);

    // iOS Safari fallback: show a hint after a short delay (iOS doesn't fire beforeinstallprompt)
    const isIOs = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOs && !isInstalled()) {
      const t = setTimeout(() => setVisible(true), 2000);
      return () => {
        clearTimeout(t);
        window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
        window.removeEventListener('appinstalled', onAppInstalled);
      };
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  if (!visible || isInstalled()) return null;

  const handleInstall = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setVisible(false);
        setDeferredPrompt(null);
      }
    } else {
      // iOS fallback: guide the user
      window.alert('To install FREEVEE, tap the Share button in Safari, then choose "Add to Home Screen".');
    }
  };

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setVisible(false);
    setDeferredPrompt(null);
  };

  return (
    <div
      className="install-banner"
      role="dialog"
      aria-label="Install FREEVEE"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
        <div
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, #a78bfa 0%, #6366f1 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}
        >
          <Download size={18} color="#fff" />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#fff' }}>Install FREEVEE</div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Add it to your home screen for a full-screen app experience</div>
        </div>
      </div>
      <button className="action-btn primary" onClick={handleInstall} style={{ flexShrink: 0 }}>
        Install
      </button>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss"
        style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', padding: '4px', flexShrink: 0 }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
