'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AutocutMark from '@/components/branding/AutocutMark';
import { useAuth } from '@/components/auth/AuthProvider';
import { useSubscription } from '@/components/auth/SubscriptionProvider';
import { capture } from '@/lib/analytics';

/* ── Left branding panel (shared across all states) ──────────── */

function BrandingPanel() {
  return (
    <div className="sub-left" style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: '40px 56px',
      borderRight: '1px solid rgba(255,255,255,0.07)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Subtle glow */}
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 600,
        height: 400,
        borderRadius: '50%',
        background: 'radial-gradient(ellipse, rgba(33,212,255,0.07) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <AutocutMark size={32} withTile />
        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.025em', color: 'rgba(255,255,255,0.92)' }}>
          Autocut
        </span>
      </div>

      {/* Headline */}
      <div>
        <p style={{
          fontSize: 'clamp(32px, 3vw, 48px)',
          fontWeight: 700,
          letterSpacing: '-0.035em',
          lineHeight: 1.1,
          color: 'rgba(255,255,255,0.92)',
          margin: '0 0 20px',
          maxWidth: 480,
        }}>
          Describe the edit.<br />Autocut makes it.
        </p>
        <p style={{
          fontSize: 15,
          color: 'rgba(255,255,255,0.38)',
          lineHeight: 1.65,
          margin: 0,
          maxWidth: 400,
        }}>
          Tell Autocut what to cut. It finds the moments and applies every edit directly to your timeline.
        </p>
      </div>

      {/* Bottom */}
      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.18)', margin: 0 }}>
        &copy; 2025 Autocut
      </p>
    </div>
  );
}

/* ── Right panel: pricing ────────────────────────────────────── */

