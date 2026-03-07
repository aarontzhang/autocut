'use client';

import { useRef, useState, useCallback } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';

export default function UploadScreen() {
  const setVideoFile = useEditorStore(s => s.setVideoFile);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('video/')) return;
    setVideoFile(file);
  }, [setVideoFile]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div
      className="h-screen flex flex-col items-center justify-center"
      style={{ background: 'var(--bg-base)' }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5 mb-12">
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'linear-gradient(135deg, #00c4cc, #0094ff)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </div>
        <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg-primary)', letterSpacing: '-0.02em' }}>
          CUT
        </span>
      </div>

      {/* Drop zone */}
      <div
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onClick={() => inputRef.current?.click()}
        style={{
          width: 480,
          border: `1.5px dashed ${isDragging ? 'var(--teal)' : 'rgba(255,255,255,0.15)'}`,
          borderRadius: 12,
          padding: '52px 32px',
          background: isDragging ? 'var(--teal-dim)' : 'rgba(255,255,255,0.02)',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
        }}
      >
        {/* Upload icon */}
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: isDragging ? 'var(--teal-dim)' : 'rgba(255,255,255,0.04)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: `1px solid ${isDragging ? 'var(--teal-border)' : 'rgba(255,255,255,0.08)'}`,
          transition: 'all 0.2s ease',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
            stroke={isDragging ? 'var(--teal)' : 'rgba(255,255,255,0.4)'} strokeWidth="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </div>

        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--fg-primary)', marginBottom: 6 }}>
            {isDragging ? 'Drop to import' : 'Import video'}
          </p>
          <p style={{ fontSize: 13, color: 'var(--fg-secondary)' }}>
            Drag & drop or click to browse
          </p>
        </div>

        <div style={{
          display: 'flex', gap: 8, marginTop: 4,
        }}>
          {['MP4', 'MOV', 'AVI', 'WEBM', 'MKV'].map(fmt => (
            <span key={fmt} style={{
              fontSize: 11, fontFamily: 'var(--font-geist-mono)',
              color: 'var(--fg-muted)',
              padding: '2px 7px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 4,
            }}>{fmt}</span>
          ))}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
      </div>

      {/* Bottom hint */}
      <p style={{ marginTop: 28, fontSize: 12, color: 'var(--fg-muted)' }}>
        Powered by Claude AI · No file size limits
      </p>
    </div>
  );
}
