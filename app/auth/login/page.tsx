'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/components/auth/AuthProvider';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import AutocutMark from '@/components/branding/AutocutMark';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { user } = useAuth();

  useEffect(() => {
    if (user) router.replace('/projects');
  }, [router, user]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const routeError = params.get('error');
    const routeMessage = params.get('message');
    setError(routeError ?? '');
    setNotice(routeMessage ?? '');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);
    const supabase = getSupabaseBrowser();
    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push('/projects');
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session) {
          router.push('/projects');
        } else {
          setMode('login');
          setNotice('Check your email to confirm your account, then sign in.');
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    const supabase = getSupabaseBrowser();
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#111111',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'var(--font-serif), system-ui, sans-serif',
      padding: '24px 20px',
    }}>
      <style>{`
        .auth-input {
          width: 100%;
          padding: 10px 13px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 7px;
          color: rgba(255,255,255,0.92);
          font-size: 14px;
          font-family: inherit;
          outline: none;
          box-sizing: border-box;
          transition: border-color 0.15s;
        }
        .auth-input:focus {
          border-color: rgba(33,212,255,0.45);
        }
        .auth-input::placeholder {
          color: rgba(255,255,255,0.22);
        }
        .auth-google-btn {
          width: 100%;
          padding: 10px 13px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 7px;
          cursor: pointer;
          color: rgba(255,255,255,0.82);
          font-size: 14px;
          font-family: inherit;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 9px;
          transition: background 0.15s, border-color 0.15s;
          font-weight: 500;
        }
        .auth-google-btn:hover {
          background: rgba(255,255,255,0.08);
          border-color: rgba(255,255,255,0.18);
        }
        .auth-mode-btn {
          background: none;
          border: none;
          cursor: pointer;
          color: #21d4ff;
          font-size: 13px;
          font-family: inherit;
          padding: 0;
        }
        .auth-mode-btn:hover { text-decoration: underline; }
        .auth-back {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 13px;
          color: rgba(255,255,255,0.35);
          text-decoration: none;
          transition: color 0.15s;
          margin-bottom: 32px;
        }
        .auth-back:hover { color: rgba(255,255,255,0.65); }
      `}</style>

      {/* Back link */}
      <Link href="/" className="auth-back">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back to home
      </Link>

      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 28 }}>
        <AutocutMark size={30} withTile />
        <span style={{ fontSize: 18, fontWeight: 700, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.025em' }}>
          Autocut
        </span>
      </div>

      {/* Card */}
      <div style={{
        width: '100%',
        maxWidth: 400,
        background: '#161616',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 14,
        padding: '32px 28px 28px',
      }}>
        <h1 style={{
          fontSize: 20,
          fontWeight: 700,
          letterSpacing: '-0.025em',
          color: 'rgba(255,255,255,0.92)',
          margin: '0 0 6px',
          textAlign: 'center',
        }}>
          {mode === 'login' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p style={{
          fontSize: 13,
          color: 'rgba(255,255,255,0.35)',
          textAlign: 'center',
          margin: '0 0 24px',
        }}>
          {mode === 'login'
            ? 'Sign in to continue editing'
            : 'Start editing your videos with AI'}
        </p>

        {/* Google */}
        <button onClick={handleGoogle} className="auth-google-btn" style={{ marginBottom: 18 }}>
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.07)' }} />
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.22)' }}>or</span>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.07)' }} />
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="auth-input"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="auth-input"
          />

          {error && (
            <p style={{ fontSize: 12, color: '#f87171', margin: '2px 0 0', lineHeight: 1.5 }}>{error}</p>
          )}
          {notice && (
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', margin: '2px 0 0', lineHeight: 1.5 }}>{notice}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="iridescent-button"
            style={{
              padding: '10px 14px',
              borderRadius: 7,
              cursor: loading ? 'default' : 'pointer',
              fontSize: 14,
              fontWeight: 600,
              marginTop: 6,
              fontFamily: 'inherit',
              transition: 'filter 0.15s, box-shadow 0.15s',
            }}
          >
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p style={{
          fontSize: 13,
          color: 'rgba(255,255,255,0.3)',
          textAlign: 'center',
          margin: '20px 0 0',
        }}>
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            className="auth-mode-btn"
            onClick={() => { setMode(m => m === 'login' ? 'signup' : 'login'); setError(''); setNotice(''); }}
          >
            {mode === 'login' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
