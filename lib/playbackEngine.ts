import type {
  ClipScheduleEntry,
  RenderTimelineEntry,
  ResolvedTransitionBoundary,
  TransitionEntry,
  VideoClip,
} from './types';

function getClipDuration(clip: Pick<VideoClip, 'sourceDuration' | 'speed'>): number {
  const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
  return Math.max(0, clip.sourceDuration / speed);
}

function clampTransitionDuration(duration: number, fromClip: VideoClip, toClip: VideoClip): number {
  const maxDuration = Math.max(0, Math.min(getClipDuration(fromClip), getClipDuration(toClip)) - 1e-3);
  return Math.max(0, Math.min(duration, maxDuration));
}

function normalizeTransitionType(type: TransitionEntry['type'] | string | undefined): TransitionEntry['type'] {
  return type === 'fade_black' ? 'fade_black' : 'fade_black';
}

function getBoundaryIndexForTransition(
  clips: VideoClip[],
  transition: TransitionEntry,
  plainSchedule: ClipScheduleEntry[],
): number {
  if (transition.afterClipId) {
    const clipIndex = clips.findIndex((clip) => clip.id === transition.afterClipId);
    if (clipIndex >= 0 && clipIndex < clips.length - 1) {
      return clipIndex;
    }
  }

  const candidateTime = Number.isFinite(transition.atTime) ? transition.atTime : 0;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < plainSchedule.length - 1; index += 1) {
    const boundaryTime = plainSchedule[index].timelineEnd;
    const distance = Math.abs(boundaryTime - candidateTime);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

export function resolveTransitions(
  clips: VideoClip[],
  transitions: TransitionEntry[] = [],
): ResolvedTransitionBoundary[] {
  if (clips.length < 2 || transitions.length === 0) return [];

  const plainSchedule = buildClipSchedule(clips);
  const resolvedByBoundary = new Map<number, Omit<ResolvedTransitionBoundary, 'atTime'>>();

  for (const transition of transitions) {
    const boundaryIndex = getBoundaryIndexForTransition(clips, transition, plainSchedule);
    if (boundaryIndex < 0 || boundaryIndex >= clips.length - 1) continue;

    const fromClip = clips[boundaryIndex];
    const toClip = clips[boundaryIndex + 1];
    const duration = clampTransitionDuration(
      Number.isFinite(transition.duration) ? transition.duration : 0,
      fromClip,
      toClip,
    );
    if (duration <= 0) continue;

    resolvedByBoundary.set(boundaryIndex, {
      id: transition.id,
      afterClipId: fromClip.id,
      type: normalizeTransitionType(transition.type),
      duration,
      fromClipId: fromClip.id,
      toClipId: toClip.id,
    });
  }

  if (resolvedByBoundary.size === 0) return [];

  const renderEntries = buildRenderTimeline(clips, Array.from(resolvedByBoundary.values()).map((boundary) => ({
    id: boundary.id,
    afterClipId: boundary.afterClipId,
    atTime: 0,
    type: boundary.type,
    duration: boundary.duration,
  })));

  return renderEntries
    .map((entry) => entry.transitionOut)
    .filter((boundary): boundary is ResolvedTransitionBoundary => !!boundary)
    .sort((a, b) => a.atTime - b.atTime);
}

export function normalizeTransitionEntries(
  clips: VideoClip[],
  transitions: TransitionEntry[] = [],
): TransitionEntry[] {
  return resolveTransitions(clips, transitions).map((boundary) => ({
    id: boundary.id,
    afterClipId: boundary.afterClipId,
    atTime: boundary.atTime,
    type: boundary.type,
    duration: boundary.duration,
  }));
}

export function buildRenderTimeline(
  clips: VideoClip[],
  transitions: TransitionEntry[] = [],
): RenderTimelineEntry[] {
  if (clips.length === 0) return [];

  const plainSchedule: ClipScheduleEntry[] = [];
  let plainCursor = 0;
  for (const clip of clips) {
    const duration = getClipDuration(clip);
    plainSchedule.push({
      clipId: clip.id,
      sourceId: clip.sourceId,
      timelineStart: plainCursor,
      timelineEnd: plainCursor + duration,
      sourceStart: clip.sourceStart,
      sourceDuration: clip.sourceDuration,
      speed: clip.speed,
    });
    plainCursor += duration;
  }

  const pendingByBoundary = new Map<number, Omit<ResolvedTransitionBoundary, 'atTime'>>();
  for (const transition of transitions) {
    const boundaryIndex = getBoundaryIndexForTransition(clips, transition, plainSchedule);
    if (boundaryIndex < 0 || boundaryIndex >= clips.length - 1) continue;

    const fromClip = clips[boundaryIndex];
    const toClip = clips[boundaryIndex + 1];
    const duration = clampTransitionDuration(
      Number.isFinite(transition.duration) ? transition.duration : 0,
      fromClip,
      toClip,
    );
    if (duration <= 0) continue;

    pendingByBoundary.set(boundaryIndex, {
      id: transition.id,
      afterClipId: fromClip.id,
      type: normalizeTransitionType(transition.type),
      duration,
      fromClipId: fromClip.id,
      toClipId: toClip.id,
    });
  }

  const entries: RenderTimelineEntry[] = [];
  let renderCursor = 0;

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const duration = getClipDuration(clip);
    const transitionIn = index > 0 ? entries[index - 1]?.transitionOut ?? null : null;
    const timelineStart = index > 0
      ? Math.max(0, renderCursor - (transitionIn?.duration ?? 0))
      : 0;
    const timelineEnd = timelineStart + duration;

    const pendingOut = pendingByBoundary.get(index) ?? null;
    const transitionOut = pendingOut
      ? {
          ...pendingOut,
          atTime: Math.max(timelineStart, timelineEnd - pendingOut.duration),
        }
      : null;

    entries.push({
      clipId: clip.id,
      sourceId: clip.sourceId,
      timelineStart,
      timelineEnd,
      sourceStart: clip.sourceStart,
      sourceDuration: clip.sourceDuration,
      speed: clip.speed,
      transitionIn,
      transitionOut,
    });

    renderCursor = timelineEnd;
  }

  return entries;
}

