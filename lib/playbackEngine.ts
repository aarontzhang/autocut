import { VideoClip, ClipScheduleEntry } from './types';

/**
 * Build a schedule of when each clip plays on the timeline.
 * Each clip's timeline duration = sourceDuration / speed.
 */
export function buildClipSchedule(clips: VideoClip[]): ClipScheduleEntry[] {
  let timelineCursor = 0;
  return clips.map(clip => {
    const timelineDuration = clip.sourceDuration / clip.speed;
    const entry: ClipScheduleEntry = {
      clipId: clip.id,
      timelineStart: timelineCursor,
      timelineEnd: timelineCursor + timelineDuration,
      sourceStart: clip.sourceStart,
      sourceDuration: clip.sourceDuration,
      speed: clip.speed,
    };
    timelineCursor += timelineDuration;
    return entry;
  });
}

/**
 * Given a timeline time (playhead position), return the source video time
 * and which clip schedule entry is active.
 * Returns null if timeline is empty or time is past the end.
 */
export function timelineTimeToSource(
  schedule: ClipScheduleEntry[],
  timelineTime: number,
): { sourceTime: number; entry: ClipScheduleEntry } | null {
  // clamp to last clip if past end
  if (schedule.length === 0) return null;

  for (const entry of schedule) {
    if (timelineTime >= entry.timelineStart && timelineTime < entry.timelineEnd) {
      const offsetInTimeline = timelineTime - entry.timelineStart;
      const sourceTime = entry.sourceStart + offsetInTimeline * entry.speed;
      return { sourceTime, entry };
    }
  }

  // Past the end — return last clip's end
  const last = schedule[schedule.length - 1];
  return {
    sourceTime: last.sourceStart + last.sourceDuration,
    entry: last,
  };
}

/**
 * Given a source time and clip id, return the timeline time.
 */
export function sourceTimeToTimeline(
  schedule: ClipScheduleEntry[],
  sourceTime: number,
  clipId: string,
): number {
  const entry = schedule.find(e => e.clipId === clipId);
  if (!entry) return 0;
  const offsetInSource = sourceTime - entry.sourceStart;
  return entry.timelineStart + offsetInSource / entry.speed;
}
