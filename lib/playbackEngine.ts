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
      sourceId: clip.sourceId,
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
 * Resolve a timeline time to the clip that owns that moment.
 * Clip ranges are treated as half-open intervals [start, end), so
 * an exact cut point belongs to the following clip instead of the prior one.
 * The final clip still owns its exact end so end-of-timeline seeks clamp cleanly.
 */
export function findTimelineEntryAtTime(
  schedule: ClipScheduleEntry[],
  timelineTime: number,
): ClipScheduleEntry | null {
  if (schedule.length === 0) return null;

  for (let index = 0; index < schedule.length; index++) {
    const entry = schedule[index];
    const isLastEntry = index === schedule.length - 1;
    if (
      timelineTime >= entry.timelineStart
      && (timelineTime < entry.timelineEnd || (isLastEntry && timelineTime <= entry.timelineEnd))
    ) {
      return entry;
    }
  }

  if (timelineTime >= schedule[schedule.length - 1].timelineEnd) {
    return schedule[schedule.length - 1];
  }

  return schedule[0];
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
  if (schedule.length === 0) return null;

  const entry = findTimelineEntryAtTime(schedule, timelineTime);
  if (!entry) return null;

  const clampedTimelineTime = Math.min(
    Math.max(timelineTime, entry.timelineStart),
    entry.timelineEnd,
  );
  const offsetInTimeline = clampedTimelineTime - entry.timelineStart;
  const sourceTime = entry.sourceStart + offsetInTimeline * entry.speed;

  if (clampedTimelineTime < entry.timelineEnd) {
    return { sourceTime, entry };
  }

  return {
    sourceTime: Math.min(sourceTime, entry.sourceStart + entry.sourceDuration),
    entry,
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
