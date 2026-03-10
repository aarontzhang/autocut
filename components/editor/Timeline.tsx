'use client';

import { memo, useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { getRulerTicks, formatTime, formatTimeDetailed, formatTimePrecise, generateWaveform } from '@/lib/timelineUtils';
import { EditSnapshot } from '@/lib/useEditorStore';
import { buildClipSchedule } from '@/lib/playbackEngine';
import ClipBlock from './ClipBlock';
import type { VideoPlayerHandle } from './VideoPlayer';
import { v4 as uuidv4 } from 'uuid';
import { useAuth } from '@/components/auth/AuthProvider';
import { uploadProjectMedia } from '@/lib/projectMedia';

const BASE_TRACK_HEIGHT = 50;
const EFFECT_TRACK_H = 26;
const HEADER_W = 76;
const RULER_H = 24;

const SNAP_PX = 14; // pixels within which clips snap to each other's edges

type DragInfo = {
  type: 'clip-move' | 'clip-trim-left' | 'clip-trim-right' | 'caption' | 'text' | 'transition' | 'track-clip-move' | 'track-clip-trim-left' | 'track-clip-trim-right';
  id: string;
  trackId?: string;
  startX: number;
  origStart: number;
  origEnd: number;
  snapTotalW: number;
  snapDuration: number;
  preDragSnap: EditSnapshot;
  // Linked clip (video↔audio pair)
  linkedTrackId?: string;
  linkedClipId?: string;
  linkedOrigStart?: number;
};

type PlayheadDragInfo = {
  totalW: number;
  totalDuration: number;
};

/** Collect all timeline edge positions (start/end of every clip) for snapping, excluding specified clip IDs */
function collectSnapPoints(excludeClipIds: string[]): number[] {
  const store = useEditorStore.getState();
  const points: number[] = [0, store.currentTime];
  const sched = buildClipSchedule(store.clips);
  for (const e of sched) {
    points.push(e.timelineStart, e.timelineEnd);
  }
  for (const track of store.extraTracks) {
    for (const clip of track.clips) {
      if (excludeClipIds.includes(clip.id)) continue;
      points.push(clip.timelineStart, clip.timelineStart + clip.sourceDuration / clip.speed);
    }
  }
  return points;
}

/** Return the nearest snap point if within threshold, else return raw time. Also returns the snapped-to point for the indicator. */
function applySnap(rawTime: number, points: number[], threshold: number): { snapped: number; snapPoint: number | null } {
  let best = rawTime;
  let bestDist = threshold;
  let snapPoint: number | null = null;
  for (const p of points) {
    const d = Math.abs(rawTime - p);
    if (d < bestDist) {
      bestDist = d;
      best = p;
      snapPoint = p;
    }
  }
  return { snapped: best, snapPoint };
}

interface TimelineProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playerRef?: React.RefObject<VideoPlayerHandle | null>;
  onImportFile?: (file: File) => void;
}

