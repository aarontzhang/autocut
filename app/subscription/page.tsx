'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AutocutMark from '@/components/branding/AutocutMark';
import { useAuth } from '@/components/auth/AuthProvider';
import { useSubscription } from '@/components/auth/SubscriptionProvider';

/* ── Left branding panel ───────────────────────────────────── */

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

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <AutocutMark size={32} withTile />
        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.025em', color: 'rgba(255,255,255,0.92)' }}>
          Autocut
        </span>
      </div>

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

      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.18)', margin: 0 }}>
        &copy; 2025 Autocut
      </p>
    </div>
  );
}

/* ── Subscription details panel ─────────────────────────────── */

type SubDetails = {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  priceId: string | null;
  isGrandfathered: boolean;
};

function ManagePanel() {
  const { user } = useAuth();
  const { refresh } = useSubscription();
  const [details, setDetails] = useState<SubDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchDetails = useCallback(async () => {
    try {
      const res = await fetch('/api/stripe/subscription');
      if (!res.ok) {
        setDetails(null);
        return;
      }
      setDetails(await res.json());
    } catch {
      setDetails(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchDetails(); }, [fetchDetails]);

  const handleAction = async (action: 'cancel' | 'reactivate') => {
    setActionLoading(true);
    setError('');
    try {
      const res = await fetch('/api/stripe/subscription', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Something went wrong');
      } else {
        await fetchDetails();
        await refresh();
      }
    } catch {
      setError('Something went wrong');
    } finally {
      setActionLoading(false);
    }
  };

  const openPortal = async () => {
    setPortalLoading(true);
    setError('');
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' });
      if (!res.ok) {
        setError('Could not open billing portal');
        return;
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      setError('Could not open billing portal');
    } finally {
      setPortalLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ width: '100%', maxWidth: 420, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <AutocutMark size={28} withTile />
      </div>
    );
  }

  if (!details) {
    return (
      <div style={{ width: '100%', maxWidth: 420 }}>
        <Link href="/projects" className="sub-back" style={{ marginBottom: 40, display: 'inline-flex' }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back to projects
        </Link>

        <h1 style={{
          fontSize: 26,
          fontWeight: 700,
          letterSpacing: '-0.03em',
          color: 'rgba(255,255,255,0.95)',
          margin: '0 0 8px',
        }}>
          No subscription
        </h1>
        <p style={{
          fontSize: 14,
          color: 'rgba(255,255,255,0.42)',
          margin: '0 0 28px',
          lineHeight: 1.6,
        }}>
          You don&apos;t have an active subscription yet.
        </p>
        <Link
          href="/subscribe"
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
          Subscribe to Pro
        </Link>
      </div>
    );
  }

  const isActive = details.status === 'active' || details.status === 'trialing';
  const isCanceling = details.cancelAtPeriodEnd;
  const periodEnd = details.currentPeriodEnd
    ? new Date(details.currentPeriodEnd).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <div style={{ width: '100%', maxWidth: 420 }}>
      <Link href="/projects" className="sub-back" style={{ marginBottom: 40, display: 'inline-flex' }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back to projects
      </Link>

      <h1 style={{
        fontSize: 26,
        fontWeight: 700,
        letterSpacing: '-0.03em',
        color: 'rgba(255,255,255,0.95)',
        margin: '0 0 6px',
      }}>
        Autocut Pro
      </h1>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, marginBottom: 28 }}>
        <span style={{
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: '-0.04em',
          color: 'rgba(255,255,255,0.95)',
          lineHeight: 1,
        }}>
          $19.99
        </span>
        <span style={{
          fontSize: 14,
          color: 'rgba(255,255,255,0.3)',
          fontWeight: 500,
        }}>
          /month
        </span>
      </div>

      {/* Subscription details rows */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        marginBottom: 28,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 10,
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}>
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)' }}>Status</span>
          <span style={{
            fontSize: 13,
            fontWeight: 500,
            color: isCanceling ? '#f87171' : 'rgba(255,255,255,0.75)',
          }}>
            {isCanceling
              ? 'Cancels at period end'
              : details.status === 'trialing'
                ? 'Trial'
                : 'Active'}
          </span>
        </div>
        {periodEnd && (
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)' }}>
              {isCanceling ? 'Access until' : 'Next billing date'}
            </span>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', fontWeight: 500 }}>
              {periodEnd}
            </span>
          </div>
        )}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 16px',
        }}>
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)' }}>Email</span>
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', fontWeight: 500 }}>
            {user?.email}
          </span>
        </div>
      </div>

      {/* Manage billing (Stripe portal) */}
      {!details.isGrandfathered && (
        <button
          onClick={openPortal}
          disabled={portalLoading}
          style={{
            width: '100%',
            padding: '12px 20px',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            cursor: portalLoading ? 'default' : 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.15s, border-color 0.15s',
            letterSpacing: '-0.01em',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'rgba(255,255,255,0.85)',
            marginBottom: 12,
          }}
          onMouseEnter={e => {
            if (!portalLoading) {
              e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.16)';
            }
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
          }}
        >
          {portalLoading ? 'Opening\u2026' : 'Manage billing'}
        </button>
      )}

      {/* Cancel / Reactivate */}
      {isActive && !isCanceling && !details.isGrandfathered && (
        <button
          onClick={() => handleAction('cancel')}
          disabled={actionLoading}
          style={{
            width: '100%',
            padding: '12px 20px',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            cursor: actionLoading ? 'default' : 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.15s, border-color 0.15s',
            letterSpacing: '-0.01em',
            background: 'rgba(248,113,113,0.06)',
            border: '1px solid rgba(248,113,113,0.18)',
            color: '#f87171',
          }}
          onMouseEnter={e => {
            if (!actionLoading) {
              e.currentTarget.style.background = 'rgba(248,113,113,0.12)';
              e.currentTarget.style.borderColor = 'rgba(248,113,113,0.3)';
            }
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'rgba(248,113,113,0.06)';
            e.currentTarget.style.borderColor = 'rgba(248,113,113,0.18)';
          }}
        >
          {actionLoading ? 'Please wait\u2026' : 'Cancel subscription'}
        </button>
      )}

      {isActive && isCanceling && !details.isGrandfathered && (
        <button
          onClick={() => handleAction('reactivate')}
          disabled={actionLoading}
          className="iridescent-button"
          style={{
            width: '100%',
            padding: '12px 20px',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            cursor: actionLoading ? 'default' : 'pointer',
            fontFamily: 'inherit',
            transition: 'filter 0.15s, box-shadow 0.15s',
            letterSpacing: '-0.01em',
          }}
        >
          {actionLoading ? 'Please wait\u2026' : 'Reactivate subscription'}
        </button>
      )}

      {isCanceling && periodEnd && (
        <p style={{
          fontSize: 12,
          color: 'rgba(255,255,255,0.3)',
          margin: '12px 0 0',
          lineHeight: 1.5,
          textAlign: 'center',
        }}>
          Your subscription will remain active until {periodEnd}.
        </p>
      )}

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

/* ── Main page ──────────────────────────────────────────────── */

export default function SubscriptionPage() {
  const { user, initialized } = useAuth();
  const { loading: subLoading } = useSubscription();

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

  if (!user) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: '#111111',
      }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.42)', marginBottom: 16 }}>
            Please sign in to manage your subscription.
          </p>
          <Link
            href="/auth/login"
            className="iridescent-button"
            style={{
              display: 'inline-flex',
              padding: '11px 28px',
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
              fontFamily: 'inherit',
            }}
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      fontFamily: 'var(--font-serif), system-ui, sans-serif',
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
        <ManagePanel />
      </div>
    </div>
  );
}
