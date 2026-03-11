'use client';

import Link from 'next/link';
import AutocutMark from '@/components/branding/AutocutMark';

/* ─── Mock product UI components ────────────────────────────── */

function AppWindow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: '#0d0d0d',
      borderRadius: 10,
      border: '1px solid rgba(255,255,255,0.09)',
      boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
      overflow: 'hidden',
      width: '100%',
    }}>
      {/* macOS chrome */}
      <div style={{
        height: 38,
        background: '#1a1a1a',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        gap: 7,
        flexShrink: 0,
      }}>
        <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#3a3a3a' }} />
        <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#3a3a3a' }} />
        <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#3a3a3a' }} />
        <span style={{
          flex: 1,
          textAlign: 'center',
          fontSize: 11,
          color: 'rgba(255,255,255,0.25)',
          letterSpacing: '0.01em',
          marginRight: 52,
        }}>
          Autocut
        </span>
      </div>
      {children}
    </div>
  );
}

function HeroMock() {
  const edits = [
    { done: true, text: 'Cut filler words and ums', detail: '18 cuts · 4m 12s removed' },
    { done: true, text: 'Add captions to the full video', detail: 'Done · synced to speech' },
    { done: false, text: 'Remove the first 30 seconds of b-roll', detail: 'Working…' },
  ];

  return (
    <AppWindow>
      <div style={{ display: 'flex', height: 380 }}>
        {/* Left: video preview */}
        <div style={{
          width: '55%',
          background: '#0a0a0a',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 8,
        }}>
          {/* Fake video frame */}
          <div style={{
            width: '80%',
            aspectRatio: '16/9',
            background: '#1c1c1c',
            borderRadius: 4,
            border: '1px solid rgba(255,255,255,0.07)',
            position: 'relative',
            overflow: 'hidden',
          }}>
            {/* Fake video content — horizontal gradient bands */}
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(160deg, #1e2124 0%, #141618 60%, #0f1112 100%)',
            }} />
            {/* Fake person silhouette */}
            <div style={{
              position: 'absolute',
              bottom: 0, left: '50%',
              transform: 'translateX(-50%)',
              width: '40%', height: '65%',
              background: 'rgba(255,255,255,0.04)',
              borderRadius: '50% 50% 0 0',
            }} />
            {/* Play button */}
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 28, height: 28,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                width: 0, height: 0,
                borderTop: '5px solid transparent',
                borderBottom: '5px solid transparent',
                borderLeft: '8px solid rgba(255,255,255,0.5)',
                marginLeft: 2,
              }} />
            </div>
          </div>
          {/* Fake timeline */}
          <div style={{ width: '80%', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {[
              { w: '100%', color: '#2a5fba', label: 'video' },
              { w: '78%', color: '#1e7a6e', label: 'audio' },
              { w: '40%', color: '#6b4a1e', label: 'captions' },
            ].map(track => (
              <div key={track.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', width: 36, flexShrink: 0 }}>{track.label}</span>
                <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.04)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: track.w, height: '100%', background: track.color, borderRadius: 2, opacity: 0.7 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: chat / edits panel */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{ padding: '14px 14px 0', flexShrink: 0 }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginBottom: 10 }}>Edits</div>
          </div>

          <div style={{ flex: 1, padding: '0 14px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {edits.map((edit, i) => (
              <div key={i} style={{
                background: edit.done ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${edit.done ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.10)'}`,
                borderRadius: 6,
                padding: '9px 10px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                  {edit.done ? (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <circle cx="6" cy="6" r="5.5" stroke="rgba(255,255,255,0.2)" />
                      <path d="M3.5 6L5.2 7.8L8.5 4.5" stroke="rgba(255,255,255,0.45)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <div style={{
                      width: 11, height: 11, borderRadius: '50%',
                      border: '1.5px solid rgba(255,255,255,0.25)',
                      flexShrink: 0,
                    }} />
                  )}
                  <span style={{
                    fontSize: 11.5,
                    color: edit.done ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.85)',
                    textDecoration: edit.done ? 'none' : 'none',
                  }}>
                    {edit.text}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.22)', paddingLeft: 18 }}>
                  {edit.detail}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <div style={{
            padding: '10px 14px 14px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}>
            <div style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.09)',
              borderRadius: 7,
              padding: '8px 10px',
              fontSize: 11,
              color: 'rgba(255,255,255,0.25)',
            }}>
              Describe an edit…
            </div>
          </div>
        </div>
      </div>
    </AppWindow>
  );
}

