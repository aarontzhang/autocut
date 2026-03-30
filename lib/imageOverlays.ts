import type { ImageOverlayEntry } from './types';
import type { CSSProperties } from 'react';

export const DEFAULT_IMAGE_WIDTH_PERCENT = 25;
export const DEFAULT_IMAGE_OPACITY = 1.0;

export function normalizeImageOverlayEntry(entry: Partial<ImageOverlayEntry>): ImageOverlayEntry | null {
  if (
    !Number.isFinite(entry.startTime)
    || !Number.isFinite(entry.endTime)
    || entry.endTime! <= entry.startTime!
    || typeof entry.sourceId !== 'string'
    || entry.sourceId.length === 0
  ) {
    return null;
  }

  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    sourceId: entry.sourceId,
    startTime: entry.startTime!,
    endTime: entry.endTime!,
    positionX: Number.isFinite(entry.positionX) ? Math.max(0, Math.min(100, Number(entry.positionX))) : 50,
    positionY: Number.isFinite(entry.positionY) ? Math.max(0, Math.min(100, Number(entry.positionY))) : 50,
    widthPercent: Number.isFinite(entry.widthPercent) ? Math.max(5, Math.min(100, Number(entry.widthPercent))) : DEFAULT_IMAGE_WIDTH_PERCENT,
    opacity: Number.isFinite(entry.opacity) ? Math.max(0, Math.min(1, Number(entry.opacity))) : DEFAULT_IMAGE_OPACITY,
  };
}

export function getImageOverlayPreviewStyle(
  overlay: ImageOverlayEntry,
): CSSProperties {
  return {
    position: 'absolute' as const,
    left: `${overlay.positionX}%`,
    top: `${overlay.positionY}%`,
    transform: 'translate(-50%, -50%)',
    width: `${overlay.widthPercent}%`,
    opacity: overlay.opacity,
    pointerEvents: 'auto' as const,
    cursor: 'grab',
  };
}
