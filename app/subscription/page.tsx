'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import AutocutMark from '@/components/branding/AutocutMark';
import { useAuth } from '@/components/auth/AuthProvider';
import { useSubscription } from '@/components/auth/SubscriptionProvider';

type SubDetails = {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  priceId: string | null;
  isGrandfathered: boolean;
};

export default function SubscriptionPage() {
  const { user, initialized } = useAuth();
  const { loading: subLoading, refresh } = useSubscription();
  const router = useRouter();

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

  useEffect(() => {
    if (initialized && user) void fetchDetails();
    else if (initialized) setLoading(false);
  }, [initialized, user, fetchDetails]);

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

  if (!initialized || subLoading || loading) {
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
        fontFamily: 'var(--font-serif), system-ui, sans-serif',
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

  const isActive = details && (details.status === 'active' || details.status === 'trialing');
  const isCanceling = details?.cancelAtPeriodEnd;
  const periodEnd = details?.currentPeriodEnd
    ? new Date(details.currentPeriodEnd).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#111111',
      fontFamily: 'var(--font-serif), system-ui, sans-serif',
      color: 'rgba(255,255,255,0.92)',
    }}>
      <style>{`
        .billing-back {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          color: rgba(255,255,255,0.4);
          text-decoration: none;
          transition: color 0.15s;
        }
        .billing-back:hover { color: rgba(255,255,255,0.7); }
        .billing-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
          padding: 24px;
        }
        .billing-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 14px 0;
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .billing-row:last-child { border-bottom: none; }
        .billing-label {
          font-size: 13.5px;
          color: rgba(255,255,255,0.4);
        }
        .billing-value {
          font-size: 13.5px;
          color: rgba(255,255,255,0.8);
          font-weight: 500;
        }
        .billing-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 11px 20px;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
          transition: background 0.15s, border-color 0.15s, opacity 0.15s;
          letter-spacing: -0.01em;
        }
        .billing-btn:disabled { opacity: 0.5; cursor: default; }
        .billing-btn-secondary {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          color: rgba(255,255,255,0.8);
        }
        .billing-btn-secondary:hover:not(:disabled) {
          background: rgba(255,255,255,0.08);
          border-color: rgba(255,255,255,0.15);
        }
        .billing-btn-danger {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.4);
          font-weight: 500;
        }
        .billing-btn-danger:hover:not(:disabled) {
          background: rgba(248,113,113,0.06);
          border-color: rgba(248,113,113,0.2);
          color: #f87171;
        }
        .billing-section-title {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: rgba(255,255,255,0.3);
          margin: 0 0 14px;
        }
      `}</style>

      {/* Header */}
      <div style={{
        maxWidth: 640,
        margin: '0 auto',
        padding: '40px 32px 0',
      }}>
        <Link href="/projects" className="billing-back">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back to projects
        </Link>
      </div>

      {/* Content */}
      <div style={{
        maxWidth: 640,
        margin: '0 auto',
        padding: '40px 32px 80px',
      }}>
        <h1 style={{
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: '-0.03em',
          margin: '0 0 8px',
        }}>
          Billing
        </h1>
        <p style={{
          fontSize: 14,
          color: 'rgba(255,255,255,0.4)',
          margin: '0 0 40px',
          lineHeight: 1.6,
        }}>
          Manage your subscription, update payment details, and view billing history.
        </p>

        {!details ? (
          /* ── No subscription state ─────────────────────── */
          <div className="billing-card" style={{ textAlign: 'center', padding: '48px 32px' }}>
            <p style={{
              fontSize: 16,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.85)',
              margin: '0 0 8px',
            }}>
              No active subscription
            </p>
            <p style={{
              fontSize: 14,
              color: 'rgba(255,255,255,0.4)',
              margin: '0 0 24px',
              lineHeight: 1.6,
            }}>
              Subscribe to Autocut Pro to get unlimited AI-powered editing.
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
              }}
            >
              Subscribe to Pro
            </Link>
          </div>
        ) : (
          /* ── Active subscription state ─────────────────── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

            {/* Plan section */}
            <div>
              <p className="billing-section-title">Current plan</p>
              <div className="billing-card">
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: 20,
                }}>
                  <div>
                    <h2 style={{
                      fontSize: 20,
                      fontWeight: 700,
                      letterSpacing: '-0.02em',
                      margin: '0 0 4px',
                    }}>
                      Autocut Pro
                    </h2>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
                      <span style={{
                        fontSize: 28,
                        fontWeight: 700,
                        letterSpacing: '-0.04em',
                        lineHeight: 1.2,
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
                  </div>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: '0.01em',
                    background: isCanceling
                      ? 'rgba(248,113,113,0.08)'
                      : 'rgba(52,211,153,0.08)',
                    color: isCanceling
                      ? '#f87171'
                      : '#34d399',
                  }}>
                    <span style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: isCanceling ? '#f87171' : '#34d399',
                    }} />
                    {isCanceling ? 'Canceling' : isActive ? 'Active' : details.status}
                  </span>
                </div>

                {isCanceling && periodEnd && (
                  <div style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    background: 'rgba(248,113,113,0.04)',
                    border: '1px solid rgba(248,113,113,0.1)',
                    marginBottom: 4,
                  }}>
                    <p style={{
                      fontSize: 13,
                      color: 'rgba(255,255,255,0.55)',
                      margin: 0,
                      lineHeight: 1.5,
                    }}>
                      Your subscription will be canceled on <strong style={{ color: 'rgba(255,255,255,0.8)' }}>{periodEnd}</strong>. You&apos;ll keep access to Pro features until then.
                    </p>
                  </div>
                )}

                {details.isGrandfathered && (
                  <div style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.07)',
                  }}>
                    <p style={{
                      fontSize: 13,
                      color: 'rgba(255,255,255,0.5)',
                      margin: 0,
                      lineHeight: 1.5,
                    }}>
                      You have a grandfathered Pro plan. Enjoy!
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Billing details section */}
            <div>
              <p className="billing-section-title">Billing details</p>
              <div className="billing-card" style={{ padding: '4px 24px' }}>
                <div className="billing-row">
                  <span className="billing-label">Status</span>
                  <span className="billing-value" style={{
                    color: isCanceling ? '#f87171' : 'rgba(255,255,255,0.8)',
                  }}>
                    {isCanceling
                      ? 'Cancels at period end'
                      : details.status === 'trialing'
                        ? 'Trial'
                        : 'Active'}
                  </span>
                </div>
                {periodEnd && (
                  <div className="billing-row">
                    <span className="billing-label">
                      {isCanceling ? 'Access until' : 'Next billing date'}
                    </span>
                    <span className="billing-value">{periodEnd}</span>
                  </div>
                )}
                <div className="billing-row">
                  <span className="billing-label">Email</span>
                  <span className="billing-value">{user.email}</span>
                </div>
              </div>
            </div>

            {/* Payment & portal section */}
            {!details.isGrandfathered && (
              <div>
                <p className="billing-section-title">Payment method</p>
                <div className="billing-card" style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}>
                  <p style={{
                    fontSize: 13.5,
                    color: 'rgba(255,255,255,0.4)',
                    margin: 0,
                    lineHeight: 1.5,
                  }}>
                    Update your payment method, view invoices, or download receipts through the billing portal.
                  </p>
                  <button
                    onClick={openPortal}
                    disabled={portalLoading}
                    className="billing-btn billing-btn-secondary"
                    style={{ flexShrink: 0, marginLeft: 20 }}
                  >
                    {portalLoading ? 'Opening\u2026' : 'Manage'}
                  </button>
                </div>
              </div>
            )}

            {/* Cancel / Reactivate */}
            {isActive && !details.isGrandfathered && (
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 28 }}>
                {isCanceling ? (
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}>
                    <div>
                      <p style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: 'rgba(255,255,255,0.85)',
                        margin: '0 0 4px',
                      }}>
                        Reactivate subscription
                      </p>
                      <p style={{
                        fontSize: 13,
                        color: 'rgba(255,255,255,0.4)',
                        margin: 0,
                        lineHeight: 1.5,
                      }}>
                        Resume your Pro plan. You&apos;ll be billed at the start of the next cycle.
                      </p>
                    </div>
                    <button
                      onClick={() => handleAction('reactivate')}
                      disabled={actionLoading}
                      className="iridescent-button billing-btn"
                      style={{ flexShrink: 0, marginLeft: 20 }}
                    >
                      {actionLoading ? 'Please wait\u2026' : 'Reactivate'}
                    </button>
                  </div>
                ) : (
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}>
                    <div>
                      <p style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: 'rgba(255,255,255,0.85)',
                        margin: '0 0 4px',
                      }}>
                        Cancel subscription
                      </p>
                      <p style={{
                        fontSize: 13,
                        color: 'rgba(255,255,255,0.4)',
                        margin: 0,
                        lineHeight: 1.5,
                      }}>
                        You&apos;ll keep access until the end of your current billing period.
                      </p>
                    </div>
                    <button
                      onClick={() => handleAction('cancel')}
                      disabled={actionLoading}
                      className="billing-btn billing-btn-danger"
                      style={{ flexShrink: 0, marginLeft: 20 }}
                    >
                      {actionLoading ? 'Please wait\u2026' : 'Cancel plan'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {error && (
              <p style={{
                fontSize: 13,
                color: '#f87171',
                margin: 0,
                lineHeight: 1.5,
              }}>
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