export default function Timeline({ videoRef, playerRef, onImportFile }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(800);
  const dragRef = useRef<DragInfo | null>(null);
  const panRef = useRef<{ startX: number; startScrollLeft: number; moved: boolean } | null>(null);
  const playheadDragRef = useRef<PlayheadDragInfo | null>(null);
  const clipDragJustEnded = useRef(false);

  // Track clip selection (supports linked video+audio pair highlighting)
  const [selectedTrackClipId, setSelectedTrackClipId] = useState<string | null>(null);
  // Snap indicator: pixel X position within the tracks content div, null when not snapping
  const [snapIndicatorX, setSnapIndicatorX] = useState<number | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);

  const videoDuration = useEditorStore(s => s.videoDuration);
  const zoom = useEditorStore(s => s.zoom);
  const setZoom = useEditorStore(s => s.setZoom);
  const setCurrentTime = useEditorStore(s => s.setCurrentTime);
  const clips = useEditorStore(s => s.previewSnapshot?.clips ?? s.clips);
  const captions = useEditorStore(s => s.previewSnapshot?.captions ?? s.captions);
  const transitions = useEditorStore(s => s.previewSnapshot?.transitions ?? s.transitions);
  const textOverlays = useEditorStore(s => s.previewSnapshot?.textOverlays ?? s.textOverlays);
  const extraTracks = useEditorStore(s => s.extraTracks);
  const addClipToTrack = useEditorStore(s => s.addClipToTrack);
  const appendVideoToTimeline = useEditorStore(s => s.appendVideoToTimeline);
  const insertVideoIntoTimeline = useEditorStore(s => s.insertVideoIntoTimeline);
  const updateTrackClipSourcePath = useEditorStore(s => s.updateTrackClipSourcePath);
  const updateClipSourcePath = useEditorStore(s => s.updateClipSourcePath);
  const removeTrackClip = useEditorStore(s => s.removeTrackClip);
  const selectedItem = useEditorStore(s => s.selectedItem);
  const setSelectedItem = useEditorStore(s => s.setSelectedItem);
  const splitClipAtTime = useEditorStore(s => s.splitClipAtTime);
  const { user } = useAuth();

  // Delete key: remove selected extra-track clip (and its linked partner)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTrackClipId) {
        e.preventDefault();
        const store = useEditorStore.getState();
        for (const track of store.extraTracks) {
          const clip = track.clips.find(c => c.id === selectedTrackClipId);
          if (clip) {
            store.removeTrackClip(track.id, selectedTrackClipId);
            // Remove linked partner (video↔audio pair)
            if (clip.linkedClipId) {
              for (const t2 of store.extraTracks) {
                if (t2.clips.find(c => c.id === clip.linkedClipId)) {
                  store.removeTrackClip(t2.id, clip.linkedClipId);
                  break;
                }
              }
            }
            setSelectedTrackClipId(null);
            break;
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedTrackClipId]);

  // Dynamic track height — shrinks as more tracks are added
  const totalMediaTracks = 2 + extraTracks.length; // main video + main audio + extras
  const TRACK_HEIGHT = Math.max(26, Math.round(BASE_TRACK_HEIGHT - (totalMediaTracks - 2) * 5));

  // Build schedule from clips
  const schedule = buildClipSchedule(clips);
  const mainTrackEnd = schedule.length > 0 ? schedule[schedule.length - 1].timelineEnd : videoDuration;

  const maxExtraTrackEnd = extraTracks.reduce((acc, track) =>
    track.clips.reduce((trackAcc, clip) => {
      const clipEnd = clip.timelineStart + clip.sourceDuration / clip.speed;
      return Math.max(trackAcc, clipEnd);
    }, acc), 0);

  const contentDuration = Math.max(mainTrackEnd, maxExtraTrackEnd);
  const RIGHT_PAD = Math.max(30, contentDuration * 0.3);
  const totalTimelineDuration = contentDuration + RIGHT_PAD;

  const totalW = trackWidth * zoom;
  const ticks = getRulerTicks(totalTimelineDuration, totalW);
  const majorTickInterval = useMemo(() => {
    const majorTimes = ticks.filter((tick) => tick.major).map((tick) => tick.time);
    if (majorTimes.length < 2) return totalTimelineDuration;
    return majorTimes[1] - majorTimes[0];
  }, [ticks, totalTimelineDuration]);
  const formatRulerLabel = useCallback((time: number) => {
    if (majorTickInterval <= 0.1) return formatTimePrecise(time);
    if (majorTickInterval <= 1) return formatTimeDetailed(time);
    return formatTime(time);
  }, [majorTickInterval]);

  const hasCaptions = captions.length > 0;
  const hasTextOverlays = textOverlays.length > 0;
  const hasTransitions = transitions.length > 0;

  const waveform = useMemo(() => {
    if (videoDuration <= 0) return [];
    const bars = Math.max(100, Math.floor(totalW / 4));
    return generateWaveform(videoDuration, bars);
  }, [videoDuration, totalW]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setTrackWidth(e.contentRect.width - HEADER_W);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Non-passive wheel: ctrl/meta = zoom (focal-point), vertical = horizontal pan
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const cursorXInContent = (e.clientX - rect.left - HEADER_W) + el.scrollLeft;

        const cur = useEditorStore.getState().zoom;
        const factor = e.deltaY > 0 ? 1 / 1.25 : 1.25;
        const next = Math.round(cur * factor * 100) / 100;
        useEditorStore.getState().setZoom(next);

        requestAnimationFrame(() => {
          const newZoom = useEditorStore.getState().zoom;
          const ratio = newZoom / cur;
          const newCursorX = cursorXInContent * ratio;
          el.scrollLeft = Math.max(0, newCursorX - (e.clientX - rect.left - HEADER_W));
        });
        return;
      }
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Convert timeline time to pixel
  const tPx = useCallback((t: number) => {
    if (totalTimelineDuration <= 0) return 0;
    return (t / totalTimelineDuration) * totalW;
  }, [totalTimelineDuration, totalW]);

  const seek = useCallback((clientX: number, containerEl: HTMLDivElement) => {
    if (panRef.current?.moved) return; // was a pan drag, not a click
    if (clipDragJustEnded.current) { clipDragJustEnded.current = false; return; } // suppress seek after clip drag
    const rect = containerEl.getBoundingClientRect();
    const scrollLeft = containerEl.scrollLeft;
    const px = (clientX - rect.left - HEADER_W) + scrollLeft;
    const t = Math.max(0, Math.min(contentDuration, (px / totalW) * totalTimelineDuration));
    playerRef?.current?.seekTo(t);
    if (!playerRef?.current) {
      setCurrentTime(t);
      const store = useEditorStore.getState();
      const sched = buildClipSchedule(store.clips);
      if (sched.length > 0) {
        let targetEntry = sched.find(e => t >= e.timelineStart && t <= e.timelineEnd);
        if (!targetEntry) targetEntry = sched[sched.length - 1];
        const offsetInTimeline = t - targetEntry.timelineStart;
        const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, sourceTime);
      }
    }
    setSelectedItem(null);
  }, [contentDuration, playerRef, setCurrentTime, setSelectedItem, totalTimelineDuration, totalW, videoRef]);

  const scrubPlayhead = useCallback((clientX: number, dragInfo: PlayheadDragInfo) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rawPx = (clientX - rect.left - HEADER_W) + el.scrollLeft;
    const rawT = Math.max(0, Math.min(dragInfo.totalDuration, (rawPx / dragInfo.totalW) * dragInfo.totalDuration));
    const snapThreshold = (SNAP_PX / dragInfo.totalW) * dragInfo.totalDuration;
    const snapPts = collectSnapPoints([]);
    const t = snapEnabled ? applySnap(rawT, snapPts, snapThreshold).snapped : rawT;
    playerRef?.current?.seekTo(t);
    if (!playerRef?.current) {
      useEditorStore.getState().setCurrentTime(t);
      const store = useEditorStore.getState();
      const sched = buildClipSchedule(store.clips);
      if (sched.length > 0) {
        let targetEntry = sched.find(entry => t >= entry.timelineStart && t <= entry.timelineEnd);
        if (!targetEntry) targetEntry = sched[sched.length - 1];
        const offsetInTimeline = t - targetEntry.timelineStart;
        const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, sourceTime);
      }
    }
  }, [playerRef, snapEnabled, videoRef]);

  const beginPlayheadDrag = useCallback((clientX: number) => {
    const dragInfo = { totalW, totalDuration: totalTimelineDuration };
    playheadDragRef.current = dragInfo;
    document.body.style.cursor = 'ew-resize';
    scrubPlayhead(clientX, dragInfo);
  }, [scrubPlayhead, totalTimelineDuration, totalW]);

  const getSnappedTime = useCallback((rawTime: number, clipDuration = 0, excludeClipIds: string[] = []) => {
    const clamped = Math.max(0, rawTime);
    if (!snapEnabled) return clamped;
    const snapThreshold = (SNAP_PX / Math.max(totalW, 1)) * totalTimelineDuration;
    const snapPts = collectSnapPoints(excludeClipIds);
    const byStart = applySnap(clamped, snapPts, snapThreshold);
    if (clipDuration <= 0) return byStart.snapped;
    const byEnd = applySnap(clamped + clipDuration, snapPts, snapThreshold);
    const startByEnd = byEnd.snapped - clipDuration;
    return Math.abs(byStart.snapped - clamped) <= Math.abs(startByEnd - clamped) ? byStart.snapped : startByEnd;
  }, [snapEnabled, totalTimelineDuration, totalW]);

  // ── Drag handlers ──────────────────────────────────────────────────────────

  const startEffectDrag = useCallback((
    e: React.MouseEvent,
    type: 'caption' | 'text' | 'transition',
    id: string,
    origStart: number,
    origEnd: number,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedItem({ type: type === 'caption' ? 'caption' : type === 'text' ? 'text' : 'transition', id });
    const state = useEditorStore.getState();
    const preDragSnap: EditSnapshot = {
      clips: state.clips,
      captions: state.captions,
      transitions: state.transitions,
      textOverlays: state.textOverlays,
    };
    dragRef.current = { type, id, startX: e.clientX, origStart, origEnd, snapTotalW: totalW, snapDuration: totalTimelineDuration, preDragSnap };
    document.body.style.cursor = 'grabbing';
  }, [setSelectedItem, totalW, totalTimelineDuration]);

  const startClipTrimLeft = useCallback((e: React.MouseEvent, clipId: string) => {
    e.stopPropagation(); e.preventDefault();
    const state = useEditorStore.getState();
    const clip = state.clips.find(c => c.id === clipId);
    if (!clip) return;
    const preDragSnap: EditSnapshot = {
      clips: state.clips, captions: state.captions,
      transitions: state.transitions, textOverlays: state.textOverlays,
    };
    dragRef.current = {
      type: 'clip-trim-left', id: clipId,
      startX: e.clientX,
      origStart: clip.sourceStart,
      origEnd: clip.sourceStart + clip.sourceDuration,
      snapTotalW: totalW,
      snapDuration: totalTimelineDuration,
      preDragSnap,
    };
    document.body.style.cursor = 'ew-resize';
  }, [totalW, totalTimelineDuration]);

  const startClipTrimRight = useCallback((e: React.MouseEvent, clipId: string) => {
    e.stopPropagation(); e.preventDefault();
    const state = useEditorStore.getState();
    const clip = state.clips.find(c => c.id === clipId);
    if (!clip) return;
    const preDragSnap: EditSnapshot = {
      clips: state.clips, captions: state.captions,
      transitions: state.transitions, textOverlays: state.textOverlays,
    };
    dragRef.current = {
      type: 'clip-trim-right', id: clipId,
      startX: e.clientX,
      origStart: clip.sourceStart,
      origEnd: clip.sourceStart + clip.sourceDuration,
      snapTotalW: totalW,
      snapDuration: totalTimelineDuration,
      preDragSnap,
    };
    document.body.style.cursor = 'ew-resize';
  }, [totalW, totalTimelineDuration]);

  const startClipMove = useCallback((e: React.MouseEvent, clipId: string) => {
    e.stopPropagation(); e.preventDefault();
    const state = useEditorStore.getState();
    const schedule = buildClipSchedule(state.clips);
    const entry = schedule.find(en => en.clipId === clipId);
    if (!entry) return;
    const preDragSnap: EditSnapshot = {
      clips: state.clips, captions: state.captions,
      transitions: state.transitions, textOverlays: state.textOverlays,
    };
    dragRef.current = {
      type: 'clip-move', id: clipId,
      startX: e.clientX,
      origStart: entry.timelineStart,
      origEnd: entry.timelineEnd,
      snapTotalW: totalW,
      snapDuration: totalTimelineDuration,
      preDragSnap,
    };
    setSelectedItem({ type: 'clip', id: clipId });
    document.body.style.cursor = 'grabbing';
  }, [setSelectedItem, totalW, totalTimelineDuration]);

  const startTrackClipDrag = useCallback((e: React.MouseEvent, trackId: string, clipId: string) => {
    e.stopPropagation(); e.preventDefault();
    const state = useEditorStore.getState();
    const track = state.extraTracks.find(t => t.id === trackId);
    const clip = track?.clips.find(c => c.id === clipId);
    if (!clip) return;

    // Select this clip (and highlight its linked partner via linkedClipId)
    setSelectedTrackClipId(clipId);

    // Find linked clip (video↔audio pair) for synchronized movement
    let linkedTrackId: string | undefined;
    let linkedClipId: string | undefined;
    let linkedOrigStart: number | undefined;
    if (clip.linkedClipId) {
      for (const t of state.extraTracks) {
        const linked = t.clips.find(c => c.id === clip.linkedClipId);
        if (linked) {
          linkedTrackId = t.id;
          linkedClipId = linked.id;
          linkedOrigStart = linked.timelineStart;
          break;
        }
      }
    }

    const preDragSnap: EditSnapshot = {
      clips: state.clips, captions: state.captions,
      transitions: state.transitions, textOverlays: state.textOverlays,
    };
    dragRef.current = {
      type: 'track-clip-move', id: clipId, trackId,
      startX: e.clientX,
      origStart: clip.timelineStart,
      origEnd: clip.timelineStart + clip.sourceDuration / clip.speed,
      snapTotalW: totalW,
      snapDuration: totalTimelineDuration,
      preDragSnap,
      linkedTrackId,
      linkedClipId,
      linkedOrigStart,
    };
    document.body.style.cursor = 'grabbing';
  }, [totalW, totalTimelineDuration]);

  const startTrackClipTrimLeft = useCallback((e: React.MouseEvent, trackId: string, clipId: string) => {
    e.stopPropagation(); e.preventDefault();
    const state = useEditorStore.getState();
    const track = state.extraTracks.find(t => t.id === trackId);
    const clip = track?.clips.find(c => c.id === clipId);
    if (!clip) return;
    const preDragSnap: EditSnapshot = {
      clips: state.clips, captions: state.captions,
      transitions: state.transitions, textOverlays: state.textOverlays,
    };
    dragRef.current = {
      type: 'track-clip-trim-left', id: clipId, trackId,
      startX: e.clientX,
      origStart: clip.timelineStart,
      origEnd: clip.timelineStart + clip.sourceDuration / clip.speed,
      snapTotalW: totalW,
      snapDuration: totalTimelineDuration,
      preDragSnap,
    };
    document.body.style.cursor = 'ew-resize';
  }, [totalW, totalTimelineDuration]);

  const startTrackClipTrimRight = useCallback((e: React.MouseEvent, trackId: string, clipId: string) => {
    e.stopPropagation(); e.preventDefault();
    const state = useEditorStore.getState();
    const track = state.extraTracks.find(t => t.id === trackId);
    const clip = track?.clips.find(c => c.id === clipId);
    if (!clip) return;
    const preDragSnap: EditSnapshot = {
      clips: state.clips, captions: state.captions,
      transitions: state.transitions, textOverlays: state.textOverlays,
    };
    dragRef.current = {
      type: 'track-clip-trim-right', id: clipId, trackId,
      startX: e.clientX,
      origStart: clip.timelineStart,
      origEnd: clip.timelineStart + clip.sourceDuration / clip.speed,
      snapTotalW: totalW,
      snapDuration: totalTimelineDuration,
      preDragSnap,
    };
    document.body.style.cursor = 'ew-resize';
  }, [totalW, totalTimelineDuration]);

  // Handle file drop onto a track at the cursor's horizontal position
  const handleTrackFileDrop = async (
    e: React.DragEvent,
    trackId: string,
  ) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const el = scrollRef.current;
    if (!el) return;

    // Compute timeline position from drop X
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left - HEADER_W) + el.scrollLeft;
    const rawDropTime = Math.max(0, (px / totalW) * totalTimelineDuration);

    // Get duration
    const sourceUrl = URL.createObjectURL(file);
    const duration = await new Promise<number>((resolve) => {
      const tmp = document.createElement('video');
      tmp.src = sourceUrl;
      tmp.onloadedmetadata = () => { resolve(tmp.duration); URL.revokeObjectURL(tmp.src); };
      tmp.onerror = () => { resolve(10); URL.revokeObjectURL(tmp.src); };
    });

    const targetStart = getSnappedTime(rawDropTime, duration);

    const clipId = uuidv4();
    addClipToTrack(trackId, {
      id: clipId,
      sourceUrl,
      sourceName: file.name,
      sourceStart: 0,
      sourceDuration: duration,
      timelineStart: targetStart,
      speed: 1,
      volume: 1,
    });

    const { currentProjectId } = useEditorStore.getState();
    if (user && currentProjectId) {
      uploadProjectMedia(file, user.id, currentProjectId, 'tracks').then((storagePath) => {
        updateTrackClipSourcePath(trackId, clipId, storagePath);
      }).catch((error: Error) => {
        console.warn('Track clip upload failed:', error.message);
      });
    }
  };

  // Handle file drop onto the main timeline area → insert into the primary timeline
  const [isMainDragOver, setIsMainDragOver] = useState(false);

  const handleMainFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsMainDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith('video/')) return;

    // If no main video loaded yet, import this as the main video
    if (!useEditorStore.getState().videoUrl) {
      if (onImportFile) {
        onImportFile(file);
      } else {
        useEditorStore.getState().setVideoFile(file);
      }
      return;
    }

    // Capture cursor position before the await (synthetic event gets recycled)
    const el = scrollRef.current;
    let dropTime = useEditorStore.getState().currentTime;
    if (el) {
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left - HEADER_W) + el.scrollLeft;
      dropTime = Math.max(0, (px / totalW) * totalTimelineDuration);
    }

    const sourceUrl = URL.createObjectURL(file);
    const duration = await new Promise<number>((resolve) => {
      const tmp = document.createElement('video');
      tmp.src = sourceUrl;
      tmp.onloadedmetadata = () => { resolve(tmp.duration); tmp.src = ''; };
      tmp.onerror = () => { resolve(10); tmp.src = ''; };
    });

    const targetTime = getSnappedTime(dropTime, duration);
    const clipId = targetTime >= mainTrackEnd - 0.05
      ? appendVideoToTimeline(sourceUrl, file.name, duration)
      : insertVideoIntoTimeline(sourceUrl, file.name, duration, targetTime);

    const { currentProjectId } = useEditorStore.getState();
    if (user && currentProjectId) {
      uploadProjectMedia(file, user.id, currentProjectId, 'sources').then((storagePath) => {
        updateClipSourcePath(clipId, storagePath);
      }).catch((error: Error) => {
        console.warn('Main timeline clip upload failed:', error.message);
      });
    }
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      // Playhead scrub drag — with snapping to clip edges
      const ph = playheadDragRef.current;
      if (ph) {
        scrubPlayhead(e.clientX, ph);
        return;
      }

      // Pan (scroll) the timeline if no clip/effect drag is active
      const p = panRef.current;
      if (p && !dragRef.current) {
        const dx = e.clientX - p.startX;
        if (Math.abs(dx) > 4) {
          p.moved = true;
          const el = scrollRef.current;
          if (el) el.scrollLeft = Math.max(0, p.startScrollLeft - dx);
        }
        return;
      }

      const d = dragRef.current;
      if (!d) return;
      const pxDelta = e.clientX - d.startX;
      const timeDelta = (pxDelta / d.snapTotalW) * d.snapDuration;
      const store = useEditorStore.getState();

      if (d.type === 'clip-move') {
        // Reorder V1 main clip by dragging: find the new array index based on cursor position
        const rawNewStart = d.origStart + timeDelta;
        const clipDuration = d.origEnd - d.origStart;
        const midpoint = rawNewStart + clipDuration / 2;
        const schedule = buildClipSchedule(store.clips);
        let newIndex = schedule.length - 1;
        for (let i = 0; i < schedule.length; i++) {
          if (schedule[i].clipId === d.id) continue;
          const entryMid = (schedule[i].timelineStart + schedule[i].timelineEnd) / 2;
          if (midpoint < entryMid) { newIndex = i; break; }
        }
        // Direct state update (no history push) — history is pushed on mouseUp
        const idx = store.clips.findIndex(c => c.id === d.id);
        if (idx !== -1) {
          const newClips = [...store.clips];
          const [removed] = newClips.splice(idx, 1);
          newClips.splice(Math.max(0, Math.min(newClips.length, newIndex)), 0, removed);
          useEditorStore.setState({ clips: newClips });
        }
      } else if (d.type === 'track-clip-move' && d.trackId) {
        const rawNewStart = d.origStart + timeDelta;
        const clipDuration = d.origEnd - d.origStart;
        const snapThreshold = (SNAP_PX / d.snapTotalW) * d.snapDuration;
        const excludeIds = [d.id, d.linkedClipId].filter(Boolean) as string[];
        const snapPts = collectSnapPoints(excludeIds);
        const startSnap = snapEnabled ? applySnap(rawNewStart, snapPts, snapThreshold) : { snapped: rawNewStart, snapPoint: null };
        const endSnap = snapEnabled ? applySnap(rawNewStart + clipDuration, snapPts, snapThreshold) : { snapped: rawNewStart + clipDuration, snapPoint: null };
        const snappedByEnd = endSnap.snapped - clipDuration;
        const distStart = Math.abs(startSnap.snapped - rawNewStart);
        const distEnd = Math.abs(snappedByEnd - rawNewStart);
        const newTimelineStart = distStart <= distEnd ? startSnap.snapped : snappedByEnd;
        const activeSnapPoint = distStart <= distEnd ? startSnap.snapPoint : endSnap.snapPoint;

        // Show snap indicator
        if (snapEnabled && activeSnapPoint !== null) {
          setSnapIndicatorX((activeSnapPoint / d.snapDuration) * d.snapTotalW);
        } else {
          setSnapIndicatorX(null);
        }

        store.moveTrackClip(d.trackId, d.id, Math.max(0, newTimelineStart));

        // Move linked clip (video↔audio pair) by the same delta
        if (d.linkedTrackId && d.linkedClipId && d.linkedOrigStart !== undefined) {
          const linkedDelta = newTimelineStart - d.origStart;
          store.moveTrackClip(d.linkedTrackId, d.linkedClipId, Math.max(0, d.linkedOrigStart + linkedDelta));
        }
      } else if (d.type === 'track-clip-trim-left' && d.trackId) {
        const track = store.extraTracks.find(t => t.id === d.trackId);
        const clip = track?.clips.find(c => c.id === d.id);
        if (!clip) return;
        const newTimelineStart = Math.max(0, d.origStart + timeDelta);
        const newSourceStart = clip.sourceStart + (newTimelineStart - d.origStart) * clip.speed;
        const newSourceDuration = (d.origEnd - newTimelineStart) * clip.speed;
        if (newSourceDuration < 0.1) return;
        store.moveTrackClip(d.trackId, d.id, newTimelineStart);
        store.trimTrackClip(d.trackId, d.id, Math.max(0, newSourceStart), newSourceDuration);
      } else if (d.type === 'track-clip-trim-right' && d.trackId) {
        const track = store.extraTracks.find(t => t.id === d.trackId);
        const clip = track?.clips.find(c => c.id === d.id);
        if (!clip) return;
        const newEnd = Math.max(d.origStart + 0.1, d.origEnd + timeDelta);
        const newSourceDuration = (newEnd - d.origStart) * clip.speed;
        store.trimTrackClip(d.trackId, d.id, clip.sourceStart, newSourceDuration);
      } else if (d.type === 'clip-trim-left') {
        const clip = store.clips.find(c => c.id === d.id);
        if (!clip) return;
        const sourceTimeDelta = timeDelta * clip.speed;
        const newSourceStart = Math.max(0, d.origStart + sourceTimeDelta);
        const newSourceDuration = d.origEnd - newSourceStart;
        if (newSourceDuration < 0.1) return;
        store.trimClip(d.id, newSourceStart, newSourceDuration);
      } else if (d.type === 'clip-trim-right') {
        const newEnd = Math.max(d.origStart + 0.1, d.origEnd + timeDelta * (store.clips.find(c => c.id === d.id)?.speed ?? 1));
        const newSourceDuration = newEnd - d.origStart;
        store.trimClip(d.id, d.origStart, newSourceDuration);
      } else if (d.type === 'transition') {
        const newAt = Math.max(0, Math.min(d.snapDuration, d.origStart + timeDelta));
        store.updateTransition(d.id, { atTime: newAt });
      } else {
        const segLen = d.origEnd - d.origStart;
        let newStart = d.origStart + timeDelta;
        let newEnd = d.origEnd + timeDelta;
        if (newStart < 0) { newStart = 0; newEnd = segLen; }
        if (newEnd > d.snapDuration) { newEnd = d.snapDuration; newStart = Math.max(0, d.snapDuration - segLen); }
        if (d.type === 'caption') store.updateCaption(d.id, { startTime: newStart, endTime: newEnd });
        else if (d.type === 'text') store.updateTextOverlay(d.id, { startTime: newStart, endTime: newEnd });
      }
    };

    const onMouseUp = () => {
      setSnapIndicatorX(null);
      if (playheadDragRef.current) {
        playheadDragRef.current = null;
        document.body.style.cursor = '';
        return;
      }
      if (panRef.current) {
        panRef.current = null;
        document.body.style.cursor = '';
      }
      const d = dragRef.current;
      if (!d) return;
      clipDragJustEnded.current = true;
      useEditorStore.getState().pushHistory(d.preDragSnap);
      dragRef.current = null;
      document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [scrubPlayhead, snapEnabled]);

  // Handle right-click on video track to split at playhead
  const handleVideoTrackContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitClipAtTime(useEditorStore.getState().currentTime);
  }, [splitClipAtTime]);

  const px = (t: number) => tPx(t);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px', height: 34,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-panel)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 10, color: 'var(--fg-muted)',
          fontFamily: 'var(--font-serif)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          Timeline
        </span>

        {clips.length > 1 && (
          <span style={{
            fontSize: 10, padding: '1px 7px', borderRadius: 3,
            background: 'rgba(33,212,255,0.12)',
            border: '1px solid rgba(33,212,255,0.26)',
            color: 'rgba(184,243,255,0.92)',
            fontFamily: 'var(--font-serif)',
          }}>
            {clips.length} clips
          </span>
        )}

        <div style={{ flex: 1 }} />

        <button
          onClick={() => setSnapEnabled(v => !v)}
          style={{
            height: 22,
            padding: '0 9px',
            borderRadius: 999,
            border: `1px solid ${snapEnabled ? 'var(--accent-border)' : 'var(--border)'}`,
            background: snapEnabled ? 'rgba(33,212,255,0.18)' : 'transparent',
            color: snapEnabled ? 'var(--accent-strong)' : 'var(--fg-secondary)',
            cursor: 'pointer',
            fontSize: 10,
            fontFamily: 'var(--font-serif)',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          {snapEnabled ? 'Snapping On' : 'Free Move'}
        </button>

        {/* Zoom controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button
            onClick={() => setZoom(Math.round(zoom / 1.25 * 100) / 100)}
            style={{
              width: 22, height: 22, borderRadius: 4, background: 'transparent',
              border: '1px solid var(--border)', cursor: 'pointer',
              color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >−</button>
          <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-serif)', minWidth: 30, textAlign: 'center' }}>
            {zoom}×
          </span>
          <button
            onClick={() => setZoom(Math.round(zoom * 1.25 * 10) / 10)}
            style={{
              width: 22, height: 22, borderRadius: 4, background: 'transparent',
              border: '1px solid var(--border)', cursor: 'pointer',
              color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >+</button>
        </div>
      </div>

      {/* Scrollable area */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', display: 'flex', flexDirection: 'row', cursor: 'grab', position: 'relative' }}
        className="no-select"
        onMouseDown={e => {
          // Don't start a pan if clicking on a clip/effect block or playhead dot
          if ((e.target as HTMLElement).closest('.clip-block, .clip-caption, .clip-textoverlay, .clip-audio, .playhead-dot')) return;
          panRef.current = { startX: e.clientX, startScrollLeft: scrollRef.current?.scrollLeft ?? 0, moved: false };
          document.body.style.cursor = 'grabbing';
        }}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setIsMainDragOver(true); }}
        onDragLeave={e => { if (!scrollRef.current?.contains(e.relatedTarget as Node)) setIsMainDragOver(false); }}
        onDrop={handleMainFileDrop}
      >
        {isMainDragOver && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none',
            border: '2px dashed rgba(255,255,255,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255,255,255,0.03)',
          }}>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-serif)' }}>
              Drop video to place here
            </span>
          </div>
        )}
        {/* Track headers */}
        <div style={{
          width: HEADER_W, flexShrink: 0,
          background: 'var(--bg-panel)',
          borderRight: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          position: 'sticky', left: 0, zIndex: 10,
        }}>
          <div style={{ height: RULER_H, borderBottom: '1px solid var(--border)' }} />
          <TrackHeader icon={<VideoIcon />} label="V1" height={TRACK_HEIGHT} color="var(--blue-clip-hi)" />
          {extraTracks.filter(t => t.type === 'video').map(track => (
            <TrackHeader
              key={track.id}
              icon={<VideoIcon />}
              label={track.label}
              height={TRACK_HEIGHT}
              color="var(--blue-clip-hi)"
            />
          ))}
          <TrackHeader icon={<AudioIcon />} label="A1" height={TRACK_HEIGHT} color="var(--blue-clip-hi)" />
          {extraTracks.filter(t => t.type === 'audio').map(track => (
            <TrackHeader
              key={track.id}
              icon={<AudioIcon />}
              label={track.label}
              height={TRACK_HEIGHT}
              color="var(--blue-clip-hi)"
            />
          ))}
          {hasCaptions && <EffectHeader label="CC" color="var(--caption-clip)" />}
          {hasTextOverlays && <EffectHeader label="Text" color="var(--text-clip)" />}
          {hasTransitions && <EffectHeader label="Trans." color="rgba(255,255,255,0.5)" />}
        </div>

        {/* Tracks content */}
        <div style={{ position: 'relative', width: totalW, minWidth: '100%', flexShrink: 0 }}>
          {/* Snap indicator — glowing vertical line at the snap point during drag */}
          {snapIndicatorX !== null && (
            <div style={{
              position: 'absolute', left: snapIndicatorX, top: 0, bottom: 0, width: 1,
              background: 'var(--accent-strong)',
              boxShadow: '0 0 10px 2px var(--accent-border)',
              zIndex: 20, pointerEvents: 'none',
            }} />
          )}
          {/* Extended playhead hit area */}
          <div
            className="playhead-hitbox"
            style={{ display: 'none' }}
          />

          {/* Ruler */}
          <div
            style={{
              height: RULER_H, position: 'relative',
              background: 'var(--bg-elevated)',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer', overflow: 'hidden',
            }}
            onClick={e => { const c = scrollRef.current; if (c) seek(e.clientX, c); }}
          >
            {ticks.map(({ time, major }) => {
              const x = tPx(time);
              return (
                <div key={time} style={{ position: 'absolute', left: x, top: 0 }}>
                  <div style={{
                    width: 1,
                    height: major ? 9 : 4,
                    background: major ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)',
                    marginTop: major ? 6 : 10,
                  }} />
                  {major && (
                  <span style={{
                      position: 'absolute', top: 5, left: 4,
                      fontSize: 9, fontFamily: 'var(--font-serif)',
                      color: 'rgba(255,255,255,0.3)',
                      whiteSpace: 'nowrap',
                    }}>
                      {formatRulerLabel(time)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Video track — clip blocks */}
          <TrackRow height={TRACK_HEIGHT} onSeek={e => { const c = scrollRef.current; if (c) seek(e.clientX, c); }} onContextMenu={handleVideoTrackContextMenu}>
            {videoDuration > 0 && schedule.map((entry, i) => {
              const clip = clips.find(c => c.id === entry.clipId);
              if (!clip) return null;
              const clipLeft = tPx(entry.timelineStart);
              const clipWidth = tPx(entry.timelineEnd) - clipLeft;
              return (
                <ClipBlock
                  key={clip.id}
                  clip={clip}
                  left={clipLeft}
                  width={clipWidth}
                  height={TRACK_HEIGHT}
                  isSelected={selectedItem?.type === 'clip' && selectedItem.id === clip.id}
                  index={i}
                  onSelect={e => { e.stopPropagation(); setSelectedItem({ type: 'clip', id: clip.id }); }}
                  onMouseDown={e => startClipMove(e, clip.id)}
                  onTrimLeftStart={e => startClipTrimLeft(e, clip.id)}
                  onTrimRightStart={e => startClipTrimRight(e, clip.id)}
                />
              );
            })}
          </TrackRow>

          {/* Extra video tracks */}
          {extraTracks.filter(t => t.type === 'video').map(track => (
            <ExtraTrackRow
              key={track.id}
              height={TRACK_HEIGHT}
              track={track}
              tPx={tPx}
              selectedTrackClipId={selectedTrackClipId}
              onDrop={e => handleTrackFileDrop(e, track.id)}
              onClipDrag={(e, clipId) => startTrackClipDrag(e, track.id, clipId)}
              onTrimLeft={(e, clipId) => startTrackClipTrimLeft(e, track.id, clipId)}
              onTrimRight={(e, clipId) => startTrackClipTrimRight(e, track.id, clipId)}
              onRemoveClip={clipId => removeTrackClip(track.id, clipId)}
              onDeselect={() => setSelectedTrackClipId(null)}
            />
          ))}

          {/* Audio track */}
          <TrackRow height={TRACK_HEIGHT} onSeek={e => { const c = scrollRef.current; if (c) seek(e.clientX, c); }}>
            {videoDuration > 0 && schedule.map((entry) => {
              const clip = clips.find(c => c.id === entry.clipId);
              if (!clip) return null;
              const clipLeft = tPx(entry.timelineStart);
              const clipWidth = tPx(entry.timelineEnd) - clipLeft;
              // Get the waveform slice for this clip
              const startFrac = clip.sourceStart / videoDuration;
              const endFrac = (clip.sourceStart + clip.sourceDuration) / videoDuration;
              const startBar = Math.floor(startFrac * waveform.length);
              const endBar = Math.ceil(endFrac * waveform.length);
              const clipWaveform = waveform.slice(startBar, endBar);
              const isClipSelected = selectedItem?.type === 'clip' && selectedItem.id === clip.id;
              return (
                <div
                  key={clip.id}
                  className="clip-audio"
                  style={{
                    position: 'absolute',
                    left: clipLeft,
                    top: 6,
                    width: Math.max(2, clipWidth),
                    height: TRACK_HEIGHT - 12,
                    borderRadius: 4,
                    overflow: 'hidden',
                    background: isClipSelected ? 'rgba(96,165,250,0.18)' : undefined,
                    border: isClipSelected ? '2px solid var(--accent)' : '1px solid rgba(255,255,255,0.06)',
                    cursor: 'pointer',
                    boxShadow: isClipSelected ? '0 0 0 1px rgba(96,165,250,0.45), inset 0 0 0 1px rgba(255,255,255,0.08)' : 'none',
                    opacity: isClipSelected ? 1 : 0.92,
                  }}
                  onClick={e => { e.stopPropagation(); setSelectedItem({ type: 'clip', id: clip.id }); }}
                >
                  <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', alignItems: 'center',
                    padding: '2px 0',
                  }}>
                    {clipWaveform.map((h, wi) => (
                      <div key={wi} className="waveform-bar" style={{ flex: 1, minWidth: 1, height: `${h * 90}%`, opacity: 0.6 }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </TrackRow>

          {/* Extra audio tracks */}
          {extraTracks.filter(t => t.type === 'audio').map(track => (
            <ExtraTrackRow
              key={track.id}
              height={TRACK_HEIGHT}
              track={track}
              tPx={tPx}
              selectedTrackClipId={selectedTrackClipId}
              onDrop={e => handleTrackFileDrop(e, track.id)}
              onClipDrag={(e, clipId) => startTrackClipDrag(e, track.id, clipId)}
              onTrimLeft={(e, clipId) => startTrackClipTrimLeft(e, track.id, clipId)}
              onTrimRight={(e, clipId) => startTrackClipTrimRight(e, track.id, clipId)}
              onRemoveClip={clipId => removeTrackClip(track.id, clipId)}
              onDeselect={() => setSelectedTrackClipId(null)}
            />
          ))}

          {/* Captions track */}
          {hasCaptions && (
            <EffectTrackRow height={EFFECT_TRACK_H}>
              {captions.map((c) => {
                if (!totalTimelineDuration) return null;
                const isSel = selectedItem?.type === 'caption' && selectedItem.id === c.id;
                return (
                  <div
                    key={c.id}
                    className="clip-caption"
                    title={c.text}
                    style={{
                      position: 'absolute',
                      left: px(c.startTime),
                      width: Math.max(4, px(c.endTime) - px(c.startTime)),
                      top: 3, height: EFFECT_TRACK_H - 6,
                      borderRadius: 3, overflow: 'hidden',
                      border: isSel ? '1.5px solid rgba(255,255,255,0.7)' : '1px solid rgba(255,255,255,0.12)',
                      display: 'flex', alignItems: 'center', padding: '0 5px',
                      cursor: 'grab', boxSizing: 'border-box',
                    }}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => startEffectDrag(e, 'caption', c.id!, c.startTime, c.endTime)}
                  >
                    <span style={{
                      fontSize: 9, color: 'rgba(0,0,0,0.85)', fontWeight: 600,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontFamily: 'var(--font-serif)',
                    }}>{c.text}</span>
                  </div>
                );
              })}
            </EffectTrackRow>
          )}

          {/* Text overlay track */}
          {hasTextOverlays && (
            <EffectTrackRow height={EFFECT_TRACK_H}>
              {textOverlays.map((t) => {
                if (!totalTimelineDuration) return null;
                const isSel = selectedItem?.type === 'text' && selectedItem.id === t.id;
                return (
                  <div
                    key={t.id}
                    className="clip-textoverlay"
                    title={`${t.position}: ${t.text}`}
                    style={{
                      position: 'absolute',
                      left: px(t.startTime),
                      width: Math.max(4, px(t.endTime) - px(t.startTime)),
                      top: 3, height: EFFECT_TRACK_H - 6,
                      borderRadius: 3, overflow: 'hidden',
                      border: isSel ? '1.5px solid rgba(255,255,255,0.7)' : '1px solid rgba(255,255,255,0.12)',
                      display: 'flex', alignItems: 'center', padding: '0 5px',
                      cursor: 'grab', boxSizing: 'border-box',
                    }}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => startEffectDrag(e, 'text', t.id!, t.startTime, t.endTime)}
                  >
                    <span style={{
                      fontSize: 9, color: 'rgba(255,255,255,0.9)', fontWeight: 500,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontFamily: 'var(--font-serif)',
                    }}>{t.text}</span>
                  </div>
                );
              })}
            </EffectTrackRow>
          )}

          {/* Transitions track */}
          {hasTransitions && (
            <EffectTrackRow height={EFFECT_TRACK_H}>
              {transitions.map((t) => {
                if (!totalTimelineDuration) return null;
                const isSel = selectedItem?.type === 'transition' && selectedItem.id === t.id;
                return (
                  <div
                    key={t.id}
                    title={`${t.type} (${t.duration}s)`}
                    style={{
                      position: 'absolute',
                      left: px(t.atTime) - 8,
                      top: 3, width: 16, height: EFFECT_TRACK_H - 6,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'grab', zIndex: 2,
                    }}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => startEffectDrag(e, 'transition', t.id!, t.atTime, t.atTime)}
                  >
                    <div style={{
                      width: 10, height: 10,
                      background: isSel ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.7)',
                      transform: 'rotate(45deg)', borderRadius: 2,
                    }} />
                  </div>
                );
              })}
            </EffectTrackRow>
          )}

          <TimelinePlayheadOverlay
            scrollRef={scrollRef}
            totalTimelineDuration={totalTimelineDuration}
            totalW={totalW}
            headerWidth={HEADER_W}
            rulerHeight={RULER_H}
            playheadDragRef={playheadDragRef}
            onBeginDrag={beginPlayheadDrag}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function TrackRow({ height, onSeek, onContextMenu, children }: {
  height: number;
  onSeek: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        height, position: 'relative',
        background: 'rgba(255,255,255,0.015)',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer', overflow: 'hidden',
      }}
      onClick={onSeek}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  );
}

function EffectTrackRow({ height, children }: { height: number; children: React.ReactNode }) {
  return (
    <div style={{
      height, position: 'relative',
      background: 'rgba(255,255,255,0.01)',
      borderBottom: '1px solid var(--border)',
      overflow: 'hidden',
    }}>
      {children}
    </div>
  );
}

const TimelinePlayheadOverlay = memo(function TimelinePlayheadOverlay({
  scrollRef,
  totalTimelineDuration,
  totalW,
  headerWidth,
  rulerHeight,
  playheadDragRef,
  onBeginDrag,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  totalTimelineDuration: number;
  totalW: number;
  headerWidth: number;
  rulerHeight: number;
  playheadDragRef: React.MutableRefObject<PlayheadDragInfo | null>;
  onBeginDrag: (clientX: number) => void;
}) {
  const currentTime = useEditorStore(s => s.currentTime);

  const playheadX = useMemo(() => {
    if (totalTimelineDuration <= 0) return 0;
    return (currentTime / totalTimelineDuration) * totalW;
  }, [currentTime, totalTimelineDuration, totalW]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || totalTimelineDuration <= 0 || playheadDragRef.current) return;
    const viewLeft = el.scrollLeft;
    const viewRight = viewLeft + el.clientWidth - headerWidth;
    const margin = 80;
    if (playheadX < viewLeft + margin || playheadX > viewRight - margin) {
      el.scrollLeft = Math.max(0, playheadX - (el.clientWidth - headerWidth) / 2);
    }
  }, [currentTime, headerWidth, playheadDragRef, playheadX, scrollRef, totalTimelineDuration]);

  return (
    <>
      <div
        className="playhead-hitbox"
        style={{
          position: 'absolute',
          left: Math.max(0, playheadX - 12),
          top: 0,
          bottom: 0,
          width: 24,
          zIndex: 15,
          cursor: 'ew-resize',
        }}
        onMouseDown={e => {
          e.stopPropagation();
          e.preventDefault();
          onBeginDrag(e.clientX);
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: playheadX,
          top: rulerHeight - 2,
          bottom: 0,
          width: 2,
          background: 'rgba(255,255,255,0.92)',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.12)',
          zIndex: 14,
          pointerEvents: 'none',
        }}
      />
      <div
        className="playhead-dot"
        style={{
          position: 'absolute',
          top: 1,
          left: playheadX - 7,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: 'var(--accent)',
          cursor: 'ew-resize',
          zIndex: 16,
          boxShadow: '0 0 0 3px rgba(33,212,255,0.12)',
        }}
        onMouseDown={e => {
          e.stopPropagation();
          e.preventDefault();
          onBeginDrag(e.clientX);
        }}
      />
    </>
  );
});

function TrackHeader({ icon, label, height, color, onRemove }: {
  icon: React.ReactNode; label: string; height: number; color: string; onRemove?: () => void;
}) {
  return (
    <div style={{
      height,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 3, padding: '0 6px',
      borderBottom: '1px solid var(--border)',
      position: 'relative',
    }}>
      <div style={{ color, opacity: 0.85 }}>{icon}</div>
      <span style={{
        fontSize: 8, fontFamily: 'var(--font-serif)',
        color: 'var(--fg-muted)',
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>{label}</span>
      {onRemove && (
        <button
          onClick={onRemove}
          title="Remove track"
          style={{
            position: 'absolute', top: 3, right: 3,
            width: 12, height: 12,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.25)', padding: 0,
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,100,100,0.7)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.25)'; }}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      )}
    </div>
  );
}

const EXTRA_CLIP_COLOR = { bg: 'rgba(59,130,246,0.35)', border: 'rgba(96,165,250,0.6)' };

const ExtraTrackRow = memo(function ExtraTrackRow({ height, track, tPx, selectedTrackClipId, onDrop, onClipDrag, onTrimLeft, onTrimRight, onRemoveClip, onDeselect }: {
  height: number;
  track: import('@/lib/types').MediaTrack;
  tPx: (t: number) => number;
  selectedTrackClipId?: string | null;
  onDrop: (e: React.DragEvent) => void;
  onClipDrag: (e: React.MouseEvent, clipId: string) => void;
  onTrimLeft: (e: React.MouseEvent, clipId: string) => void;
  onTrimRight: (e: React.MouseEvent, clipId: string) => void;
  onRemoveClip: (clipId: string) => void;
  onDeselect?: () => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const HANDLE_W = 5;

  return (
    <div
      style={{
        height, position: 'relative',
        background: isDragOver ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.008)',
        borderBottom: '1px solid var(--border)',
        overflow: 'hidden',
        transition: 'background 0.1s',
      }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={e => { e.stopPropagation(); setIsDragOver(false); onDrop(e); }}
      onClick={e => { if ((e.target as HTMLElement) === e.currentTarget) onDeselect?.(); }}
    >
      {isDragOver && (
        <div style={{
          position: 'absolute', inset: 0,
          border: '1px dashed rgba(255,255,255,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none', zIndex: 10,
        }}>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', fontFamily: 'var(--font-serif)' }}>
            Drop to place clip
          </span>
        </div>
      )}
      {track.clips.map((clip, i) => {
        void i;
        const color = EXTRA_CLIP_COLOR;
        const clipLeft = tPx(clip.timelineStart);
        const clipW = Math.max(HANDLE_W * 2 + 4, tPx(clip.timelineStart + clip.sourceDuration / clip.speed) - clipLeft);
        // A clip is "selected" if it is the selected clip OR its linked partner is selected
        const isSelected = selectedTrackClipId !== null && selectedTrackClipId !== undefined &&
          (clip.id === selectedTrackClipId || clip.linkedClipId === selectedTrackClipId);
        return (
          <div
            key={clip.id}
            className="clip-block"
            style={{
              position: 'absolute',
              left: clipLeft,
              top: 5,
              width: clipW,
              height: height - 10,
              background: isSelected ? color.bg.replace('0.3', '0.5') : color.bg,
              border: isSelected ? `2px solid ${color.border.replace('0.6', '1')}` : `1.5px solid ${color.border}`,
              borderRadius: 4,
              boxSizing: 'border-box',
              cursor: 'grab',
              overflow: 'hidden',
              boxShadow: isSelected ? `0 0 0 1px ${color.border}` : 'none',
              transition: 'border 0.08s, box-shadow 0.08s',
            }}
            onMouseDown={e => { e.stopPropagation(); onClipDrag(e, clip.id); }}
          >
            {/* Left trim handle */}
            <div
              style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: HANDLE_W, cursor: 'ew-resize',
                background: color.border, opacity: 0.7,
              }}
              onMouseDown={e => { e.stopPropagation(); onTrimLeft(e, clip.id); }}
            />
            {/* Label */}
            <span style={{
              position: 'absolute', left: HANDLE_W + 3, top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 9, color: 'rgba(255,255,255,0.7)',
              fontFamily: 'var(--font-serif)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              maxWidth: clipW - HANDLE_W * 2 - 16, pointerEvents: 'none',
            }}>
              {clip.sourceName}
            </span>
            {/* Remove button */}
            <button
              style={{
                position: 'absolute', top: 2, right: HANDLE_W + 2,
                width: 12, height: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.4)', border: 'none', borderRadius: 2,
                cursor: 'pointer', color: 'rgba(255,255,255,0.6)', padding: 0,
              }}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onRemoveClip(clip.id); }}
            >
              <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
            {/* Right trim handle */}
            <div
              style={{
                position: 'absolute', right: 0, top: 0, bottom: 0,
                width: HANDLE_W, cursor: 'ew-resize',
                background: color.border, opacity: 0.7,
              }}
              onMouseDown={e => { e.stopPropagation(); onTrimRight(e, clip.id); }}
            />
          </div>
        );
      })}
    </div>
  );
});

function EffectHeader({ label, color }: { label: string; color: string }) {
  return (
    <div style={{
      height: EFFECT_TRACK_H,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      borderBottom: '1px solid var(--border)',
    }}>
      <span style={{
        fontSize: 8, fontFamily: 'var(--font-serif)',
        color, letterSpacing: '0.05em', textTransform: 'uppercase',
      }}>{label}</span>
    </div>
  );
}

function VideoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
      <path d="M7 2v20M17 2v20M2 12h20M2 7h5M17 7h5M2 17h5M17 17h5"/>
    </svg>
  );
}

function AudioIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>
  );
}
