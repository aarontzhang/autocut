'use client';

import { useRef, useCallback } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { formatTimeShort } from '@/lib/timelineUtils';

export default function MediaPanel() {
  const videoFile = useEditorStore(s => s.videoFile);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const videoUrl = useEditorStore(s => s.videoUrl);
  const setVideoFile = useEditorStore(s => s.setVideoFile);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleImport = useCallback((file: File) => {
    if (!file.type.startsWith('video/')) return;
    setVideoFile(file);
  }, [setVideoFile]);

  const fileSizeMB = videoFile ? (videoFile.size / 1024 / 1024).toFixed(1) : null;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%',
      background: 'var(--bg-panel)',
    }}>
      {/* Header */}
      <div style={{
        height: 40,
        display: 'flex', alignItems: 'center',
        padding: '0 12px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-serif)' }}>
          Media
        </span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {/* Media card */}
        {videoFile && videoUrl && (
          <div style={{
            borderRadius: 7,
            overflow: 'hidden',
            border: '1px solid var(--border-mid)',
            background: 'var(--bg-elevated)',
            cursor: 'pointer',
          }}>
            {/* Thumbnail */}
            <div style={{
              width: '100%',
              aspectRatio: '16/9',
              background: '#000',
              position: 'relative',
              overflow: 'hidden',
            }}>
              <video
                src={videoUrl}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                muted
              />
              {/* Duration badge */}
              {videoDuration > 0 && (
                <div style={{
                  position: 'absolute', bottom: 5, right: 6,
                  fontSize: 10, fontFamily: 'var(--font-serif)',
                  color: '#fff',
                  background: 'rgba(0,0,0,0.7)',
                  padding: '2px 5px', borderRadius: 3,
                }}>
                  {formatTimeShort(videoDuration)}
                </div>
              )}
            </div>

            {/* File info */}
            <div style={{ padding: '7px 9px' }}>
              <p style={{
                fontSize: 11, fontWeight: 500,
                color: 'var(--fg-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                marginBottom: 2,
              }}>
                {videoFile.name}
              </p>
              <p style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
                {fileSizeMB} MB{videoDuration > 0 ? ` · ${formatTimeShort(videoDuration)}` : ''}
              </p>
            </div>
          </div>
        )}

        {/* Import button */}
        <button
          onClick={() => inputRef.current?.click()}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            width: '100%', marginTop: 8,
            padding: '7px 10px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px dashed rgba(255,255,255,0.12)',
            borderRadius: 6, cursor: 'pointer',
            fontSize: 12, color: 'var(--fg-secondary)',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Import video
        </button>
        <input
          ref={inputRef}
          type="file" accept="video/*" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f); }}
        />
      </div>
    </div>
  );
}
