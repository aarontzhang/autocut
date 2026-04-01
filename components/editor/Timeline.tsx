'use client';

import { memo, useRef, useState, useCallback, useEffect, useMemo } from 'react';
import type { CSSProperties, ReactNode, RefObject, MutableRefObject } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import {
  getRulerTicks,
  formatTime,
  formatTimeDetailed,
  formatTimePrecise,
  generateWaveform,
  mapTimelineTimeAcrossSnapshots,
} from '@/lib/timelineUtils';
import { buildClipSchedule, buildPlainSchedule, findTimelineEntryAtTime, getTimelineDuration } from '@/lib/playbackEngine';
import type { Track } from '@/lib/types';
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';
import { getReviewOverlayDescriptors, buildReviewGroupWithUpdatedItems, updateReviewItemAction, MIN_CLIP_DURATION_SECONDS } from '@/lib/editActionUtils';
import ClipBlock from './ClipBlock';
import type { VideoPlayerHandle } from './VideoPlayer';

const BASE_TRACK_HEIGHT = 50;
const EFFECT_TRACK_H = 26;
const HEADER_W = 76;
const RULER_H = 24;

type PlayheadDragInfo = {
  pointerId: number;
  totalW: number;
  totalDuration: number;
};

type CutEdgeDragInfo = {
  pointerId: number;
  itemId: string;
  edge: 'start' | 'end';
  totalW: number;
  totalDuration: number;
  otherEdgeTime: number;
};

type ClipReorderDragInfo = {
  pointerId: number;
  clipId: string;
  sourceClipIndex: number;
  startClientX: number;
  startClientY: number;
  isDragging: boolean;
  currentDropIndex: number | null;
  clipWidth: number;
  clipHeight: number;
};

type ClipVisualLayout = {
  clipId: string;
  rawLeft: number;
  rawWidth: number;
  displayLeft: number;
  displayWidth: number;
  lane: number;
};

const CLIP_MIN_DISPLAY_WIDTH = 22;
const CLIP_LANE_STEP = 18;
const CLIP_LANE_OVERLAP_EPSILON_PX = 0.5;

function buildClipVisualLayouts(
  schedule: ReturnType<typeof buildClipSchedule>,
  toPx: (time: number) => number,
): { layouts: ClipVisualLayout[]; laneCount: number } {
  const laneEndByIndex: number[] = [];
  const layouts = schedule.map((entry) => {
    const rawLeft = toPx(entry.timelineStart);
    const rawWidth = Math.max(1, toPx(entry.timelineEnd) - rawLeft);
    const rawRight = rawLeft + rawWidth;
    const displayWidth = Math.max(CLIP_MIN_DISPLAY_WIDTH, rawWidth);
    const displayLeft = rawWidth >= CLIP_MIN_DISPLAY_WIDTH
      ? rawLeft
      : Math.max(0, rawLeft - (displayWidth - rawWidth) / 2);

    let lane = 0;
    // Only stack clips when their real timeline ranges overlap.
    // Back-to-back clips should stay on the same row even if their rendered boxes touch.
    while (
      laneEndByIndex[lane] !== undefined
      && rawLeft + CLIP_LANE_OVERLAP_EPSILON_PX < laneEndByIndex[lane]
    ) {
      lane += 1;
    }
    laneEndByIndex[lane] = rawRight;

    return {
      clipId: entry.clipId,
      rawLeft,
      rawWidth,
      displayLeft,
      displayWidth,
      lane,
    };
  });

  return {
    layouts,
    laneCount: Math.max(1, laneEndByIndex.length),
  };
}

interface TimelineProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  playerRef?: RefObject<VideoPlayerHandle | null>;
  onImportSources?: (files: File[], insertionMode: 'insert', insertAtTime: number) => void | Promise<void>;
}

