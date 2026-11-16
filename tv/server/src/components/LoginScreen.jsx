import React from 'react';
import { Tv, PlayCircle, Sparkles, HardDrive, Layers, ShieldCheck, ArrowRight } from 'lucide-react';
import { loginWithGoogle } from '../utils/auth.js';

export default function LoginScreen({ error }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#121214',
      padding: '24px',
      position: 'relative',
      overflow: 'hidden'
    }}>
      <div style={{
        maxWidth: '460px',
        width: '100%',
        padding: '36px 32px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        borderRadius: '6px',
        background: '#1a1a20',
        border: '1px solid #2e2e3c',
        boxShadow: '0 20px 50px rgba(0, 0, 0, 0.8)',
        zIndex: 1
      }}>
        {/* App Logo / Adobe Badge */}
        <div style={{
          width: '52px',
          height: '52px',
          borderRadius: '6px',
          background: '#7c3aed',
          border: '1px solid #9061f9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 8px 24px rgba(124, 58, 237, 0.35)',
          marginBottom: '18px'
        }}>
          <span style={{ fontSize: '24px', fontWeight: 900, color: '#fff', letterSpacing: '-0.5px' }}>Ft</span>
        </div>

        <h1 style={{ fontSize: '24px', fontWeight: 800, color: '#fff', margin: 0, letterSpacing: '0.5px' }}>
          FREE<span style={{ color: '#a78bfa' }}>VEE</span>
        </h1>
        <div style={{
          fontSize: '10.5px',
          fontWeight: 700,
          color: '#a78bfa',
          letterSpacing: '1.5px',
          textTransform: 'uppercase',
          marginTop: '3px',
          marginBottom: '14px',
          fontFamily: 'monospace'
        }}>
          Television Workstation
        </div>

        <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '24px', lineHeight: 1.5, maxWidth: '380px' }}>
          Authentication required. Connect your Google account to mount your Google Drive TV & Movie library into the Freevee workstation.
        </p>

        {error && (
          <div style={{
            width: '100%',
            padding: '12px 14px',
            borderRadius: '4px',
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#fca5a5',
            fontSize: '12.5px',
            marginBottom: '20px',
            textAlign: 'left',
            fontFamily: 'monospace'
          }}>
            <strong>Notice:</strong> {error}
          </div>
        )}

        {/* Google Sign In Button */}
        <button
          onClick={loginWithGoogle}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            padding: '12px 20px',
            borderRadius: '4px',
            background: '#22222a',
            color: '#ffffff',
            border: '1px solid #3b3b4c',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#282834';
            e.currentTarget.style.borderColor = '#8b5cf6';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#22222a';
            e.currentTarget.style.borderColor = '#3b3b4c';
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
          </svg>
          <span>Sign in with Google</span>
        </button>

        {/* Feature Highlights */}
        <div style={{ marginTop: '24px', width: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            borderRadius: '4px',
            background: '#15151a',
            border: '1px solid #282834',
            textAlign: 'left',
            fontSize: '12px',
            color: '#d1d5db'
          }}>
            <Tv size={16} style={{ color: '#a78bfa', flexShrink: 0 }} />
            <span>Watch Live TV, 24/7 channels & streaming services</span>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            borderRadius: '4px',
            background: '#15151a',
            border: '1px solid #282834',
            textAlign: 'left',
            fontSize: '12px',
            color: '#d1d5db'
          }}>
            <HardDrive size={16} style={{ color: '#38bdf8', flexShrink: 0 }} />
            <span>Mount your Google Drive TV & movie library</span>
          </div>
        </div>
      </div>
    </div>
  );
}
