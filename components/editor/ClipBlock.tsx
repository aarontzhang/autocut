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
  index: number;
}

const CLIP_COLOR = {
  bg: 'rgba(59,130,246,0.35)',
  border: 'rgba(96,165,250,0.6)',
  hi: 'rgba(96,165,250,0.9)',
};

export default function ClipBlock({
  clip, left, width, height, isSelected,
  onSelect, index
}: ClipBlockProps) {
  void index;
  const color = CLIP_COLOR;

  // Timeline duration = sourceDuration / speed
  const timelineDuration = clip.sourceDuration / clip.speed;

  return (
    <div
      className="clip-block"
      style={{
        position: 'absolute',
        left,
        top: 6,
        width: Math.max(24, width),
        height: height - 12,
        background: color.bg,
        borderRadius: 4,
        border: `1.5px solid ${isSelected ? 'var(--accent)' : color.border}`,
        outline: isSelected ? '1.5px solid rgba(255,255,255,0.2)' : undefined,
        outlineOffset: isSelected ? '1px' : undefined,
        boxSizing: 'border-box',
        overflow: 'hidden',
        cursor: 'pointer',
        userSelect: 'none',
      }}
      onClick={onSelect}
    >
      {/* Label */}
      <div style={{
        position: 'absolute',
        left: 10,
        right: 10,
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
    </div>
  );
}
