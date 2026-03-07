'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { timeToPx, pxToTime, getRulerTicks, formatTime, formatTimeDetailed, generateWaveform } from '@/lib/timelineUtils';
import { CaptionEntry, TextOverlayEntry, TransitionEntry } from '@/lib/types';
import { EditSnapshot } from '@/lib/useEditorStore';
import { buildClipSchedule } from '@/lib/playbackEngine';
import ClipBlock from './ClipBlock';

const BASE_TRACK_HEIGHT = 50;
const EFFECT_TRACK_H = 26;
const HEADER_W = 76;
const RULER_H = 24;

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
};

interface TimelineProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

export default function Timeline({ videoRef }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(800);
  const [waveform, setWaveform] = useState<number[]>([]);
  const dragRef = useRef<DragInfo | null>(null);
  const panRef = useRef<{ startX: number; startScrollLeft: number; moved: boolean } | null>(null);
  const playheadDragRef = useRef<{ totalW: number; totalDuration: number } | null>(null);

  const currentTime = useEditorStore(s => s.currentTime);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const zoom = useEditorStore(s => s.zoom);
  const setZoom = useEditorStore(s => s.setZoom);
  const setCurrentTime = useEditorStore(s => s.setCurrentTime);
  const clips = useEditorStore(s => s.clips);
  const captions = useEditorStore(s => s.captions);
  const transitions = useEditorStore(s => s.transitions);
  const textOverlays = useEditorStore(s => s.textOverlays);
  const extraTracks = useEditorStore(s => s.extraTracks);
  const addTrack = useEditorStore(s => s.addTrack);
  const removeTrack = useEditorStore(s => s.removeTrack);
  const addClipToTrack = useEditorStore(s => s.addClipToTrack);
  const moveTrackClip = useEditorStore(s => s.moveTrackClip);
  const trimTrackClip = useEditorStore(s => s.trimTrackClip);
  const removeTrackClip = useEditorStore(s => s.removeTrackClip);
  const videoFile = useEditorStore(s => s.videoFile);
  const selectedItem = useEditorStore(s => s.selectedItem);
  const setSelectedItem = useEditorStore(s => s.setSelectedItem);
  const splitClipAtTime = useEditorStore(s => s.splitClipAtTime);
  const trimClip = useEditorStore(s => s.trimClip);
  const pushHistory = useEditorStore(s => s.pushHistory);

  // Dynamic track height — shrinks as more tracks are added
  const totalMediaTracks = 2 + extraTracks.length; // main video + main audio + extras
  const TRACK_HEIGHT = Math.max(26, Math.round(BASE_TRACK_HEIGHT - (totalMediaTracks - 2) * 5));

  // Build schedule from clips
  const schedule = buildClipSchedule(clips);
  const totalTimelineDuration = schedule.length > 0 ? schedule[schedule.length - 1].timelineEnd : videoDuration;

  const totalW = trackWidth * zoom;
  const ticks = getRulerTicks(totalTimelineDuration, totalW);

  const hasCaptions = captions.length > 0;
  const hasTextOverlays = textOverlays.length > 0;
  const hasTransitions = transitions.length > 0;

  useEffect(() => {
    if (videoDuration > 0) {
      const bars = Math.max(100, Math.floor(totalW / 4));
      setWaveform(generateWaveform(videoDuration, bars));
    }
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

  // Convert timeline time to pixel
  const tPx = useCallback((t: number) => {
    if (totalTimelineDuration <= 0) return 0;
    return (t / totalTimelineDuration) * totalW;
  }, [totalTimelineDuration, totalW]);

  const seek = useCallback((clientX: number, containerEl: HTMLDivElement) => {
    if (panRef.current?.moved) return; // was a pan drag, not a click
    const rect = containerEl.getBoundingClientRect();
    const scrollLeft = containerEl.scrollLeft;
    const px = (clientX - rect.left - HEADER_W) + scrollLeft;
    const t = Math.max(0, Math.min(totalTimelineDuration, (px / totalW) * totalTimelineDuration));
    setCurrentTime(t);
    // Map timeline time back to source for video seeking
    const store = useEditorStore.getState();
    const sched = buildClipSchedule(store.clips);
    if (sched.length > 0) {
      let targetEntry = sched.find(e => t >= e.timelineStart && t <= e.timelineEnd);
      if (!targetEntry) targetEntry = sched[sched.length - 1];
      const offsetInTimeline = t - targetEntry.timelineStart;
      const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
      if (videoRef.current) videoRef.current.currentTime = Math.max(0, sourceTime);
    }
    setSelectedItem(null);
  }, [totalTimelineDuration, totalW, setCurrentTime, videoRef, setSelectedItem]);

  // Auto-scroll playhead into view (suppressed during drag)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || totalTimelineDuration <= 0) return;
    if (playheadDragRef.current) return;
    const playheadX = tPx(currentTime);
    const viewLeft = el.scrollLeft;
    const viewRight = viewLeft + el.clientWidth - HEADER_W;
    const margin = 80;
    if (playheadX < viewLeft + margin || playheadX > viewRight - margin) {
      el.scrollLeft = Math.max(0, playheadX - (el.clientWidth - HEADER_W) / 2);
    }
  }, [currentTime, totalTimelineDuration, tPx]);

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

  const startTrackClipDrag = useCallback((e: React.MouseEvent, trackId: string, clipId: string) => {
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
      type: 'track-clip-move', id: clipId, trackId,
      startX: e.clientX,
      origStart: clip.timelineStart,
      origEnd: clip.timelineStart + clip.sourceDuration / clip.speed,
      snapTotalW: totalW,
      snapDuration: totalTimelineDuration,
      preDragSnap,
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
  const handleTrackFileDrop = useCallback(async (
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
    const dropTime = Math.max(0, (px / totalW) * totalTimelineDuration);

    // Get duration
    const sourceUrl = URL.createObjectURL(file);
    const duration = await new Promise<number>((resolve) => {
      const tmp = document.createElement('video');
      tmp.src = sourceUrl;
      tmp.onloadedmetadata = () => { resolve(tmp.duration); URL.revokeObjectURL(tmp.src); };
      tmp.onerror = () => { resolve(10); URL.revokeObjectURL(tmp.src); };
    });

    addClipToTrack(trackId, {
      sourceUrl,
      sourceName: file.name,
      sourceStart: 0,
      sourceDuration: duration,
      timelineStart: dropTime,
      speed: 1,
      volume: 1,
    });
  }, [totalW, totalTimelineDuration, addClipToTrack]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      // Playhead scrub drag
      const ph = playheadDragRef.current;
      if (ph) {
        const el = scrollRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const scrollLeft = el.scrollLeft;
        const rawPx = (e.clientX - rect.left - HEADER_W) + scrollLeft;
        const t = Math.max(0, Math.min(ph.totalDuration, (rawPx / ph.totalW) * ph.totalDuration));
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

      if (d.type === 'track-clip-move' && d.trackId) {
        const newTimelineStart = d.origStart + timeDelta;
        store.moveTrackClip(d.trackId, d.id, newTimelineStart);
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
  }, []);

  const playheadX = tPx(currentTime);

  // Handle right-click on video track to split at playhead
  const handleVideoTrackContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitClipAtTime(currentTime);
  }, [splitClipAtTime, currentTime]);

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
            background: 'rgba(59,130,246,0.12)',
            border: '1px solid rgba(96,165,250,0.25)',
            color: 'rgba(147,197,253,0.9)',
            fontFamily: 'var(--font-serif)',
          }}>
            {clips.length} clips
          </span>
        )}

        {selectedItem && (
          <span style={{
            fontSize: 10, padding: '1px 7px', borderRadius: 3,
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.5)',
            fontFamily: 'var(--font-serif)',
          }}>
            {selectedItem.type} selected · ⌫ delete
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Add track buttons */}
        <button
          onClick={() => addTrack('video')}
          title="Add video track"
          style={{
            display: 'flex', alignItems: 'center', gap: 3,
            background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(96,165,250,0.25)',
            borderRadius: 4, padding: '2px 7px', cursor: 'pointer',
            fontSize: 10, color: 'rgba(147,197,253,0.8)', fontFamily: 'var(--font-serif)',
          }}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Video
        </button>
        <button
          onClick={() => addTrack('audio')}
          title="Add audio track"
          style={{
            display: 'flex', alignItems: 'center', gap: 3,
            background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)',
            borderRadius: 4, padding: '2px 7px', cursor: 'pointer',
            fontSize: 10, color: 'rgba(110,231,183,0.8)', fontFamily: 'var(--font-serif)',
          }}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Audio
        </button>

        {/* Zoom */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            <line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
          <input
            type="range" min={1} max={20} step={0.5}
            value={zoom}
            onChange={e => setZoom(Number(e.target.value))}
            style={{ width: 72, accentColor: 'var(--accent)', cursor: 'pointer' }}
          />
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
        </div>
      </div>

      {/* Scrollable area */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', display: 'flex', flexDirection: 'row', cursor: 'grab' }}
        className="no-select"
        onMouseDown={e => {
          // Don't start a pan if clicking on a clip/effect block or playhead dot
          if ((e.target as HTMLElement).closest('.clip-block, .clip-caption, .clip-textoverlay, .clip-audio, .playhead-dot')) return;
          panRef.current = { startX: e.clientX, startScrollLeft: scrollRef.current?.scrollLeft ?? 0, moved: false };
          document.body.style.cursor = 'grabbing';
        }}
      >
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
              onRemove={() => removeTrack(track.id)}
            />
          ))}
          <TrackHeader icon={<AudioIcon />} label="A1" height={TRACK_HEIGHT} color="var(--audio-clip-hi)" />
          {extraTracks.filter(t => t.type === 'audio').map(track => (
            <TrackHeader
              key={track.id}
              icon={<AudioIcon />}
              label={track.label}
              height={TRACK_HEIGHT}
              color="var(--audio-clip-hi)"
              onRemove={() => removeTrack(track.id)}
            />
          ))}
          {hasCaptions && <EffectHeader label="CC" color="var(--caption-clip)" />}
          {hasTextOverlays && <EffectHeader label="Text" color="var(--text-clip)" />}
          {hasTransitions && <EffectHeader label="Trans." color="rgba(255,255,255,0.5)" />}
        </div>

        {/* Tracks content */}
        <div style={{ position: 'relative', width: totalW, flexShrink: 0 }}>
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
                      {zoom > 8 ? formatTimeDetailed(time) : formatTime(time)}
                    </span>
                  )}
                </div>
              );
            })}
            <div
              className="playhead-dot"
              style={{
                position: 'absolute', top: 3, left: playheadX - 6,
                width: 12, height: 12, borderRadius: '50%',
                background: 'var(--accent)',
                cursor: 'ew-resize',
                zIndex: 5,
              }}
              onMouseDown={e => {
                e.stopPropagation();
                e.preventDefault();
                playheadDragRef.current = { totalW, totalDuration: totalTimelineDuration };
                document.body.style.cursor = 'ew-resize';
              }}
            />
          </div>

          {/* Video track — clip blocks */}
          <TrackRow height={TRACK_HEIGHT} onSeek={e => { const c = scrollRef.current; if (c) seek(e.clientX, c); }} onContextMenu={handleVideoTrackContextMenu}>
            {videoDuration > 0 && schedule.map((entry, i) => {
              const clip = clips.find(c => c.id === entry.clipId);
              if (!clip) return null;
              const clipLeft = tPx(entry.timelineStart);
              const clipWidth = tPx(entry.timelineEnd) - clipLeft;
              const isSelected = selectedItem?.type === 'clip' && selectedItem.id === clip.id;
              return (
                <ClipBlock
                  key={clip.id}
                  clip={clip}
                  left={clipLeft}
                  width={clipWidth}
                  height={TRACK_HEIGHT}
                  isSelected={isSelected}
                  index={i}
                  onSelect={e => { e.stopPropagation(); setSelectedItem({ type: 'clip', id: clip.id }); }}
                  onMouseDown={e => { e.stopPropagation(); }}
                  onTrimLeftStart={e => startClipTrimLeft(e, clip.id)}
                  onTrimRightStart={e => startClipTrimRight(e, clip.id)}
                />
              );
            })}
            <Playhead x={playheadX} height={TRACK_HEIGHT} />
          </TrackRow>

          {/* Extra video tracks */}
          {extraTracks.filter(t => t.type === 'video').map(track => (
            <ExtraTrackRow
              key={track.id}
              height={TRACK_HEIGHT}
              track={track}
              totalW={totalW}
              totalTimelineDuration={totalTimelineDuration}
              tPx={tPx}
              playheadX={playheadX}
              onDrop={e => handleTrackFileDrop(e, track.id)}
              onClipDrag={(e, clipId) => startTrackClipDrag(e, track.id, clipId)}
              onTrimLeft={(e, clipId) => startTrackClipTrimLeft(e, track.id, clipId)}
              onTrimRight={(e, clipId) => startTrackClipTrimRight(e, track.id, clipId)}
              onRemoveClip={clipId => removeTrackClip(track.id, clipId)}
            />
          ))}

          {/* Audio track */}
          <TrackRow height={TRACK_HEIGHT} onSeek={e => { const c = scrollRef.current; if (c) seek(e.clientX, c); }}>
            {videoDuration > 0 && schedule.map((entry, i) => {
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
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
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
            <Playhead x={playheadX} height={TRACK_HEIGHT} />
          </TrackRow>

          {/* Extra audio tracks */}
          {extraTracks.filter(t => t.type === 'audio').map(track => (
            <ExtraTrackRow
              key={track.id}
              height={TRACK_HEIGHT}
              track={track}
              totalW={totalW}
              totalTimelineDuration={totalTimelineDuration}
              tPx={tPx}
              playheadX={playheadX}
              onDrop={e => handleTrackFileDrop(e, track.id)}
              onClipDrag={(e, clipId) => startTrackClipDrag(e, track.id, clipId)}
              onTrimLeft={(e, clipId) => startTrackClipTrimLeft(e, track.id, clipId)}
              onTrimRight={(e, clipId) => startTrackClipTrimRight(e, track.id, clipId)}
              onRemoveClip={clipId => removeTrackClip(track.id, clipId)}
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
              <Playhead x={playheadX} height={EFFECT_TRACK_H} />
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
              <Playhead x={playheadX} height={EFFECT_TRACK_H} />
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
              <Playhead x={playheadX} height={EFFECT_TRACK_H} />
            </EffectTrackRow>
          )}
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

function Playhead({ x, height }: { x: number; height: number }) {
  return (
    <div style={{
      position: 'absolute', top: 0, left: x,
      width: 1, height,
      background: 'rgba(255,255,255,0.85)',
      zIndex: 4, pointerEvents: 'none',
    }} />
  );
}

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

const EXTRA_CLIP_COLORS = [
  { bg: 'rgba(168,85,247,0.3)', border: 'rgba(192,132,252,0.6)' },
  { bg: 'rgba(236,72,153,0.3)', border: 'rgba(244,114,182,0.6)' },
  { bg: 'rgba(20,184,166,0.3)', border: 'rgba(45,212,191,0.6)' },
  { bg: 'rgba(245,158,11,0.3)', border: 'rgba(251,191,36,0.6)' },
];

function ExtraTrackRow({ height, track, totalW, totalTimelineDuration, tPx, playheadX, onDrop, onClipDrag, onTrimLeft, onTrimRight, onRemoveClip }: {
  height: number;
  track: import('@/lib/types').MediaTrack;
  totalW: number;
  totalTimelineDuration: number;
  tPx: (t: number) => number;
  playheadX: number;
  onDrop: (e: React.DragEvent) => void;
  onClipDrag: (e: React.MouseEvent, clipId: string) => void;
  onTrimLeft: (e: React.MouseEvent, clipId: string) => void;
  onTrimRight: (e: React.MouseEvent, clipId: string) => void;
  onRemoveClip: (clipId: string) => void;
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
      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={e => { setIsDragOver(false); onDrop(e); }}
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
        const color = EXTRA_CLIP_COLORS[i % EXTRA_CLIP_COLORS.length];
        const clipLeft = tPx(clip.timelineStart);
        const clipW = Math.max(HANDLE_W * 2 + 4, tPx(clip.timelineStart + clip.sourceDuration / clip.speed) - clipLeft);
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
              background: color.bg,
              border: `1.5px solid ${color.border}`,
              borderRadius: 4,
              boxSizing: 'border-box',
              cursor: 'grab',
              overflow: 'hidden',
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
      <Playhead x={playheadX} height={height} />
    </div>
  );
}

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