function FeatureMockDescribe() {
  return (
    <AppWindow>
      <div style={{ padding: 20 }}>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginBottom: 14 }}>Command</div>
        <div style={{
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8,
          padding: '12px 14px',
          fontSize: 13,
          color: 'rgba(255,255,255,0.8)',
          marginBottom: 16,
        }}>
          "Cut out every time I say um, like, or you know."
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { t: 'Transcribing audio…', done: true },
            { t: 'Locating 23 filler moments', done: true },
            { t: 'Applying cuts to timeline', done: true },
            { t: '4m 08s removed', done: true, dim: true },
          ].map((step, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="5.5" stroke="rgba(255,255,255,0.15)" />
                <path d="M3.5 6L5.2 7.8L8.5 4.5" stroke="rgba(255,255,255,0.4)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span style={{ fontSize: 12, color: step.dim ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.6)' }}>{step.t}</span>
            </div>
          ))}
        </div>
      </div>
    </AppWindow>
  );
}

function FeatureMockPatterns() {
  const history = [
    { label: 'Podcast ep. 12', edits: 'Filler cuts · captions · intro trim' },
    { label: 'Tutorial: React hooks', edits: 'Filler cuts · captions · b-roll removal' },
    { label: 'Weekly vlog #7', edits: 'Filler cuts · captions · outro trim' },
    { label: 'Product demo v2', edits: 'Filler cuts · captions · silence removal' },
  ];
  return (
    <AppWindow>
      <div style={{ padding: 20 }}>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginBottom: 14 }}>Recent projects</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {history.map((item, i) => (
            <div key={i} style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 12px',
              borderRadius: 6,
              background: i === 0 ? 'rgba(255,255,255,0.05)' : 'transparent',
              border: `1px solid ${i === 0 ? 'rgba(255,255,255,0.09)' : 'transparent'}`,
            }}>
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>{item.label}</span>
              <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.25)' }}>{item.edits}</span>
            </div>
          ))}
        </div>
        <div style={{
          marginTop: 14,
          padding: '10px 12px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 7,
          fontSize: 11,
          color: 'rgba(255,255,255,0.35)',
        }}>
          Autocut learned your style → applying your usual 4 edits automatically
        </div>
      </div>
    </AppWindow>
  );
}

/* ─── Main component ─────────────────────────────────────────── */

