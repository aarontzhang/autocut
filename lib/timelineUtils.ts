import { VideoClip, CaptionEntry } from './types';

/**
 * Convert a current-timeline timestamp to the corresponding source video timestamp,
 * accounting for which clip it falls in and any speed changes.
 */
export function timelineToSourceTime(clips: VideoClip[], timelineTime: number): number {
  let cursor = 0;
  for (const clip of clips) {
    const clipDuration = clip.sourceDuration / clip.speed;
    if (timelineTime <= cursor + clipDuration) {
      const offset = Math.max(0, timelineTime - cursor);
      return clip.sourceStart + offset * clip.speed;
    }
    cursor += clipDuration;
  }
  // Past end — clamp to end of last clip
  if (clips.length > 0) {
    const last = clips[clips.length - 1];
    return last.sourceStart + last.sourceDuration;
  }
  return timelineTime;
}

/**
 * For a timeline range [startTime, endTime], return the source video segments
 * that correspond to it, with their timeline offsets for timestamp correction.
 */
export function getSourceSegmentsForTimelineRange(
  clips: VideoClip[],
  startTime: number,
  endTime: number,
): Array<{ sourceStart: number; sourceDuration: number; timelineOffset: number }> {
  const segments: Array<{ sourceStart: number; sourceDuration: number; timelineOffset: number }> = [];
  let cursor = 0;
  for (const clip of clips) {
    const clipDuration = clip.sourceDuration / clip.speed;
    const clipStart = cursor;
    const clipEnd = cursor + clipDuration;
    const overlapStart = Math.max(startTime, clipStart);
    const overlapEnd = Math.min(endTime, clipEnd);
    if (overlapEnd > overlapStart) {
      const sourceOffset = (overlapStart - clipStart) * clip.speed;
      segments.push({
        sourceStart: clip.sourceStart + sourceOffset,
        sourceDuration: (overlapEnd - overlapStart) * clip.speed,
        timelineOffset: overlapStart,
      });
    }
    cursor = clipEnd;
    if (cursor >= endTime) break;
  }
  return segments;
}

export function timeToPx(time: number, duration: number, width: number): number {
  if (duration <= 0) return 0;
  return (time / duration) * width;
}

export function pxToTime(px: number, duration: number, width: number): number {
  if (width <= 0) return 0;
  return Math.max(0, Math.min(duration, (px / width) * duration));
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatTimeDetailed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
}

export function formatTimePrecise(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const m = Math.floor(safeSeconds / 60);
  const s = Math.floor(safeSeconds % 60);
  const ms = Math.round((safeSeconds % 1) * 1000);
  if (ms === 1000) {
    return formatTimePrecise(safeSeconds + 0.001);
  }
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

export function formatTimeShort(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function getRulerTicks(duration: number, width: number): { time: number; major: boolean }[] {
  if (duration <= 0 || width <= 0) return [];
  const targetMajor = Math.max(4, Math.floor(width / 80));
  const rawInterval = duration / targetMajor;

  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let majorInterval = candidates[candidates.length - 1];
  for (const c of candidates) {
    if (c >= rawInterval) { majorInterval = c; break; }
  }
  const minorInterval = majorInterval / 5;

  const ticks: { time: number; major: boolean }[] = [];
  const step = minorInterval;
  for (let t = 0; t <= duration + 0.001; t += step) {
    const snapped = Math.round(t * 1000) / 1000;
    const isMajor = Math.abs(snapped % majorInterval) < step * 0.1;
    ticks.push({ time: snapped, major: isMajor });
  }
  return ticks;
}

export function invertSegments(
  cutSegments: Array<{ startTime: number; endTime: number }>,
  duration: number,
): Array<{ startTime: number; endTime: number }> {
  if (cutSegments.length === 0) return [{ startTime: 0, endTime: duration }];
  const sorted = [...cutSegments].sort((a, b) => a.startTime - b.startTime);
  const keep: Array<{ startTime: number; endTime: number }> = [];
  let cursor = 0;
  for (const seg of sorted) {
    if (seg.startTime > cursor + 0.01) keep.push({ startTime: cursor, endTime: seg.startTime });
    cursor = Math.max(cursor, seg.endTime);
  }
  if (cursor < duration - 0.01) keep.push({ startTime: cursor, endTime: duration });
  return keep;
}

/**
 * Convert a source video timestamp to the current-timeline timestamp,
 * accounting for deleted segments (returns null if the source time was cut out).
 */
export function sourceTimeToTimeline(clips: VideoClip[], sourceTime: number): number | null {
  let cursor = 0;
  for (const clip of clips) {
    const clipDuration = clip.sourceDuration / clip.speed;
    if (sourceTime >= clip.sourceStart && sourceTime <= clip.sourceStart + clip.sourceDuration) {
      return cursor + (sourceTime - clip.sourceStart) / clip.speed;
    }
    cursor += clipDuration;
  }
  return null;
}

/**
 * Build a transcript string from raw captions remapped to the current timeline.
 * Captions whose source time falls in deleted segments are omitted.
 */
export function buildTranscriptContext(clips: VideoClip[], rawCaptions: CaptionEntry[]): string {
  const mapped = rawCaptions
    .map((cap) => {
      const timelineStart = sourceTimeToTimeline(clips, cap.startTime);
      const timelineEnd = sourceTimeToTimeline(clips, cap.endTime);
      if (timelineStart === null || timelineEnd === null) return null;
      return {
        startTime: timelineStart,
        endTime: timelineEnd,
        text: cap.text.trim(),
      };
    })
    .filter((entry): entry is { startTime: number; endTime: number; text: string } => !!entry && !!entry.text);

  const lines: string[] = [];
  let active: { startTime: number; endTime: number; parts: string[] } | null = null;

  for (const entry of mapped) {
    const pauseSinceLast = active ? entry.startTime - active.endTime : Infinity;
    const nextWordCount = (active?.parts.length ?? 0) + 1;
    const nextTextLength = active
      ? active.parts.join(' ').length + 1 + entry.text.length
      : entry.text.length;
    const shouldFlush = !!active && (
      pauseSinceLast > 0.45 ||
      nextWordCount > 10 ||
      nextTextLength > 72
    );

    if (!active || shouldFlush) {
      if (active) {
        lines.push(`[${formatTimePrecise(active.startTime)}-${formatTimePrecise(active.endTime)}] ${active.parts.join(' ')}`);
      }
      active = {
        startTime: entry.startTime,
        endTime: entry.endTime,
        parts: [entry.text],
      };
      continue;
    }

    active.endTime = entry.endTime;
    active.parts.push(entry.text);
  }

  if (active) {
    lines.push(`[${formatTimePrecise(active.startTime)}-${formatTimePrecise(active.endTime)}] ${active.parts.join(' ')}`);
  }

  return lines.join('\n');
}

/** Generate a deterministic pseudo-waveform array (normalized 0-1) for visual display */
export function generateWaveform(duration: number, bars: number): number[] {
  const result: number[] = [];
  let seed = duration * 1337;
  for (let i = 0; i < bars; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const rand = seed / 233280;
    // Mix to make it feel more like audio
    const envelope = Math.sin((i / bars) * Math.PI) * 0.6 + 0.4;
    result.push(0.15 + rand * 0.8 * envelope);
  }
  return result;
}