export default function Timeline({
  videoRef,
  playerRef,
  onImportSources,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number; moved: boolean } | null>(null);
  const playheadDragRef = useRef<PlayheadDragInfo | null>(null);
  const cutEdgeDragRef = useRef<CutEdgeDragInfo | null>(null);
  const imageEdgeDragRef = useRef<{ pointerId: number; overlayId: string; edge: 'start' | 'end'; otherEdgeTime: number } | null>(null);
  const imageMoveDragRef = useRef<{ pointerId: number; overlayId: string; startClientX: number; originalStartTime: number; originalEndTime: number; isDragging: boolean } | null>(null);
  const clipReorderDragRef = useRef<ClipReorderDragInfo | null>(null);

  const [trackWidth, setTrackWidth] = useState(800);
  const [clipDropIndicator, setClipDropIndicator] = useState<{ xPx: number; targetIndex: number } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ clipId: string; clientX: number; clientY: number; width: number; height: number; waveformSlice: number[] } | null>(null);
  const waveformRef = useRef<number[]>([]);

  const videoDuration = useEditorStore(s => s.videoDuration);
  const zoom = useEditorStore(s => s.zoom);
  const setZoom = useEditorStore(s => s.setZoom);
  const setCurrentTime = useEditorStore(s => s.setCurrentTime);
  const currentTime = useEditorStore(s => s.currentTime);
  const previewSnapshot = useEditorStore(s => s.previewSnapshot);
  const activeReviewSession = useEditorStore(s => s.activeReviewSession);
  const activeReviewFocusItemId = useEditorStore(s => s.activeReviewFocusItemId);
  const liveClips = useEditorStore(s => s.clips);
  const liveCaptions = useEditorStore(s => s.captions);
  const liveTransitions = useEditorStore(s => s.transitions);
  const liveMarkers = useEditorStore(s => s.markers);
  const liveTextOverlays = useEditorStore(s => s.textOverlays);
  const selectedItem = useEditorStore(s => s.selectedItem);
  const setSelectedItem = useEditorStore(s => s.setSelectedItem);
  const splitClipAtTime = useEditorStore(s => s.splitClipAtTime);
  const createMarkerAtTime = useEditorStore(s => s.createMarkerAtTime);
  const requestSeek = useEditorStore(s => s.requestSeek);
  const insertClipFromSource = useEditorStore(s => s.insertClipFromSource);
  const reorderClip = useEditorStore(s => s.reorderClip);
  const liveImageOverlays = useEditorStore(s => s.imageOverlays);
  const sources = useEditorStore(s => s.sources);
  const tracks = useEditorStore(s => s.tracks);
  const addTrack = useEditorStore(s => s.addTrack);
  const removeTrack = useEditorStore(s => s.removeTrack);
  const updateTrack = useEditorStore(s => s.updateTrack);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const reviewPlaybackUsesBase = Boolean(
    activeReviewSession?.items.some((item) => item.action.type === 'delete_range'),
  );
  const timelineSnapshot = activeReviewSession?.baseSnapshot ?? previewSnapshot;
  const playbackSnapshot = reviewPlaybackUsesBase && activeReviewSession
    ? activeReviewSession.baseSnapshot
    : (previewSnapshot ?? {
      clips: liveClips,
      captions: liveCaptions,
      transitions: liveTransitions,
      markers: liveMarkers,
      textOverlays: liveTextOverlays,
      imageOverlays: liveImageOverlays,
    });
  const clips = timelineSnapshot?.clips ?? liveClips;
  const captions = timelineSnapshot?.captions ?? liveCaptions;
  const transitions = timelineSnapshot?.transitions ?? liveTransitions;
  const markers = timelineSnapshot?.markers ?? liveMarkers;
  const textOverlays = timelineSnapshot?.textOverlays ?? liveTextOverlays;
  const imageOverlays = timelineSnapshot?.imageOverlays ?? liveImageOverlays;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key === 'c') {
        e.preventDefault();
        splitClipAtTime(useEditorStore.getState().currentTime);
        return;
      }
      if (key === 'm') {
        e.preventDefault();
        createMarkerAtTime(useEditorStore.getState().currentTime, { createdBy: 'human' });
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createMarkerAtTime, splitClipAtTime]);

  const schedule = buildClipSchedule(clips, transitions);
  const audioTracks = useMemo(
    () => tracks.filter((t) => t.type === 'audio').sort((a, b) => a.order - b.order),
    [tracks],
  );
  const audioTrackSchedules = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildPlainSchedule>>();
    for (const track of audioTracks) {
      const trackClips = clips.filter((c) => c.trackId === track.id);
      map.set(track.id, buildPlainSchedule(trackClips));
    }
    return map;
  }, [audioTracks, clips]);
  const playbackDuration = useMemo(
    () => Math.max(0, getTimelineDuration(playbackSnapshot.clips, playbackSnapshot.transitions)),
    [playbackSnapshot.clips, playbackSnapshot.transitions],
  );
  const mainTrackEnd = useMemo(
    () => (schedule.length > 0 ? schedule[schedule.length - 1].timelineEnd : videoDuration),
    [schedule, videoDuration],
  );
  const contentDuration = useMemo(
    () => (mainTrackEnd > 0 ? mainTrackEnd : videoDuration),
    [mainTrackEnd, videoDuration],
  );
  const RIGHT_PAD = useMemo(
    () => Math.max(30, contentDuration * 0.3),
    [contentDuration],
  );
  const totalTimelineDuration = useMemo(
    () => contentDuration + RIGHT_PAD,
    [RIGHT_PAD, contentDuration],
  );
  const displayedCurrentTime = useMemo(() => {
    if (!activeReviewSession || reviewPlaybackUsesBase) {
      return Math.max(0, Math.min(currentTime, contentDuration));
    }

    const mappedTime = mapTimelineTimeAcrossSnapshots(
      playbackSnapshot.clips,
      clips,
      currentTime,
      playbackSnapshot.transitions,
      transitions,
    );
    if (mappedTime === null) {
      return Math.max(0, Math.min(currentTime, contentDuration));
    }
    return Math.max(0, Math.min(mappedTime, contentDuration));
  }, [
    activeReviewSession,
    clips,
    contentDuration,
    currentTime,
    reviewPlaybackUsesBase,
    playbackSnapshot.clips,
    playbackSnapshot.transitions,
    transitions,
  ]);

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

  const reviewOverlays = useMemo(
    () => (activeReviewSession ? getReviewOverlayDescriptors(activeReviewSession) : []),
    [activeReviewSession],
  );
  const hasCaptions = captions.length > 0 || reviewOverlays.some((overlay) => overlay.kind === 'caption');
  const hasTransitions = transitions.length > 0 || reviewOverlays.some((overlay) => overlay.kind === 'transition');
  const cutReviewOverlays = reviewOverlays.filter((overlay) => overlay.kind === 'cut');
  const hasTextOverlays = textOverlays.length > 0 || reviewOverlays.some((overlay) => overlay.kind === 'text');
  const hasImageOverlays = imageOverlays.length > 0 || reviewOverlays.some((overlay) => overlay.kind === 'image');

  const waveform = useMemo(() => {
    if (videoDuration <= 0) return [];
    const bars = Math.max(100, Math.floor(totalW / 4));
    return generateWaveform(videoDuration, bars);
  }, [videoDuration, totalW]);
  waveformRef.current = waveform;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setTrackWidth(entry.contentRect.width - HEADER_W);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const cursorXInContent = (e.clientX - rect.left - HEADER_W) + el.scrollLeft;
        const cur = useEditorStore.getState().zoom;
        // Proportional zoom: scale smoothly based on delta magnitude
        const sensitivity = 0.005;
        const factor = Math.pow(2, -e.deltaY * sensitivity);
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

  const tPx = useCallback((time: number) => {
    if (totalTimelineDuration <= 0) return 0;
    return (time / totalTimelineDuration) * totalW;
  }, [totalTimelineDuration, totalW]);
  const clipVisualLayout = useMemo(() => buildClipVisualLayouts(schedule, tPx), [schedule, tPx]);
  const TRACK_HEIGHT = BASE_TRACK_HEIGHT + (clipVisualLayout.laneCount - 1) * CLIP_LANE_STEP;
  const audioTrackLayouts = useMemo(() => {
    const map = new Map<string, Map<string, ClipVisualLayout>>();
    for (const [trackId, trackSchedule] of audioTrackSchedules) {
      const { layouts } = buildClipVisualLayouts(trackSchedule, tPx);
      map.set(trackId, new Map(layouts.map((l) => [l.clipId, l])));
    }
    return map;
  }, [audioTrackSchedules, tPx]);

  const pxToTimelineTime = useCallback((clientX: number, containerEl: HTMLDivElement) => {
    const rect = containerEl.getBoundingClientRect();
    const scrollLeft = containerEl.scrollLeft;
    const px = (clientX - rect.left - HEADER_W) + scrollLeft;
    return Math.max(0, Math.min(contentDuration, (px / totalW) * totalTimelineDuration));
  }, [contentDuration, totalTimelineDuration, totalW]);

  const mapDisplayTimeToPlaybackTime = useCallback((displayTime: number) => {
    const currentSession = useEditorStore.getState().activeReviewSession;
    const usesBase = Boolean(currentSession?.items.some((item) => item.action.type === 'delete_range'));
    if (!currentSession || usesBase) {
      return Math.max(0, Math.min(displayTime, playbackDuration || contentDuration));
    }

    const mappedTime = mapTimelineTimeAcrossSnapshots(
      clips,
      playbackSnapshot.clips,
      displayTime,
      transitions,
      playbackSnapshot.transitions,
    );
    if (mappedTime === null) {
      return Math.max(0, Math.min(displayTime, playbackDuration));
    }
    return Math.max(0, Math.min(mappedTime, playbackDuration));
  }, [
    clips,
    contentDuration,
    playbackDuration,
    playbackSnapshot.clips,
    playbackSnapshot.transitions,
    transitions,
  ]);
  const requestDisplaySeek = useCallback((displayTime: number) => {
    requestSeek(mapDisplayTimeToPlaybackTime(displayTime));
  }, [mapDisplayTimeToPlaybackTime, requestSeek]);

  const seekToTimelineTime = useCallback((timelineTime: number) => {
    const nextTime = mapDisplayTimeToPlaybackTime(timelineTime);
    playerRef?.current?.seekTo(nextTime);

    if (!playerRef?.current) {
      setCurrentTime(nextTime);
      const currentState = useEditorStore.getState();
      const currentSchedule = buildClipSchedule(currentState.clips, currentState.transitions);
      const targetEntry = findTimelineEntryAtTime(currentSchedule, nextTime);
      if (targetEntry && videoRef.current) {
        const offsetInTimeline = nextTime - targetEntry.timelineStart;
        const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
        videoRef.current.currentTime = Math.max(0, sourceTime);
      }
    }

    setSelectedItem(null);
  }, [mapDisplayTimeToPlaybackTime, playerRef, setCurrentTime, setSelectedItem, videoRef]);

  const seek = useCallback((clientX: number, containerEl: HTMLDivElement) => {
    if (panRef.current?.moved) return;
    seekToTimelineTime(pxToTimelineTime(clientX, containerEl));
  }, [pxToTimelineTime, seekToTimelineTime]);

  const canHandleTimelineDrop = useCallback((dataTransfer: DataTransfer) => (
    Array.from(dataTransfer.types).includes('application/x-autocut-source-id')
    || Array.from(dataTransfer.types).includes('application/x-autocut-image-source-id')
    || Array.from(dataTransfer.types).includes('Files')
    || dataTransfer.files.length > 0
  ), []);

  const handleTrackDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const container = scrollRef.current;
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();
    const timelineTime = pxToTimelineTime(event.clientX, container);
    const imageSourceId = event.dataTransfer.getData('application/x-autocut-image-source-id');
    if (imageSourceId) {
      useEditorStore.getState().createImageOverlayAtTime(imageSourceId, timelineTime);
      return;
    }
    const sourceId = event.dataTransfer.getData('application/x-autocut-source-id');
    if (sourceId) {
      insertClipFromSource(sourceId, timelineTime);
      return;
    }
    const imageFiles = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length > 0) {
      const file = imageFiles[0];
      const url = URL.createObjectURL(file);
      const store = useEditorStore.getState();
      const addedSources = store.importSources([{
        fileName: file.name,
        duration: 5,
        isPrimary: false,
        status: 'ready',
        runtime: { file, objectUrl: url, playerUrl: url, processingUrl: url },
      }], { shouldAppendClips: false });
      if (addedSources.length > 0) {
        const newSource = addedSources[0];
        store.updateSource(newSource.id, { mediaType: 'image' } as Partial<import('@/lib/types').ProjectSource>);
        store.createImageOverlayAtTime(newSource.id, timelineTime);
      }
      return;
    }
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('video/'));
    if (files.length > 0 && onImportSources) {
      void onImportSources(files, 'insert', timelineTime);
    }
  }, [insertClipFromSource, onImportSources, pxToTimelineTime]);

  const handleTimelineDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canHandleTimelineDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, [canHandleTimelineDrop]);

  const scrubPlayhead = useCallback((clientX: number, dragInfo: PlayheadDragInfo) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rawPx = (clientX - rect.left - HEADER_W) + el.scrollLeft;
    const displayTime = Math.max(0, Math.min(contentDuration, (rawPx / dragInfo.totalW) * dragInfo.totalDuration));
    const nextTime = mapDisplayTimeToPlaybackTime(displayTime);

    playerRef?.current?.seekTo(nextTime);
    if (!playerRef?.current) {
      useEditorStore.getState().setCurrentTime(nextTime);
    }
  }, [contentDuration, mapDisplayTimeToPlaybackTime, playerRef]);

  const beginPlayheadDrag = useCallback((clientX: number, pointerId: number) => {
    const dragInfo = { pointerId, totalW, totalDuration: totalTimelineDuration };
    playheadDragRef.current = dragInfo;
    document.body.style.cursor = 'ew-resize';
    scrubPlayhead(clientX, dragInfo);
  }, [scrubPlayhead, totalTimelineDuration, totalW]);

  const updateCutEdge = useCallback((clientX: number, dragInfo: CutEdgeDragInfo) => {
    const el = scrollRef.current;
    if (!el) return;
    const newTime = pxToTimelineTime(clientX, el);
    const session = useEditorStore.getState().activeReviewSession;
    if (!session) return;

    let clampedTime: number;
    if (dragInfo.edge === 'start') {
      clampedTime = Math.max(0, Math.min(newTime, dragInfo.otherEdgeTime - MIN_CLIP_DURATION_SECONDS));
    } else {
      clampedTime = Math.max(dragInfo.otherEdgeTime + MIN_CLIP_DURATION_SECONDS, Math.min(newTime, contentDuration));
    }

    const patch = dragInfo.edge === 'start'
      ? { deleteStartTime: clampedTime }
      : { deleteEndTime: clampedTime };

    const nextGroup = buildReviewGroupWithUpdatedItems(
      session,
      (items) => items.map((item) =>
        item.id === dragInfo.itemId ? updateReviewItemAction(item, patch) : item
      ),
    );
    useEditorStore.getState().setActiveReviewSession(nextGroup);
  }, [contentDuration, pxToTimelineTime]);

  const beginCutEdgeDrag = useCallback((
    clientX: number,
    pointerId: number,
    itemId: string,
    edge: 'start' | 'end',
    startTime: number,
    endTime: number,
  ) => {
    const dragInfo: CutEdgeDragInfo = {
      pointerId,
      itemId,
      edge,
      totalW,
      totalDuration: totalTimelineDuration,
      otherEdgeTime: edge === 'start' ? endTime : startTime,
    };
    cutEdgeDragRef.current = dragInfo;
    document.body.style.cursor = 'ew-resize';
    useEditorStore.getState().setActiveReviewFocusItemId(itemId);
    updateCutEdge(clientX, dragInfo);
  }, [totalTimelineDuration, totalW, updateCutEdge]);

  const updateImageEdge = useCallback((clientX: number, drag: { overlayId: string; edge: 'start' | 'end'; otherEdgeTime: number }) => {
    const el = scrollRef.current;
    if (!el) return;
    let newTime = pxToTimelineTime(clientX, el);

    // Magnetic snapping to clip boundaries and playhead
    if (totalW > 0 && totalTimelineDuration > 0) {
      const snapThreshold = 8 / totalW * totalTimelineDuration;
      const state = useEditorStore.getState();
      const snapPoints: number[] = [state.currentTime];
      const currentSchedule = buildClipSchedule(state.clips, state.transitions);
      for (const entry of currentSchedule) {
        snapPoints.push(entry.timelineStart);
        snapPoints.push(entry.timelineEnd);
      }
      for (const sp of snapPoints) {
        if (Math.abs(newTime - sp) < snapThreshold) { newTime = sp; break; }
      }
    }

    let clamped: number;
    if (drag.edge === 'start') {
      clamped = Math.max(0, Math.min(newTime, drag.otherEdgeTime - MIN_CLIP_DURATION_SECONDS));
    } else {
      clamped = Math.max(drag.otherEdgeTime + MIN_CLIP_DURATION_SECONDS, Math.min(newTime, contentDuration));
    }
    const patch = drag.edge === 'start' ? { startTime: clamped } : { endTime: clamped };
    useEditorStore.getState().updateImageOverlay(drag.overlayId, patch);
  }, [contentDuration, pxToTimelineTime, totalW, totalTimelineDuration]);

  const beginImageEdgeDrag = useCallback((
    clientX: number,
    pointerId: number,
    overlayId: string,
    edge: 'start' | 'end',
    startTime: number,
    endTime: number,
  ) => {
    const drag = { pointerId, overlayId, edge, otherEdgeTime: edge === 'start' ? endTime : startTime };
    imageEdgeDragRef.current = drag;
    document.body.style.cursor = 'ew-resize';
    updateImageEdge(clientX, drag);
  }, [updateImageEdge]);

  const updateImageMove = useCallback((clientX: number, drag: { overlayId: string; startClientX: number; originalStartTime: number; originalEndTime: number }) => {
    const el = scrollRef.current;
    if (!el) return;
    const duration = drag.originalEndTime - drag.originalStartTime;
    const cursorTime = pxToTimelineTime(clientX, el);
    const startCursorTime = pxToTimelineTime(drag.startClientX, el);
    const timeDelta = cursorTime - startCursorTime;
    let newStart = drag.originalStartTime + timeDelta;
    let newEnd = drag.originalEndTime + timeDelta;

    // Magnetic snapping to clip boundaries and playhead
    if (totalW > 0 && totalTimelineDuration > 0) {
      const snapThreshold = 8 / totalW * totalTimelineDuration;
      const state = useEditorStore.getState();
      const snapPoints: number[] = [state.currentTime];
      const currentSchedule = buildClipSchedule(state.clips, state.transitions);
      for (const entry of currentSchedule) {
        snapPoints.push(entry.timelineStart);
        snapPoints.push(entry.timelineEnd);
      }
      let bestDist = snapThreshold;
      let bestDelta = 0;
      for (const sp of snapPoints) {
        const dStart = Math.abs(newStart - sp);
        if (dStart < bestDist) { bestDist = dStart; bestDelta = sp - newStart; }
        const dEnd = Math.abs(newEnd - sp);
        if (dEnd < bestDist) { bestDist = dEnd; bestDelta = sp - newEnd; }
      }
      if (bestDist < snapThreshold) { newStart += bestDelta; newEnd += bestDelta; }
    }

    if (newStart < 0) { newStart = 0; newEnd = duration; }
    if (newEnd > contentDuration) { newEnd = contentDuration; newStart = contentDuration - duration; }
    useEditorStore.getState().updateImageOverlay(drag.overlayId, { startTime: newStart, endTime: newEnd });
  }, [contentDuration, pxToTimelineTime, totalW, totalTimelineDuration]);

  const beginClipReorderDrag = useCallback((
    e: React.PointerEvent,
    clipId: string,
    clipIndex: number,
    clipWidth: number,
    clipHeight: number,
  ) => {
    if (e.button !== 0) return;
    if (activeReviewSession) return;
    e.stopPropagation();
    e.preventDefault();
    clipReorderDragRef.current = {
      pointerId: e.pointerId,
      clipId,
      sourceClipIndex: clipIndex,
      startClientX: e.clientX,
      startClientY: e.clientY,
      isDragging: false,
      currentDropIndex: null,
      clipWidth,
      clipHeight,
    };
  }, [activeReviewSession]);

  const endInteractions = useCallback((pointerId?: number) => {
    const playheadDrag = playheadDragRef.current;
    if (playheadDrag && (pointerId === undefined || playheadDrag.pointerId === pointerId)) {
      playheadDragRef.current = null;
    }

    const pan = panRef.current;
    if (pan && (pointerId === undefined || pan.pointerId === pointerId)) {
      panRef.current = null;
    }

    const cutEdgeDrag = cutEdgeDragRef.current;
    if (cutEdgeDrag && (pointerId === undefined || cutEdgeDrag.pointerId === pointerId)) {
      cutEdgeDragRef.current = null;
    }

    const imgEdgeDrag = imageEdgeDragRef.current;
    if (imgEdgeDrag && (pointerId === undefined || imgEdgeDrag.pointerId === pointerId)) {
      imageEdgeDragRef.current = null;
    }

    const imgMoveDrag = imageMoveDragRef.current;
    if (imgMoveDrag && (pointerId === undefined || imgMoveDrag.pointerId === pointerId)) {
      imageMoveDragRef.current = null;
    }

    const clipDrag = clipReorderDragRef.current;
    if (clipDrag && (pointerId === undefined || clipDrag.pointerId === pointerId)) {
      if (clipDrag.isDragging && clipDrag.currentDropIndex !== null) {
        let effectiveIndex = clipDrag.currentDropIndex;
        if (clipDrag.sourceClipIndex < effectiveIndex) {
          effectiveIndex -= 1;
        }
        if (effectiveIndex !== clipDrag.sourceClipIndex) {
          reorderClip(clipDrag.clipId, effectiveIndex);
        }
      } else if (!clipDrag.isDragging) {
        setSelectedItem({ type: 'clip', id: clipDrag.clipId });
      }
      clipReorderDragRef.current = null;
      setClipDropIndicator(null);
      setDragGhost(null);
    }

    if (!playheadDragRef.current && !panRef.current && !cutEdgeDragRef.current && !imageEdgeDragRef.current && !imageMoveDragRef.current && !clipReorderDragRef.current) {
      document.body.style.cursor = '';
    }
  }, [reorderClip, setSelectedItem]);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const playheadDrag = playheadDragRef.current;
      if (playheadDrag && playheadDrag.pointerId === e.pointerId) {
        scrubPlayhead(e.clientX, playheadDrag);
        return;
      }

      const cutEdgeDrag = cutEdgeDragRef.current;
      if (cutEdgeDrag && cutEdgeDrag.pointerId === e.pointerId) {
        updateCutEdge(e.clientX, cutEdgeDrag);
        return;
      }

      const imgEdgeDrag = imageEdgeDragRef.current;
      if (imgEdgeDrag && imgEdgeDrag.pointerId === e.pointerId) {
        updateImageEdge(e.clientX, imgEdgeDrag);
        return;
      }

      const imgMoveDrag = imageMoveDragRef.current;
      if (imgMoveDrag && imgMoveDrag.pointerId === e.pointerId) {
        const dx = e.clientX - imgMoveDrag.startClientX;
        if (!imgMoveDrag.isDragging) {
          if (Math.abs(dx) > 5) {
            imgMoveDrag.isDragging = true;
            document.body.style.cursor = 'grabbing';
          } else {
            return;
          }
        }
        updateImageMove(e.clientX, imgMoveDrag);
        return;
      }

      const clipDrag = clipReorderDragRef.current;
      if (clipDrag && clipDrag.pointerId === e.pointerId) {
        const dx = e.clientX - clipDrag.startClientX;
        const dy = e.clientY - clipDrag.startClientY;
        if (!clipDrag.isDragging) {
          if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
            clipDrag.isDragging = true;
            document.body.style.cursor = 'grabbing';
          } else {
            return;
          }
        }
        const el = scrollRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const scrollLeft = el.scrollLeft;
        const timelineX = e.clientX - rect.left + scrollLeft - HEADER_W;
        const currentClips = useEditorStore.getState().clips;
        const currentTransitions = useEditorStore.getState().transitions;
        const currentSchedule = buildClipSchedule(currentClips, currentTransitions);
        const totalDur = currentSchedule.length > 0 ? currentSchedule[currentSchedule.length - 1].timelineEnd : 1;
        const totalPx = trackWidth * (useEditorStore.getState().zoom ?? 1);
        const cursorTime = (timelineX / totalPx) * totalDur;

        let dropIndex = currentSchedule.length;
        for (let i = 0; i < currentSchedule.length; i++) {
          const midpoint = (currentSchedule[i].timelineStart + currentSchedule[i].timelineEnd) / 2;
          if (cursorTime < midpoint) {
            dropIndex = i;
            break;
          }
        }
        clipDrag.currentDropIndex = dropIndex;

        let indicatorTime: number;
        if (dropIndex === 0) {
          indicatorTime = currentSchedule.length > 0 ? currentSchedule[0].timelineStart : 0;
        } else if (dropIndex >= currentSchedule.length) {
          indicatorTime = currentSchedule[currentSchedule.length - 1].timelineEnd;
        } else {
          indicatorTime = currentSchedule[dropIndex].timelineStart;
        }
        const indicatorX = (indicatorTime / totalDur) * totalPx;
        setClipDropIndicator({ xPx: indicatorX, targetIndex: dropIndex });
        const draggedClip = currentClips.find(c => c.id === clipDrag.clipId);
        let waveSlice: number[] = [];
        if (draggedClip) {
          const vd = useEditorStore.getState().videoDuration;
          const wf = waveformRef.current;
          if (draggedClip.sourceId === MAIN_SOURCE_ID && vd > 0 && wf.length > 0) {
            const startFrac = draggedClip.sourceStart / vd;
            const endFrac = (draggedClip.sourceStart + draggedClip.sourceDuration) / vd;
            const startBar = Math.floor(startFrac * wf.length);
            const endBar = Math.ceil(endFrac * wf.length);
            waveSlice = wf.slice(startBar, endBar);
          } else {
            waveSlice = Array.from({ length: 12 }, (_, i) => 0.35 + (i % 5) / 10);
          }
        }
        setDragGhost({
          clipId: clipDrag.clipId,
          clientX: e.clientX,
          clientY: e.clientY,
          width: clipDrag.clipWidth,
          height: clipDrag.clipHeight,
          waveformSlice: waveSlice,
        });
        return;
      }

      const pan = panRef.current;
      if (!pan || pan.pointerId !== e.pointerId) return;
      const dx = e.clientX - pan.startX;
      if (Math.abs(dx) > 4) {
        pan.moved = true;
        const el = scrollRef.current;
        if (el) el.scrollLeft = Math.max(0, pan.startScrollLeft - dx);
      }
    };

    const onPointerEnd = (e: PointerEvent) => {
      endInteractions(e.pointerId);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      endInteractions();
    };
  }, [endInteractions, scrubPlayhead, updateCutEdge, updateImageEdge, updateImageMove]);

  const px = (time: number) => tPx(time);
  const clipLayoutById = useMemo(
    () => new Map(clipVisualLayout.layouts.map((layout) => [layout.clipId, layout])),
    [clipVisualLayout.layouts],
  );
  const hasCutReviewOverlays = cutReviewOverlays.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          flexShrink: 0,
          minHeight: 50,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
          <span
            style={{
              fontSize: 10,
              color: 'var(--fg-muted)',
              fontFamily: 'var(--font-serif)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            Timeline
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <TimelineActionButton
              label="Cut"
              onClick={() => splitClipAtTime(useEditorStore.getState().currentTime)}
              icon={<CutToolIcon />}
            />
            <TimelineActionButton
              label="Text"
              onClick={() => {
                const time = useEditorStore.getState().currentTime;
                useEditorStore.getState().addTextOverlayAtTime(time, 'Text', 5);
              }}
              icon={<TextToolIcon />}
            />
            <TimelineActionButton
              label="Image"
              onClick={() => imageInputRef.current?.click()}
              icon={<ImageToolIcon />}
            />
            <TimelineActionButton
              label="Marker"
              onClick={() => createMarkerAtTime(useEditorStore.getState().currentTime, { createdBy: 'human' })}
              icon={<MarkerToolIcon />}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              onClick={() => setZoom(Math.round((zoom / 1.25) * 100) / 100)}
              style={zoomButtonStyle}
            >
              −
            </button>
            <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-serif)', minWidth: 30, textAlign: 'center' }}>
              {zoom}×
            </span>
            <button
              onClick={() => setZoom(Math.round(zoom * 1.25 * 100) / 100)}
              style={zoomButtonStyle}
            >
              +
            </button>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', display: 'flex', flexDirection: 'row', cursor: 'grab', position: 'relative' }}
        className="no-select"
        onPointerDown={e => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest('.playhead-hitbox, .playhead-dot, .cut-edge-handle, .clip-block, .clip-audio')) return;
          panRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
            moved: false,
          };
          document.body.style.cursor = 'grabbing';
        }}
      >
        <div
          style={{
            width: HEADER_W,
            flexShrink: 0,
            background: 'var(--bg-panel)',
            borderRight: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            position: 'sticky',
            left: 0,
            zIndex: 10,
          }}
        >
          <div style={{ height: RULER_H, borderBottom: '1px solid var(--border)' }} />
          <TrackHeader icon={<VideoIcon />} height={TRACK_HEIGHT} color="var(--blue-clip-hi)" />
          <TrackHeader icon={<AudioIcon />} height={TRACK_HEIGHT} color="var(--blue-clip-hi)" />
          {audioTracks.map((track) => (
            <AudioTrackHeader
              key={track.id}
              track={track}
              height={BASE_TRACK_HEIGHT}
              onToggleMute={() => updateTrack(track.id, { muted: !track.muted })}
              onToggleLock={() => updateTrack(track.id, { locked: !track.locked })}
              onRemove={() => removeTrack(track.id)}
            />
          ))}
          <div
            style={{
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
              color: 'var(--fg-muted)',
              fontSize: 10,
              fontFamily: 'var(--font-serif)',
            }}
            onClick={() => addTrack('audio')}
            title="Add audio track"
          >
            <span style={{ opacity: 0.6 }}>+ Audio</span>
          </div>
          {hasCaptions && <EffectHeader icon={<CaptionIcon />} color="var(--caption-clip)" />}
          {hasTextOverlays && <EffectHeader icon={<TextOverlayIcon />} color="var(--text-clip)" />}
          {hasImageOverlays && <EffectHeader icon={<ImageTrackIcon />} color="rgba(34,197,94,0.8)" />}
          {hasTransitions && <EffectHeader icon={<TransitionIcon />} color="rgba(255,255,255,0.5)" />}
        </div>

        <div
          style={{ position: 'relative', width: totalW, minWidth: '100%', flexShrink: 0 }}
          onDragOver={handleTimelineDragOver}
          onDrop={handleTrackDrop}
        >
          <div
            style={{
              height: RULER_H,
              position: 'relative',
              background: 'var(--bg-elevated)',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
              overflow: 'hidden',
            }}
            onClick={e => {
              const container = scrollRef.current;
              if (container) seek(e.clientX, container);
            }}
          >
            {ticks.map(({ time, major }) => {
              const x = tPx(time);
              return (
                <div key={time} style={{ position: 'absolute', left: x, top: 0 }}>
                  <div
                    style={{
                      width: 1,
                      height: major ? 9 : 4,
                      background: major ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)',
                      marginTop: major ? 6 : 10,
                    }}
                  />
                  {major && (
                    <span
                      style={{
                        position: 'absolute',
                        top: 5,
                        left: 4,
                        fontSize: 9,
                        fontFamily: 'var(--font-serif)',
                        color: 'rgba(255,255,255,0.3)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatRulerLabel(time)}
                    </span>
                  )}
                </div>
              );
            })}
            {markers.map((marker) => {
              const x = tPx(marker.timelineTime);
              const isSelected = selectedItem?.type === 'marker' && selectedItem.id === marker.id;
              return (
                <button
                  key={marker.id}
                  title={`Marker ${marker.number}${marker.label ? ` • ${marker.label}` : ''}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedItem({ type: 'marker', id: marker.id });
                    requestDisplaySeek(marker.timelineTime);
                  }}
                  style={{
                    position: 'absolute',
                    left: x,
                    transform: 'translateX(-50%)',
                    top: 2,
                    width: 18,
                    height: 20,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: isSelected ? '#fef08a' : '#fde68a',
                    cursor: 'pointer',
                    zIndex: 2,
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      clipPath: 'polygon(0 0, 100% 0, 100% 100%, 50% 72%, 0 100%)',
                      border: isSelected ? '1px solid #fef08a' : '1px solid rgba(250,204,21,0.32)',
                      background: isSelected ? 'rgba(250,204,21,0.2)' : 'rgba(250,204,21,0.12)',
                      fontSize: 9,
                      fontWeight: 700,
                      fontFamily: 'var(--font-serif)',
                      lineHeight: 1,
                    }}
                  >
                    {marker.number}
                  </span>
                </button>
              );
            })}
            {reviewOverlays
              .filter((overlay) => overlay.kind === 'marker' && typeof overlay.atTime === 'number')
              .map((overlay) => {
                const isFocused = activeReviewFocusItemId === overlay.itemId;
                return (
                  <div
                    key={overlay.id}
                    style={{
                      position: 'absolute',
                      left: tPx(overlay.atTime!),
                      transform: 'translateX(-50%)',
                      top: 1,
                      width: 14,
                      height: 16,
                      borderRadius: 999,
                      border: isFocused ? '1px solid rgba(250,204,21,0.95)' : '1px dashed rgba(250,204,21,0.55)',
                      background: isFocused ? 'rgba(250,204,21,0.28)' : 'rgba(250,204,21,0.12)',
                      pointerEvents: 'none',
                      zIndex: 1,
                    }}
                  />
                );
              })}
          </div>

          <TrackRow
            height={TRACK_HEIGHT}
            onSeek={e => { const container = scrollRef.current; if (container) seek(e.clientX, container); }}
            onDrop={handleTrackDrop}
            onDragOver={handleTimelineDragOver}
          >
            {hasCutReviewOverlays && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(0,0,0,0.16)',
                  pointerEvents: 'none',
                }}
              />
            )}
            {cutReviewOverlays.map((overlay) => {
              if (overlay.startTime === undefined || overlay.endTime === undefined) return null;
              const isFocused = activeReviewFocusItemId === overlay.itemId;
              const overlayWidth = Math.max(3, px(overlay.endTime) - px(overlay.startTime));
              const HANDLE_W = 14;
              const handleColor = isFocused ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.6)';
              return (
                <div
                  key={overlay.id}
                  style={{
                    position: 'absolute',
                    left: px(overlay.startTime),
                    width: overlayWidth,
                    top: 4,
                    bottom: 4,
                    borderRadius: 4,
                    border: isFocused ? '1px solid rgba(248,113,113,0.95)' : '1px solid rgba(248,113,113,0.45)',
                    background: isFocused
                      ? 'repeating-linear-gradient(135deg, rgba(248,113,113,0.45), rgba(248,113,113,0.45) 6px, rgba(248,113,113,0.18) 6px, rgba(248,113,113,0.18) 12px)'
                      : 'repeating-linear-gradient(135deg, rgba(248,113,113,0.24), rgba(248,113,113,0.24) 6px, rgba(248,113,113,0.1) 6px, rgba(248,113,113,0.1) 12px)',
                    pointerEvents: 'auto',
                    zIndex: isFocused ? 3 : 1,
                    cursor: 'pointer',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    useEditorStore.getState().setActiveReviewFocusItemId(overlay.itemId);
                  }}
                >
                  {/* Left edge handle */}
                  <div
                    className="cut-edge-handle"
                    style={{
                      position: 'absolute',
                      left: -HANDLE_W / 2,
                      top: -2,
                      bottom: -2,
                      width: HANDLE_W,
                      cursor: 'ew-resize',
                      zIndex: 4,
                      touchAction: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      e.preventDefault();
                      beginCutEdgeDrag(e.clientX, e.pointerId, overlay.itemId, 'start', overlay.startTime!, overlay.endTime!);
                    }}
                  >
                    <div style={{
                      width: 5,
                      height: '50%',
                      minHeight: 12,
                      maxHeight: 28,
                      borderRadius: 2,
                      background: handleColor,
                      boxShadow: '0 0 4px rgba(0,0,0,0.5)',
                      transition: 'background 0.15s',
                    }} />
                  </div>
                  {/* Right edge handle */}
                  <div
                    className="cut-edge-handle"
                    style={{
                      position: 'absolute',
                      right: -HANDLE_W / 2,
                      top: -2,
                      bottom: -2,
                      width: HANDLE_W,
                      cursor: 'ew-resize',
                      zIndex: 4,
                      touchAction: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      e.preventDefault();
                      beginCutEdgeDrag(e.clientX, e.pointerId, overlay.itemId, 'end', overlay.startTime!, overlay.endTime!);
                    }}
                  >
                    <div style={{
                      width: 5,
                      height: '50%',
                      minHeight: 12,
                      maxHeight: 28,
                      borderRadius: 2,
                      background: handleColor,
                      boxShadow: '0 0 4px rgba(0,0,0,0.5)',
                      transition: 'background 0.15s',
                    }} />
                  </div>
                </div>
              );
            })}
            {videoDuration > 0 && schedule.map((entry, index) => {
              const clip = clips.find(item => item.id === entry.clipId);
              if (!clip) return null;
              const layout = clipLayoutById.get(entry.clipId);
              if (!layout) return null;
              return (
                <ClipBlock
                  key={clip.id}
                  clip={clip}
                  left={layout.displayLeft}
                  width={layout.displayWidth}
                  top={6 + layout.lane * CLIP_LANE_STEP}
                  height={BASE_TRACK_HEIGHT - 12}
                  isSelected={selectedItem?.type === 'clip' && selectedItem.id === clip.id}
                  isTagged={false}
                  isDragging={clipDropIndicator !== null && clipReorderDragRef.current?.clipId === clip.id}
                  index={index}
                  title={`Clip ${clip.displayNumber ?? (index + 1)} • ${formatTime(entry.timelineStart)} - ${formatTime(entry.timelineEnd)}`}
                  onPointerDown={e => beginClipReorderDrag(e, clip.id, index, layout.displayWidth, BASE_TRACK_HEIGHT - 12)}
                />
              );
            })}
            {clipDropIndicator && (
              <div
                style={{
                  position: 'absolute',
                  left: clipDropIndicator.xPx - 1,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: 'var(--accent)',
                  zIndex: 20,
                  pointerEvents: 'none',
                  borderRadius: 1,
                  boxShadow: '0 0 6px rgba(96,165,250,0.6)',
                }}
              />
            )}
          </TrackRow>

          <TrackRow
            height={TRACK_HEIGHT}
            onSeek={e => { const container = scrollRef.current; if (container) seek(e.clientX, container); }}
            onDrop={handleTrackDrop}
            onDragOver={handleTimelineDragOver}
          >
            {hasCutReviewOverlays && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(0,0,0,0.16)',
                  pointerEvents: 'none',
                }}
              />
            )}
            {cutReviewOverlays.map((overlay) => {
              if (overlay.startTime === undefined || overlay.endTime === undefined) return null;
              const isFocused = activeReviewFocusItemId === overlay.itemId;
              return (
                <div
                  key={`${overlay.id}:audio`}
                  style={{
                    position: 'absolute',
                    left: px(overlay.startTime),
                    width: Math.max(3, px(overlay.endTime) - px(overlay.startTime)),
                    top: 4,
                    bottom: 4,
                    borderRadius: 4,
                    border: isFocused ? '1px solid rgba(248,113,113,0.9)' : '1px solid rgba(248,113,113,0.38)',
                    background: isFocused
                      ? 'repeating-linear-gradient(135deg, rgba(248,113,113,0.42), rgba(248,113,113,0.42) 6px, rgba(248,113,113,0.16) 6px, rgba(248,113,113,0.16) 12px)'
                      : 'repeating-linear-gradient(135deg, rgba(248,113,113,0.22), rgba(248,113,113,0.22) 6px, rgba(248,113,113,0.08) 6px, rgba(248,113,113,0.08) 12px)',
                    pointerEvents: 'none',
                    zIndex: 1,
                  }}
                />
              );
            })}
            {videoDuration > 0 && schedule.map((entry) => {
              const clip = clips.find(item => item.id === entry.clipId);
              if (!clip) return null;
              const layout = clipLayoutById.get(entry.clipId);
              if (!layout) return null;
              const clipWaveform = clip.sourceId === MAIN_SOURCE_ID
                ? (() => {
                    const startFrac = clip.sourceStart / videoDuration;
                    const endFrac = (clip.sourceStart + clip.sourceDuration) / videoDuration;
                    const startBar = Math.floor(startFrac * waveform.length);
                    const endBar = Math.ceil(endFrac * waveform.length);
                    return waveform.slice(startBar, endBar);
                  })()
                : Array.from({ length: Math.max(12, Math.floor(Math.max(24, layout.displayWidth) / 6)) }, (_, index) => (
                    0.35 + ((index % 5) / 10)
                  ));
              const isClipSelected = selectedItem?.type === 'clip' && selectedItem.id === clip.id;
              const isClipDragging = clipDropIndicator !== null && clipReorderDragRef.current?.clipId === clip.id;
              return (
                <div
                  key={clip.id}
                  className="clip-audio"
                  style={{
                    position: 'absolute',
                    left: layout.displayLeft,
                    top: 6 + layout.lane * CLIP_LANE_STEP,
                    width: layout.displayWidth,
                    height: BASE_TRACK_HEIGHT - 12,
                    borderRadius: 4,
                    overflow: 'hidden',
                    background: isClipSelected ? 'rgba(96,165,250,0.18)' : undefined,
                    border: isClipSelected ? '2px solid var(--accent)' : '1px solid rgba(255,255,255,0.06)',
                    cursor: 'grab',
                    touchAction: 'none',
                    boxShadow: isClipSelected ? '0 0 0 1px rgba(96,165,250,0.45), inset 0 0 0 1px rgba(255,255,255,0.08)' : 'none',
                    opacity: isClipDragging ? 0.4 : isClipSelected ? 1 : 0.92,
                  }}
                  title={`Clip ${clip.displayNumber ?? ''} • ${formatTime(entry.timelineStart)} - ${formatTime(entry.timelineEnd)}`}
                  onPointerDown={e => {
                    if (e.button !== 0) return;
                    beginClipReorderDrag(e, clip.id, clips.findIndex(c => c.id === clip.id), layout.displayWidth, BASE_TRACK_HEIGHT - 12);
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      padding: '2px 0',
                    }}
                  >
                    {clipWaveform.map((heightValue, waveformIndex) => (
                      <div key={waveformIndex} className="waveform-bar" style={{ flex: 1, minWidth: 1, height: `${heightValue * 90}%`, opacity: 0.6 }} />
                    ))}
                  </div>
                </div>
              );
            })}
            {clipDropIndicator && (
              <div
                style={{
                  position: 'absolute',
                  left: clipDropIndicator.xPx - 1,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: 'var(--accent)',
                  zIndex: 20,
                  pointerEvents: 'none',
                  borderRadius: 1,
                  boxShadow: '0 0 6px rgba(96,165,250,0.6)',
                }}
              />
            )}
          </TrackRow>

          {/* Background audio tracks */}
          {audioTracks.map((track) => {
            const trackSchedule = audioTrackSchedules.get(track.id) ?? [];
            const layoutMap = audioTrackLayouts.get(track.id);
            return (
              <TrackRow
                key={track.id}
                height={BASE_TRACK_HEIGHT}
                onSeek={e => { const container = scrollRef.current; if (container) seek(e.clientX, container); }}
              >
                {trackSchedule.map((entry) => {
                  const clip = clips.find((c) => c.id === entry.clipId);
                  if (!clip) return null;
                  const layout = layoutMap?.get(entry.clipId);
                  if (!layout) return null;
                  const barCount = Math.max(12, Math.floor(Math.max(24, layout.displayWidth) / 6));
                  const isClipSelected = selectedItem?.type === 'clip' && selectedItem.id === clip.id;
                  return (
                    <div
                      key={clip.id}
                      className="clip-audio"
                      style={{
                        position: 'absolute',
                        left: layout.displayLeft,
                        top: 6,
                        width: layout.displayWidth,
                        height: BASE_TRACK_HEIGHT - 12,
                        borderRadius: 4,
                        overflow: 'hidden',
                        background: isClipSelected ? 'rgba(96,165,250,0.18)' : 'rgba(168,85,247,0.12)',
                        border: isClipSelected ? '2px solid var(--accent)' : '1px solid rgba(168,85,247,0.25)',
                        cursor: track.locked ? 'default' : 'pointer',
                        opacity: track.muted ? 0.4 : 1,
                      }}
                      title={`${track.name} • ${formatTime(entry.timelineStart)} - ${formatTime(entry.timelineEnd)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedItem({ type: 'clip', id: clip.id });
                      }}
                    >
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', padding: '2px 0' }}>
                        {Array.from({ length: barCount }, (_, i) => (
                          <div key={i} className="waveform-bar" style={{ flex: 1, minWidth: 1, height: `${(0.3 + ((i % 7) / 10)) * 90}%`, opacity: 0.5, background: 'rgba(168,85,247,0.6)' }} />
                        ))}
                      </div>
                      {layout.displayWidth > 60 && (
                        <span style={{ position: 'absolute', left: 6, top: 2, fontSize: 9, color: 'rgba(168,85,247,0.8)', fontFamily: 'var(--font-serif)', pointerEvents: 'none' }}>
                          {sources.find((s) => s.id === clip.sourceId)?.fileName ?? 'Audio'}
                        </span>
                      )}
                    </div>
                  );
                })}
              </TrackRow>
            );
          })}

          {/* "+ Audio" button row in content area */}
          <div style={{ height: 28, position: 'relative', borderBottom: '1px solid var(--border)' }} />

          {hasCaptions && (
            <EffectTrackRow height={EFFECT_TRACK_H}>
              {captions.map((caption) => {
                const isSelected = selectedItem?.type === 'caption' && selectedItem.id === caption.id;
                return (
                  <button
                    key={caption.id}
                    type="button"
                    title={caption.text}
                    style={{
                      position: 'absolute',
                      left: px(caption.startTime),
                      width: Math.max(4, px(caption.endTime) - px(caption.startTime)),
                      top: 3,
                      height: EFFECT_TRACK_H - 6,
                      borderRadius: 3,
                      overflow: 'hidden',
                      border: isSelected ? '1.5px solid rgba(255,255,255,0.7)' : '1px solid rgba(255,255,255,0.12)',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '0 5px',
                      cursor: 'pointer',
                      boxSizing: 'border-box',
                      background: 'var(--caption-clip)',
                    }}
                    onClick={e => {
                      e.stopPropagation();
                      setSelectedItem({ type: 'caption', id: caption.id! });
                    }}
                  >
                    <span
                      style={{
                        fontSize: 9,
                        color: 'rgba(0,0,0,0.85)',
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: 'var(--font-serif)',
                      }}
                    >
                      {caption.text}
                    </span>
                  </button>
                );
              })}
              {reviewOverlays
                .filter((overlay) => overlay.kind === 'caption' && overlay.startTime !== undefined && overlay.endTime !== undefined)
                .map((overlay) => {
                  const isFocused = activeReviewFocusItemId === overlay.itemId;
                  return (
                    <div
                      key={overlay.id}
                      style={{
                        position: 'absolute',
                        left: px(overlay.startTime!),
                        width: Math.max(4, px(overlay.endTime!) - px(overlay.startTime!)),
                        top: 3,
                        height: EFFECT_TRACK_H - 6,
                        borderRadius: 3,
                        border: isFocused ? '1.5px solid rgba(255,255,255,0.92)' : '1px dashed rgba(255,255,255,0.5)',
                        background: isFocused ? 'rgba(245,158,11,0.58)' : 'rgba(245,158,11,0.28)',
                        pointerEvents: 'none',
                      }}
                    />
                  );
                })}
            </EffectTrackRow>
          )}

          {hasTextOverlays && (
            <EffectTrackRow height={EFFECT_TRACK_H}>
              {textOverlays.map((overlay) => {
                const isSelected = selectedItem?.type === 'text' && selectedItem.id === overlay.id;
                return (
                  <button
                    key={overlay.id}
                    type="button"
                    title={`${overlay.position}: ${overlay.text}`}
                    style={{
                      position: 'absolute',
                      left: px(overlay.startTime),
                      width: Math.max(4, px(overlay.endTime) - px(overlay.startTime)),
                      top: 3,
                      height: EFFECT_TRACK_H - 6,
                      borderRadius: 3,
                      overflow: 'hidden',
                      border: isSelected ? '1.5px solid rgba(255,255,255,0.7)' : '1px solid rgba(255,255,255,0.12)',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '0 5px',
                      cursor: 'pointer',
                      boxSizing: 'border-box',
                      background: 'var(--text-clip)',
                    }}
                    onClick={e => {
                      e.stopPropagation();
                      setSelectedItem({ type: 'text', id: overlay.id! });
                    }}
                  >
                    <span
                      style={{
                        fontSize: 9,
                        color: 'rgba(255,255,255,0.9)',
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: 'var(--font-serif)',
                      }}
                    >
                      {overlay.text}
                    </span>
                  </button>
                  );
                })}
              {reviewOverlays
                .filter((overlay) => overlay.kind === 'text' && overlay.startTime !== undefined && overlay.endTime !== undefined)
                .map((overlay) => {
                  const isFocused = activeReviewFocusItemId === overlay.itemId;
                  return (
                    <div
                      key={overlay.id}
                      style={{
                        position: 'absolute',
                        left: px(overlay.startTime!),
                        width: Math.max(4, px(overlay.endTime!) - px(overlay.startTime!)),
                        top: 3,
                        height: EFFECT_TRACK_H - 6,
                        borderRadius: 3,
                        border: isFocused ? '1.5px solid rgba(255,255,255,0.92)' : '1px dashed rgba(255,255,255,0.5)',
                        background: isFocused ? 'rgba(139,92,246,0.52)' : 'rgba(139,92,246,0.24)',
                        pointerEvents: 'none',
                      }}
                    />
                  );
                })}
            </EffectTrackRow>
          )}

          {hasImageOverlays && (
            <EffectTrackRow height={EFFECT_TRACK_H}>
              {imageOverlays.map((overlay) => {
                const isSelected = selectedItem?.type === 'image' && selectedItem.id === overlay.id;
                const source = sources.find((s) => s.id === overlay.sourceId);
                const IMG_HANDLE_W = 14;
                return (
                  <div
                    key={overlay.id}
                    style={{
                      position: 'absolute',
                      left: px(overlay.startTime),
                      width: Math.max(4, px(overlay.endTime) - px(overlay.startTime)),
                      top: 3,
                      height: EFFECT_TRACK_H - 6,
                    }}
                  >
                    <button
                      type="button"
                      title={source?.fileName ?? 'Image overlay'}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        borderRadius: 3,
                        overflow: 'hidden',
                        border: isSelected ? '1.5px solid rgba(255,255,255,0.7)' : '1px solid rgba(255,255,255,0.12)',
                        display: 'flex',
                        alignItems: 'center',
                        padding: '0 5px',
                        cursor: 'grab',
                        boxSizing: 'border-box',
                        background: 'rgba(34,197,94,0.6)',
                        touchAction: 'none',
                      }}
                      onClick={e => {
                        e.stopPropagation();
                        if (imageMoveDragRef.current?.isDragging) return;
                        setSelectedItem({ type: 'image', id: overlay.id });
                      }}
                      onPointerDown={e => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        e.preventDefault();
                        setSelectedItem({ type: 'image', id: overlay.id });
                        imageMoveDragRef.current = {
                          pointerId: e.pointerId,
                          overlayId: overlay.id,
                          startClientX: e.clientX,
                          originalStartTime: overlay.startTime,
                          originalEndTime: overlay.endTime,
                          isDragging: false,
                        };
                      }}
                    >
                      <span
                        style={{
                          fontSize: 9,
                          color: 'rgba(255,255,255,0.9)',
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontFamily: 'var(--font-serif)',
                        }}
                      >
                        {source?.fileName ?? 'Image'}
                      </span>
                    </button>
                    <div
                      style={{
                        position: 'absolute',
                        left: -IMG_HANDLE_W / 2,
                        top: -2,
                        bottom: -2,
                        width: IMG_HANDLE_W,
                        cursor: 'ew-resize',
                        zIndex: 4,
                        touchAction: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        e.preventDefault();
                        beginImageEdgeDrag(e.clientX, e.pointerId, overlay.id, 'start', overlay.startTime, overlay.endTime);
                      }}
                    >
                      <div style={{ width: 3, height: '60%', borderRadius: 1.5, background: 'rgba(255,255,255,0.5)' }} />
                    </div>
                    <div
                      style={{
                        position: 'absolute',
                        right: -IMG_HANDLE_W / 2,
                        top: -2,
                        bottom: -2,
                        width: IMG_HANDLE_W,
                        cursor: 'ew-resize',
                        zIndex: 4,
                        touchAction: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        e.preventDefault();
                        beginImageEdgeDrag(e.clientX, e.pointerId, overlay.id, 'end', overlay.startTime, overlay.endTime);
                      }}
                    >
                      <div style={{ width: 3, height: '60%', borderRadius: 1.5, background: 'rgba(255,255,255,0.5)' }} />
                    </div>
                  </div>
                );
              })}
              {reviewOverlays
                .filter((overlay) => overlay.kind === 'image' && overlay.startTime !== undefined && overlay.endTime !== undefined)
                .map((overlay) => {
                  const isFocused = activeReviewFocusItemId === overlay.itemId;
                  return (
                    <div
                      key={overlay.id}
                      style={{
                        position: 'absolute',
                        left: px(overlay.startTime!),
                        width: Math.max(4, px(overlay.endTime!) - px(overlay.startTime!)),
                        top: 3,
                        height: EFFECT_TRACK_H - 6,
                        borderRadius: 3,
                        border: isFocused ? '1.5px solid rgba(255,255,255,0.92)' : '1px dashed rgba(255,255,255,0.5)',
                        background: isFocused ? 'rgba(34,197,94,0.52)' : 'rgba(34,197,94,0.24)',
                        pointerEvents: 'none',
                      }}
                    />
                  );
                })}
            </EffectTrackRow>
          )}

          {hasTransitions && (
            <EffectTrackRow height={EFFECT_TRACK_H}>
              {transitions.map((transition) => {
                const isSelected = selectedItem?.type === 'transition' && selectedItem.id === transition.id;
                return (
                  <button
                    key={transition.id}
                    type="button"
                    title={`${transition.type} (${transition.duration}s)`}
                    style={{
                      position: 'absolute',
                      left: px(transition.atTime) - 8,
                      top: 3,
                      width: 16,
                      height: EFFECT_TRACK_H - 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      zIndex: 2,
                      background: 'transparent',
                      border: 'none',
                    }}
                    onClick={e => {
                      e.stopPropagation();
                      setSelectedItem({ type: 'transition', id: transition.id! });
                    }}
                  >
                    <div
                      style={{
                        width: 10,
                        height: 10,
                        background: isSelected ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.7)',
                        transform: 'rotate(45deg)',
                        borderRadius: 2,
                      }}
                    />
                  </button>
                );
              })}
              {reviewOverlays
                .filter((overlay) => overlay.kind === 'transition' && overlay.atTime !== undefined)
                .map((overlay) => {
                  const isFocused = activeReviewFocusItemId === overlay.itemId;
                  return (
                    <div
                      key={overlay.id}
                      style={{
                        position: 'absolute',
                        left: px(overlay.atTime!) - 8,
                        top: 3,
                        width: 16,
                        height: EFFECT_TRACK_H - 6,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                      }}
                    >
                      <div
                        style={{
                          width: 10,
                          height: 10,
                          transform: 'rotate(45deg)',
                          borderRadius: 2,
                          border: isFocused ? '1px solid rgba(255,255,255,0.95)' : '1px dashed rgba(255,255,255,0.55)',
                          background: isFocused ? 'rgba(255,255,255,0.66)' : 'rgba(255,255,255,0.22)',
                        }}
                      />
                    </div>
                  );
                })}
            </EffectTrackRow>
          )}

          <TimelinePlayheadOverlay
            currentTime={displayedCurrentTime}
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
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          event.target.value = '';
          const url = URL.createObjectURL(file);
          const store = useEditorStore.getState();
          const addedSources = store.importSources([{
            fileName: file.name,
            duration: 5,
            isPrimary: false,
            status: 'ready',
            runtime: { file, objectUrl: url, playerUrl: url, processingUrl: url },
          }], { shouldAppendClips: false });
          if (addedSources.length > 0) {
            const newSource = addedSources[0];
            // Mark as image source
            store.updateSource(newSource.id, { mediaType: 'image' } as Partial<import('@/lib/types').ProjectSource>);
            store.createImageOverlayAtTime(newSource.id, store.currentTime);
          }
        }}
      />
      {dragGhost && (
        <div
          style={{
            position: 'fixed',
            left: dragGhost.clientX - dragGhost.width / 2,
            top: dragGhost.clientY - dragGhost.height / 2,
            width: dragGhost.width,
            pointerEvents: 'none',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {/* Video clip block */}
          <div style={{
            height: dragGhost.height,
            background: 'rgba(59,130,246,0.45)',
            border: '1.5px solid rgba(96,165,250,0.9)',
            borderRadius: 4,
            opacity: 0.9,
            boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            paddingLeft: 10,
          }}>
            <span style={{
              fontSize: 10,
              fontWeight: 500,
              color: 'rgba(255,255,255,0.9)',
              fontFamily: 'var(--font-serif)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {`Clip ${clips.find(c => c.id === dragGhost.clipId)?.displayNumber ?? ''}`}
            </span>
          </div>
          {/* Audio waveform block */}
          <div style={{
            height: dragGhost.height,
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 4,
            overflow: 'hidden',
            opacity: 0.9,
            background: 'rgba(96,165,250,0.12)',
            display: 'flex',
            alignItems: 'center',
            padding: '2px 0',
          }}>
            {dragGhost.waveformSlice.map((h, i) => (
              <div key={i} className="waveform-bar" style={{ flex: 1, minWidth: 1, height: `${h * 90}%`, opacity: 0.6 }} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const zoomButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  background: 'transparent',
  border: '1px solid var(--border)',
  cursor: 'pointer',
  color: 'var(--fg-muted)',
  fontSize: 14,
  lineHeight: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

function TrackRow({ height, onSeek, onDrop, onDragOver, children }: {
  height: number;
  onSeek: (e: React.MouseEvent) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        height,
        position: 'relative',
        background: 'rgba(255,255,255,0.015)',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer',
        overflow: 'hidden',
      }}
      onClick={onSeek}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      {children}
    </div>
  );
}

function EffectTrackRow({ height, children }: { height: number; children: ReactNode }) {
  return (
    <div
      style={{
        height,
        position: 'relative',
        background: 'rgba(255,255,255,0.01)',
        borderBottom: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
}

const TimelinePlayheadOverlay = memo(function TimelinePlayheadOverlay({
  currentTime,
  scrollRef,
  totalTimelineDuration,
  totalW,
  headerWidth,
  rulerHeight,
  playheadDragRef,
  onBeginDrag,
}: {
  currentTime: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  totalTimelineDuration: number;
  totalW: number;
  headerWidth: number;
  rulerHeight: number;
  playheadDragRef: MutableRefObject<PlayheadDragInfo | null>;
  onBeginDrag: (clientX: number, pointerId: number) => void;
}) {
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
          touchAction: 'none',
        }}
        onPointerDown={e => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          onBeginDrag(e.clientX, e.pointerId);
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: playheadX - 1,
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
          left: playheadX,
          transform: 'translateX(-50%)',
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: 'var(--accent)',
          cursor: 'ew-resize',
          zIndex: 16,
          boxShadow: '0 0 0 3px rgba(33,212,255,0.12)',
          pointerEvents: 'none',
        }}
      />
    </>
  );
});

function TrackHeader({ icon, height, color }: {
  icon: ReactNode;
  height: number;
  color: string;
}) {
  return (
    <div style={{
      height,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 12px',
      borderBottom: '1px solid var(--border)',
      color,
    }}>
      {icon}
    </div>
  );
}

function AudioTrackHeader({ track, height, onToggleMute, onToggleLock, onRemove }: {
  track: Track;
  height: number;
  onToggleMute: () => void;
  onToggleLock: () => void;
  onRemove: () => void;
}) {
  return (
    <div style={{
      height,
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '0 6px',
      borderBottom: '1px solid var(--border)',
      color: 'rgba(168,85,247,0.8)',
      fontSize: 9,
      fontFamily: 'var(--font-serif)',
    }}>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {track.name}
      </span>
      <button
        type="button"
        onClick={onToggleMute}
        title={track.muted ? 'Unmute' : 'Mute'}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 2,
          color: track.muted ? 'rgba(248,113,113,0.8)' : 'rgba(255,255,255,0.4)',
          fontSize: 10,
        }}
      >
        {track.muted ? '🔇' : '🔊'}
      </button>
      <button
        type="button"
        onClick={onRemove}
        title="Remove track"
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 2,
          color: 'rgba(255,255,255,0.3)',
          fontSize: 9,
        }}
      >
        ✕
      </button>
    </div>
  );
}

function EffectHeader({ icon, color }: { icon: ReactNode; color: string }) {
  return (
    <div style={{
      height: EFFECT_TRACK_H,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 12px',
      borderBottom: '1px solid var(--border)',
      color,
    }}>
      {icon}
    </div>
  );
}

function TimelineActionButton({ label, onClick, icon }: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        padding: '0 10px',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(255,255,255,0.04)',
        color: 'var(--fg-secondary)',
        cursor: 'pointer',
        fontSize: 11,
        fontFamily: 'var(--font-serif)',
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function VideoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="13" height="14" rx="2" />
      <path d="M16 10l5-3v10l-5-3z" />
    </svg>
  );
}

function AudioIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M11 5L6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 010 7" />
      <path d="M18.5 5.5a9 9 0 010 13" />
    </svg>
  );
}

function CaptionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="M7 15h4" />
      <path d="M13 15h4" />
    </svg>
  );
}

function TransitionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="9" height="16" rx="2" />
      <rect x="13" y="4" width="9" height="16" rx="2" />
      <path d="M11 8l2 4-2 4" />
    </svg>
  );
}

function TextOverlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h12" />
      <path d="M12 4v16" />
      <path d="M8 20h8" />
    </svg>
  );
}

function CutToolIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.12 15.88" />
      <path d="M14.47 14.48L20 20" />
      <path d="M8.12 8.12L12 12" />
    </svg>
  );
}

function MarkerToolIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21l-7-4V5a2 2 0 012-2h10a2 2 0 012 2v12z" />
    </svg>
  );
}

function TextToolIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M6 4h12M12 4v16" />
    </svg>
  );
}

function ImageToolIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8" cy="10" r="2" />
      <path d="M21 15l-5-5-8 8" />
    </svg>
  );
}

function ImageTrackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8" cy="10" r="2" />
      <path d="M21 15l-5-5-8 8" />
    </svg>
  );
}
