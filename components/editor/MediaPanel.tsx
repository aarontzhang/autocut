'use client';

import { useRef } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { formatTimeShort } from '@/lib/timelineUtils';

export default function MediaPanel({
  onImportMainFile,
  canImport,
}: {
  onImportMainFile?: (file: File) => void | Promise<void>;
  canImport: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const videoUrl = useEditorStore(s => s.videoUrl);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const videoName = useEditorStore(s => s.videoName);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg-panel)' }}>
      <div style={{
        height: 40, display: 'flex', alignItems: 'center',
        padding: '0 12px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-serif)' }}>
          Source
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {videoUrl && (
          <div
            style={{
              borderRadius: 10,
              overflow: 'hidden',
              border: '1px solid var(--border-mid)',
              background: 'var(--bg-elevated)',
            }}
          >
            <div style={{ width: '100%', aspectRatio: '16/9', background: '#000', position: 'relative', overflow: 'hidden' }}>
              <video
                src={videoUrl}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                muted
                preload="metadata"
                playsInline
              />
              {videoDuration > 0 && (
                <div style={{
                  position: 'absolute', bottom: 8, right: 8,
                  fontSize: 10, fontFamily: 'var(--font-serif)', color: '#fff',
                  background: 'rgba(0,0,0,0.7)', padding: '2px 6px', borderRadius: 4,
                }}>
                  {formatTimeShort(videoDuration)}
                </div>
              )}
            </div>
            <div style={{ padding: '10px 11px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-primary)', lineHeight: 1.4 }}>
                {videoName || 'Source video'}
              </p>
            </div>
          </div>
        )}

        {canImport && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            style={{
              flexShrink: 0,
              display: 'flex', alignItems: 'center', gap: 7,
              width: '100%', padding: '9px 10px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px dashed rgba(255,255,255,0.12)',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12,
              color: 'var(--fg-secondary)',
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Import video
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file && onImportMainFile) {
              void onImportMainFile(file);
            }
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
