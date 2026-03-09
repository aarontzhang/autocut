import { v4 as uuidv4 } from 'uuid';
import { buildClipSchedule } from './playbackEngine';
import type {
  CaptionEntry,
  EditAction,
  TextOverlayEntry,
  TransitionEntry,
  VideoClip,
} from './types';

export interface EditSnapshot {
  clips: VideoClip[];
  captions: CaptionEntry[];
  transitions: TransitionEntry[];
  textOverlays: TextOverlayEntry[];
}

function splitClipAtTime(clips: VideoClip[], timelineTime: number): VideoClip[] {
  const schedule = buildClipSchedule(clips);
  const targetEntry = schedule.find(entry => timelineTime > entry.timelineStart && timelineTime < entry.timelineEnd);
  if (!targetEntry) return clips;

  const clip = clips.find(item => item.id === targetEntry.clipId);
  if (!clip) return clips;

  const offsetInTimeline = timelineTime - targetEntry.timelineStart;
  const splitSourceOffset = offsetInTimeline * targetEntry.speed;
  const firstDuration = splitSourceOffset;
  const secondStart = clip.sourceStart + splitSourceOffset;
  const secondDuration = clip.sourceDuration - splitSourceOffset;
  if (firstDuration < 0.05 || secondDuration < 0.05) return clips;

  const firstClip: VideoClip = { ...clip, sourceDuration: firstDuration };
  const secondClip: VideoClip = { ...clip, id: uuidv4(), sourceStart: secondStart, sourceDuration: secondDuration };
  const index = clips.findIndex(item => item.id === clip.id);
  return [...clips.slice(0, index), firstClip, secondClip, ...clips.slice(index + 1)];
}

function deleteRange(clips: VideoClip[], startTime: number, endTime: number): VideoClip[] {
  const schedule = buildClipSchedule(clips);
  const nextClips: VideoClip[] = [];

  for (const entry of schedule) {
    const clip = clips.find(item => item.id === entry.clipId);
    if (!clip) continue;
    const timelineStart = entry.timelineStart;
    const timelineEnd = entry.timelineEnd;
    const speed = entry.speed;

    if (timelineEnd <= startTime || timelineStart >= endTime) {
      nextClips.push(clip);
      continue;
    }

    if (timelineStart >= startTime && timelineEnd <= endTime) {
      continue;
    }

    if (timelineStart < startTime && timelineEnd > endTime) {
      const firstDuration = (startTime - timelineStart) * speed;
      const secondOffset = (endTime - timelineStart) * speed;
      const secondDuration = clip.sourceDuration - secondOffset;
      if (firstDuration >= 0.05) nextClips.push({ ...clip, sourceDuration: firstDuration });
      if (secondDuration >= 0.05) {
        nextClips.push({
          ...clip,
          id: uuidv4(),
          sourceStart: clip.sourceStart + secondOffset,
          sourceDuration: secondDuration,
        });
      }
      continue;
    }

    if (timelineStart < startTime) {
      const keptDuration = (startTime - timelineStart) * speed;
      if (keptDuration >= 0.05) nextClips.push({ ...clip, sourceDuration: keptDuration });
      continue;
    }

    const cutOffset = (endTime - timelineStart) * speed;
    const remainingDuration = clip.sourceDuration - cutOffset;
    if (remainingDuration >= 0.05) {
      nextClips.push({
        ...clip,
        sourceStart: clip.sourceStart + cutOffset,
        sourceDuration: remainingDuration,
      });
    }
  }

  return nextClips;
}

export function actionChangesTimelineStructure(action: EditAction) {
  return ['split_clip', 'delete_range', 'delete_ranges', 'delete_clip', 'reorder_clip'].includes(action.type);
}

export function applyActionToSnapshot(snapshot: EditSnapshot, action: EditAction): EditSnapshot {
  if (action.type === 'none' || action.type === 'transcribe_request' || action.type === 'request_frames') return snapshot;

  if (action.type === 'split_clip') {
    if (action.splitTime === undefined) return snapshot;
    const clips = splitClipAtTime(snapshot.clips, action.splitTime);
    return clips === snapshot.clips ? snapshot : { ...snapshot, clips };
  }

  if (action.type === 'delete_range') {
    if (action.deleteStartTime === undefined || action.deleteEndTime === undefined) return snapshot;
    return { ...snapshot, clips: deleteRange(snapshot.clips, action.deleteStartTime, action.deleteEndTime) };
  }

  if (action.type === 'delete_ranges') {
    const ranges = [...(action.ranges ?? [])].sort((a, b) => b.start - a.start);
    const clips = ranges.reduce((acc, range) => {
      if (range.end <= range.start) return acc;
      return deleteRange(acc, range.start, range.end);
    }, snapshot.clips);
    return { ...snapshot, clips };
  }

  if (action.type === 'reorder_clip') {
    const clipIndex = action.clipIndex ?? 0;
    const clip = snapshot.clips[clipIndex];
    if (!clip || action.newIndex === undefined) return snapshot;
    const remaining = snapshot.clips.filter(item => item.id !== clip.id);
    const targetIndex = Math.max(0, Math.min(action.newIndex, remaining.length));
    const clips = [...remaining.slice(0, targetIndex), clip, ...remaining.slice(targetIndex)];
    return { ...snapshot, clips };
  }

  if (action.type === 'delete_clip') {
    const clipIndex = action.clipIndex ?? 0;
    const clip = snapshot.clips[clipIndex];
    if (!clip) return snapshot;
    return { ...snapshot, clips: snapshot.clips.filter(item => item.id !== clip.id) };
  }

  if (action.type === 'set_clip_speed') {
    const clip = snapshot.clips[action.clipIndex ?? 0];
    if (!clip || action.speed === undefined) return snapshot;
    return {
      ...snapshot,
      clips: snapshot.clips.map(item => item.id === clip.id ? { ...item, speed: action.speed ?? item.speed } : item),
    };
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
      .sort((a, b) => b.start - a.start)
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

  if (action.type === 'add_text_overlay') {
    return (action.textOverlays ?? []).map(textOverlay => ({
      type: 'add_text_overlay' as const,
      textOverlays: [textOverlay],
      message: action.message,
    }));
  }

  return [action];
}
