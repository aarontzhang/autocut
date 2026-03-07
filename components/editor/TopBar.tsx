'use client';

import { useRef, useCallback } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { exportClips } from '@/lib/ffmpegClient';

export default function TopBar() {
  const videoFile = useEditorStore(s => s.videoFile);
  const videoData = useEditorStore(s => s.videoData);
  const ffmpegJob = useEditorStore(s => s.ffmpegJob);
  const clips = useEditorStore(s => s.clips);
  const setFFmpegJob = useEditorStore(s => s.setFFmpegJob);
  const resetEditor = useEditorStore(s => s.resetEditor);
  const setVideoFile = useEditorStore(s => s.setVideoFile);
  const undo = useEditorStore(s => s.undo);
  const redo = useEditorStore(s => s.redo);
  const canUndo = useEditorStore(s => s.history.length > 0);
  const canRedo = useEditorStore(s => s.future.length > 0);
  const inputRef = useRef<HTMLInputElement>(null);

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
        <svg width="20" height="20" viewBox="0 0 18 18" fill="var(--accent)">
          <path d="M 0,2.5 Q 0,0 2.236,1.118 L 6.764,3.382 Q 9,4.5 6.764,5.618 L 2.236,7.882 Q 0,9 0,6.5 Z"/>
          <path d="M 9,7 Q 9,4.5 11.236,5.618 L 15.764,7.882 Q 18,9 15.764,10.118 L 11.236,12.382 Q 9,13.5 9,11 Z"/>
          <path d="M 0,11.5 Q 0,9 2.236,10.118 L 6.764,12.382 Q 9,13.5 6.764,14.618 L 2.236,16.882 Q 0,18 0,15.5 Z"/>
        </svg>
        <span style={{
          fontSize: 14, fontWeight: 600,
          color: 'var(--fg-primary)',
          letterSpacing: '-0.02em',
          fontFamily: 'var(--font-serif)',
        }}>
          Autocut
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

      {/* New Project */}
      <button
        onClick={resetEditor}
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
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        New
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

      {/* Export / Download */}
      {outputReady ? (
        <a
          href={(ffmpegJob as { status: 'done'; outputUrl: string }).outputUrl}
          download="export-output.mp4"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, fontWeight: 500,
            background: 'var(--accent)', color: '#000',
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
            color: canExport ? '#000' : 'var(--fg-muted)',
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
    </div>
  );
}
