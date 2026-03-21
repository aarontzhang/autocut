'use client';

import { useMemo, useRef } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { formatTimeShort } from '@/lib/timelineUtils';

export default function MediaPanel({
  onImportSources,
}: {
  onImportSources?: (files: File[]) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const sources = useEditorStore((s) => s.sources);
  const sourceRuntimeById = useEditorStore((s) => s.sourceRuntimeById);
  const appendClipFromSource = useEditorStore((s) => s.appendClipFromSource);

  const sourceCards = useMemo(() => (
    sources.map((source) => ({
      ...source,
      previewUrl: sourceRuntimeById[source.id]?.objectUrl || sourceRuntimeById[source.id]?.playerUrl || '',
    }))
  ), [sourceRuntimeById, sources]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg-panel)' }}>
      <div style={{
        height: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 12px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-serif)' }}>
          Sources
        </span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          style={{
            border: '1px solid var(--border-mid)',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--fg-secondary)',
            fontSize: 11,
            padding: '5px 8px',
            cursor: 'pointer',
          }}
        >
          Import
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sourceCards.map((source) => (
          <div
            key={source.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'copyMove';
              event.dataTransfer.setData('application/x-autocut-source-id', source.id);
              event.dataTransfer.setData('text/plain', source.fileName);
            }}
            style={{
              borderRadius: 10,
              overflow: 'hidden',
              border: source.isPrimary ? '1px solid rgba(96,165,250,0.55)' : '1px solid var(--border-mid)',
              background: 'var(--bg-elevated)',
              cursor: 'grab',
            }}
          >
            <div style={{ width: '100%', aspectRatio: '16/9', background: '#000', position: 'relative', overflow: 'hidden' }}>
              {source.previewUrl ? (
                <video
                  src={source.previewUrl}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  muted
                  preload="metadata"
                  playsInline
                />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)' }}>
                  <span style={{ fontSize: 11, fontFamily: 'var(--font-serif)' }}>Waiting for media…</span>
                </div>
              )}
              {source.duration > 0 && (
                <div style={{
                  position: 'absolute', bottom: 8, left: 8,
                  fontSize: 10, fontFamily: 'var(--font-serif)', color: '#fff',
                  background: 'rgba(0,0,0,0.7)', padding: '2px 6px', borderRadius: 4,
                }}>
                  {formatTimeShort(source.duration)}
                </div>
              )}
              <button
                type="button"
                onClick={() => appendClipFromSource(source.id)}
                style={{
                  position: 'absolute',
                  right: 8,
                  bottom: 8,
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  border: '1px solid rgba(255,255,255,0.18)',
                  background: 'rgba(16,16,16,0.72)',
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title="Append to timeline"
              >
                +
              </button>
            </div>
            <div style={{ padding: '10px 11px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-primary)', lineHeight: 1.4, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {source.fileName || 'Source video'}
                </p>
                {source.isPrimary && (
                  <span style={{
                    flexShrink: 0,
                    fontSize: 9,
                    padding: '2px 5px',
                    borderRadius: 999,
                    background: 'rgba(59,130,246,0.18)',
                    color: 'rgba(191,219,254,0.95)',
                    fontFamily: 'var(--font-serif)',
                  }}>
                    Primary
                  </span>
                )}
              </div>
              <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-serif)', textTransform: 'capitalize' }}>
                {source.status}
              </span>
            </div>
          </div>
        ))}

        {sourceCards.length === 0 && (
          <div style={{
            border: '1px dashed rgba(255,255,255,0.12)',
            borderRadius: 10,
            padding: '14px 12px',
            color: 'var(--fg-muted)',
            fontSize: 12,
            textAlign: 'center',
          }}>
            Import videos to build your source library.
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0 && onImportSources) {
              void onImportSources(files);
            }
            event.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
