'use client';

import { useState } from 'react';
import AutocutMark from '@/components/branding/AutocutMark';

export default function WaitlistPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'duplicate' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || status === 'loading') return;
    setStatus('loading');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) { setStatus('error'); return; }
      setStatus(data.alreadyJoined ? 'duplicate' : 'success');
    } catch {
      setStatus('error');
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#111111',
      color: 'rgba(255,255,255,0.92)',
      fontFamily: 'var(--font-serif), system-ui, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 24px',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32, maxWidth: 440, width: '100%' }}>
        <AutocutMark size={40} withTile />

        <div style={{ textAlign: 'center' }}>
          <h1 style={{
            fontSize: 36, fontWeight: 700, letterSpacing: '-0.035em',
            lineHeight: 1.1, margin: '0 0 14px',
          }}>
            Join the waitlist
          </h1>
          <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.42)', lineHeight: 1.65, margin: 0 }}>
            Autocut is currently invite-only. Drop your email and we&apos;ll reach out when a spot opens up.
          </p>
        </div>

        {status === 'success' ? (
          <div style={{
            textAlign: 'center',
            padding: '24px 32px',
            background: 'rgba(74,222,128,0.08)',
            border: '1px solid rgba(74,222,128,0.25)',
            borderRadius: 14,
            width: '100%',
          }}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>✓</div>
            <div style={{ fontSize: 15, color: '#4ade80', fontWeight: 600, marginBottom: 6 }}>You&apos;re on the list</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>We&apos;ll reach out when your spot is ready.</div>
          </div>
        ) : status === 'duplicate' ? (
          <div style={{
            textAlign: 'center',
            padding: '24px 32px',
            background: 'rgba(250,204,21,0.06)',
            border: '1px solid rgba(250,204,21,0.2)',
            borderRadius: 14,
            width: '100%',
          }}>
            <div style={{ fontSize: 15, color: '#facc15', fontWeight: 600, marginBottom: 6 }}>Already on the list</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>We have your email — we&apos;ll be in touch.</div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (status === 'error') setStatus('idle'); }}
              placeholder="your@email.com"
              style={{
                height: 48,
                padding: '0 16px',
                background: 'rgba(255,255,255,0.05)',
                border: status === 'error'
                  ? '1px solid rgba(239,68,68,0.6)'
                  : '1px solid rgba(255,255,255,0.12)',
                borderRadius: 12,
                color: 'rgba(255,255,255,0.88)',
                fontSize: 14,
                fontFamily: 'inherit',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
            <button
              type="submit"
              disabled={status === 'loading'}
              className="iridescent-button"
              style={{
                height: 48,
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 600,
                cursor: status === 'loading' ? 'wait' : 'pointer',
                letterSpacing: '-0.01em',
                opacity: status === 'loading' ? 0.7 : 1,
                border: 'none',
                width: '100%',
              }}
            >
              {status === 'loading' ? 'Joining…' : 'Join the waitlist'}
            </button>
            {status === 'error' && (
              <p style={{ fontSize: 13, color: 'rgba(239,68,68,0.8)', margin: 0, textAlign: 'center' }}>
                Something went wrong — please try again.
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
