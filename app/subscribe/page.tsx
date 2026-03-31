'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AutocutMark from '@/components/branding/AutocutMark';
import { useAuth } from '@/components/auth/AuthProvider';
import { useSubscription } from '@/components/auth/SubscriptionProvider';

const FEATURES = [
  'AI chat editing',
  'Transcription up to 2 hours / day',
  'Multi-source timeline',
  'Unlimited projects',
  'Priority support',
];

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
      <circle cx="7.5" cy="7.5" r="7" fill="rgba(33,212,255,0.12)" stroke="rgba(33,212,255,0.3)" strokeWidth="1" />
      <path d="M4.5 7.7l2 2 4-4" stroke="#21d4ff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SuccessView() {
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => router.replace('/projects'), 3000);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 20,
      padding: '48px 32px',
      textAlign: 'center',
    }}>
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
      }}>
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <path d="M9 16.5l5 5 9-10" stroke="#21d4ff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div>
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
    </div>
  );
}

function SubscribedView({ hideManage }: { hideManage?: boolean }) {
  const [loading, setLoading] = useState(false);

  const handleManage = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' });
      const { url } = await res.json();
      if (url) window.location.href = url;
    } catch {
      setLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 20,
      padding: '48px 32px',
      textAlign: 'center',
    }}>
      <div style={{
        width: 56,
        height: 56,
        borderRadius: '50%',
        background: 'rgba(33,212,255,0.08)',
        border: '1.5px solid rgba(33,212,255,0.25)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M9 12l2 2 4-4" stroke="#21d4ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="9" stroke="#21d4ff" strokeWidth="1.5" opacity="0.4" />
        </svg>
      </div>

      <div>
        <h1 style={{
          fontSize: 24,
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
          margin: 0,
        }}>
          Autocut Pro is active on your account.
        </p>
      </div>

      {!hideManage && (
        <button
          onClick={handleManage}
          disabled={loading}
          className="iridescent-button"
          style={{
            padding: '11px 28px',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            cursor: loading ? 'default' : 'pointer',
            fontFamily: 'inherit',
            transition: 'filter 0.15s, box-shadow 0.15s',
            marginTop: 4,
          }}
        >
          {loading ? 'Please wait\u2026' : 'Manage Subscription'}
        </button>
      )}
    </div>
  );
}

function PricingCard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const searchParams = useSearchParams();
  const canceled = searchParams.get('canceled') === 'true';
  const [showCanceled, setShowCanceled] = useState(canceled);

  const handleSubscribe = useCallback(async () => {
    setLoading(true);
    setError('');
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
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 0,
      width: '100%',
      maxWidth: 420,
    }}>
      {showCanceled && (
        <div style={{
          width: '100%',
          padding: '10px 14px',
          marginBottom: 16,
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

      <div
        className="panel-sheen"
        style={{
          width: '100%',
          borderRadius: 16,
          border: '1px solid rgba(33,212,255,0.12)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div style={{
          position: 'absolute',
          top: 0,
          left: '15%',
          right: '15%',
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(33,212,255,0.4), transparent)',
        }} />

        <div style={{ padding: '36px 32px 32px' }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 12px',
            borderRadius: 999,
            background: 'rgba(33,212,255,0.08)',
            border: '1px solid rgba(33,212,255,0.18)',
            marginBottom: 24,
          }}>
            <div style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#21d4ff',
              boxShadow: '0 0 8px rgba(33,212,255,0.5)',
            }} />
            <span style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: '#21d4ff',
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
            }}>
              Autocut Pro
            </span>
          </div>

          <div style={{ marginBottom: 28 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
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
              margin: '10px 0 0',
              lineHeight: 1.5,
            }}>
              Everything you need to edit videos with AI. Cancel anytime.
            </p>
          </div>

          <div style={{
            height: 1,
            background: 'rgba(255,255,255,0.06)',
            marginBottom: 24,
          }} />

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            marginBottom: 32,
          }}>
            {FEATURES.map(feature => (
              <div key={feature} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
              }}>
                <CheckIcon />
                <span style={{
                  fontSize: 14,
                  color: 'rgba(255,255,255,0.72)',
                  lineHeight: 1.4,
                }}>
                  {feature}
                </span>
              </div>
            ))}
          </div>

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
              textAlign: 'center',
              lineHeight: 1.5,
            }}>
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SubscribeContent() {
  const { user, initialized } = useAuth();
  const { isSubscribed, isManual, loading: subLoading } = useSubscription();
  const searchParams = useSearchParams();
  const success = searchParams.get('success') === 'true';

  if (!initialized || subLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
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
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'var(--font-serif), system-ui, sans-serif',
      background: '#111111',
      position: 'relative',
      overflow: 'hidden',
      padding: '48px 24px',
    }}>
      <style>{`
        @keyframes subscribeGlow {
          0%, 100% { opacity: 0.5; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.8; transform: translate(-50%, -50%) scale(1.05); }
        }
        @keyframes cardReveal {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div style={{
        position: 'absolute',
        top: '45%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 700,
        height: 500,
        borderRadius: '50%',
        background: 'radial-gradient(ellipse, rgba(33,212,255,0.05) 0%, rgba(33,212,255,0.02) 40%, transparent 70%)',
        pointerEvents: 'none',
        animation: 'subscribeGlow 8s ease-in-out infinite',
      }} />

      <div style={{
        position: 'absolute',
        top: '60%',
        left: '35%',
        transform: 'translate(-50%, -50%)',
        width: 400,
        height: 400,
        borderRadius: '50%',
        background: 'radial-gradient(ellipse, rgba(64,122,255,0.03) 0%, transparent 60%)',
        pointerEvents: 'none',
      }} />

      <div style={{
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
        maxWidth: 480,
        animation: 'cardReveal 0.4s ease-out',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          marginBottom: showSuccess || showSubscribed ? 40 : 36,
        }}>
          <AutocutMark size={28} withTile />
          <span style={{
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: 'rgba(255,255,255,0.82)',
          }}>
            Autocut
          </span>
        </div>

        {showSuccess ? (
          <SuccessView />
        ) : showSubscribed ? (
          <SubscribedView hideManage={isManual} />
        ) : (
          <PricingCard />
        )}

        <Link
          href="/"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            marginTop: 32,
            fontSize: 13,
            color: 'rgba(255,255,255,0.28)',
            textDecoration: 'none',
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.55)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.28)'; }}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to home
        </Link>
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
