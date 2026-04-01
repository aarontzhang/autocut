import type {
  ClipScheduleEntry,
  RenderTimelineEntry,
  ResolvedTransitionBoundary,
  Track,
  TransitionEntry,
  TransitionType,
  VideoClip,
} from './types';
import { VALID_TRANSITION_TYPES } from './types';

const CONTINUOUS_SOURCE_SEQUENCE_EPSILON = 1 / 60;

function getClipDuration(clip: Pick<VideoClip, 'sourceDuration' | 'speed'>): number {
  const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
  return Math.max(0, clip.sourceDuration / speed);
}

function clampTransitionDuration(duration: number, fromClip: VideoClip, toClip: VideoClip): number {
  const maxDuration = Math.max(0, Math.min(getClipDuration(fromClip), getClipDuration(toClip)) * 2 - 1e-3);
  return Math.max(0, Math.min(duration, maxDuration));
}

function normalizeTransitionType(type: TransitionType | string | undefined): TransitionType {
  if (type && (VALID_TRANSITION_TYPES as readonly string[]).includes(type)) {
    return type as TransitionType;
  }
  return 'fade_black';
}

function getBoundaryIndexForTransition(
  clips: VideoClip[],
  transition: TransitionEntry,
  plainSchedule: ClipScheduleEntry[],
): number {
  const boundaryCount = Math.max(0, plainSchedule.length - 1);
  if (boundaryCount === 0) return -1;

  if (transition.afterClipId) {
    const clipIndex = clips.findIndex((clip) => clip.id === transition.afterClipId);
    if (clipIndex >= 0 && clipIndex < clips.length - 1) {
      return clipIndex;
    }
    return -1;
  }

  const candidateTime = Number.isFinite(transition.atTime) ? transition.atTime : 0;
  const maxLegacyOffset = Number.isFinite(transition.duration)
    ? Math.max(0, Number(transition.duration)) + 1e-3
    : 1e-3;
  let bestMatch: { index: number; delta: number } | null = null;

  for (let index = 0; index < boundaryCount; index += 1) {
    const boundaryTime = plainSchedule[index].timelineEnd;
    const delta = boundaryTime - candidateTime;
    if (delta < -1e-3 || delta > maxLegacyOffset) {
      continue;
    }
    if (!bestMatch || delta < bestMatch.delta) {
      bestMatch = { index, delta };
    }
  }

  return bestMatch?.index ?? -1;
}

export function buildPlainSchedule(clips: VideoClip[]): ClipScheduleEntry[] {
  const schedule: ClipScheduleEntry[] = [];
  let cursor = 0;

  for (const clip of clips) {
    const duration = getClipDuration(clip);
    schedule.push({
      clipId: clip.id,
      sourceId: clip.sourceId,
      timelineStart: cursor,
      timelineEnd: cursor + duration,
      sourceStart: clip.sourceStart,
      sourceDuration: clip.sourceDuration,
      speed: clip.speed,
    });
    cursor += duration;
  }

  return schedule;
}

export function shouldUseSeparateVideoLayerForPlaybackHandoff(
  currentEntry: Pick<ClipScheduleEntry, 'sourceId' | 'sourceStart' | 'sourceDuration'> | null | undefined,
  nextEntry: Pick<ClipScheduleEntry, 'sourceId' | 'sourceStart' | 'sourceDuration'> | null | undefined,
): boolean {
  if (!currentEntry || !nextEntry) return false;
  if (currentEntry.sourceId !== nextEntry.sourceId) return true;

  const currentSourceEnd = currentEntry.sourceStart + currentEntry.sourceDuration;
  return Math.abs(nextEntry.sourceStart - currentSourceEnd) > CONTINUOUS_SOURCE_SEQUENCE_EPSILON;
}

export function resolveTransitions(
  clips: VideoClip[],
  transitions: TransitionEntry[] = [],
): ResolvedTransitionBoundary[] {
  if (clips.length < 2) return [];
  if (transitions.length === 0 && !clips.some((c) => c.outTransition)) return [];

  const plainSchedule = buildPlainSchedule(clips);
  const resolvedByBoundary = new Map<number, Omit<ResolvedTransitionBoundary, 'atTime'>>();

  // First pass: legacy TransitionEntry[] array
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

  // Second pass: clip.outTransition takes precedence over legacy entries
  for (let i = 0; i < clips.length - 1; i++) {
    const clip = clips[i];
    if (!clip.outTransition) continue;
    const toClip = clips[i + 1];
    const duration = clampTransitionDuration(
      Number.isFinite(clip.outTransition.duration) ? clip.outTransition.duration : 0,
      clip,
      toClip,
    );
    if (duration <= 0) continue;

    resolvedByBoundary.set(i, {
      id: clip.outTransition.id,
      afterClipId: clip.id,
      type: normalizeTransitionType(clip.outTransition.type),
      duration,
      fromClipId: clip.id,
      toClipId: toClip.id,
    });
  }

  return Array.from(resolvedByBoundary.entries())
    .map(([boundaryIndex, boundary]) => ({
      ...boundary,
      atTime: plainSchedule[boundaryIndex].timelineEnd,
    }))
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

  const plainSchedule = buildPlainSchedule(clips);
  const resolvedTransitions = resolveTransitions(clips, transitions);
  const transitionOutByClipId = new Map(resolvedTransitions.map((boundary) => [boundary.fromClipId, boundary]));
  const transitionInByClipId = new Map(resolvedTransitions.map((boundary) => [boundary.toClipId, boundary]));

  return plainSchedule.map((entry) => ({
    ...entry,
    transitionIn: transitionInByClipId.get(entry.clipId) ?? null,
    transitionOut: transitionOutByClipId.get(entry.clipId) ?? null,
  }));
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

  const match = schedule.find((entry, index) => {
    const isLastEntry = index === schedule.length - 1;
    return (
      timelineTime >= entry.timelineStart
      && (timelineTime < entry.timelineEnd || (isLastEntry && timelineTime <= entry.timelineEnd))
    );
  });

  if (match) return [match];
  if (timelineTime >= schedule[schedule.length - 1].timelineEnd) return [schedule[schedule.length - 1]];
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

// ─── Multi-Track Helpers ────────────────────────────────────────────────────

export function buildMultiTrackSchedule(
  clips: VideoClip[],
  tracks: Track[],
): Map<string, ClipScheduleEntry[]> {
  const result = new Map<string, ClipScheduleEntry[]>();
  for (const track of tracks) {
    const trackClips = clips.filter((c) => c.trackId === track.id);
    result.set(track.id, buildPlainSchedule(trackClips));
  }
  return result;
}

export function getMultiTrackDuration(
  clips: VideoClip[],
  tracks: Track[],
): number {
  const schedule = buildMultiTrackSchedule(clips, tracks);
  let maxDuration = 0;
  for (const entries of schedule.values()) {
    if (entries.length > 0) {
      maxDuration = Math.max(maxDuration, entries[entries.length - 1].timelineEnd);
    }
  }
  return maxDuration;
}

export function findMultiTrackEntriesAtTime(
  multiSchedule: Map<string, ClipScheduleEntry[]>,
  timelineTime: number,
): Map<string, ClipScheduleEntry | null> {
  const result = new Map<string, ClipScheduleEntry | null>();
  for (const [trackId, schedule] of multiSchedule) {
    result.set(trackId, findTimelineEntryAtTime(schedule, timelineTime));
  }
  return result;
}
