'use client';

import Link from 'next/link';
import AutocutMark from '@/components/branding/AutocutMark';

/* ─── Reusable window chrome ─────────────────────────────────── */

function AppWindow({
  children,
  style,
  accent = false,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  accent?: boolean;
}) {
  return (
    <div style={{
      background: '#0d0d0d',
      borderRadius: 10,
      border: accent
        ? '1px solid rgba(33, 212, 255, 0.22)'
        : '1px solid rgba(255,255,255,0.09)',
      boxShadow: accent
        ? '0 0 0 1px rgba(33,212,255,0.06), 0 40px 100px rgba(0,0,0,0.7), 0 0 60px rgba(33,212,255,0.05)'
        : '0 40px 100px rgba(0,0,0,0.7)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      ...style,
    }}>
      {/* macOS chrome */}
      <div style={{
        height: 36,
        background: '#161616',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 7,
        flexShrink: 0,
      }}>
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#3a3a3a' }} />
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#3a3a3a' }} />
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#3a3a3a' }} />
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          marginRight: 52,
        }}>
          <AutocutMark size={14} withTile />
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.01em' }}>Autocut</span>
        </div>
      </div>
      {children}
    </div>
  );
}

/* ─── Video scene placeholder ────────────────────────────────── */

function VideoScene() {
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {/* Sky gradient */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: '58%',
        background: 'linear-gradient(180deg, #0c1b4d 0%, #1a3a8a 35%, #2563eb 70%, #93c5fd 100%)',
      }} />
      {/* Ground */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, height: '48%',
        background: 'linear-gradient(180deg, #4ade80 0%, #22c55e 35%, #15803d 100%)',
      }} />
      {/* Sun glow */}
      <div style={{
        position: 'absolute', top: '18%', right: '30%',
        width: 36, height: 36,
        borderRadius: '50%',
        background: '#fef08a',
        boxShadow: '0 0 30px 14px rgba(254,240,138,0.3), 0 0 60px 28px rgba(253,224,71,0.1)',
      }} />
      {/* Horizon haze */}
      <div style={{
        position: 'absolute', top: '50%', left: 0, right: 0, height: 20,
        background: 'linear-gradient(180deg, rgba(147,197,253,0.4) 0%, rgba(74,222,128,0.4) 100%)',
        filter: 'blur(4px)',
        transform: 'translateY(-50%)',
      }} />
      {/* Person silhouette */}
      <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)' }}>
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {/* Head */}
          <div style={{
            width: 26, height: 26, borderRadius: '50%',
            background: 'rgba(5,10,30,0.75)',
          }} />
          {/* Body */}
          <div style={{
            width: 52, height: 70,
            background: 'rgba(5,10,30,0.75)',
            borderRadius: '46% 46% 0 0',
            marginTop: -6,
          }} />
        </div>
      </div>
      {/* Vignette */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at 50% 50%, transparent 50%, rgba(0,0,0,0.3) 100%)',
      }} />
    </div>
  );
}

/* ─── Full editor mock (hero) ────────────────────────────────── */

