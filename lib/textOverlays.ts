import type { TextOverlayEntry } from './types';

export function normalizeTextOverlayEntry(entry: Partial<TextOverlayEntry>): TextOverlayEntry | null {
  if (
    !Number.isFinite(entry.startTime)
    || !Number.isFinite(entry.endTime)
    || entry.endTime! <= entry.startTime!
    || typeof entry.text !== 'string'
  ) {
    return null;
  }

  return {
    id: typeof entry.id === 'string' ? entry.id : undefined,
    startTime: entry.startTime!,
    endTime: entry.endTime!,
    text: entry.text,
    position: entry.position === 'top' || entry.position === 'center' || entry.position === 'bottom'
      ? entry.position
      : 'bottom',
    fontSize: Number.isFinite(entry.fontSize) ? Math.max(10, Number(entry.fontSize)) : undefined,
  };
}
