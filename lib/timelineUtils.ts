import { getCaptionSourceId, getClipSourceId, getSourceRangeId } from './sourceUtils';
import { VideoClip, CaptionEntry, EditAction, SilenceCandidate, SourceRangeRef } from './types';

/**
 * Convert a current-timeline timestamp to the corresponding source video timestamp,
 * accounting for which clip it falls in and any speed changes.
 */
export function timelineToSourceTime(clips: VideoClip[], timelineTime: number): number {
  let cursor = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const clipDuration = clip.sourceDuration / clip.speed;
    const clipEnd = cursor + clipDuration;
    const isLastClip = index === clips.length - 1;
    if (timelineTime >= cursor && (timelineTime < clipEnd || (isLastClip && timelineTime <= clipEnd))) {
      const offset = Math.max(0, timelineTime - cursor);
      return clip.sourceStart + offset * clip.speed;
    }
    cursor = clipEnd;
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
): Array<{ sourceId: string; sourceStart: number; sourceDuration: number; timelineOffset: number }> {
  const segments: Array<{ sourceId: string; sourceStart: number; sourceDuration: number; timelineOffset: number }> = [];
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
        sourceId: getClipSourceId(clip),
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

  const candidates = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
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
export function sourceTimeToTimeline(
  clips: VideoClip[],
  sourceTime: number,
  sourceId?: string | null,
): number | null {
  let cursor = 0;
  for (const clip of clips) {
    const clipDuration = clip.sourceDuration / clip.speed;
    if (sourceId && getClipSourceId(clip) !== sourceId) {
      cursor += clipDuration;
      continue;
    }
    if (sourceTime >= clip.sourceStart && sourceTime <= clip.sourceStart + clip.sourceDuration) {
      return cursor + (sourceTime - clip.sourceStart) / clip.speed;
    }
    cursor += clipDuration;
  }
  return null;
}

/**
 * Return every current-timeline occurrence of a source timestamp.
 * A source moment can appear multiple times after duplication or reordering.
 */
export function sourceTimeToTimelineOccurrences(
  clips: VideoClip[],
  sourceTime: number,
  sourceId?: string | null,
): number[] {
  const matches: number[] = [];
  let cursor = 0;
  for (const clip of clips) {
    const clipDuration = clip.sourceDuration / clip.speed;
    if (sourceId && getClipSourceId(clip) !== sourceId) {
      cursor += clipDuration;
      continue;
    }
    if (sourceTime >= clip.sourceStart && sourceTime <= clip.sourceStart + clip.sourceDuration) {
      matches.push(cursor + (sourceTime - clip.sourceStart) / clip.speed);
    }
    cursor += clipDuration;
  }
  return matches;
}

/**
 * Project a source-time range onto the current timeline.
 * Returns zero ranges if the source span is fully cut out.
 */
export function sourceRangeToTimelineRanges(
  clips: VideoClip[],
  sourceId: string | null | undefined,
  sourceStart: number,
  sourceEnd: number,
): Array<{ timelineStart: number; timelineEnd: number }> {
  if (sourceEnd <= sourceStart) return [];
  const ranges: Array<{ timelineStart: number; timelineEnd: number }> = [];
  let cursor = 0;
  for (const clip of clips) {
    const clipDuration = clip.sourceDuration / clip.speed;
    if (sourceId && getClipSourceId(clip) !== sourceId) {
      cursor += clipDuration;
      continue;
    }
    const clipSourceStart = clip.sourceStart;
    const clipSourceEnd = clip.sourceStart + clip.sourceDuration;
    const overlapStart = Math.max(sourceStart, clipSourceStart);
    const overlapEnd = Math.min(sourceEnd, clipSourceEnd);

    if (overlapEnd > overlapStart) {
      ranges.push({
        timelineStart: cursor + (overlapStart - clipSourceStart) / clip.speed,
        timelineEnd: cursor + (overlapEnd - clipSourceStart) / clip.speed,
      });
    }

    cursor += clipDuration;
  }
  return ranges;
}

export function mergeSourceRanges(
  ranges: SourceRangeRef[],
): SourceRangeRef[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges]
    .filter((range) => range.sourceEnd > range.sourceStart)
    .sort((a, b) => {
      const aId = getSourceRangeId(a) ?? '';
      const bId = getSourceRangeId(b) ?? '';
      return aId.localeCompare(bId) || a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd;
    });
  if (sorted.length === 0) return [];

  const merged: SourceRangeRef[] = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const current = merged[merged.length - 1];
    if (
      getSourceRangeId(range) === getSourceRangeId(current)
      && range.sourceStart <= current.sourceEnd + 1e-6
    ) {
      current.sourceEnd = Math.max(current.sourceEnd, range.sourceEnd);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function subtractSourceRanges(
  target: SourceRangeRef,
  removed: SourceRangeRef[],
): SourceRangeRef[] {
  let remaining: SourceRangeRef[] = [{ ...target }];
  const targetSourceId = getSourceRangeId(target);
  for (const cut of mergeSourceRanges(removed)) {
    if (targetSourceId !== getSourceRangeId(cut)) continue;
    remaining = remaining.flatMap((range) => {
      if (cut.sourceEnd <= range.sourceStart || cut.sourceStart >= range.sourceEnd) {
        return [range];
      }
      const next: SourceRangeRef[] = [];
      if (cut.sourceStart > range.sourceStart) {
        next.push({
          ...range,
          sourceStart: range.sourceStart,
          sourceEnd: Math.min(cut.sourceStart, range.sourceEnd),
        });
      }
      if (cut.sourceEnd < range.sourceEnd) {
        next.push({
          ...range,
          sourceStart: Math.max(cut.sourceEnd, range.sourceStart),
          sourceEnd: range.sourceEnd,
        });
      }
      return next;
    });
    if (remaining.length === 0) break;
  }
  return remaining.filter((range) => range.sourceEnd - range.sourceStart > 1e-3);
}

export function sourceRangesForAction(
  clips: VideoClip[],
  action: EditAction,
): SourceRangeRef[] {
  if (action.type === 'delete_range') {
    if (action.deleteStartTime === undefined || action.deleteEndTime === undefined) return [];
    return getSourceSegmentsForTimelineRange(clips, action.deleteStartTime, action.deleteEndTime)
      .map((segment) => ({
        sourceId: segment.sourceId,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceStart + segment.sourceDuration,
      }));
  }

  if (action.type === 'delete_ranges') {
    return (action.ranges ?? []).flatMap((range) => (
      getSourceSegmentsForTimelineRange(clips, range.start, range.end).map((segment) => ({
        sourceId: segment.sourceId,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceStart + segment.sourceDuration,
      }))
    ));
  }

  return [];
}

/**
 * Build a transcript string from raw captions remapped to the current timeline.
 * Captions whose source time falls in deleted segments are omitted.
 */
export function buildTranscriptContext(clips: VideoClip[], rawCaptions: CaptionEntry[]): string {
  const mapped = rawCaptions
    .map((cap) => {
      const captionSourceId = getCaptionSourceId(cap);
      const occurrences = sourceRangeToTimelineRanges(clips, captionSourceId, cap.startTime, cap.endTime)
        .filter((range) => range.timelineEnd > range.timelineStart);
      return occurrences.map((range) => ({
        startTime: range.timelineStart,
        endTime: range.timelineEnd,
        text: cap.text.trim(),
      }));
    })
    .flat()
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
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

type TimelineSpeechSegment = {
  startTime: number;
  endTime: number;
};

export function getTimelineDuration(clips: VideoClip[]): number {
  return clips.reduce((total, clip) => total + clip.sourceDuration / clip.speed, 0);
}

function collectTimelineClipBoundaries(clips: VideoClip[]): number[] {
  const boundaries: number[] = [];
  let cursor = 0;

  for (const clip of clips) {
    const clipDuration = clip.sourceDuration / clip.speed;
    if (cursor > 1e-3) {
      boundaries.push(cursor);
    }
    cursor += clipDuration;
    boundaries.push(cursor);
  }

  return boundaries;
}

function mergeTimelineSpeechSegments(segments: TimelineSpeechSegment[]): TimelineSpeechSegment[] {
  if (segments.length === 0) return [];

  const sorted = [...segments]
    .filter((segment) => segment.endTime > segment.startTime)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);

  if (sorted.length === 0) return [];

  const merged = [{ ...sorted[0] }];
  for (const segment of sorted.slice(1)) {
    const current = merged[merged.length - 1];
    if (segment.startTime <= current.endTime + 0.01) {
      current.endTime = Math.max(current.endTime, segment.endTime);
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
}

export function buildTimelineSpeechSegments(clips: VideoClip[], rawCaptions: CaptionEntry[]): TimelineSpeechSegment[] {
  if (clips.length === 0 || rawCaptions.length === 0) return [];

  const speechSegments: TimelineSpeechSegment[] = [];
  let timelineCursor = 0;

  for (const clip of clips) {
    const clipSourceId = getClipSourceId(clip);
    const clipSourceStart = clip.sourceStart;
    const clipSourceEnd = clip.sourceStart + clip.sourceDuration;
    const clipSpeed = clip.speed || 1;
    const clipTimelineStart = timelineCursor;
    const clipTimelineDuration = clip.sourceDuration / clipSpeed;

    for (const caption of rawCaptions) {
      if (getCaptionSourceId(caption) !== clipSourceId) continue;
      const overlapStart = Math.max(caption.startTime, clipSourceStart);
      const overlapEnd = Math.min(caption.endTime, clipSourceEnd);
      if (overlapEnd <= overlapStart) continue;

      speechSegments.push({
        startTime: clipTimelineStart + (overlapStart - clipSourceStart) / clipSpeed,
        endTime: clipTimelineStart + (overlapEnd - clipSourceStart) / clipSpeed,
      });
    }

    timelineCursor += clipTimelineDuration;
  }

  return mergeTimelineSpeechSegments(speechSegments);
}

export function buildTimelineSilenceCandidates(
  clips: VideoClip[],
  rawCaptions: CaptionEntry[],
  settings: {
    paddingSeconds: number;
    minDurationSeconds: number;
    preserveShortPauses?: boolean;
  },
): SilenceCandidate[] {
  const timelineDuration = getTimelineDuration(clips);
  if (timelineDuration <= 0) return [];
  const clipBoundaries = collectTimelineClipBoundaries(clips);

  const speechSegments = buildTimelineSpeechSegments(clips, rawCaptions);
  const paddingSeconds = Math.max(0, settings.paddingSeconds);
  const minDurationSeconds = Math.max(0, settings.minDurationSeconds);
  const preserveShortPauses = settings.preserveShortPauses ?? false;
  const gaps: Array<{ gapStart: number; gapEnd: number }> = [];

  if (speechSegments.length === 0) {
    gaps.push({ gapStart: 0, gapEnd: timelineDuration });
  } else {
    if (speechSegments[0].startTime > 0) {
      gaps.push({ gapStart: 0, gapEnd: speechSegments[0].startTime });
    }

    for (let index = 0; index < speechSegments.length - 1; index += 1) {
      const current = speechSegments[index];
      const next = speechSegments[index + 1];
      if (next.startTime > current.endTime) {
        gaps.push({ gapStart: current.endTime, gapEnd: next.startTime });
      }
    }

    const lastSpeechSegment = speechSegments[speechSegments.length - 1];
    if (lastSpeechSegment.endTime < timelineDuration) {
      gaps.push({ gapStart: lastSpeechSegment.endTime, gapEnd: timelineDuration });
    }
  }

  return gaps.flatMap((gap) => {
    const gapDuration = gap.gapEnd - gap.gapStart;
    if (gapDuration <= 0) return [];
    if (preserveShortPauses && gapDuration < Math.max(0.35, minDurationSeconds + paddingSeconds * 2)) {
      return [];
    }

    const touchesTimelineStart = gap.gapStart <= 1e-3;
    const touchesTimelineEnd = gap.gapEnd >= timelineDuration - 1e-3;
    const touchesClipBoundaryStart = clipBoundaries.some((boundary) => Math.abs(gap.gapStart - boundary) <= 1e-3);
    const touchesClipBoundaryEnd = clipBoundaries.some((boundary) => Math.abs(gap.gapEnd - boundary) <= 1e-3);
    // Only preserve padding next to speech. If silence reaches the timeline edge,
    // or a hard clip boundary, cut all the way to that edge instead of leaving
    // a tiny silent tail/head clip behind.
    const deleteStart = touchesTimelineStart || touchesClipBoundaryStart
      ? gap.gapStart
      : Math.min(gap.gapEnd, gap.gapStart + paddingSeconds);
    const deleteEnd = touchesTimelineEnd || touchesClipBoundaryEnd
      ? gap.gapEnd
      : Math.max(deleteStart, gap.gapEnd - paddingSeconds);
    const duration = deleteEnd - deleteStart;
    if (duration < minDurationSeconds) return [];

    return [{
      gapStart: gap.gapStart,
      gapEnd: gap.gapEnd,
      deleteStart,
      deleteEnd,
      duration,
    }];
  });
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