function HeroEditorMock() {
  return (
    <AppWindow accent style={{ flex: 1, minHeight: 0 }}>
      {/* App top bar */}
      <div style={{
        height: 38,
        background: '#141414',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 8,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 2 }}>
          {[1, 2].map(i => (
            <div key={i} style={{
              width: 22, height: 22, borderRadius: 5,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.06)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {i === 1
                ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 7L5 4l3 3" stroke="rgba(255,255,255,0.3)" strokeWidth="1.4" strokeLinecap="round" /></svg>
                : <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M8 7L5 4 2 7" stroke="rgba(255,255,255,0.3)" strokeWidth="1.4" strokeLinecap="round" /></svg>
              }
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{
          height: 22, padding: '0 10px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 5,
          display: 'flex', alignItems: 'center',
          fontSize: 10, color: 'rgba(255,255,255,0.35)',
          gap: 5,
        }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#4ade80' }} />
          Export
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left: video + timeline */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          minWidth: 0,
        }}>
          {/* Video player */}
          <div style={{ flex: 1, position: 'relative', background: '#080808', minHeight: 0 }}>
            <VideoScene />
            {/* Playback overlay */}
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              background: 'linear-gradient(transparent, rgba(0,0,0,0.7))',
              padding: '24px 10px 8px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%',
                  background: 'rgba(255,255,255,0.1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                    <path d="M2 1.5l5 2.5-5 2.5V1.5z" fill="rgba(255,255,255,0.7)" />
                  </svg>
                </div>
                <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.5)' }}>0:13 / 7:42</span>
              </div>
              {/* Scrubber */}
              <div style={{ height: 2, background: 'rgba(255,255,255,0.12)', borderRadius: 1, position: 'relative' }}>
                <div style={{ width: '28%', height: '100%', background: '#21d4ff', borderRadius: 1 }} />
                <div style={{
                  position: 'absolute', top: '50%', left: '28%',
                  transform: 'translate(-50%, -50%)',
                  width: 8, height: 8, borderRadius: '50%',
                  background: '#21d4ff',
                  boxShadow: '0 0 6px rgba(33,212,255,0.6)',
                }} />
              </div>
            </div>
          </div>

          {/* Timeline */}
          <div style={{
            height: 90,
            background: '#111111',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            padding: '8px 8px 0',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}>
            {/* Ruler */}
            <div style={{ display: 'flex', gap: 2, marginBottom: 2 }}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{ flex: 1, fontSize: 8, color: 'rgba(255,255,255,0.2)', textAlign: 'center' }}>
                  {i === 0 ? '0:00' : i === 4 ? '0:30' : ''}
                </div>
              ))}
            </div>
            {/* Tracks */}
            {[
              { label: 'video', segments: [{ w: '100%', color: 'linear-gradient(90deg, #149bff, #67e8ff)' }] },
              { label: 'audio', segments: [{ w: '88%', color: 'linear-gradient(90deg, #18acff, #82f0ff)' }] },
              { label: 'captions', segments: [{ w: '72%', color: 'linear-gradient(90deg, #d97706, #f59e0b)' }] },
            ].map(track => (
              <div key={track.label} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 16 }}>
                <span style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.2)', width: 38, flexShrink: 0, textAlign: 'right' }}>
                  {track.label}
                </span>
                <div style={{ flex: 1, height: '100%', background: 'rgba(255,255,255,0.04)', borderRadius: 2, overflow: 'hidden' }}>
                  {track.segments.map((seg, i) => (
                    <div key={i} style={{ width: seg.w, height: '100%', background: seg.color, borderRadius: 2 }} />
                  ))}
                </div>
              </div>
            ))}
            {/* Playhead */}
            <div style={{
              position: 'relative', marginTop: -56, pointerEvents: 'none',
            }}>
              <div style={{
                position: 'absolute', left: 'calc(38% + 42px)', top: 0, bottom: 0,
                width: 1, background: '#ffffff', opacity: 0.6,
                height: 56,
              }} />
            </div>
          </div>
        </div>

        {/* Right: chat sidebar */}
        <div style={{
          width: 240,
          display: 'flex',
          flexDirection: 'column',
          background: '#0e0e0e',
          flexShrink: 0,
        }}>
          {/* Messages */}
          <div style={{
            flex: 1,
            padding: '12px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            justifyContent: 'flex-end',
            overflowY: 'hidden',
          }}>
            {/* User message */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <div style={{
                background: 'rgba(255,255,255,0.07)',
                borderRadius: '8px 8px 2px 8px',
                padding: '7px 10px',
                fontSize: 11,
                color: 'rgba(255,255,255,0.75)',
                maxWidth: '85%',
                lineHeight: 1.5,
              }}>
                Cut every time I say "um" or pause awkwardly
              </div>
            </div>

            {/* AI message */}
            <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
              <div style={{ flexShrink: 0, marginTop: 1 }}>
                <AutocutMark size={16} withTile />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 8, lineHeight: 1.5,
                }}>
                  Found 18 moments. Ready to review.
                </div>
                {/* Action card */}
                <div style={{
                  background: '#1a1a1a',
                  border: '1px solid rgba(255,255,255,0.09)',
                  borderRadius: 7,
                  overflow: 'hidden',
                }}>
                  {/* Card header */}
                  <div style={{
                    padding: '8px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                  }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>Delete ranges</span>
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginLeft: 'auto' }}>18 cuts</span>
                  </div>
                  {/* Card footer */}
                  <div style={{ padding: '7px 10px' }}>
                    <button style={{
                      width: '100%',
                      padding: '6px',
                      background: 'rgba(33,212,255,0.1)',
                      border: '1px solid rgba(33,212,255,0.28)',
                      borderRadius: 5,
                      fontSize: 11,
                      fontWeight: 500,
                      color: '#21d4ff',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}>
                      Start review →
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Input */}
          <div style={{
            padding: '8px 10px 10px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}>
            <div style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 7,
              padding: '8px 10px',
              fontSize: 10.5,
              color: 'rgba(255,255,255,0.2)',
            }}>
              Find events, reference markers, and review cuts…
            </div>
          </div>
        </div>
      </div>
    </AppWindow>
  );
}