export function buildClipSchedule(
  clips: VideoClip[],
  transitions: TransitionEntry[] = [],
): ClipScheduleEntry[] {
  return buildRenderTimeline(clips, transitions).map((entry) => ({
    clipId: entry.clipId,
    sourceId: entry.sourceId,
    timelineStart: entry.timelineStart,
    timelineEnd: entry.timelineEnd,
    sourceStart: entry.sourceStart,
    sourceDuration: entry.sourceDuration,
    speed: entry.speed,
  }));
}

export function getTimelineDuration(
  clips: VideoClip[],
  transitions: TransitionEntry[] = [],
): number {
  const schedule = buildRenderTimeline(clips, transitions);
  return schedule.length > 0 ? schedule[schedule.length - 1].timelineEnd : 0;
}

export function findRenderEntriesAtTime(
  schedule: RenderTimelineEntry[],
  timelineTime: number,
): RenderTimelineEntry[] {
  if (schedule.length === 0) return [];

  const matches = schedule.filter((entry, index) => {
    const isLastEntry = index === schedule.length - 1;
    return (
      timelineTime >= entry.timelineStart
      && (timelineTime < entry.timelineEnd || (isLastEntry && timelineTime <= entry.timelineEnd))
    );
  });

  if (matches.length > 0) {
    return matches;
  }

  if (timelineTime >= schedule[schedule.length - 1].timelineEnd) {
    return [schedule[schedule.length - 1]];
  }

  return [schedule[0]];
}

export function findTimelineEntryAtTime(
  schedule: ClipScheduleEntry[],
  timelineTime: number,
): ClipScheduleEntry | null {
  if (schedule.length === 0) return null;

  let matched: ClipScheduleEntry | null = null;
  for (let index = 0; index < schedule.length; index += 1) {
    const entry = schedule[index];
    const isLastEntry = index === schedule.length - 1;
    if (
      timelineTime >= entry.timelineStart
      && (timelineTime < entry.timelineEnd || (isLastEntry && timelineTime <= entry.timelineEnd))
    ) {
      matched = entry;
    }
  }

  if (matched) return matched;
  if (timelineTime >= schedule[schedule.length - 1].timelineEnd) {
    return schedule[schedule.length - 1];
  }
  return schedule[0];
}

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

export function sourceTimeToTimeline(
  schedule: ClipScheduleEntry[],
  sourceTime: number,
  clipId: string,
): number {
  const entry = schedule.find((candidate) => candidate.clipId === clipId);
  if (!entry) return 0;
  const offsetInSource = sourceTime - entry.sourceStart;
  return entry.timelineStart + offsetInSource / entry.speed;
}