export default function LandingPage() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#111111',
      color: 'var(--fg-primary)',
      fontFamily: 'var(--font-serif), system-ui, sans-serif',
      display: 'flex',
      flexDirection: 'column',
    }}>

      {/* Nav */}
      <nav style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '16px 48px',
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'rgba(17,17,17,0.9)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AutocutMark size={24} withTile />
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
            Autocut
          </span>
        </div>
        <Link
          href="/auth/login"
          className="iridescent-button"
          style={{
            display: 'inline-block',
            padding: '7px 18px',
            borderRadius: 20,
            fontSize: 13,
            fontWeight: 500,
            textDecoration: 'none',
            letterSpacing: '-0.01em',
          }}
        >
          Start editing
        </Link>
      </nav>

      {/* Hero */}
      <section style={{
        padding: '96px 48px 80px',
        display: 'grid',
        gridTemplateColumns: '1fr 1.2fr',
        gap: 64,
        alignItems: 'center',
        maxWidth: 1200,
        margin: '0 auto',
        width: '100%',
      }}>
        <div>
          <h1 style={{
            fontSize: 'clamp(40px, 4.5vw, 58px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.08,
            margin: '0 0 20px',
            color: 'rgba(255,255,255,0.95)',
          }}>
            Edit your videos<br />by describing them.
          </h1>
          <p style={{
            fontSize: 17,
            color: 'rgba(255,255,255,0.45)',
            lineHeight: 1.6,
            margin: '0 0 36px',
            maxWidth: 380,
          }}>
            Tell Autocut what to cut. It finds the moments and makes the edits — no timeline scrubbing.
          </p>
          <Link
            href="/auth/login"
            className="iridescent-button"
            style={{
              display: 'inline-block',
              padding: '11px 26px',
              borderRadius: 24,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
              letterSpacing: '-0.01em',
            }}
          >
            Start editing →
          </Link>
        </div>

        {/* Hero product mock */}
        <div style={{ position: 'relative' }}>
          <HeroMock />
        </div>
      </section>

      {/* Feature 1 */}
      <section style={{
        padding: '80px 48px',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 80,
        alignItems: 'center',
        maxWidth: 1200,
        margin: '0 auto',
        width: '100%',
        borderTop: '1px solid rgba(255,255,255,0.05)',
      }}>
        <div>
          <FeatureMockDescribe />
        </div>
        <div>
          <h2 style={{
            fontSize: 'clamp(28px, 3vw, 40px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.15,
            margin: '0 0 16px',
          }}>
            Describe it.<br />Watch it happen.
          </h2>
          <p style={{
            fontSize: 16,
            color: 'rgba(255,255,255,0.45)',
            lineHeight: 1.65,
            margin: 0,
            maxWidth: 360,
          }}>
            Type a plain language instruction. Autocut transcribes your video, finds every matching moment, and applies the cuts — without you touching a timeline.
          </p>
        </div>
      </section>

      {/* Feature 2 */}
      <section style={{
        padding: '80px 48px',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 80,
        alignItems: 'center',
        maxWidth: 1200,
        margin: '0 auto',
        width: '100%',
        borderTop: '1px solid rgba(255,255,255,0.05)',
      }}>
        <div>
          <h2 style={{
            fontSize: 'clamp(28px, 3vw, 40px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.15,
            margin: '0 0 16px',
          }}>
            Learns your<br />editing style.
          </h2>
          <p style={{
            fontSize: 16,
            color: 'rgba(255,255,255,0.45)',
            lineHeight: 1.65,
            margin: 0,
            maxWidth: 360,
          }}>
            Every creator makes the same 3–4 edits on every video. Autocut tracks your patterns and starts applying them automatically — so your first cut is already 80% done.
          </p>
        </div>
        <div>
          <FeatureMockPatterns />
        </div>
      </section>

      {/* Pull quote */}
      <section style={{
        padding: '100px 48px',
        textAlign: 'center',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        maxWidth: 1200,
        margin: '0 auto',
        width: '100%',
      }}>
        <p style={{
          fontSize: 'clamp(24px, 3.5vw, 42px)',
          fontWeight: 600,
          letterSpacing: '-0.03em',
          lineHeight: 1.2,
          color: 'rgba(255,255,255,0.88)',
          maxWidth: 700,
          margin: '0 auto 40px',
        }}>
          The fastest editors aren't faster at scrubbing. They just edit less.
        </p>
        <Link
          href="/auth/login"
          className="iridescent-button"
          style={{
            display: 'inline-block',
            padding: '12px 30px',
            borderRadius: 24,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
            letterSpacing: '-0.01em',
          }}
        >
          Start for free →
        </Link>
      </section>

      {/* Footer */}
      <footer style={{
        borderTop: '1px solid rgba(255,255,255,0.06)',
        padding: '24px 48px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AutocutMark size={18} withTile />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.4)' }}>
            Autocut
          </span>
        </div>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.2)' }}>
          © 2025 Autocut
        </span>
      </footer>
    </div>
  );
}