/* ─── Chat flow mock (feature 1) ─────────────────────────────── */

function ChatFlowMock() {
  const messages = [
    { role: 'user', text: 'Add captions to the whole video' },
    {
      role: 'ai',
      text: 'Transcribed 7m 42s of audio. Captions ready.',
      card: { dot: '#f59e0b', label: 'Add captions', detail: '94 segments', cta: 'Start review →' },
    },
    { role: 'user', text: 'Also cut the intro — first 22 seconds' },
    {
      role: 'ai',
      text: 'Done.',
      card: { dot: '#ef4444', label: 'Delete range', detail: '0:00–0:22', status: 'Auto-applied ✓' },
    },
  ];

  return (
    <AppWindow accent style={{ width: '100%' }}>
      <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.map((msg, i) => (
          msg.role === 'user' ? (
            <div key={i} style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <div style={{
                background: 'rgba(255,255,255,0.07)',
                borderRadius: '8px 8px 2px 8px',
                padding: '8px 12px',
                fontSize: 12,
                color: 'rgba(255,255,255,0.75)',
                maxWidth: '75%',
                lineHeight: 1.5,
              }}>
                {msg.text}
              </div>
            </div>
          ) : (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <AutocutMark size={16} withTile />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 8, lineHeight: 1.5 }}>
                  {msg.text}
                </div>
                {msg.card && (
                  <div style={{
                    background: '#1a1a1a',
                    border: '1px solid rgba(255,255,255,0.09)',
                    borderRadius: 7,
                    overflow: 'hidden',
                    maxWidth: 280,
                  }}>
                    <div style={{
                      padding: '8px 12px',
                      display: 'flex', alignItems: 'center', gap: 6,
                      borderBottom: msg.card.cta ? '1px solid rgba(255,255,255,0.06)' : undefined,
                    }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: msg.card.dot, flexShrink: 0 }} />
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{msg.card.label}</span>
                      <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.3)', marginLeft: 'auto' }}>{msg.card.detail}</span>
                    </div>
                    {msg.card.cta && (
                      <div style={{ padding: '7px 12px' }}>
                        <button style={{
                          width: '100%', padding: '6px',
                          background: 'rgba(33,212,255,0.1)',
                          border: '1px solid rgba(33,212,255,0.28)',
                          borderRadius: 5, fontSize: 11, fontWeight: 500,
                          color: '#21d4ff', cursor: 'pointer', fontFamily: 'inherit',
                        }}>{msg.card.cta}</button>
                      </div>
                    )}
                    {msg.card.status && (
                      <div style={{ padding: '7px 12px', fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
                        {msg.card.status}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        ))}
      </div>
    </AppWindow>
  );
}

/* ─── Timeline mock (feature 2) ─────────────────────────────── */

function TimelineMock() {
  const tracks = [
    {
      label: 'video',
      clips: [
        { start: '0%', width: '28%', color: 'linear-gradient(90deg, #149bff, #67e8ff)' },
        { start: '30%', width: '42%', color: 'linear-gradient(90deg, #149bff, #67e8ff)' },
        { start: '74%', width: '22%', color: 'linear-gradient(90deg, #149bff, #67e8ff)' },
      ],
    },
    {
      label: 'audio',
      clips: [
        { start: '0%', width: '99%', color: 'linear-gradient(90deg, #18acff, #82f0ff)', opacity: 0.7 },
      ],
    },
    {
      label: 'captions',
      clips: [
        { start: '0%', width: '68%', color: 'linear-gradient(90deg, #d97706, #f59e0b)' },
      ],
    },
    {
      label: 'text',
      clips: [
        { start: '4%', width: '18%', color: 'linear-gradient(90deg, #7c3aed, #a78bfa)' },
      ],
    },
  ];

  const markers = [
    { pos: '18%', label: '@1' },
    { pos: '38%', label: '@2' },
    { pos: '62%', label: '@3' },
  ];

  return (
    <AppWindow accent style={{ width: '100%' }}>
      {/* Ruler */}
      <div style={{
        height: 24,
        background: '#141414',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        padding: '0 8px 0 80px',
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between' }}>
          {['0:00', '1:00', '2:00', '3:00', '4:00', '5:00', '6:00', '7:00', '7:42'].map(t => (
            <span key={t} style={{ fontSize: 9, color: 'rgba(255,255,255,0.22)' }}>{t}</span>
          ))}
        </div>
      </div>

      {/* Tracks */}
      <div style={{ padding: '10px 8px 14px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {tracks.map(track => (
          <div key={track.label} style={{ display: 'flex', alignItems: 'center', gap: 0, height: 22 }}>
            <div style={{ width: 72, flexShrink: 0, fontSize: 9.5, color: 'rgba(255,255,255,0.22)', textAlign: 'right', paddingRight: 8 }}>
              {track.label}
            </div>
            <div style={{ flex: 1, height: '100%', background: 'rgba(255,255,255,0.03)', borderRadius: 3, position: 'relative', overflow: 'visible' }}>
              {track.clips.map((clip, i) => (
                <div key={i} style={{
                  position: 'absolute',
                  left: clip.start,
                  width: clip.width,
                  top: 0, bottom: 0,
                  background: clip.color,
                  borderRadius: 3,
                  opacity: (clip as any).opacity ?? 1,
                }} />
              ))}
              {/* Playhead on first track */}
              {track.label === 'video' && (
                <div style={{
                  position: 'absolute',
                  left: '38%',
                  top: -24,
                  bottom: -86,
                  width: 1,
                  background: 'rgba(255,255,255,0.55)',
                  zIndex: 10,
                  pointerEvents: 'none',
                }} />
              )}
            </div>
          </div>
        ))}

        {/* Markers row */}
        <div style={{ display: 'flex', alignItems: 'center', height: 16 }}>
          <div style={{ width: 72, flexShrink: 0 }} />
          <div style={{ flex: 1, position: 'relative', height: '100%' }}>
            {markers.map(m => (
              <div key={m.label} style={{
                position: 'absolute',
                left: m.pos,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 0,
              }}>
                <div style={{
                  fontSize: 8.5,
                  fontWeight: 700,
                  color: '#21d4ff',
                  background: 'rgba(33,212,255,0.12)',
                  border: '1px solid rgba(33,212,255,0.3)',
                  borderRadius: 3,
                  padding: '1px 4px',
                  lineHeight: 1.4,
                }}>{m.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppWindow>
  );
}

/* ─── Main page ─────────────────────────────────────────────── */

export default function LandingPage() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#111111',
      color: 'rgba(255,255,255,0.92)',
      fontFamily: 'var(--font-serif), system-ui, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      overflowX: 'hidden',
    }}>

      {/* ── Nav ─────────────────────────────────────────────── */}
      <nav style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 48px',
        height: 54,
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'rgba(17,17,17,0.92)',
        backdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <AutocutMark size={32} withTile />
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em' }}>
            Autocut
          </span>
        </div>
        <Link
          href="/auth/login"
          className="iridescent-button"
          style={{
            display: 'inline-block',
            padding: '8px 20px',
            borderRadius: 20,
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
            letterSpacing: '-0.01em',
          }}
        >
          Start editing
        </Link>
      </nav>

      {/* ── Hero ──────────────────────────────────────────────── */}
      <section style={{
        display: 'grid',
        gridTemplateColumns: '400px 1fr',
        minHeight: 'calc(100vh - 54px)',
        paddingLeft: 64,
        paddingTop: 0,
        paddingBottom: 0,
        gap: 0,
        alignItems: 'stretch',
      }}>
        {/* Left: text */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          paddingRight: 40,
          paddingTop: 60,
          paddingBottom: 60,
        }}>
          <h1 style={{
            fontSize: 'clamp(38px, 3.6vw, 54px)',
            fontWeight: 700,
            letterSpacing: '-0.035em',
            lineHeight: 1.08,
            margin: '0 0 20px',
          }}>
            Describe your edit.<br />Autocut makes it real.
          </h1>
          <p style={{
            fontSize: 16,
            color: 'rgba(255,255,255,0.42)',
            lineHeight: 1.65,
            margin: '0 0 36px',
          }}>
            Tell Autocut what you want changed — cut the filler, add captions, trim a section. It finds the right moments in your video and applies every edit directly to your timeline.
          </p>
          <div>
            <Link
              href="/auth/login"
              className="iridescent-button"
              style={{
                display: 'inline-block',
                padding: '12px 28px',
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
        </div>

        {/* Right: editor mock — extends to viewport edge */}
        <div style={{
          padding: '24px 0 24px 24px',
          display: 'flex',
          alignItems: 'stretch',
          overflow: 'hidden',
        }}>
          <HeroEditorMock />
        </div>
      </section>

      {/* ── Feature 1: Chat flow ──────────────────────────────── */}
      <section style={{
        borderTop: '1px solid rgba(255,255,255,0.05)',
        padding: '96px 64px',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 72,
        alignItems: 'center',
        maxWidth: 1280,
        margin: '0 auto',
        width: '100%',
      }}>
        <div>
          <h2 style={{
            fontSize: 'clamp(30px, 2.8vw, 42px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            margin: '0 0 18px',
          }}>
            Type it.<br />Review it.<br />Done.
          </h2>
          <p style={{
            fontSize: 15,
            color: 'rgba(255,255,255,0.42)',
            lineHeight: 1.7,
            margin: 0,
            maxWidth: 360,
          }}>
            Each edit is proposed as an action card — you control what gets applied. Step through your cuts one at a time, keep what works, skip what doesn't.
          </p>
        </div>
        <ChatFlowMock />
      </section>

      {/* ── Feature 2: Timeline ───────────────────────────────── */}
      <section style={{
        borderTop: '1px solid rgba(255,255,255,0.05)',
        padding: '96px 64px',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 72,
        alignItems: 'center',
        maxWidth: 1280,
        margin: '0 auto',
        width: '100%',
      }}>
        <TimelineMock />
        <div>
          <h2 style={{
            fontSize: 'clamp(30px, 2.8vw, 42px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            margin: '0 0 18px',
          }}>
            Every edit,<br />exactly placed.
          </h2>
          <p style={{
            fontSize: 15,
            color: 'rgba(255,255,255,0.42)',
            lineHeight: 1.7,
            margin: 0,
            maxWidth: 360,
          }}>
            Cuts, captions, text overlays, and transitions all land on the timeline precisely. Review markers let you jump straight to each proposed moment before committing anything.
          </p>
        </div>
      </section>

      {/* ── Pull quote + CTA ─────────────────────────────────── */}
      <section style={{
        borderTop: '1px solid rgba(255,255,255,0.05)',
        padding: '110px 64px',
        textAlign: 'center',
        maxWidth: 1280,
        margin: '0 auto',
        width: '100%',
      }}>
        <p style={{
          fontSize: 'clamp(26px, 3.2vw, 44px)',
          fontWeight: 600,
          letterSpacing: '-0.03em',
          lineHeight: 1.18,
          color: 'rgba(255,255,255,0.88)',
          maxWidth: 660,
          margin: '0 auto 40px',
        }}>
          The fastest editors aren't faster at scrubbing.<br />They just describe it and move on.
        </p>
        <Link
          href="/auth/login"
          className="iridescent-button"
          style={{
            display: 'inline-block',
            padding: '13px 32px',
            borderRadius: 26,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
            letterSpacing: '-0.01em',
          }}
        >
          Start for free →
        </Link>
      </section>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer style={{
        borderTop: '1px solid rgba(255,255,255,0.06)',
        padding: '20px 48px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AutocutMark size={20} withTile />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.35)' }}>
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
