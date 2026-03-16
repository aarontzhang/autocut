import { v4 as uuidv4 } from 'uuid';
import { buildClipSchedule } from './playbackEngine';
import type {
  AppliedActionRecord,
  CaptionEntry,
  EditAction,
  MarkerEntry,
  TextOverlayEntry,
  TransitionEntry,
  VideoClip,
} from './types';

export interface EditSnapshot {
  clips: VideoClip[];
  captions: CaptionEntry[];
  transitions: TransitionEntry[];
  markers: MarkerEntry[];
  textOverlays: TextOverlayEntry[];
  appliedActions?: AppliedActionRecord[];
}

export const MIN_CLIP_DURATION_SECONDS = 0.05;
export const CLIP_EDGE_SNAP_EPSILON_SECONDS = 0.08;

export function sanitizeTimelineClips(clips: VideoClip[]): VideoClip[] {
  return clips.filter((clip) => (
    Number.isFinite(clip.sourceDuration)
    && Number.isFinite(clip.speed)
    && clip.speed > 0
    && clip.sourceDuration >= MIN_CLIP_DURATION_SECONDS
  ));
}

function snapTimeToClipEdge(time: number, timelineStart: number, timelineEnd: number) {
  if (Math.abs(time - timelineStart) <= CLIP_EDGE_SNAP_EPSILON_SECONDS) {
    return timelineStart;
  }
  if (Math.abs(time - timelineEnd) <= CLIP_EDGE_SNAP_EPSILON_SECONDS) {
    return timelineEnd;
  }
  return time;
}

