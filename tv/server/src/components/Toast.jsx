import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info', duration = 4000, onClick = null) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type, onClick }]);
    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
    }
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = {
    success: (msg, dur, onClick) => addToast(msg, 'success', dur, onClick),
    error: (msg, dur, onClick) => addToast(msg, 'error', dur, onClick),
    info: (msg, dur, onClick) => addToast(msg, 'info', dur, onClick),
    warning: (msg, dur, onClick) => addToast(msg, 'warning', dur, onClick)
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 99999, display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'none' }}>
        {toasts.map(t => (
          <div
            key={t.id}
            className="glass-panel"
            onClick={() => {
              if (t.onClick) {
                t.onClick();
                removeToast(t.id);
              }
            }}
            style={{
              padding: '12px 16px',
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontSize: '13px',
              fontWeight: 500,
              color: '#fff',
              background: t.type === 'error' ? 'rgba(244, 63, 94, 0.95)' : t.type === 'warning' ? 'rgba(245, 158, 11, 0.95)' : t.type === 'success' ? 'rgba(16, 185, 129, 0.9)' : 'rgba(22, 22, 28, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              pointerEvents: 'auto',
              minWidth: '260px',
              maxWidth: '420px',
              cursor: t.onClick ? 'pointer' : 'default'
            }}
          >
            {t.type === 'success' && <CheckCircle size={16} />}
            {(t.type === 'error' || t.type === 'warning') && <AlertCircle size={16} />}
            {t.type === 'info' && <Info size={16} />}
            <span style={{ flex: 1, lineHeight: 1.4 }}>{t.message}</span>
            {t.onClick && (
              <span
                style={{
                  background: 'rgba(255, 255, 255, 0.25)',
                  color: '#fff',
                  padding: '3px 8px',
                  borderRadius: '5px',
                  fontSize: '11px',
                  fontWeight: 600,
                  whiteSpace: 'nowrap'
                }}
              >
                Reconnect
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeToast(t.id);
              }}
              style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', opacity: 0.7, padding: '2px' }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) return { success: () => {}, error: () => {}, info: () => {}, warning: () => {} };
  return ctx;
}
