'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useAuth } from '@/components/auth/AuthProvider';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import AutocutMark from '@/components/branding/AutocutMark';

function SubscribeContent() {
  const { user, initialized } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const success = searchParams.get('success') === 'true';
  const canceled = searchParams.get('canceled') === 'true';

  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(success);
  const [isSubscribed, setIsSubscribed] = useState(false);

  // Redirect unauthenticated users to login
  useEffect(() => {
    if (initialized && !user) router.replace('/auth/login');
  }, [initialized, user, router]);

  // Check subscription status
  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    let attempts = 0;

    const check = async () => {
      const supabase = getSupabaseBrowser();
      const { data } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('user_id', user.id)
        .in('status', ['active', 'trialing'])
        .limit(1)
        .maybeSingle();

      if (cancelled) return;

      if (data) {
        setIsSubscribed(true);
        setChecking(false);
        if (success) {
          setTimeout(() => router.push('/projects'), 1500);
        }
        return;
      }

      // If returning from checkout success, poll a few times waiting for webhook
      if (success && attempts < 10) {
        attempts++;
        setTimeout(check, 2000);
      } else {
        setChecking(false);
      }
    };

    check();
    return () => { cancelled = true; };
  }, [user, success, router]);

  const handleSubscribe = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/stripe/checkout', { method: 'POST' });
      const { url } = await res.json();
      if (url) window.location.href = url;
    } catch {
      setLoading(false);
    }
  };

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

  const handleSignOut = async () => {
    await getSupabaseBrowser().auth.signOut();
    router.push('/auth/login');
  };

  if (!initialized || !user) {
    return null;
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'var(--font-serif), system-ui, sans-serif',
      background: '#111111',
      padding: '48px 24px',
    }}>
      <div style={{ marginBottom: 40, display: 'flex', alignItems: 'center', gap: 10 }}>
        <AutocutMark size={32} withTile />
        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.025em', color: 'rgba(255,255,255,0.92)' }}>
          Autocut
        </span>
      </div>

      <div style={{
        width: '100%',
        maxWidth: 440,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
        padding: '40px 36px',
        textAlign: 'center',
      }}>
        {/* Success state — waiting for webhook */}
        {success && checking && (
          <>
            <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', color: 'rgba(255,255,255,0.92)', margin: '0 0 12px' }}>
              Activating your account...
            </h1>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', margin: 0, lineHeight: 1.6 }}>
              This should only take a moment.
            </p>
          </>
        )}

        {/* Success state — subscription active */}
        {success && !checking && isSubscribed && (
          <>
            <div style={{ fontSize: 40, marginBottom: 12 }}>&#10003;</div>
            <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', color: 'rgba(255,255,255,0.92)', margin: '0 0 12px' }}>
              You&apos;re all set!
            </h1>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', margin: 0, lineHeight: 1.6 }}>
              Redirecting to your projects...
            </p>
          </>
        )}

        {/* Already subscribed (not from checkout success) */}
        {!success && isSubscribed && (
          <>
            <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', color: 'rgba(255,255,255,0.92)', margin: '0 0 8px' }}>
              Subscription active
            </h1>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', margin: '0 0 24px', lineHeight: 1.6 }}>
              You have full access to Autocut.
            </p>
            <button
              onClick={handleManage}
              disabled={loading}
              style={{
                width: '100%',
                padding: '11px 14px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8,
                cursor: 'pointer',
                color: 'rgba(255,255,255,0.82)',
                fontSize: 14,
                fontWeight: 500,
                fontFamily: 'inherit',
                marginBottom: 10,
              }}
            >
              {loading ? 'Please wait...' : 'Manage subscription'}
            </button>
            <button
              onClick={() => router.push('/projects')}
              className="iridescent-button"
              style={{
                width: '100%',
                padding: '11px 14px',
                borderRadius: 8,
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 600,
                fontFamily: 'inherit',
              }}
            >
              Go to projects
            </button>
          </>
        )}

        {/* Canceled checkout */}
        {canceled && !isSubscribed && !checking && (
          <>
            <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', color: 'rgba(255,255,255,0.92)', margin: '0 0 8px' }}>
              Subscription not completed
            </h1>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', margin: '0 0 24px', lineHeight: 1.6 }}>
              No worries — you can subscribe whenever you&apos;re ready.
            </p>
            <button
              onClick={handleSubscribe}
              disabled={loading}
              className="iridescent-button"
              style={{
                width: '100%',
                padding: '11px 14px',
                borderRadius: 8,
                cursor: loading ? 'default' : 'pointer',
                fontSize: 14,
                fontWeight: 600,
                fontFamily: 'inherit',
              }}
            >
              {loading ? 'Please wait...' : 'Try again'}
            </button>
          </>
        )}

        {/* Default paywall — not subscribed */}
        {!success && !canceled && !isSubscribed && !checking && (
          <>
            <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', color: 'rgba(255,255,255,0.92)', margin: '0 0 8px' }}>
              Start your subscription
            </h1>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', margin: '0 0 28px', lineHeight: 1.6 }}>
              Get full access to Autocut&apos;s AI-powered video editor.
            </p>

            <div style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12,
              padding: '24px 20px',
              marginBottom: 24,
            }}>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                Autocut Pro
              </p>
              <p style={{ fontSize: 36, fontWeight: 700, color: 'rgba(255,255,255,0.92)', margin: '0 0 4px', letterSpacing: '-0.03em' }}>
                $19.99<span style={{ fontSize: 15, fontWeight: 400, color: 'rgba(255,255,255,0.35)' }}>/month</span>
              </p>
              <ul style={{
                listStyle: 'none',
                padding: 0,
                margin: '16px 0 0',
                textAlign: 'left',
                fontSize: 13,
                color: 'rgba(255,255,255,0.55)',
                lineHeight: 2,
              }}>
                <li>&#10003;  AI-powered video editing</li>
                <li>&#10003;  Unlimited projects</li>
                <li>&#10003;  Auto transcription & captions</li>
                <li>&#10003;  Chat-based editing commands</li>
              </ul>
            </div>

            <button
              onClick={handleSubscribe}
              disabled={loading}
              className="iridescent-button"
              style={{
                width: '100%',
                padding: '13px 14px',
                borderRadius: 8,
                cursor: loading ? 'default' : 'pointer',
                fontSize: 15,
                fontWeight: 600,
                fontFamily: 'inherit',
              }}
            >
              {loading ? 'Please wait...' : 'Subscribe now'}
            </button>
          </>
        )}
      </div>

      {/* Footer links */}
      <div style={{ marginTop: 24, display: 'flex', gap: 20 }}>
        <button
          onClick={handleSignOut}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            color: 'rgba(255,255,255,0.3)',
            fontFamily: 'inherit',
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

export default function SubscribePage() {
  return (
    <Suspense>
      <SubscribeContent />
    </Suspense>
  );
}