function mergeDeleteRanges(ranges: Array<{ start: number; end: number }>) {
  if (ranges.length === 0) return [];

  const sorted = [...ranges]
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (sorted.length === 0) return [];

  const merged = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const current = merged[merged.length - 1];
    if (range.start <= current.end + CLIP_EDGE_SNAP_EPSILON_SECONDS) {
      current.end = Math.max(current.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function splitClipsAtTime(clips: VideoClip[], timelineTime: number): VideoClip[] {
  const normalizedClips = sanitizeTimelineClips(clips);
  const schedule = buildClipSchedule(normalizedClips);
  const targetEntry = schedule.find((entry) => {
    const snappedTime = snapTimeToClipEdge(timelineTime, entry.timelineStart, entry.timelineEnd);
    return snappedTime > entry.timelineStart && snappedTime < entry.timelineEnd;
  });
  if (!targetEntry) return normalizedClips;

  const clip = normalizedClips.find(item => item.id === targetEntry.clipId);
  if (!clip) return normalizedClips;

  const snappedTime = snapTimeToClipEdge(timelineTime, targetEntry.timelineStart, targetEntry.timelineEnd);
  const offsetInTimeline = snappedTime - targetEntry.timelineStart;
  const splitSourceOffset = offsetInTimeline * targetEntry.speed;
  const firstDuration = splitSourceOffset;
  const secondStart = clip.sourceStart + splitSourceOffset;
  const secondDuration = clip.sourceDuration - splitSourceOffset;
  if (firstDuration < MIN_CLIP_DURATION_SECONDS || secondDuration < MIN_CLIP_DURATION_SECONDS) return normalizedClips;

  const firstClip: VideoClip = { ...clip, sourceDuration: firstDuration };
  const secondClip: VideoClip = { ...clip, id: uuidv4(), sourceStart: secondStart, sourceDuration: secondDuration };
  const index = normalizedClips.findIndex(item => item.id === clip.id);
  return [...normalizedClips.slice(0, index), firstClip, secondClip, ...normalizedClips.slice(index + 1)];
}

export function deleteRangeFromClips(clips: VideoClip[], startTime: number, endTime: number): VideoClip[] {
  const normalizedClips = sanitizeTimelineClips(clips);
  if (endTime <= startTime) return normalizedClips;
  const schedule = buildClipSchedule(normalizedClips);
  const nextClips: VideoClip[] = [];

  for (const entry of schedule) {
    const clip = normalizedClips.find(item => item.id === entry.clipId);
    if (!clip) continue;
    const timelineStart = entry.timelineStart;
    const timelineEnd = entry.timelineEnd;
    const speed = entry.speed;
    const effectiveStart = snapTimeToClipEdge(startTime, timelineStart, timelineEnd);
    const effectiveEnd = snapTimeToClipEdge(endTime, timelineStart, timelineEnd);

    if (timelineEnd <= effectiveStart || timelineStart >= effectiveEnd) {
      nextClips.push(clip);
      continue;
    }

    if (timelineStart >= effectiveStart && timelineEnd <= effectiveEnd) {
      continue;
    }

    if (timelineStart < effectiveStart && timelineEnd > effectiveEnd) {
      const firstDuration = (effectiveStart - timelineStart) * speed;
      const secondOffset = (effectiveEnd - timelineStart) * speed;
      const secondDuration = clip.sourceDuration - secondOffset;
      if (firstDuration >= MIN_CLIP_DURATION_SECONDS) nextClips.push({ ...clip, sourceDuration: firstDuration });
      if (secondDuration >= MIN_CLIP_DURATION_SECONDS) {
        nextClips.push({
          ...clip,
          id: uuidv4(),
          sourceStart: clip.sourceStart + secondOffset,
          sourceDuration: secondDuration,
        });
      }
      continue;
    }

    if (timelineStart < effectiveStart) {
      const keptDuration = (effectiveStart - timelineStart) * speed;
      if (keptDuration >= MIN_CLIP_DURATION_SECONDS) nextClips.push({ ...clip, sourceDuration: keptDuration });
      continue;
    }

    const cutOffset = (effectiveEnd - timelineStart) * speed;
    const remainingDuration = clip.sourceDuration - cutOffset;
    if (remainingDuration >= MIN_CLIP_DURATION_SECONDS) {
      nextClips.push({
        ...clip,
        sourceStart: clip.sourceStart + cutOffset,
        sourceDuration: remainingDuration,
      });
    }
  }

  return sanitizeTimelineClips(nextClips);
}

export function actionChangesTimelineStructure(action: EditAction) {
  return ['split_clip', 'delete_range', 'delete_ranges', 'delete_clip', 'reorder_clip', 'set_clip_speed'].includes(action.type);
}

function withClearedMarkers(snapshot: EditSnapshot, patch: Partial<EditSnapshot>): EditSnapshot {
  return {
    ...snapshot,
    ...patch,
    markers: [],
  };
}

export function applyActionToSnapshot(snapshot: EditSnapshot, action: EditAction): EditSnapshot {
  if (
    action.type === 'none' ||
    action.type === 'transcribe_request' ||
    action.type === 'request_frames' ||
    action.type === 'update_ai_settings'
  ) return snapshot;

  if (action.type === 'split_clip') {
    if (action.splitTime === undefined) return snapshot;
    const clips = splitClipsAtTime(snapshot.clips, action.splitTime);
    return clips === snapshot.clips ? snapshot : withClearedMarkers(snapshot, { clips });
  }

  if (action.type === 'delete_range') {
    if (action.deleteStartTime === undefined || action.deleteEndTime === undefined) return snapshot;
    return withClearedMarkers(snapshot, {
      clips: deleteRangeFromClips(snapshot.clips, action.deleteStartTime, action.deleteEndTime),
    });
  }

  if (action.type === 'delete_ranges') {
    const ranges = mergeDeleteRanges(action.ranges ?? []).sort((a, b) => b.start - a.start);
    const clips = ranges.reduce((acc, range) => {
      if (range.end <= range.start) return acc;
      return deleteRangeFromClips(acc, range.start, range.end);
    }, snapshot.clips);
    return withClearedMarkers(snapshot, { clips });
  }

  if (action.type === 'reorder_clip') {
    const clipIndex = action.clipIndex ?? 0;
    const clip = snapshot.clips[clipIndex];
    if (!clip || action.newIndex === undefined) return snapshot;
    const remaining = snapshot.clips.filter(item => item.id !== clip.id);
    const targetIndex = Math.max(0, Math.min(action.newIndex, remaining.length));
    const clips = [...remaining.slice(0, targetIndex), clip, ...remaining.slice(targetIndex)];
    return withClearedMarkers(snapshot, { clips });
  }

  if (action.type === 'delete_clip') {
    const clipIndex = action.clipIndex ?? 0;
    const clip = snapshot.clips[clipIndex];
    if (!clip) return snapshot;
    return withClearedMarkers(snapshot, {
      clips: snapshot.clips.filter(item => item.id !== clip.id),
    });
  }

  if (action.type === 'set_clip_speed') {
    const clip = snapshot.clips[action.clipIndex ?? 0];
    if (!clip || action.speed === undefined) return snapshot;
    return withClearedMarkers(snapshot, {
      clips: snapshot.clips.map(item => item.id === clip.id ? { ...item, speed: action.speed ?? item.speed } : item),
    });
  }

  if (action.type === 'set_clip_volume') {
    const clip = snapshot.clips[action.clipIndex ?? 0];
    if (!clip || action.volume === undefined) return snapshot;
    return {
      ...snapshot,
      clips: snapshot.clips.map(item => item.id === clip.id ? {
        ...item,
        volume: action.volume ?? item.volume,
        ...(action.fadeIn !== undefined ? { fadeIn: action.fadeIn } : {}),
        ...(action.fadeOut !== undefined ? { fadeOut: action.fadeOut } : {}),
      } : item),
    };
  }

  if (action.type === 'set_clip_filter') {
    const clip = snapshot.clips[action.clipIndex ?? 0];
    if (!clip) return snapshot;
    return {
      ...snapshot,
      clips: snapshot.clips.map(item => item.id === clip.id ? { ...item, filter: action.filter ?? null } : item),
    };
  }

  if (action.type === 'add_captions') {
    return {
      ...snapshot,
      captions: [...snapshot.captions, ...(action.captions ?? []).map(caption => ({ ...caption, id: uuidv4() }))],
    };
  }

  if (action.type === 'add_transition') {
    return {
      ...snapshot,
      transitions: [...snapshot.transitions, ...(action.transitions ?? []).map(transition => ({ ...transition, id: uuidv4() }))],
    };
  }

  if (action.type === 'add_marker') {
    const marker = action.marker;
    if (marker?.timelineTime === undefined) return snapshot;
    const nextNumber = snapshot.markers.length === 0
      ? 1
      : Math.max(...snapshot.markers.map((entry) => entry.number)) + 1;
    return {
      ...snapshot,
      markers: [
        ...snapshot.markers,
        {
          id: marker.id ?? uuidv4(),
          number: marker.number ?? nextNumber,
          timelineTime: marker.timelineTime,
          label: marker.label,
          createdBy: marker.createdBy ?? 'ai',
          status: marker.status ?? 'open',
          linkedRange: marker.linkedRange,
          linkedMessageId: marker.linkedMessageId,
          confidence: marker.confidence ?? null,
          note: marker.note,
        },
      ],
    };
  }

  if (action.type === 'add_markers') {
    const markers = (action.markers ?? []).filter((marker) => marker.timelineTime !== undefined);
    if (markers.length === 0) return snapshot;
    let nextNumber = snapshot.markers.length === 0
      ? 1
      : Math.max(...snapshot.markers.map((entry) => entry.number)) + 1;
    return {
      ...snapshot,
      markers: [
        ...snapshot.markers,
        ...markers.map((marker) => ({
          id: marker.id ?? uuidv4(),
          number: marker.number ?? nextNumber++,
          timelineTime: marker.timelineTime!,
          label: marker.label,
          createdBy: marker.createdBy ?? 'ai',
          status: marker.status ?? 'open',
          linkedRange: marker.linkedRange,
          linkedMessageId: marker.linkedMessageId,
          confidence: marker.confidence ?? null,
          note: marker.note,
        })),
      ],
    };
  }

  if (action.type === 'update_marker') {
    if (!action.markerId) return snapshot;
    return {
      ...snapshot,
      markers: snapshot.markers.map((marker) => (
        marker.id === action.markerId
          ? {
              ...marker,
              ...action.marker,
              timelineTime: action.marker?.timelineTime ?? marker.timelineTime,
              number: action.marker?.number ?? marker.number,
            }
          : marker
      )),
    };
  }

  if (action.type === 'remove_marker') {
    if (!action.markerId) return snapshot;
    return {
      ...snapshot,
      markers: snapshot.markers.filter((marker) => marker.id !== action.markerId),
    };
  }

  if (action.type === 'add_text_overlay') {
    return {
      ...snapshot,
      textOverlays: [...snapshot.textOverlays, ...(action.textOverlays ?? []).map(overlay => ({ ...overlay, id: uuidv4() }))],
    };
  }

  if (action.type === 'replace_text_overlay') {
    const replacement = action.textOverlays?.[0];
    const overlayIndex = action.overlayIndex ?? 0;
    if (!replacement || overlayIndex >= snapshot.textOverlays.length) return snapshot;
    const textOverlays = [...snapshot.textOverlays];
    textOverlays[overlayIndex] = { ...replacement, id: uuidv4() };
    return { ...snapshot, textOverlays };
  }

  return snapshot;
}

export function expandActionForReview(action: EditAction): EditAction[] {
  if (action.type === 'delete_ranges') {
    return [...(action.ranges ?? [])]
      .sort((a, b) => a.start - b.start)
      .map(range => ({
        type: 'delete_range' as const,
        deleteStartTime: range.start,
        deleteEndTime: range.end,
        message: `Remove ${range.start.toFixed(2)}s to ${range.end.toFixed(2)}s.`,
      }));
  }

  if (action.type === 'add_captions') {
    return (action.captions ?? []).map(caption => ({
      type: 'add_captions' as const,
      captions: [caption],
      message: action.message,
    }));
  }

  if (action.type === 'add_transition') {
    return (action.transitions ?? []).map(transition => ({
      type: 'add_transition' as const,
      transitions: [transition],
      message: action.message,
    }));
  }

  if (action.type === 'add_markers') {
    return (action.markers ?? []).map((marker) => ({
      type: 'add_marker' as const,
      marker,
      message: action.message,
    }));
  }

  if (action.type === 'add_text_overlay') {
    return (action.textOverlays ?? []).map(textOverlay => ({
      type: 'add_text_overlay' as const,
      textOverlays: [textOverlay],
      message: action.message,
    }));
  }

  return [action];
}
