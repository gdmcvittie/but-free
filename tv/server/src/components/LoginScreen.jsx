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
      background: 'radial-gradient(ellipse at top, #1e1b4b 0%, #09090b 70%)',
      padding: '24px',
      position: 'relative',
      overflow: 'hidden'
    }}>
      {/* Ambient background glows */}
      <div style={{ position: 'absolute', top: '-10%', left: '20%', width: '400px', height: '400px', background: 'rgba(139, 92, 246, 0.15)', borderRadius: '50%', filter: 'blur(100px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '-10%', right: '20%', width: '500px', height: '500px', background: 'rgba(6, 182, 212, 0.12)', borderRadius: '50%', filter: 'blur(120px)', pointerEvents: 'none' }} />

      <div className="glass-panel" style={{
        maxWidth: '480px',
        width: '100%',
        padding: '40px 32px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        borderRadius: '24px',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 24px 64px rgba(0, 0, 0, 0.8)',
        zIndex: 1
      }}>
        {/* App Logo */}
        <div style={{
          width: '68px',
          height: '68px',
          borderRadius: '18px',
          background: 'linear-gradient(135deg, #a78bfa 0%, #6366f1 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 12px 28px rgba(139, 92, 246, 0.4)',
          marginBottom: '20px'
        }}>
          <Tv size={34} color="#fff" />
        </div>

        <h1 style={{ fontSize: '28px', fontFamily: 'var(--font-display)', fontWeight: 800, color: '#fff', margin: 0, letterSpacing: '-0.5px' }}>
          FREE<span style={{ background: 'linear-gradient(90deg, #a78bfa, #22d3ee)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>VEE</span>
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginTop: '8px', marginBottom: '28px', lineHeight: 1.5 }}>
          Your personal streaming hub powered by Google Drive. Stream your movies & TV shows anywhere with zero local storage.
        </p>

        {error && (
          <div style={{
            width: '100%',
            padding: '12px 16px',
            borderRadius: '10px',
            background: 'rgba(244, 63, 94, 0.15)',
            border: '1px solid rgba(244, 63, 94, 0.3)',
            color: '#fca5a5',
            fontSize: '13px',
            marginBottom: '20px',
            textAlign: 'left'
          }}>
            <strong>Authentication Notice:</strong> {error}
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
            padding: '14px 20px',
            borderRadius: '12px',
            background: '#ffffff',
            color: '#1f2937',
            border: 'none',
            fontSize: '15px',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
            transition: 'transform 0.2s ease, box-shadow 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 8px 24px rgba(255, 255, 255, 0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.3)';
          }}
        >
          {/* Google Color SVG Icon */}
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
          </svg>
          Sign in with Google
        </button>

        {/* Feature List */}
        <div style={{ marginTop: '32px', width: '100%', display: 'flex', flexDirection: 'column', gap: '14px', borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '24px', textAlign: 'left' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            <HardDrive size={18} style={{ color: '#22d3ee', flexShrink: 0 }} />
            <span>Connect your Google Drive TV & Movie folders</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            <Layers size={18} style={{ color: '#a78bfa', flexShrink: 0 }} />
            <span>Browse 10+ Streaming Service catalogs (Netflix, Prime, Crave, CBC)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            <Sparkles size={18} style={{ color: '#f59e0b', flexShrink: 0 }} />
            <span>Multi-user isolation with personal Continue Watching progress</span>
          </div>
        </div>
      </div>
    </div>
  );
}
