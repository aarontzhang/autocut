'use client';

import { useRef, useCallback } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { formatTimeShort } from '@/lib/timelineUtils';

export default function MediaPanel({
  onImportMainFile,
  onImportLibraryFile,
  onImportFiles,
}: {
  onImportMainFile?: (file: File) => void;
  onImportLibraryFile?: (file: File) => Promise<void>;
  onImportFiles?: (files: File[]) => void | Promise<void>;
}) {
  const videoUrl = useEditorStore(s => s.videoUrl);
  const mediaLibrary = useEditorStore(s => s.mediaLibrary);
  const setVideoFile = useEditorStore(s => s.setVideoFile);
  const addToMediaLibrary = useEditorStore(s => s.addToMediaLibrary);
  const appendVideoToTimeline = useEditorStore(s => s.appendVideoToTimeline);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleImport = useCallback(async (file: File) => {
    if (!file.type.startsWith('video/')) return;
    if (!videoUrl) {
      if (onImportMainFile) onImportMainFile(file);
      else setVideoFile(file);
    } else {
      if (onImportLibraryFile) await onImportLibraryFile(file);
      else await addToMediaLibrary(file);
    }
  }, [videoUrl, setVideoFile, addToMediaLibrary, onImportMainFile, onImportLibraryFile]);

  const handleImportFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    if (onImportFiles) {
      await onImportFiles(files);
      return;
    }

    for (const file of files) {
      await handleImport(file);
    }
  }, [handleImport, onImportFiles]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-panel)' }}>
      <div style={{
        height: 40, display: 'flex', alignItems: 'center',
        padding: '0 12px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-serif)' }}>
          Media
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {mediaLibrary.map((item, idx) => (
          <div key={item.id} style={{
            borderRadius: 7, overflow: 'hidden',
            border: '1px solid var(--border-mid)',
            background: 'var(--bg-elevated)',
          }}>
            <div style={{ width: '100%', aspectRatio: '16/9', background: '#000', position: 'relative', overflow: 'hidden' }}>
              <video
                src={item.url}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                muted
                preload="none"
                playsInline
              />
              {item.duration > 0 && (
                <div style={{
                  position: 'absolute', bottom: 5, right: 6,
                  fontSize: 10, fontFamily: 'var(--font-serif)', color: '#fff',
                  background: 'rgba(0,0,0,0.7)', padding: '2px 5px', borderRadius: 3,
                }}>
                  {formatTimeShort(item.duration)}
                </div>
              )}
            </div>
            <div style={{ padding: '7px 9px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 1 }}>
                  {item.name}
                </p>
                <p style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
                  {item.duration > 0 ? formatTimeShort(item.duration) : '—'}{idx === 0 ? ' · main' : ''}
                </p>
              </div>
              {idx > 0 && (
                <button
                  onClick={() => appendVideoToTimeline(item.url, item.name, item.duration, item.sourcePath, item.sourceId)}
                  title="Append to timeline"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '4px 8px', borderRadius: 5,
                    border: '1px solid var(--border-mid)',
                    background: 'rgba(255,255,255,0.05)', cursor: 'pointer',
                    fontSize: 11, color: 'var(--fg-secondary)', flexShrink: 0,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                    <polyline points="12 5 19 12 12 19"/>
                  </svg>
                  Append
                </button>
              )}
            </div>
          </div>
        ))}

        <button
          onClick={() => inputRef.current?.click()}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            width: '100%', padding: '7px 10px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px dashed rgba(255,255,255,0.12)',
            borderRadius: 6, cursor: 'pointer',
            fontSize: 12, color: 'var(--fg-secondary)',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Import video
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          multiple
          className="hidden"
          onChange={e => {
            void handleImportFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