function PricingPanel() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const searchParams = useSearchParams();
  const canceled = searchParams.get('canceled') === 'true';
  const [showCanceled, setShowCanceled] = useState(canceled);

  useEffect(() => {
    if (canceled) capture('subscription_checkout_canceled', {});
  }, [canceled]);

  const handleSubscribe = useCallback(async () => {
    setLoading(true);
    setError('');
    capture('subscription_checkout_started', {});
    try {
      const res = await fetch('/api/stripe/checkout', { method: 'POST' });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error ?? 'Something went wrong');
        setLoading(false);
      }
    } catch {
      setError('Something went wrong');
      setLoading(false);
    }
  }, []);

  return (
    <div style={{ width: '100%', maxWidth: 380 }}>
      <Link href="/" className="sub-back" style={{ marginBottom: 40, display: 'inline-flex' }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back to home
      </Link>

      {showCanceled && (
        <div style={{
          width: '100%',
          padding: '10px 14px',
          marginBottom: 20,
          background: 'rgba(248,113,113,0.06)',
          border: '1px solid rgba(248,113,113,0.18)',
          borderRadius: 9,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}>
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
            Checkout was canceled.
          </span>
          <button
            onClick={() => setShowCanceled(false)}
            style={{
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.3)',
              cursor: 'pointer',
              padding: '2px',
              display: 'flex',
              flexShrink: 0,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, marginBottom: 10 }}>
        <span style={{
          fontSize: 48,
          fontWeight: 700,
          letterSpacing: '-0.04em',
          color: 'rgba(255,255,255,0.95)',
          lineHeight: 1,
        }}>
          $19.99
        </span>
        <span style={{
          fontSize: 15,
          color: 'rgba(255,255,255,0.3)',
          fontWeight: 500,
        }}>
          /month
        </span>
      </div>

      <p style={{
        fontSize: 14,
        color: 'rgba(255,255,255,0.38)',
        margin: '0 0 32px',
        lineHeight: 1.5,
      }}>
        Everything you need to edit videos with AI. Cancel anytime.
      </p>

      <button
        onClick={handleSubscribe}
        disabled={loading}
        className="iridescent-button"
        style={{
          width: '100%',
          padding: '13px 20px',
          borderRadius: 10,
          fontSize: 15,
          fontWeight: 600,
          cursor: loading ? 'default' : 'pointer',
          fontFamily: 'inherit',
          transition: 'filter 0.15s, box-shadow 0.15s',
          letterSpacing: '-0.01em',
        }}
      >
        {loading ? 'Redirecting\u2026' : 'Subscribe'}
      </button>

      {error && (
        <p style={{
          fontSize: 13,
          color: '#f87171',
          margin: '12px 0 0',
          lineHeight: 1.5,
        }}>
          {error}
        </p>
      )}
    </div>
  );
}

/* ── Right panel: success ────────────────────────────────────── */

function SuccessPanel() {
  const router = useRouter();

  useEffect(() => {
    capture('subscription_activated', {});
    const timer = setTimeout(() => router.replace('/projects'), 3000);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div style={{ width: '100%', maxWidth: 380 }}>
      <div style={{
        width: 72,
        height: 72,
        borderRadius: '50%',
        background: 'rgba(33,212,255,0.08)',
        border: '2px solid rgba(33,212,255,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 0 40px rgba(33,212,255,0.12), inset 0 0 20px rgba(33,212,255,0.06)',
        marginBottom: 24,
      }}>
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <path d="M9 16.5l5 5 9-10" stroke="#21d4ff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <h1 style={{
        fontSize: 28,
        fontWeight: 700,
        letterSpacing: '-0.03em',
        color: 'rgba(255,255,255,0.95)',
        margin: '0 0 8px',
      }}>
        You&apos;re all set!
      </h1>
      <p style={{
        fontSize: 14,
        color: 'rgba(255,255,255,0.42)',
        margin: 0,
        lineHeight: 1.6,
      }}>
        Your subscription is active. Redirecting to your projects&hellip;
      </p>
    </div>
  );
}

/* ── Right panel: already subscribed ─────────────────────────── */

function SubscribedPanel() {
  return (
    <div style={{ width: '100%', maxWidth: 380 }}>
      <Link href="/" className="sub-back" style={{ marginBottom: 40, display: 'inline-flex' }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back to home
      </Link>

      <div style={{
        width: 56,
        height: 56,
        borderRadius: '50%',
        background: 'rgba(33,212,255,0.08)',
        border: '1.5px solid rgba(33,212,255,0.25)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 24,
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M9 12l2 2 4-4" stroke="#21d4ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="9" stroke="#21d4ff" strokeWidth="1.5" opacity="0.4" />
        </svg>
      </div>

      <h1 style={{
        fontSize: 26,
        fontWeight: 700,
        letterSpacing: '-0.03em',
        color: 'rgba(255,255,255,0.95)',
        margin: '0 0 6px',
      }}>
        You&apos;re subscribed
      </h1>
      <p style={{
        fontSize: 14,
        color: 'rgba(255,255,255,0.42)',
        margin: '0 0 28px',
      }}>
        Autocut Pro is active on your account.
      </p>

      <Link
          href="/subscription"
          className="iridescent-button"
          style={{
            display: 'inline-flex',
            padding: '11px 28px',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
            fontFamily: 'inherit',
            transition: 'filter 0.15s, box-shadow 0.15s',
          }}
        >
          Manage Subscription
        </Link>
    </div>
  );
}

/* ── Main subscribe page ─────────────────────────────────────── */

function SubscribeContent() {
  const { user, initialized } = useAuth();
  const { isSubscribed, loading: subLoading } = useSubscription();
  const searchParams = useSearchParams();
  const success = searchParams.get('success') === 'true';

  if (!initialized || subLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: '#111111',
      }}>
        <AutocutMark size={36} withTile />
      </div>
    );
  }

  const showSuccess = success && user;
  const showSubscribed = isSubscribed && !success;

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      background: '#111111',
    }}>
      <style>{`
        .sub-back {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 13px;
          color: rgba(255,255,255,0.35);
          text-decoration: none;
          transition: color 0.15s;
        }
        .sub-back:hover { color: rgba(255,255,255,0.65); }

        @media (max-width: 768px) {
          .sub-left { display: none !important; }
          .sub-right { border-left: none !important; }
        }
      `}</style>

      <BrandingPanel />

      <div className="sub-right" style={{
        width: '100%',
        maxWidth: 520,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 48px',
        borderLeft: '1px solid rgba(255,255,255,0.07)',
      }}>
        {showSuccess ? (
          <SuccessPanel />
        ) : showSubscribed ? (
          <SubscribedPanel />
        ) : (
          <PricingPanel />
        )}
      </div>
    </div>
  );
}

export default function SubscribePage() {
  return (
    <Suspense fallback={
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#111111',
      }}>
        <AutocutMark size={36} withTile />
      </div>
    }>
      <SubscribeContent />
    </Suspense>
  );
}
