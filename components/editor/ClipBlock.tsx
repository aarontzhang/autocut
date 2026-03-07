'use client';

import { VideoClip } from '@/lib/types';
import { formatTime } from '@/lib/timelineUtils';

interface ClipBlockProps {
  clip: VideoClip;
  left: number;    // px position
  width: number;   // px width
  height: number;
  isSelected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onMouseDown: (e: React.MouseEvent) => void;  // for drag-to-reorder
  onTrimLeftStart: (e: React.MouseEvent) => void;
  onTrimRightStart: (e: React.MouseEvent) => void;
  index: number;   // for alternating colors
}

const CLIP_COLORS = [
  { bg: 'rgba(59,130,246,0.35)', border: 'rgba(96,165,250,0.6)', hi: 'rgba(96,165,250,0.9)' },
  { bg: 'rgba(99,102,241,0.35)', border: 'rgba(129,140,248,0.6)', hi: 'rgba(129,140,248,0.9)' },
  { bg: 'rgba(16,185,129,0.3)', border: 'rgba(52,211,153,0.6)', hi: 'rgba(52,211,153,0.9)' },
  { bg: 'rgba(245,158,11,0.3)', border: 'rgba(251,191,36,0.6)', hi: 'rgba(251,191,36,0.9)' },
];

export default function ClipBlock({
  clip, left, width, height, isSelected,
  onSelect, onMouseDown, onTrimLeftStart, onTrimRightStart, index
}: ClipBlockProps) {
  const color = CLIP_COLORS[index % CLIP_COLORS.length];
  const HANDLE_W = 6;

  // Timeline duration = sourceDuration / speed
  const timelineDuration = clip.sourceDuration / clip.speed;

  return (
    <div
      className="clip-block"
      style={{
        position: 'absolute',
        left,
        top: 6,
        width: Math.max(HANDLE_W * 2 + 4, width),
        height: height - 12,
        background: color.bg,
        borderRadius: 4,
        border: `1.5px solid ${isSelected ? 'var(--accent)' : color.border}`,
        outline: isSelected ? '1.5px solid rgba(255,255,255,0.2)' : undefined,
        outlineOffset: isSelected ? '1px' : undefined,
        boxSizing: 'border-box',
        overflow: 'hidden',
        cursor: 'grab',
        userSelect: 'none',
      }}
      onClick={onSelect}
      onMouseDown={onMouseDown}
    >
      {/* Label */}
      <div style={{
        position: 'absolute',
        left: HANDLE_W + 4,
        right: HANDLE_W + 4,
        top: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}>
        <span style={{
          fontSize: 10,
          fontWeight: 500,
          color: 'rgba(255,255,255,0.85)',
          fontFamily: 'var(--font-serif)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 1,
        }}>
          {formatTime(timelineDuration)}
        </span>

        {/* Speed badge */}
        {clip.speed !== 1.0 && width > 40 && (
          <span style={{
            fontSize: 9,
            fontWeight: 700,
            color: 'rgba(255,220,50,1)',
            fontFamily: 'var(--font-serif)',
            background: 'rgba(0,0,0,0.35)',
            padding: '1px 4px',
            borderRadius: 2,
            flexShrink: 0,
          }}>
            {clip.speed}×
          </span>
        )}

        {/* Filter badge */}
        {clip.filter && clip.filter.type !== 'none' && width > 50 && (
          <span style={{
            fontSize: 9,
            color: 'rgba(167,139,250,0.9)',
            fontFamily: 'var(--font-serif)',
            background: 'rgba(139,92,246,0.2)',
            padding: '1px 4px',
            borderRadius: 2,
            flexShrink: 0,
          }}>
            {clip.filter.type[0].toUpperCase()}
          </span>
        )}
      </div>

      {/* Left trim handle */}
      <div
        style={{
          position: 'absolute',
          left: 0, top: 0, bottom: 0,
          width: HANDLE_W,
          background: isSelected ? color.hi : 'rgba(255,255,255,0.2)',
          cursor: 'ew-resize',
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onMouseDown={e => { e.stopPropagation(); onTrimLeftStart(e); }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ width: 1.5, height: 12, background: 'rgba(255,255,255,0.6)', borderRadius: 1 }} />
      </div>

      {/* Right trim handle */}
      <div
        style={{
          position: 'absolute',
          right: 0, top: 0, bottom: 0,
          width: HANDLE_W,
          background: isSelected ? color.hi : 'rgba(255,255,255,0.2)',
          cursor: 'ew-resize',
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onMouseDown={e => { e.stopPropagation(); onTrimRightStart(e); }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ width: 1.5, height: 12, background: 'rgba(255,255,255,0.6)', borderRadius: 1 }} />
      </div>
    </div>
  );
}
