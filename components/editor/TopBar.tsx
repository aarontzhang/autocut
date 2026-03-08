'use client';

import { useRef, useCallback, useState, useEffect } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { exportClips } from '@/lib/ffmpegClient';
import SaveIndicator from '@/components/editor/SaveIndicator';
import { useAuth } from '@/components/auth/AuthProvider';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

function UserMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSignOut = async () => {
    await getSupabaseBrowser().auth.signOut();
    router.push('/auth/login');
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={email}
        style={{
          width: 28, height: 28, borderRadius: '50%',
          background: 'var(--accent)', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 600, color: '#fff', flexShrink: 0,
        }}
      >
        {email[0]?.toUpperCase() ?? '?'}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 36, right: 0, zIndex: 100,
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          minWidth: 200,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          overflow: 'hidden',
        }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {email}
            </p>
          </div>
          <button
            onClick={() => { setOpen(false); router.push('/projects'); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', padding: '9px 14px',
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 12, color: 'var(--fg-secondary)', textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--fg-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--fg-secondary)'; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
            </svg>
            My Projects
          </button>
          <div style={{ height: 1, background: 'var(--border)', margin: '0 14px' }} />
          <button
            onClick={handleSignOut}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', padding: '9px 14px',
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 12, color: 'var(--fg-secondary)', textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = '#f87171'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--fg-secondary)'; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function TopBar() {
  const videoFile = useEditorStore(s => s.videoFile);
  const videoData = useEditorStore(s => s.videoData);
  const ffmpegJob = useEditorStore(s => s.ffmpegJob);
  const clips = useEditorStore(s => s.clips);
  const setFFmpegJob = useEditorStore(s => s.setFFmpegJob);
  const setVideoFile = useEditorStore(s => s.setVideoFile);
  const undo = useEditorStore(s => s.undo);
  const redo = useEditorStore(s => s.redo);
  const canUndo = useEditorStore(s => s.history.length > 0);
  const canRedo = useEditorStore(s => s.future.length > 0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuth();
  const router = useRouter();

  const outputReady = ffmpegJob.status === 'done';
  const canExport = clips.length > 0 && ffmpegJob.status === 'idle' && !!videoFile;

  const handleExport = useCallback(async () => {
    if (!videoFile || clips.length === 0) return;
    setFFmpegJob({ status: 'running', progress: 0, stage: 'Initializing…' });
    try {
      const outputUrl = await exportClips({
        fileUrl: videoData ?? videoFile,
        clips,
        onStage: (stage) => setFFmpegJob({ status: 'running', progress: 0, stage }),
        onProgress: (progress) => setFFmpegJob({ status: 'running', progress, stage: 'Processing…' }),
      });
      setFFmpegJob({ status: 'done', outputUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
      setFFmpegJob({ status: 'error', message: msg || 'Unknown error' });
    }
  }, [videoFile, videoData, clips, setFFmpegJob]);

  return (
    <div style={{
      height: 44,
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border)',
      padding: '0 14px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexShrink: 0,
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 4 }}>
        <img src="/logo.png" width={20} height={20} style={{ display: 'block', flexShrink: 0 }} alt="Claude Cut" />
        <span style={{
          fontSize: 14, fontWeight: 600,
          color: 'var(--fg-primary)',
          letterSpacing: '-0.02em',
          fontFamily: 'var(--font-serif)',
        }}>
          Claude Cut
        </span>
      </div>

      <div style={{ width: 1, height: 16, background: 'var(--border-mid)' }} />

      {/* Undo / Redo */}
      <button
        onClick={undo}
        disabled={!canUndo}
        title="Undo (⌘Z)"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28,
          background: 'none', border: 'none', borderRadius: 4, cursor: canUndo ? 'pointer' : 'default',
          color: canUndo ? 'var(--fg-secondary)' : 'var(--fg-faint)',
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={e => { if (canUndo) { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--fg-primary)'; }}}
        onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = canUndo ? 'var(--fg-secondary)' : 'var(--fg-faint)'; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="1 4 1 10 7 10"/>
          <path d="M3.51 15a9 9 0 1 0 .49-3.96"/>
        </svg>
      </button>
      <button
        onClick={redo}
        disabled={!canRedo}
        title="Redo (⌘⇧Z)"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28,
          background: 'none', border: 'none', borderRadius: 4, cursor: canRedo ? 'pointer' : 'default',
          color: canRedo ? 'var(--fg-secondary)' : 'var(--fg-faint)',
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={e => { if (canRedo) { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--fg-primary)'; }}}
        onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = canRedo ? 'var(--fg-secondary)' : 'var(--fg-faint)'; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-.49-3.96"/>
        </svg>
      </button>

      <div style={{ width: 1, height: 16, background: 'var(--border-mid)' }} />

      {/* My Projects */}
      <button
        onClick={() => router.push('/projects')}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          fontSize: 12, color: 'var(--fg-secondary)',
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '4px 8px', borderRadius: 4,
          fontFamily: 'var(--font-serif)',
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--fg-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--fg-secondary)'; }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        </svg>
        Projects
      </button>

      {/* Import video */}
      <button
        onClick={() => inputRef.current?.click()}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          fontSize: 12, color: 'var(--fg-secondary)',
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '4px 8px', borderRadius: 4,
          fontFamily: 'var(--font-serif)',
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--fg-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--fg-secondary)'; }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        Import
      </button>
      <input
        ref={inputRef}
        type="file" accept="video/*"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) setVideoFile(f); }}
      />

      {/* File name */}
      {videoFile && (
        <span style={{
          fontSize: 12, color: 'var(--fg-muted)',
          maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {videoFile.name}
        </span>
      )}

      <div style={{ flex: 1 }} />

      <SaveIndicator />

      {/* Export / Download */}
      {outputReady ? (
        <a
          href={(ffmpegJob as { status: 'done'; outputUrl: string }).outputUrl}
          download="export-output.mp4"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, fontWeight: 500,
            background: 'var(--accent)', color: '#fff',
            border: 'none', borderRadius: 5, cursor: 'pointer',
            padding: '5px 14px', textDecoration: 'none',
            fontFamily: 'var(--font-serif)',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download
        </a>
      ) : (
        <button
          onClick={handleExport}
          disabled={!canExport}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, fontWeight: 500,
            background: canExport ? 'var(--accent)' : 'var(--bg-elevated)',
            color: canExport ? '#fff' : 'var(--fg-muted)',
            border: `1px solid ${canExport ? 'transparent' : 'var(--border-mid)'}`,
            borderRadius: 5, cursor: canExport ? 'pointer' : 'default',
            padding: '5px 14px',
            fontFamily: 'var(--font-serif)',
            transition: 'all 0.15s',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Export
        </button>
      )}

      {user && (
        <>
          <div style={{ width: 1, height: 16, background: 'var(--border-mid)', marginLeft: 4 }} />
          <UserMenu email={user.email ?? ''} />
        </>
      )}
    </div>
  );
}
