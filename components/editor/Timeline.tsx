'use client';

import { memo, useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { getRulerTicks, formatTime, formatTimeDetailed, formatTimePrecise, generateWaveform } from '@/lib/timelineUtils';
import type { EditSnapshot } from '@/lib/useEditorStore';
import { buildClipSchedule, findTimelineEntryAtTime } from '@/lib/playbackEngine';
import ClipBlock from './ClipBlock';
import type { VideoPlayerHandle } from './VideoPlayer';
import { useAuth } from '@/components/auth/AuthProvider';
import { uploadProjectMedia } from '@/lib/projectMedia';
import HoverPillIconButton from '@/components/ui/HoverPillIconButton';

const BASE_TRACK_HEIGHT = 50;
const EFFECT_TRACK_H = 26;
const HEADER_W = 76;
const RULER_H = 24;
const CLIP_REORDER_INTENT_PX = 22;

type DragInfo = {
  type: 'clip-move' | 'caption' | 'text' | 'transition';
  id: string;
  startX: number;
  origStart: number;
  origEnd: number;
  totalW: number;
  totalDuration: number;
  preDragSnap: EditSnapshot;
  intentLocked?: boolean;
};

type PlayheadDragInfo = {
  totalW: number;
  totalDuration: number;
};

type ClipMovePreview = {
  clipId: string;
  ghostLeft: number;
  ghostWidth: number;
  insertionLeft: number;
  targetIndex: number;
};

interface TimelineProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playerRef?: React.RefObject<VideoPlayerHandle | null>;
  onImportFile?: (file: File) => void | Promise<void>;
  onStorageUploadError?: (error: unknown) => void;
  onStorageUploadSuccess?: () => void;
}

