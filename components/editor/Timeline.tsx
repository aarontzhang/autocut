'use client';

import { memo, useRef, useState, useCallback, useEffect, useMemo } from 'react';
import type { CSSProperties, ReactNode, RefObject, MutableRefObject } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { getRulerTicks, formatTime, formatTimeDetailed, formatTimePrecise, generateWaveform } from '@/lib/timelineUtils';
import { buildClipSchedule, findTimelineEntryAtTime } from '@/lib/playbackEngine';
import ClipBlock from './ClipBlock';
import type { VideoPlayerHandle } from './VideoPlayer';

const BASE_TRACK_HEIGHT = 50;
const EFFECT_TRACK_H = 26;
const HEADER_W = 76;
const RULER_H = 24;

type PlayheadDragInfo = {
  totalW: number;
  totalDuration: number;
};

interface TimelineProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  playerRef?: RefObject<VideoPlayerHandle | null>;
}

export default function Timeline({
  videoRef,
  playerRef,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ startX: number; startScrollLeft: number; moved: boolean } | null>(null);
  const playheadDragRef = useRef<PlayheadDragInfo | null>(null);

  const [trackWidth, setTrackWidth] = useState(800);

  const videoDuration = useEditorStore(s => s.videoDuration);
  const zoom = useEditorStore(s => s.zoom);
  const setZoom = useEditorStore(s => s.setZoom);
  const setCurrentTime = useEditorStore(s => s.setCurrentTime);
  const pendingDeleteRanges = useEditorStore(s => s.pendingDeleteRanges);
  const clips = useEditorStore(s => s.pendingDeleteRanges ? s.clips : (s.previewSnapshot?.clips ?? s.clips));
  const captions = useEditorStore(s => s.pendingDeleteRanges ? s.captions : (s.previewSnapshot?.captions ?? s.captions));
  const transitions = useEditorStore(s => s.pendingDeleteRanges ? s.transitions : (s.previewSnapshot?.transitions ?? s.transitions));
  const markers = useEditorStore(s => s.pendingDeleteRanges ? s.markers : (s.previewSnapshot?.markers ?? s.markers));
  const textOverlays = useEditorStore(s => s.pendingDeleteRanges ? s.textOverlays : (s.previewSnapshot?.textOverlays ?? s.textOverlays));
  const selectedItem = useEditorStore(s => s.selectedItem);
  const taggedMarkerIds = useEditorStore(s => s.taggedMarkerIds);
  const setSelectedItem = useEditorStore(s => s.setSelectedItem);
  const toggleTaggedMarker = useEditorStore(s => s.toggleTaggedMarker);
  const splitClipAtTime = useEditorStore(s => s.splitClipAtTime);
  const createMarkerAtTime = useEditorStore(s => s.createMarkerAtTime);
  const requestSeek = useEditorStore(s => s.requestSeek);

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
  const schedule = buildClipSchedule(clips, transitions);
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
  }, [contentDuration, playerRef, setCurrentTime, setSelectedItem, videoRef]);

  const seek = useCallback((clientX: number, containerEl: HTMLDivElement) => {
    if (panRef.current?.moved) return;
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
    }
  }, [contentDuration, playerRef]);

  const beginPlayheadDrag = useCallback((clientX: number) => {
    const dragInfo = { totalW, totalDuration: totalTimelineDuration };
    playheadDragRef.current = dragInfo;
    document.body.style.cursor = 'ew-resize';
    scrubPlayhead(clientX, dragInfo);
  }, [scrubPlayhead, totalTimelineDuration, totalW]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const playheadDrag = playheadDragRef.current;
      if (playheadDrag) {
        scrubPlayhead(e.clientX, playheadDrag);
        return;
      }

      const pan = panRef.current;
      if (!pan) return;
      const dx = e.clientX - pan.startX;
      if (Math.abs(dx) > 4) {
        pan.moved = true;
        const el = scrollRef.current;
        if (el) el.scrollLeft = Math.max(0, pan.startScrollLeft - dx);
      }
    };

    const onMouseUp = () => {
      if (playheadDragRef.current) {
        playheadDragRef.current = null;
      }
      if (panRef.current) {
        panRef.current = null;
      }
      document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [scrubPlayhead]);

  const px = (time: number) => tPx(time);

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
              label="Add marker"
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
              onClick={() => setZoom(Math.round(zoom * 1.25 * 10) / 10)}
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
        onMouseDown={e => {
          if ((e.target as HTMLElement).closest('.playhead-dot')) return;
          panRef.current = { startX: e.clientX, startScrollLeft: scrollRef.current?.scrollLeft ?? 0, moved: false };
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
                  index={index}
                  onSelect={e => {
                    e.stopPropagation();
                    setSelectedItem({ type: 'clip', id: clip.id });
                  }}
                />
              );
            })}
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
                    width: Math.max(24, clipWidth),
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
            </EffectTrackRow>
          )}

          {pendingDeleteRanges?.ranges.map((range, i) => {
            const left = tPx(range.start);
            const width = Math.max(1, tPx(range.end) - left);
            return (
              <div key={i} style={{
                position: 'absolute',
                left, width,
                top: RULER_H, bottom: 0,
                background: 'rgba(239, 68, 68, 0.25)',
                borderLeft: '1px solid rgba(239, 68, 68, 0.6)',
                borderRight: '1px solid rgba(239, 68, 68, 0.6)',
                zIndex: 8,
                pointerEvents: 'none',
              }} />
            );
          })}
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

function TrackRow({ height, onSeek, children }: {
  height: number;
  onSeek: (e: React.MouseEvent) => void;
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
  scrollRef,
  totalTimelineDuration,
  totalW,
  headerWidth,
  rulerHeight,
  playheadDragRef,
  onBeginDrag,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  totalTimelineDuration: number;
  totalW: number;
  headerWidth: number;
  rulerHeight: number;
  playheadDragRef: MutableRefObject<PlayheadDragInfo | null>;
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
          pointerEvents: 'none',
        }}
      />
    </>
  );
});

function TrackHeader({ icon, label, height, color }: {
  icon: ReactNode;
  label: string;
  height: number;
  color: string;
}) {
  return (
    <div style={{
      height,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '0 12px',
      borderBottom: '1px solid var(--border)',
      color: 'var(--fg-secondary)',
      fontSize: 11,
      fontFamily: 'var(--font-serif)',
    }}>
      <span style={{ color }}>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function EffectHeader({ label, color }: { label: string; color: string }) {
  return (
    <div style={{
      height: EFFECT_TRACK_H,
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      borderBottom: '1px solid var(--border)',
      color,
      fontSize: 10,
      fontFamily: 'var(--font-serif)',
    }}>
      {label}
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
