'use client';

import Link from 'next/link';
import AutocutMark from '@/components/branding/AutocutMark';

const steps = [
  {
    label: 'Describe',
    description: 'Tell Autocut what to change in plain language',
  },
  {
    label: 'Find',
    description: 'It indexes your video and finds exactly those moments',
  },
  {
    label: 'Done',
    description: 'Cuts, captions, and removals execute automatically',
  },
];

export default function LandingPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-base)',
        color: 'var(--fg-primary)',
        fontFamily: 'var(--font-serif), system-ui, sans-serif',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Nav */}
      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 40px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AutocutMark size={28} withTile />
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              color: 'var(--fg-primary)',
            }}
          >
            Autocut
          </span>
        </div>
        <Link
          href="/auth/login"
          style={{
            fontSize: 13,
            color: 'var(--fg-secondary)',
            textDecoration: 'none',
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid var(--border-mid)',
            transition: 'color 0.15s ease, border-color 0.15s ease',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLAnchorElement).style.color = 'var(--fg-primary)';
            (e.currentTarget as HTMLAnchorElement).style.borderColor = 'rgba(255,255,255,0.25)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLAnchorElement).style.color = 'var(--fg-secondary)';
            (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--border-mid)';
          }}
        >
          Sign in
        </Link>
      </nav>

      {/* Hero */}
      <section
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '80px 24px 60px',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Background glow */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse 60% 50% at 50% 40%, rgba(33, 212, 255, 0.04) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        {/* Eyebrow */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 24,
            padding: '5px 12px',
            borderRadius: 20,
            border: '1px solid var(--accent-border)',
            background: 'var(--accent-gradient-soft)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
          }}
        >
          AI Video Editor
        </div>

        {/* Headline */}
        <h1
          style={{
            fontSize: 'clamp(36px, 6vw, 64px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            margin: '0 0 20px',
            maxWidth: 680,
          }}
        >
          Edit your videos by{' '}
          <span style={{ color: 'var(--accent)' }}>describing</span> them.
        </h1>

        {/* Subheadline */}
        <p
          style={{
            fontSize: 'clamp(15px, 2vw, 18px)',
            color: 'var(--fg-secondary)',
            lineHeight: 1.6,
            maxWidth: 500,
            margin: '0 0 40px',
          }}
        >
          Tell Autocut what to cut. It finds the moments and makes the edits —
          no timeline scrubbing required.
        </p>

        {/* CTA */}
        <Link
          href="/auth/login"
          className="iridescent-button"
          style={{
            display: 'inline-block',
            padding: '12px 28px',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
            transition: 'filter 0.15s ease, box-shadow 0.15s ease',
            letterSpacing: '-0.01em',
          }}
        >
          Start editing →
        </Link>
      </section>

      {/* How it works */}
      <section
        style={{
          padding: '60px 40px 80px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 40,
        }}
      >
        <p
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            margin: 0,
          }}
        >
          How it works
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 16,
            width: '100%',
            maxWidth: 760,
          }}
        >
          {steps.map((step, i) => (
            <div
              key={step.label}
              style={{
                background: 'var(--bg-panel)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '28px 24px',
                transition: 'transform 0.15s ease, box-shadow 0.15s ease',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
                (e.currentTarget as HTMLDivElement).style.boxShadow =
                  '0 8px 24px rgba(0,0,0,0.35)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
                (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fg-muted)',
                  marginBottom: 10,
                }}
              >
                0{i + 1}
              </div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  marginBottom: 8,
                  letterSpacing: '-0.01em',
                }}
              >
                {step.label}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--fg-secondary)',
                  lineHeight: 1.55,
                }}
              >
                {step.description}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer
        style={{
          borderTop: '1px solid var(--border)',
          padding: '20px 40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          © Autocut
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AutocutMark size={16} withTile={false} />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--fg-muted)',
              letterSpacing: '-0.01em',
            }}
          >
            Autocut
          </span>
        </div>
      </footer>
    </div>
  );
}