export default function Timeline({
  videoRef,
  playerRef,
  onImportFile,
  onStorageUploadError,
  onStorageUploadSuccess,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragInfo | null>(null);
  const panRef = useRef<{ startX: number; startScrollLeft: number; moved: boolean } | null>(null);
  const playheadDragRef = useRef<PlayheadDragInfo | null>(null);
  const clipDragJustEnded = useRef(false);

  const [trackWidth, setTrackWidth] = useState(800);
  const [isMainDragOver, setIsMainDragOver] = useState(false);
  const [clipMovePreview, setClipMovePreview] = useState<ClipMovePreview | null>(null);

  const videoDuration = useEditorStore(s => s.videoDuration);
  const zoom = useEditorStore(s => s.zoom);
  const setZoom = useEditorStore(s => s.setZoom);
  const setCurrentTime = useEditorStore(s => s.setCurrentTime);
  const clips = useEditorStore(s => s.previewSnapshot?.clips ?? s.clips);
  const captions = useEditorStore(s => s.previewSnapshot?.captions ?? s.captions);
  const transitions = useEditorStore(s => s.previewSnapshot?.transitions ?? s.transitions);
  const markers = useEditorStore(s => s.previewSnapshot?.markers ?? s.markers);
  const textOverlays = useEditorStore(s => s.previewSnapshot?.textOverlays ?? s.textOverlays);
  const appendVideoToTimeline = useEditorStore(s => s.appendVideoToTimeline);
  const insertVideoIntoTimeline = useEditorStore(s => s.insertVideoIntoTimeline);
  const updateClipSourcePath = useEditorStore(s => s.updateClipSourcePath);
  const reorderClip = useEditorStore(s => s.reorderClip);
  const selectedItem = useEditorStore(s => s.selectedItem);
  const taggedMarkerIds = useEditorStore(s => s.taggedMarkerIds);
  const setSelectedItem = useEditorStore(s => s.setSelectedItem);
  const toggleTaggedMarker = useEditorStore(s => s.toggleTaggedMarker);
  const splitClipAtTime = useEditorStore(s => s.splitClipAtTime);
  const createMarkerAtTime = useEditorStore(s => s.createMarkerAtTime);
  const requestSeek = useEditorStore(s => s.requestSeek);
  const { user } = useAuth();

  const readVideoDuration = useCallback((sourceUrl: string) => (
    new Promise<number>((resolve) => {
      const tmp = document.createElement('video');
      tmp.preload = 'metadata';
      tmp.src = sourceUrl;
      tmp.onloadedmetadata = () => { resolve(tmp.duration); tmp.src = ''; };
      tmp.onerror = () => { resolve(10); tmp.src = ''; };
    })
  ), []);

  const waitForMainTimelineReady = useCallback(() => (
    new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 5000;

      const checkReady = () => {
        const state = useEditorStore.getState();
        if (state.videoUrl && state.videoDuration > 0 && state.clips.length > 0) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        window.setTimeout(checkReady, 50);
      };

      checkReady();
    })
  ), []);

  const insertFilesIntoTimeline = useCallback(async (files: File[], initialDropTime?: number) => {
    const videoFiles = files.filter((file) => file.type.startsWith('video/'));
    if (videoFiles.length === 0) return;
    let filesToInsert = videoFiles;

    if (!useEditorStore.getState().videoUrl) {
      const [firstFile, ...remainingFiles] = videoFiles;
      if (!firstFile) return;

      await onImportFile?.(firstFile);
      if (remainingFiles.length === 0) return;

      const mainTimelineReady = await waitForMainTimelineReady();
      if (!mainTimelineReady) return;
      filesToInsert = remainingFiles;
    }

    const initialSchedule = buildClipSchedule(useEditorStore.getState().clips);
    let nextInsertTime = initialDropTime ?? (
      initialSchedule.length > 0
        ? initialSchedule[initialSchedule.length - 1].timelineEnd
        : useEditorStore.getState().videoDuration
    );
    for (const file of filesToInsert) {
      const sourceUrl = URL.createObjectURL(file);
      const duration = await readVideoDuration(sourceUrl);
      const currentSchedule = buildClipSchedule(useEditorStore.getState().clips);
      const currentTrackEnd = currentSchedule.length > 0
        ? currentSchedule[currentSchedule.length - 1].timelineEnd
        : useEditorStore.getState().videoDuration;
      const clipId = nextInsertTime >= currentTrackEnd - 0.05
        ? appendVideoToTimeline(sourceUrl, file.name, duration)
        : insertVideoIntoTimeline(sourceUrl, file.name, duration, nextInsertTime);

      const { currentProjectId } = useEditorStore.getState();
      if (user && currentProjectId) {
        uploadProjectMedia(file, currentProjectId, 'sources').then((storagePath) => {
          updateClipSourcePath(clipId, storagePath);
          onStorageUploadSuccess?.();
        }).catch((error: Error) => {
          console.warn('Timeline clip upload failed:', error.message);
          onStorageUploadError?.(error);
        });
      }

      nextInsertTime += duration;
    }
  }, [
    appendVideoToTimeline,
    insertVideoIntoTimeline,
    onImportFile,
    onStorageUploadError,
    onStorageUploadSuccess,
    readVideoDuration,
    updateClipSourcePath,
    waitForMainTimelineReady,
    user,
  ]);

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

  const TRACK_HEIGHT = BASE_TRACK_HEIGHT;
  const schedule = buildClipSchedule(clips);
  const mainTrackEnd = schedule.length > 0 ? schedule[schedule.length - 1].timelineEnd : videoDuration;
  const contentDuration = Math.max(mainTrackEnd, videoDuration);
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

  const tPx = useCallback((time: number) => {
    if (totalTimelineDuration <= 0) return 0;
    return (time / totalTimelineDuration) * totalW;
  }, [totalTimelineDuration, totalW]);

  const pxToTimelineTime = useCallback((clientX: number, containerEl: HTMLDivElement) => {
    const rect = containerEl.getBoundingClientRect();
    const scrollLeft = containerEl.scrollLeft;
    const px = (clientX - rect.left - HEADER_W) + scrollLeft;
    return Math.max(0, Math.min(contentDuration, (px / totalW) * totalTimelineDuration));
  }, [contentDuration, totalTimelineDuration, totalW]);

  const seekToTimelineTime = useCallback((timelineTime: number) => {
    const nextTime = Math.max(0, Math.min(contentDuration, timelineTime));
    playerRef?.current?.seekTo(nextTime);

    if (!playerRef?.current) {
      setCurrentTime(nextTime);
      const store = useEditorStore.getState();
      const currentSchedule = buildClipSchedule(store.clips);
      if (currentSchedule.length > 0) {
        const targetEntry = findTimelineEntryAtTime(currentSchedule, nextTime);
        if (!targetEntry) return;
        const offsetInTimeline = nextTime - targetEntry.timelineStart;
        const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, sourceTime);
      }
    }

    setSelectedItem(null);
  }, [contentDuration, playerRef, setCurrentTime, setSelectedItem, videoRef]);

  const seek = useCallback((clientX: number, containerEl: HTMLDivElement) => {
    if (panRef.current?.moved) return;
    if (clipDragJustEnded.current) {
      clipDragJustEnded.current = false;
      return;
    }
    seekToTimelineTime(pxToTimelineTime(clientX, containerEl));
  }, [pxToTimelineTime, seekToTimelineTime]);

  const scrubPlayhead = useCallback((clientX: number, dragInfo: PlayheadDragInfo) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rawPx = (clientX - rect.left - HEADER_W) + el.scrollLeft;
    const nextTime = Math.max(0, Math.min(contentDuration, (rawPx / dragInfo.totalW) * dragInfo.totalDuration));

    playerRef?.current?.seekTo(nextTime);
    if (!playerRef?.current) {
      useEditorStore.getState().setCurrentTime(nextTime);
      const store = useEditorStore.getState();
      const currentSchedule = buildClipSchedule(store.clips);
      if (currentSchedule.length > 0) {
        const targetEntry = findTimelineEntryAtTime(currentSchedule, nextTime);
        if (!targetEntry) return;
        const offsetInTimeline = nextTime - targetEntry.timelineStart;
        const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, sourceTime);
      }
    }
  }, [contentDuration, playerRef, videoRef]);

  const beginPlayheadDrag = useCallback((clientX: number) => {
    const dragInfo = { totalW, totalDuration: totalTimelineDuration };
    playheadDragRef.current = dragInfo;
    document.body.style.cursor = 'ew-resize';
    scrubPlayhead(clientX, dragInfo);
  }, [scrubPlayhead, totalTimelineDuration, totalW]);

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
    dragRef.current = {
      type,
      id,
      startX: e.clientX,
      origStart,
      origEnd,
      totalW,
      totalDuration: totalTimelineDuration,
      preDragSnap: {
        clips: state.clips,
        captions: state.captions,
        transitions: state.transitions,
        markers: state.markers,
        textOverlays: state.textOverlays,
      },
    };
    document.body.style.cursor = 'grabbing';
  }, [setSelectedItem, totalTimelineDuration, totalW]);

  const startClipMove = useCallback((e: React.MouseEvent, clipId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const state = useEditorStore.getState();
    const currentSchedule = buildClipSchedule(state.clips);
    const entry = currentSchedule.find(item => item.clipId === clipId);
    if (!entry) return;
    dragRef.current = {
      type: 'clip-move',
      id: clipId,
      startX: e.clientX,
      origStart: entry.timelineStart,
      origEnd: entry.timelineEnd,
      totalW,
      totalDuration: totalTimelineDuration,
      preDragSnap: {
        clips: state.clips,
        captions: state.captions,
        transitions: state.transitions,
        markers: state.markers,
        textOverlays: state.textOverlays,
      },
      intentLocked: false,
    };
    setClipMovePreview(null);
    setSelectedItem({ type: 'clip', id: clipId });
    document.body.style.cursor = 'grabbing';
  }, [setSelectedItem, totalTimelineDuration, totalW]);

  const buildClipMovePreview = useCallback((drag: DragInfo, currentClips: typeof clips, pxDelta: number): ClipMovePreview | null => {
    if (drag.type !== 'clip-move') return null;

    const currentSchedule = buildClipSchedule(currentClips);
    const draggedEntry = currentSchedule.find((entry) => entry.clipId === drag.id);
    if (!draggedEntry || currentClips.length === 0) return null;

    const ghostLeftOrigin = tPx(draggedEntry.timelineStart);
    const ghostWidth = Math.max(24, tPx(draggedEntry.timelineEnd) - ghostLeftOrigin);
    const ghostLeft = Math.max(0, Math.min(totalW - ghostWidth, ghostLeftOrigin + pxDelta));
    const ghostMidpoint = ghostLeft + ghostWidth / 2;

    const otherEntries = currentSchedule.filter((entry) => entry.clipId !== drag.id);
    let targetIndex = otherEntries.length;
    for (let index = 0; index < otherEntries.length; index += 1) {
      const entry = otherEntries[index];
      const entryMidpoint = (tPx(entry.timelineStart) + tPx(entry.timelineEnd)) / 2;
      if (ghostMidpoint < entryMidpoint) {
        targetIndex = index;
        break;
      }
    }

    const insertionLeft = otherEntries.length === 0
      ? 0
      : targetIndex >= otherEntries.length
        ? tPx(otherEntries[otherEntries.length - 1].timelineEnd)
        : tPx(otherEntries[targetIndex].timelineStart);

    return {
      clipId: drag.id,
      ghostLeft,
      ghostWidth,
      insertionLeft,
      targetIndex: Math.max(0, Math.min(currentClips.length - 1, targetIndex)),
    };
  }, [tPx, totalW]);

  const handleMainFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsMainDragOver(false);

    const el = scrollRef.current;
    let dropTime = useEditorStore.getState().currentTime;
    if (el) {
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left - HEADER_W) + el.scrollLeft;
      dropTime = Math.max(0, (px / totalW) * totalTimelineDuration);
    }

    await insertFilesIntoTimeline(Array.from(e.dataTransfer.files), dropTime);
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const playheadDrag = playheadDragRef.current;
      if (playheadDrag) {
        scrubPlayhead(e.clientX, playheadDrag);
        return;
      }

      const pan = panRef.current;
      if (pan && !dragRef.current) {
        const dx = e.clientX - pan.startX;
        if (Math.abs(dx) > 4) {
          pan.moved = true;
          const el = scrollRef.current;
          if (el) el.scrollLeft = Math.max(0, pan.startScrollLeft - dx);
        }
        return;
      }

      const drag = dragRef.current;
      if (!drag) return;

      const pxDelta = e.clientX - drag.startX;
      const timeDelta = (pxDelta / drag.totalW) * drag.totalDuration;
      const store = useEditorStore.getState();

      if (drag.type === 'clip-move') {
        if (!drag.intentLocked && Math.abs(pxDelta) < CLIP_REORDER_INTENT_PX) {
          return;
        }
        drag.intentLocked = true;
        const preview = buildClipMovePreview(drag, store.clips, pxDelta);
        if (preview) {
          setClipMovePreview((currentPreview) => {
            if (
              currentPreview
              && currentPreview.clipId === preview.clipId
              && currentPreview.targetIndex === preview.targetIndex
              && Math.abs(currentPreview.ghostLeft - preview.ghostLeft) < 0.5
              && Math.abs(currentPreview.insertionLeft - preview.insertionLeft) < 0.5
            ) {
              return currentPreview;
            }
            return preview;
          });
        }
        return;
      }

      if (drag.type === 'transition') {
        const newAt = Math.max(0, Math.min(drag.totalDuration, drag.origStart + timeDelta));
        store.updateTransition(drag.id, { atTime: newAt });
        return;
      }

      const segLen = drag.origEnd - drag.origStart;
      let newStart = drag.origStart + timeDelta;
      let newEnd = drag.origEnd + timeDelta;
      if (newStart < 0) {
        newStart = 0;
        newEnd = segLen;
      }
      if (newEnd > drag.totalDuration) {
        newEnd = drag.totalDuration;
        newStart = Math.max(0, drag.totalDuration - segLen);
      }
      if (drag.type === 'caption') {
        store.updateCaption(drag.id, { startTime: newStart, endTime: newEnd });
      } else if (drag.type === 'text') {
        store.updateTextOverlay(drag.id, { startTime: newStart, endTime: newEnd });
      }
    };

    const onMouseUp = () => {
      if (playheadDragRef.current) {
        playheadDragRef.current = null;
        document.body.style.cursor = '';
        return;
      }

      if (panRef.current) {
        panRef.current = null;
        document.body.style.cursor = '';
      }

      const drag = dragRef.current;
      if (!drag) return;

      if (drag.type === 'clip-move') {
        const currentIndex = useEditorStore.getState().clips.findIndex((clip) => clip.id === drag.id);
        if (clipMovePreview && currentIndex !== -1 && clipMovePreview.targetIndex !== currentIndex) {
          reorderClip(drag.id, clipMovePreview.targetIndex);
          clipDragJustEnded.current = true;
        } else {
          clipDragJustEnded.current = Boolean(drag.intentLocked);
        }
        setClipMovePreview(null);
        dragRef.current = null;
        document.body.style.cursor = '';
        return;
      }

      clipDragJustEnded.current = true;
      useEditorStore.getState().pushHistory(drag.preDragSnap);
      dragRef.current = null;
      document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [buildClipMovePreview, clipMovePreview, reorderClip, scrubPlayhead]);

  const px = (time: number) => tPx(time);
  const activeDragClip = clipMovePreview ? clips.find((clip) => clip.id === clipMovePreview.clipId) ?? null : null;
  const activeDragLabel = activeDragClip?.sourceName || (activeDragClip ? `Clip ${clips.findIndex((clip) => clip.id === activeDragClip.id) + 1}` : null);

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
              label="Cut at playhead"
              onClick={() => splitClipAtTime(useEditorStore.getState().currentTime)}
              icon={<CutToolIcon />}
            />
            <TimelineActionButton
              label="Add marker at playhead"
              onClick={() => createMarkerAtTime(useEditorStore.getState().currentTime, { createdBy: 'human' })}
              icon={<MarkerToolIcon />}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
          <span
            style={{
              fontSize: 10,
              color: 'var(--fg-muted)',
              fontFamily: 'var(--font-serif)',
              whiteSpace: 'nowrap',
            }}
          >
            C to cut. M to add a marker. Drag a clip itself to move it.
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              onClick={() => setZoom(Math.round((zoom / 1.25) * 100) / 100)}
              style={{
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
              }}
            >
              −
            </button>
            <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-serif)', minWidth: 30, textAlign: 'center' }}>
              {zoom}×
            </span>
            <button
              onClick={() => setZoom(Math.round(zoom * 1.25 * 10) / 10)}
              style={{
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
              }}
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
        onMouseDown={e => {
          if ((e.target as HTMLElement).closest('.clip-block, .clip-caption, .clip-textoverlay, .clip-audio, .playhead-dot')) return;
          panRef.current = { startX: e.clientX, startScrollLeft: scrollRef.current?.scrollLeft ?? 0, moved: false };
          document.body.style.cursor = 'grabbing';
        }}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setIsMainDragOver(true); }}
        onDragLeave={e => {
          if (!scrollRef.current?.contains(e.relatedTarget as Node)) {
            setIsMainDragOver(false);
          }
        }}
        onDrop={handleMainFileDrop}
      >
        {isMainDragOver && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 20,
              pointerEvents: 'none',
              border: '2px dashed rgba(255,255,255,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255,255,255,0.03)',
            }}
          >
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-serif)' }}>
              Drop video to insert into the timeline
            </span>
          </div>
        )}

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
          <TrackHeader icon={<VideoIcon />} label="V1" height={TRACK_HEIGHT} color="var(--blue-clip-hi)" />
          <TrackHeader icon={<AudioIcon />} label="A1" height={TRACK_HEIGHT} color="var(--blue-clip-hi)" />
          {hasCaptions && <EffectHeader label="CC" color="var(--caption-clip)" />}
          {hasTextOverlays && <EffectHeader label="Text" color="var(--text-clip)" />}
          {hasTransitions && <EffectHeader label="Trans." color="rgba(255,255,255,0.5)" />}
        </div>

        <div style={{ position: 'relative', width: totalW, minWidth: '100%', flexShrink: 0 }}>
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
              const isTagged = taggedMarkerIds.includes(marker.id);
              return (
                <button
                  key={marker.id}
                  title={`${isTagged ? 'Untag' : 'Tag'} marker ${marker.number}${marker.label ? `: ${marker.label}` : ''}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleTaggedMarker(marker.id);
                    setSelectedItem({ type: 'marker', id: marker.id });
                    requestSeek(marker.timelineTime);
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
                    color: isSelected || isTagged ? '#fef08a' : '#fde68a',
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
                      border: isSelected || isTagged ? '1px solid #fef08a' : '1px solid rgba(250,204,21,0.32)',
                      background: isTagged
                        ? 'rgba(250,204,21,0.34)'
                        : isSelected
                          ? 'rgba(250,204,21,0.2)'
                          : 'rgba(250,204,21,0.12)',
                      boxShadow: isTagged ? '0 0 0 1px rgba(250,204,21,0.22)' : 'none',
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
          </div>

          <TrackRow height={TRACK_HEIGHT} onSeek={e => { const container = scrollRef.current; if (container) seek(e.clientX, container); }}>
            {videoDuration > 0 && schedule.map((entry, index) => {
              const clip = clips.find(item => item.id === entry.clipId);
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
                  isDragging={clipMovePreview?.clipId === clip.id}
                  index={index}
                  onSelect={e => {
                    e.stopPropagation();
                    setSelectedItem({ type: 'clip', id: clip.id });
                  }}
                  onDragStart={e => startClipMove(e, clip.id)}
                />
              );
            })}
            {clipMovePreview && activeDragClip && (
              <>
                <div
                  style={{
                    position: 'absolute',
                    left: Math.max(0, Math.min(totalW - 3, clipMovePreview.insertionLeft - 1.5)),
                    top: 4,
                    bottom: 4,
                    width: 3,
                    borderRadius: 999,
                    background: 'rgba(125,211,252,0.95)',
                    boxShadow: '0 0 0 4px rgba(56,189,248,0.14)',
                    pointerEvents: 'none',
                    zIndex: 6,
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: clipMovePreview.ghostLeft,
                    top: 6,
                    width: clipMovePreview.ghostWidth,
                    height: TRACK_HEIGHT - 12,
                    borderRadius: 6,
                    border: '1.5px solid rgba(125,211,252,0.95)',
                    background: 'linear-gradient(180deg, rgba(96,165,250,0.4), rgba(37,99,235,0.26))',
                    boxShadow: '0 14px 28px rgba(8,15,32,0.34), 0 0 0 1px rgba(255,255,255,0.08) inset',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '0 10px',
                    pointerEvents: 'none',
                    zIndex: 7,
                    cursor: 'grabbing',
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: 'rgba(255,255,255,0.92)',
                      fontFamily: 'var(--font-serif)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {activeDragLabel ?? 'Move clip'}
                  </span>
                </div>
              </>
            )}
          </TrackRow>

          <TrackRow height={TRACK_HEIGHT} onSeek={e => { const container = scrollRef.current; if (container) seek(e.clientX, container); }}>
            {videoDuration > 0 && schedule.map((entry) => {
              const clip = clips.find(item => item.id === entry.clipId);
              if (!clip) return null;
              const clipLeft = tPx(entry.timelineStart);
              const clipWidth = tPx(entry.timelineEnd) - clipLeft;
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
                  onClick={e => {
                    e.stopPropagation();
                    setSelectedItem({ type: 'clip', id: clip.id });
                  }}
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
          </TrackRow>

          {hasCaptions && (
            <EffectTrackRow height={EFFECT_TRACK_H}>
              {captions.map((caption) => {
                const isSelected = selectedItem?.type === 'caption' && selectedItem.id === caption.id;
                return (
                  <div
                    key={caption.id}
                    className="clip-caption"
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
                      cursor: 'grab',
                      boxSizing: 'border-box',
                    }}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => startEffectDrag(e, 'caption', caption.id!, caption.startTime, caption.endTime)}
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
                  </div>
                );
              })}
            </EffectTrackRow>
          )}

          {hasTextOverlays && (
            <EffectTrackRow height={EFFECT_TRACK_H}>
              {textOverlays.map((overlay) => {
                const isSelected = selectedItem?.type === 'text' && selectedItem.id === overlay.id;
                return (
                  <div
                    key={overlay.id}
                    className="clip-textoverlay"
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
                      cursor: 'grab',
                      boxSizing: 'border-box',
                    }}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => startEffectDrag(e, 'text', overlay.id!, overlay.startTime, overlay.endTime)}
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
                  </div>
                );
              })}
            </EffectTrackRow>
          )}

          {hasTransitions && (
            <EffectTrackRow height={EFFECT_TRACK_H}>
              {transitions.map((transition) => {
                const isSelected = selectedItem?.type === 'transition' && selectedItem.id === transition.id;
                return (
                  <div
                    key={transition.id}
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
                      cursor: 'grab',
                      zIndex: 2,
                    }}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => startEffectDrag(e, 'transition', transition.id!, transition.atTime, transition.atTime)}
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

function TrackRow({ height, onSeek, children }: {
  height: number;
  onSeek: (e: React.MouseEvent) => void;
  children: React.ReactNode;
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
    >
      {children}
    </div>
  );
}

function EffectTrackRow({ height, children }: { height: number; children: React.ReactNode }) {
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

function TrackHeader({ icon, label, height, color }: {
  icon: React.ReactNode;
  label: string;
  height: number;
  color: string;
}) {
  return (
    <div
      style={{
        height,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        padding: '0 6px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ color, opacity: 0.85 }}>{icon}</div>
      <span
        style={{
          fontSize: 8,
          fontFamily: 'var(--font-serif)',
          color: 'var(--fg-muted)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
    </div>
  );
}

function TimelineActionButton({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <HoverPillIconButton
      label={label}
      onClick={onClick}
      buttonStyle={{
        width: 32,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
        border: '1px solid var(--border)',
        background: 'rgba(255,255,255,0.03)',
        color: 'var(--fg-secondary)',
        cursor: 'pointer',
      }}
    >
      {icon}
    </HoverPillIconButton>
  );
}

function CutToolIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </svg>
  );
}

function MarkerToolIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 4.5h8a1.5 1.5 0 0 1 1.5 1.5v10.2L12 19.5l-5.5-3.3V6A1.5 1.5 0 0 1 8 4.5Z" />
    </svg>
  );
}

function EffectHeader({ label, color }: { label: string; color: string }) {
  return (
    <div
      style={{
        height: EFFECT_TRACK_H,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span
        style={{
          fontSize: 8,
          fontFamily: 'var(--font-serif)',
          color,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
    </div>
  );
}

function VideoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="6" width="12" height="12" rx="2" />
      <path d="M15.5 10 20 7.5v9l-4.5-2.5" />
    </svg>
  );
}

function AudioIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 14h3l4 4V6L8 10H5Z" />
      <path d="M16 9.5a4.5 4.5 0 0 1 0 5" />
      <path d="M18.5 7a8 8 0 0 1 0 10" />
    </svg>
  );
}
