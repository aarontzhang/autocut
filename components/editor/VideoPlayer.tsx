'use client';

import { forwardRef, useImperativeHandle, useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { buildClipSchedule } from '@/lib/playbackEngine';
import { TrackClip } from '@/lib/types';

export interface VideoPlayerHandle {
  seekTo: (timelineTime: number) => void;
  togglePlay: () => void;
}

interface VideoPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

const CSS_FILTERS: Record<string, string> = {
  cinematic: 'contrast(1.2) saturate(0.8) brightness(0.95)',
  vintage: 'contrast(1.1) saturate(0.7) sepia(0.3) brightness(1.05)',
  warm: 'saturate(1.2) brightness(1.05) hue-rotate(10deg)',
  cool: 'saturate(1.1) hue-rotate(-10deg)',
  bw: 'grayscale(1)',
  none: '',
};

function fitVideoFrame(
  container: { width: number; height: number },
  video: { width: number; height: number } | null,
) {
  if (!container.width || !container.height || !video?.width || !video.height) {
    return { width: container.width, height: container.height };
  }

  const containerRatio = container.width / container.height;
  const videoRatio = video.width / video.height;

  if (videoRatio > containerRatio) {
    return { width: container.width, height: container.width / videoRatio };
  }

  return { width: container.height * videoRatio, height: container.height };
}

function findActiveTrackClip(clips: TrackClip[], timelineTime: number): TrackClip | null {
  return clips.find(c => {
    const end = c.timelineStart + c.sourceDuration / c.speed;
    return timelineTime >= c.timelineStart && timelineTime < end;
  }) ?? null;
}

function findTimelineEntryAtTime(schedule: ReturnType<typeof buildClipSchedule>, timelineTime: number) {
  let targetEntry = schedule.find(entry => timelineTime >= entry.timelineStart && timelineTime <= entry.timelineEnd);
  if (!targetEntry && schedule.length > 0) targetEntry = schedule[schedule.length - 1];
  return targetEntry ?? null;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(({ videoRef }, ref) => {
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [sourceDimensions, setSourceDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const [isActiveSourceReady, setIsActiveSourceReady] = useState(false);
  const setVideoDuration = useEditorStore(s => s.setVideoDuration);
  const setCurrentTime = useEditorStore(s => s.setCurrentTime);
  const requestedSeekTime = useEditorStore(s => s.requestedSeekTime);
  const clearRequestedSeek = useEditorStore(s => s.clearRequestedSeek);
  const videoUrl = useEditorStore(s => s.videoUrl);
  const currentTime = useEditorStore(s => s.currentTime);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const clips = useEditorStore(s => s.previewSnapshot?.clips ?? s.clips);
  const captions = useEditorStore(s => s.previewSnapshot?.captions ?? s.captions);
  const textOverlays = useEditorStore(s => s.previewSnapshot?.textOverlays ?? s.textOverlays);
  const extraTracks = useEditorStore(s => s.extraTracks);

  const clipsRef = useRef(clips);
  useEffect(() => { clipsRef.current = clips; }, [clips]);

  // Re-seek the video when clips change while paused (e.g. after a delete while paused)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !video.paused || clips.length === 0) return;
    const sched = buildClipSchedule(clips);
    if (sched.length === 0) return;
    const ct = useEditorStore.getState().currentTime;
    const targetEntry = findTimelineEntryAtTime(sched, ct);
    if (!targetEntry) return;
    const offsetInTimeline = Math.max(0, ct - targetEntry.timelineStart);
    const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
    video.currentTime = Math.max(0, sourceTime);
  }, [clips, videoRef]);

  const extraTracksRef = useRef(extraTracks);
  useEffect(() => { extraTracksRef.current = extraTracks; }, [extraTracks]);

  const extraVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const extraAudioRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const extraAudioNodes = useRef<Map<string, { source: MediaElementAudioSourceNode; gain: GainNode }>>(new Map());

  // Multi-source refs
  const sourceVideoMapRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const activeSourceUrlRef = useRef<string>('');
  const [activeSourceUrl, setActiveSourceUrl] = useState('');
  const currentTimeRef = useRef(currentTime);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);

  // Ref for the inner video container div (for ResizeObserver)
  const videoContainerRef = useRef<HTMLDivElement>(null);

  // Track the available preview area so the frame can follow the source aspect ratio.
  useEffect(() => {
    const container = videoContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setContainerSize({ width: container.clientWidth, height: container.clientHeight });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [videoUrl]);

  // Web Audio
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  const setupAudio = useCallback(() => {
    if (!videoRef.current || audioCtxRef.current) return;
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(videoRef.current);
      const gainNode = ctx.createGain();
      source.connect(gainNode);
      gainNode.connect(ctx.destination);
      audioCtxRef.current = ctx;
      gainNodeRef.current = gainNode;
    } catch {
      // AudioContext may fail if already connected
    }
  }, [videoRef]);

  function ensureExtraAudioRouted(trackId: string, el: HTMLVideoElement) {
    const ctx = audioCtxRef.current;
    if (!ctx || extraAudioNodes.current.has(trackId)) return;
    try {
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      source.connect(gain);
      gain.connect(ctx.destination);
      extraAudioNodes.current.set(trackId, { source, gain });
    } catch {}
  }

  // Cleanup stale track audio nodes when tracks are removed
  useEffect(() => {
    const ids = new Set(extraTracks.map(t => t.id));
    for (const [id, nodes] of extraAudioNodes.current) {
      if (!ids.has(id)) {
        nodes.source.disconnect();
        nodes.gain.disconnect();
        extraAudioNodes.current.delete(id);
      }
    }
  }, [extraTracks]);

  // Find active caption and text overlay
  const activeCaption = captions.find(c => currentTime >= c.startTime && currentTime < c.endTime);
  const activeTextOverlays = textOverlays.filter(t => currentTime >= t.startTime && currentTime < t.endTime);

  // Build total timeline duration
  const schedule = buildClipSchedule(clips);
  const totalTimelineDuration = schedule.length > 0 ? schedule[schedule.length - 1].timelineEnd : videoDuration;

  const syncExtraTracks = useCallback((timelineTime: number, mainPaused: boolean) => {
    for (const track of extraTracksRef.current) {
      const map = track.type === 'video' ? extraVideoRefs.current : extraAudioRefs.current;
      const el = map.get(track.id);
      if (!el) continue;
      const activeClip = findActiveTrackClip(track.clips, timelineTime);
      if (!activeClip) {
        if (!el.paused) el.pause();
        continue;
      }
      const targetSrc = activeClip.sourceStart + (timelineTime - activeClip.timelineStart) * activeClip.speed;
      if (Math.abs(el.currentTime - targetSrc) > 0.15) el.currentTime = targetSrc;
      el.playbackRate = activeClip.speed;
      if (el.paused && !mainPaused) el.play().catch(() => {});
    }
  }, []);

  // Apply active clip's CSS filter and speed
  const applyClipEffects = useCallback((sourceTime: number) => {
    const curClips = clipsRef.current;
    const video = videoRef.current;
    if (!video) return;

    let activeClip = null;
    for (const clip of curClips) {
      const clipSource = clip.sourceUrl ?? videoUrl;
      if (clipSource !== (activeSourceUrlRef.current || videoUrl)) continue;
      if (sourceTime >= clip.sourceStart && sourceTime < clip.sourceStart + clip.sourceDuration) {
        activeClip = clip;
        break;
      }
    }
    if (!activeClip && curClips.length > 0) {
      activeClip = curClips[curClips.length - 1];
    }
    if (!activeClip) return;

    if (video.playbackRate !== activeClip.speed) {
      video.playbackRate = activeClip.speed;
    }

    const filterStr = activeClip.filter && activeClip.filter.type !== 'none'
      ? (CSS_FILTERS[activeClip.filter.type] ?? '')
      : '';
    if (video.style.filter !== filterStr) {
      video.style.filter = filterStr;
    }

    if (gainNodeRef.current && audioCtxRef.current) {
      const targetGain = activeClip.volume;
      gainNodeRef.current.gain.setTargetAtTime(targetGain, audioCtxRef.current.currentTime, 0.05);
    }
  }, [videoRef, videoUrl]);

  // Compute unique source URLs across all clips + main videoUrl
  const uniqueSourceUrls = useMemo(() => {
    const urls = new Set<string>();
    if (videoUrl) urls.add(videoUrl);
    for (const clip of clips) {
      if (clip.sourceUrl) urls.add(clip.sourceUrl);
    }
    return [...urls].filter(Boolean);
  }, [clips, videoUrl]);

  const desiredSourceUrl = useMemo(() => {
    const sched = buildClipSchedule(clips);
    const targetEntry = sched.find(entry => currentTime >= entry.timelineStart && currentTime <= entry.timelineEnd) ?? sched[0];
    const targetClip = targetEntry ? clips.find(clip => clip.id === targetEntry.clipId) : null;
    return targetClip?.sourceUrl ?? videoUrl ?? uniqueSourceUrls[0] ?? '';
  }, [clips, currentTime, uniqueSourceUrls, videoUrl]);

  const resolvedActiveSourceUrl = activeSourceUrl && uniqueSourceUrls.includes(activeSourceUrl)
    ? activeSourceUrl
    : '';
  const displaySourceUrl = resolvedActiveSourceUrl || desiredSourceUrl;
  const activeDimensions = sourceDimensions[displaySourceUrl || uniqueSourceUrls[0] || videoUrl] ?? null;
  const videoDisplaySize = useMemo(
    () => fitVideoFrame(containerSize, activeDimensions),
    [activeDimensions, containerSize],
  );

  useEffect(() => {
    const activeEl = displaySourceUrl ? sourceVideoMapRef.current.get(displaySourceUrl) : null;
    if (!activeEl) return;

    const sched = buildClipSchedule(clipsRef.current);
    const targetEntry = findTimelineEntryAtTime(sched, currentTimeRef.current);
    if (!targetEntry) return;

    const targetClip = clipsRef.current.find((clip) => clip.id === targetEntry.clipId);
    const targetSourceUrl = targetClip?.sourceUrl ?? videoUrl;
    if (targetSourceUrl !== displaySourceUrl) return;

    const offsetInTimeline = Math.max(0, currentTimeRef.current - targetEntry.timelineStart);
    const targetSourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
    const wasPlaying = Array.from(sourceVideoMapRef.current.values()).some((el) => !el.paused);

    if (Math.abs(activeEl.currentTime - targetSourceTime) > 1 / 120) {
      activeEl.currentTime = Math.max(0, targetSourceTime);
    }
    if (wasPlaying && activeEl.paused) {
      activeEl.play().catch(() => {});
    }
  }, [displaySourceUrl, uniqueSourceUrls, videoUrl]);

  // Activate a source URL — show its element, hide others, update videoRef
  const activateSource = useCallback((sourceUrl: string) => {
    if (activeSourceUrlRef.current === sourceUrl) return;
    activeSourceUrlRef.current = sourceUrl;
    setActiveSourceUrl(sourceUrl);
    setIsActiveSourceReady(false);
    const el = sourceVideoMapRef.current.get(sourceUrl);
    if (el) (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
  }, [videoRef]);

  // The time update handler (named so it can be passed to each video element)
  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;
    const sourceTime = videoRef.current.currentTime;
    const curClips = clipsRef.current;
    if (curClips.length === 0) {
      if (Math.abs(currentTimeRef.current - sourceTime) > 1 / 240) {
        currentTimeRef.current = sourceTime;
        setCurrentTime(sourceTime);
      }
      syncExtraTracks(sourceTime, videoRef.current.paused);
      return;
    }

    applyClipEffects(sourceTime);

    const curSource = activeSourceUrlRef.current || videoUrl;
    const sched = buildClipSchedule(curClips);

    // Find the schedule entry (from the current source) that contains sourceTime
    let activeEntry: typeof sched[0] | null = null;
    for (const entry of sched) {
      const clip = curClips.find(c => c.id === entry.clipId);
      if (!clip || (clip.sourceUrl ?? videoUrl) !== curSource) continue;
      if (sourceTime >= entry.sourceStart && sourceTime < entry.sourceStart + entry.sourceDuration) {
        activeEntry = entry;
        break;
      }
    }

    if (activeEntry) {
      const timelineTime = activeEntry.timelineStart + (sourceTime - activeEntry.sourceStart) / activeEntry.speed;
      if (Math.abs(currentTimeRef.current - timelineTime) > 1 / 240) {
        currentTimeRef.current = timelineTime;
        setCurrentTime(timelineTime);
      }
      syncExtraTracks(timelineTime, videoRef.current.paused);
      return;
    }

    // Not in any clip from the current source.
    // Find the furthest timelineEnd of current-source clips we've played past.
    let lastSourceTimelineEnd = 0;
    for (const entry of sched) {
      const clip = curClips.find(c => c.id === entry.clipId);
      if (!clip || (clip.sourceUrl ?? videoUrl) !== curSource) continue;
      if (sourceTime >= entry.sourceStart + entry.sourceDuration - 0.05) {
        lastSourceTimelineEnd = Math.max(lastSourceTimelineEnd, entry.timelineEnd);
      }
    }

    // Find the next entry in the full schedule after that point
    const nextEntry = sched.find(e => e.timelineStart >= lastSourceTimelineEnd - 0.01 && e.timelineEnd > lastSourceTimelineEnd);

    if (nextEntry) {
      const nextClip = curClips.find(c => c.id === nextEntry.clipId);
      const nextSource = nextClip?.sourceUrl ?? videoUrl;
      if (nextSource !== curSource) {
        // Switch to the new source
        const wasPlaying = !videoRef.current.paused;
        sourceVideoMapRef.current.get(curSource)?.pause();
        activateSource(nextSource);
        const nextEl = sourceVideoMapRef.current.get(nextSource);
        if (nextEl) {
          nextEl.currentTime = nextEntry.sourceStart;
          if (wasPlaying) nextEl.play().catch(() => {});
        }
        currentTimeRef.current = nextEntry.timelineStart;
        setCurrentTime(nextEntry.timelineStart);
      } else {
        // Same source, gap between clips — jump to next clip's source start
        videoRef.current.currentTime = nextEntry.sourceStart;
      }
      return;
    }

    // Past all clips — end of timeline
    videoRef.current.pause();
    for (const el of sourceVideoMapRef.current.values()) el.pause();
    for (const el of [...extraVideoRefs.current.values(), ...extraAudioRefs.current.values()]) el.pause();
    const lastEntry = sched[sched.length - 1];
    if (lastEntry) {
      const lastClip = curClips.find(c => c.id === lastEntry.clipId);
      const lastSource = lastClip?.sourceUrl ?? videoUrl;
      const lastEl = sourceVideoMapRef.current.get(lastSource);
      if (lastEl) lastEl.currentTime = lastEntry.sourceStart + lastEntry.sourceDuration - 0.001;
    }
    currentTimeRef.current = totalTimelineDuration;
    setCurrentTime(totalTimelineDuration);
  }, [applyClipEffects, videoRef, videoUrl, setCurrentTime, syncExtraTracks, activateSource, totalTimelineDuration]);

  useEffect(() => {
    const activeVideo = videoRef.current;
    if (!activeVideo) return;

    let frameHandle = 0;
    let rafHandle = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (!video) return;
      if (!video.paused && !video.ended && !video.seeking && video.readyState >= 2) {
        handleTimeUpdate();
      }
      schedule();
    };

    const schedule = () => {
      const video = videoRef.current;
      if (!video || cancelled) return;
      if ('requestVideoFrameCallback' in video) {
        frameHandle = (video as HTMLVideoElement & {
          requestVideoFrameCallback: (cb: () => void) => number;
        }).requestVideoFrameCallback(() => tick());
      } else {
        rafHandle = window.requestAnimationFrame(tick);
      }
    };

    schedule();

    return () => {
      cancelled = true;
      if (rafHandle) window.cancelAnimationFrame(rafHandle);
      if (frameHandle && 'cancelVideoFrameCallback' in activeVideo) {
        (activeVideo as HTMLVideoElement & {
          cancelVideoFrameCallback: (handle: number) => void;
        }).cancelVideoFrameCallback(frameHandle);
      }
    };
  }, [activeSourceUrl, handleTimeUpdate, videoRef]);

  const seekToTimelineTime = useCallback((timelineTime: number) => {
    const sched = buildClipSchedule(clipsRef.current);
    const targetEntry = findTimelineEntryAtTime(sched, timelineTime);
    if (!targetEntry) return;

    const clip = clipsRef.current.find(c => c.id === targetEntry.clipId);
    const targetSourceUrl = clip?.sourceUrl ?? videoUrl;
    const activeEl = sourceVideoMapRef.current.get(targetSourceUrl);
    if (!activeEl) return;
    const previousActiveEl = videoRef.current;
    const switchingSource = previousActiveEl !== activeEl;
    const wasPlaying = Array.from(sourceVideoMapRef.current.values()).some(el => !el.paused);
    const offsetInTimeline = timelineTime - targetEntry.timelineStart;
    const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
    const shouldApplySeek =
      switchingSource ||
      activeEl.seeking ||
      Math.abs(activeEl.currentTime - sourceTime) > 1 / 120;

    if (switchingSource) {
      for (const el of sourceVideoMapRef.current.values()) {
        if (!el.paused) el.pause();
      }
      activateSource(targetSourceUrl);
    }

    if (shouldApplySeek) {
      activeEl.currentTime = Math.max(0, sourceTime);
    }
    if (Math.abs(currentTimeRef.current - timelineTime) > 1 / 240) {
      currentTimeRef.current = timelineTime;
      setCurrentTime(timelineTime);
    }
    applyClipEffects(sourceTime);
    syncExtraTracks(timelineTime, !wasPlaying);
    if (switchingSource && wasPlaying) activeEl.play().catch(() => {});

    for (const track of extraTracksRef.current) {
      const map = track.type === 'video' ? extraVideoRefs.current : extraAudioRefs.current;
      const el = map.get(track.id);
      if (!el) continue;
      const activeClip = findActiveTrackClip(track.clips, timelineTime);
      if (activeClip) {
        el.currentTime = activeClip.sourceStart + (timelineTime - activeClip.timelineStart) * activeClip.speed;
      }
    }
  }, [activateSource, applyClipEffects, setCurrentTime, syncExtraTracks, videoRef, videoUrl]);

  useEffect(() => {
    if (requestedSeekTime === null) return;
    const frameId = window.requestAnimationFrame(() => {
      seekToTimelineTime(requestedSeekTime);
      clearRequestedSeek();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [clearRequestedSeek, requestedSeekTime, seekToTimelineTime]);

  useImperativeHandle(ref, () => ({
    seekTo: seekToTimelineTime,
    togglePlay: () => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) {
        setupAudio();
        if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
        video.play().catch(() => {});
        for (const el of [...extraVideoRefs.current.values(), ...extraAudioRefs.current.values()]) {
          if (el.src) el.play().catch(() => {});
        }
      } else {
        for (const el of sourceVideoMapRef.current.values()) el.pause();
        for (const el of [...extraVideoRefs.current.values(), ...extraAudioRefs.current.values()]) {
          el.pause();
        }
      }
    },
  }), [seekToTimelineTime, setupAudio, videoRef]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      setupAudio();
      if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
      video.play().catch(() => {});
      for (const el of [...extraVideoRefs.current.values(), ...extraAudioRefs.current.values()]) {
        if (el.src) el.play().catch(() => {});
      }
    } else {
      for (const el of sourceVideoMapRef.current.values()) el.pause();
      for (const el of [...extraVideoRefs.current.values(), ...extraAudioRefs.current.values()]) {
        el.pause();
      }
    }
  }, [videoRef, setupAudio]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)' }}>
      <div
        ref={videoContainerRef}
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden', padding: 16 }}
      >
        <div
          style={{
            position: 'relative',
            width: Math.max(0, videoDisplaySize.width),
            height: Math.max(0, videoDisplaySize.height),
            maxWidth: '100%',
            maxHeight: '100%',
          }}
        >
          {uniqueSourceUrls.map((srcUrl) => (
            <video
              key={srcUrl}
              ref={el => {
                if (!el) { sourceVideoMapRef.current.delete(srcUrl); return; }
                sourceVideoMapRef.current.set(srcUrl, el);
                if (srcUrl === displaySourceUrl) {
                  activeSourceUrlRef.current = displaySourceUrl;
                  (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
                }
              }}
              src={srcUrl}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                display: srcUrl === displaySourceUrl ? 'block' : 'none',
                visibility: srcUrl === displaySourceUrl ? 'visible' : 'hidden',
                pointerEvents: srcUrl === displaySourceUrl ? 'auto' : 'none',
                cursor: 'pointer',
              }}
              onLoadedMetadata={() => {
                const el = sourceVideoMapRef.current.get(srcUrl);
                if (!el) return;
                setSourceDimensions(prev => (
                  prev[srcUrl]?.width === el.videoWidth && prev[srcUrl]?.height === el.videoHeight
                    ? prev
                    : { ...prev, [srcUrl]: { width: el.videoWidth, height: el.videoHeight } }
                ));
                if (srcUrl === videoUrl) {
                  setVideoDuration(el.duration);
                }
                if (srcUrl === displaySourceUrl) {
                  setIsActiveSourceReady(el.readyState >= 1);
                }
              }}
              onLoadedData={e => {
                if (srcUrl === displaySourceUrl) {
                  setIsActiveSourceReady((e.currentTarget as HTMLVideoElement).readyState >= 2);
                }
              }}
              onCanPlay={e => {
                if (srcUrl === displaySourceUrl) {
                  setIsActiveSourceReady((e.currentTarget as HTMLVideoElement).readyState >= 2);
                }
              }}
              onTimeUpdate={handleTimeUpdate}
              onClick={togglePlay}
              playsInline
              preload="auto"
              crossOrigin="anonymous"
            />
          ))}

          {!isActiveSourceReady && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0,0,0,0.22)',
                pointerEvents: 'none',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'rgba(255,255,255,0.72)' }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,0.16)',
                    borderTopColor: 'var(--accent)',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
                <span style={{ fontSize: 12, fontFamily: 'var(--font-serif)' }}>Loading video...</span>
              </div>
            </div>
          )}

          {/* Extra video track overlays */}
          {extraTracks.filter(t => t.type === 'video').map(track => {
            const activeClip = findActiveTrackClip(track.clips, currentTime);
            return (
              <video
                key={track.id + '-' + (activeClip?.id ?? 'empty')}
                ref={el => {
                  if (el) {
                    extraVideoRefs.current.set(track.id, el);
                    ensureExtraAudioRouted(track.id, el);
                  } else {
                    extraVideoRefs.current.delete(track.id);
                    extraAudioNodes.current.delete(track.id);
                  }
                }}
                src={activeClip?.sourceUrl ?? undefined}
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  objectFit: 'contain',
                  display: activeClip ? 'block' : 'none',
                  pointerEvents: 'none',
                }}
                muted={false}
                playsInline
                preload="auto"
              />
            );
          })}

          {/* Extra audio tracks (hidden video elements for audio mixing) */}
          {extraTracks.filter(t => t.type === 'audio').map(track => {
            const activeClip = findActiveTrackClip(track.clips, currentTime);
            return (
              <video
                key={track.id + '-' + (activeClip?.id ?? 'empty')}
                ref={el => {
                  if (el) {
                    extraAudioRefs.current.set(track.id, el);
                    ensureExtraAudioRouted(track.id, el);
                  } else {
                    extraAudioRefs.current.delete(track.id);
                    extraAudioNodes.current.delete(track.id);
                  }
                }}
                src={activeClip?.sourceUrl ?? undefined}
                style={{ display: 'none' }}
                muted={false}
                playsInline
                preload="auto"
              />
            );
          })}

          {/* Overlays anchored to the actual video frame */}
          {videoDisplaySize.width > 0 && (activeCaption || activeTextOverlays.length > 0) && (
            <div style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
            }}>
              {activeCaption && (
                <div style={{
                  position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
                  maxWidth: '85%', background: 'rgba(0,0,0,0.78)', color: '#fff',
                  fontSize: 18, fontWeight: 700, lineHeight: 1.3, padding: '6px 14px',
                  borderRadius: 5, textAlign: 'center',
                  textShadow: '0 1px 3px rgba(0,0,0,0.5)',
                }}>
                  {activeCaption.text}
                </div>
              )}

              {activeTextOverlays.map(overlay => (
                <div key={overlay.id ?? overlay.text} style={{
                  position: 'absolute',
                  left: '50%',
                  maxWidth: '90%',
                  color: '#fff',
                  fontSize: overlay.fontSize ?? 16,
                  fontWeight: 700,
                  lineHeight: 1.3,
                  textAlign: 'center',
                  textShadow: '0 2px 8px rgba(0,0,0,0.8), 0 1px 2px rgba(0,0,0,0.9)',
                  padding: '4px 12px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  ...(overlay.position === 'top'
                    ? { top: 20, transform: 'translateX(-50%)' }
                    : overlay.position === 'bottom'
                    ? { bottom: 60, transform: 'translateX(-50%)' }
                    : { top: '50%', transform: 'translate(-50%, -50%)' }),
                }}>
                  {overlay.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

VideoPlayer.displayName = 'VideoPlayer';
export default VideoPlayer;
