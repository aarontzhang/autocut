'use client';

import { forwardRef, useImperativeHandle, useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import {
  buildRenderTimeline,
  findRenderEntriesAtTime,
} from '@/lib/playbackEngine';
import { buildCaptionCues, getCaptionCueDisplay } from '@/lib/timelineUtils';
import type { RenderTimelineEntry, ResolvedTransitionBoundary, VideoClip } from '@/lib/types';

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

const END_EPSILON = 0.03;
const SEEK_EPSILON = 1 / 120;
const DRIFT_EPSILON = 1 / 45;

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

function getEntrySourceTime(entry: RenderTimelineEntry, timelineTime: number) {
  const clampedTimelineTime = Math.max(entry.timelineStart, Math.min(timelineTime, entry.timelineEnd));
  return entry.sourceStart + (clampedTimelineTime - entry.timelineStart) * entry.speed;
}

function getTransitionProgress(boundary: ResolvedTransitionBoundary, timelineTime: number) {
  if (boundary.duration <= 0) return 1;
  return Math.max(0, Math.min(1, (timelineTime - boundary.atTime) / boundary.duration));
}

function getTransitionMix(boundary: ResolvedTransitionBoundary, timelineTime: number) {
  const progress = getTransitionProgress(boundary, timelineTime);

  if (boundary.type === 'fade_black') {
    if (progress < 0.5) {
      return {
        outgoingOpacity: 1 - progress * 2,
        incomingOpacity: 0,
        outgoingVolume: 1 - progress * 2,
        incomingVolume: 0,
        blackOpacity: progress * 1.7,
        incomingClipPath: 'inset(0 0 0 0)',
      };
    }
    return {
      outgoingOpacity: 0,
      incomingOpacity: (progress - 0.5) * 2,
      outgoingVolume: 0,
      incomingVolume: (progress - 0.5) * 2,
      blackOpacity: (1 - progress) * 1.7,
      incomingClipPath: 'inset(0 0 0 0)',
    };
  }

  if (boundary.type === 'wipe') {
    return {
      outgoingOpacity: 1,
      incomingOpacity: 1,
      outgoingVolume: 1 - progress,
      incomingVolume: progress,
      blackOpacity: 0,
      incomingClipPath: `inset(0 ${Math.max(0, (1 - progress) * 100)}% 0 0)`,
    };
  }

  if (boundary.type === 'dissolve') {
    const easedIn = Math.pow(progress, 0.85);
    const easedOut = Math.pow(1 - progress, 1.1);
    return {
      outgoingOpacity: easedOut,
      incomingOpacity: easedIn,
      outgoingVolume: Math.max(0, 1 - progress * 1.1),
      incomingVolume: Math.min(1, progress * 1.1),
      blackOpacity: 0,
      incomingClipPath: 'inset(0 0 0 0)',
    };
  }

  return {
    outgoingOpacity: 1 - progress,
    incomingOpacity: progress,
    outgoingVolume: 1 - progress,
    incomingVolume: progress,
    blackOpacity: 0,
    incomingClipPath: 'inset(0 0 0 0)',
  };
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(({ videoRef }, ref) => {
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isVideoReady, setIsVideoReady] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);

  const secondaryVideoRef = useRef<HTMLVideoElement>(null);
  const currentTimeRef = useRef(0);
  const playbackIntentRef = useRef(false);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const pendingDeleteRangesRef = useRef<ReturnType<typeof useEditorStore.getState>['pendingDeleteRanges']>(null);
  const animationFrameRef = useRef<number | null>(null);
  const playbackTickRef = useRef<() => void>(() => {});

  const setVideoDuration = useEditorStore((s) => s.setVideoDuration);
  const setCurrentTime = useEditorStore((s) => s.setCurrentTime);
  const setPlaybackActive = useEditorStore((s) => s.setPlaybackActive);
  const requestedSeekTime = useEditorStore((s) => s.requestedSeekTime);
  const clearRequestedSeek = useEditorStore((s) => s.clearRequestedSeek);
  const videoUrl = useEditorStore((s) => s.videoUrl);
  const currentTime = useEditorStore((s) => s.currentTime);
  const videoDuration = useEditorStore((s) => s.videoDuration);
  const pendingDeleteRanges = useEditorStore((s) => s.pendingDeleteRanges);
  const clips = useEditorStore((s) => (
    s.pendingDeleteRanges ? s.clips : (s.previewSnapshot?.clips ?? s.clips)
  ));
  const manualCaptions = useEditorStore((s) => (
    s.pendingDeleteRanges ? s.captions : (s.previewSnapshot?.captions ?? s.captions)
  ));
  const transitions = useEditorStore((s) => (
    s.pendingDeleteRanges ? s.transitions : (s.previewSnapshot?.transitions ?? s.transitions)
  ));
  const textOverlays = useEditorStore((s) => (
    s.pendingDeleteRanges ? s.textOverlays : (s.previewSnapshot?.textOverlays ?? s.textOverlays)
  ));

  const clipById = useMemo(() => new Map(clips.map((clip) => [clip.id, clip])), [clips]);
  const renderTimeline = useMemo(() => buildRenderTimeline(clips, transitions), [clips, transitions]);
  const totalTimelineDuration = renderTimeline.length > 0
    ? renderTimeline[renderTimeline.length - 1].timelineEnd
    : videoDuration;
  const captionCues = useMemo(
    () => buildCaptionCues(clips, manualCaptions, transitions),
    [clips, manualCaptions, transitions],
  );

  const currentTransition = useMemo(() => {
    const activeEntries = findRenderEntriesAtTime(renderTimeline, currentTime);
    if (activeEntries.length < 2) return null;
    const incomingEntry = activeEntries[1];
    return incomingEntry?.transitionIn ?? null;
  }, [currentTime, renderTimeline]);

  const transitionMix = useMemo(
    () => currentTransition ? getTransitionMix(currentTransition, currentTime) : null,
    [currentTime, currentTransition],
  );

  const activeCaptionCue = captionCues.find((cue) => currentTime >= cue.startTime && currentTime < cue.endTime) ?? null;
  const activeCaption = useMemo(() => {
    if (!captionsEnabled) return null;
    if (activeCaptionCue) {
      return getCaptionCueDisplay(activeCaptionCue, currentTime);
    }
    return null;
  }, [activeCaptionCue, captionsEnabled, currentTime]);
  const activeTextOverlays = textOverlays.filter((overlay) => currentTime >= overlay.startTime && currentTime < overlay.endTime);
  const videoDisplaySize = useMemo(
    () => fitVideoFrame(containerSize, videoDimensions),
    [containerSize, videoDimensions],
  );
  const hasCaptionTrack = captionCues.length > 0;

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    pendingDeleteRangesRef.current = pendingDeleteRanges;
  }, [pendingDeleteRanges]);

  useEffect(() => {
    const container = videoContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setContainerSize({ width: container.clientWidth, height: container.clientHeight });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const applyClipEffects = useCallback((video: HTMLVideoElement, clip: VideoClip, volumeMultiplier = 1) => {
    const filterStr = clip.filter && clip.filter.type !== 'none'
      ? (CSS_FILTERS[clip.filter.type] ?? '')
      : '';
    if (video.style.filter !== filterStr) {
      video.style.filter = filterStr;
    }
    if (video.playbackRate !== clip.speed) {
      video.playbackRate = clip.speed;
    }
    video.volume = Math.max(0, Math.min(1, clip.volume * volumeMultiplier));
  }, []);

  const pauseSecondaryVideo = useCallback(() => {
    const secondaryVideo = secondaryVideoRef.current;
    if (!secondaryVideo) return;
    secondaryVideo.pause();
    secondaryVideo.volume = 0;
  }, []);

  const syncLayers = useCallback((timelineTime: number, options?: { allowPlay?: boolean }) => {
    const primaryVideo = videoRef.current;
    if (!primaryVideo || renderTimeline.length === 0) return;

    const activeEntries = findRenderEntriesAtTime(renderTimeline, timelineTime);
    const primaryEntry = activeEntries[0];
    if (!primaryEntry) return;

    const primaryClip = clipById.get(primaryEntry.clipId);
    if (!primaryClip) return;

    const primarySourceTime = getEntrySourceTime(primaryEntry, timelineTime);
    if (Math.abs(primaryVideo.currentTime - primarySourceTime) > SEEK_EPSILON) {
      primaryVideo.currentTime = Math.max(0, primarySourceTime);
    }

    if (activeEntries.length < 2) {
      applyClipEffects(primaryVideo, primaryClip, 1);
      pauseSecondaryVideo();
      return;
    }

    const incomingEntry = activeEntries[1];
    const boundary = incomingEntry?.transitionIn;
    const incomingClip = incomingEntry ? clipById.get(incomingEntry.clipId) : null;
    const secondaryVideo = secondaryVideoRef.current;

    if (!boundary || !incomingEntry || !incomingClip || !secondaryVideo) {
      applyClipEffects(primaryVideo, primaryClip, 1);
      pauseSecondaryVideo();
      return;
    }

    const incomingSourceTime = getEntrySourceTime(incomingEntry, timelineTime);
    if (Math.abs(secondaryVideo.currentTime - incomingSourceTime) > DRIFT_EPSILON) {
      secondaryVideo.currentTime = Math.max(0, incomingSourceTime);
    }

    const mix = getTransitionMix(boundary, timelineTime);
    applyClipEffects(primaryVideo, primaryClip, mix.outgoingVolume);
    applyClipEffects(secondaryVideo, incomingClip, mix.incomingVolume);

    if (options?.allowPlay && playbackIntentRef.current) {
      if (primaryVideo.paused) {
        primaryVideo.play().catch(() => {});
      }
      if (secondaryVideo.paused) {
        secondaryVideo.play().catch(() => {});
      }
    } else {
      secondaryVideo.pause();
    }
  }, [applyClipEffects, clipById, pauseSecondaryVideo, renderTimeline, videoRef]);

  const seekToTimelineTime = useCallback((timelineTime: number) => {
    if (renderTimeline.length === 0) return;
    const clampedTimelineTime = Math.max(0, Math.min(totalTimelineDuration, timelineTime));
    currentTimeRef.current = clampedTimelineTime;
    setCurrentTime(clampedTimelineTime);
    syncLayers(clampedTimelineTime, { allowPlay: false });
  }, [renderTimeline.length, setCurrentTime, syncLayers, totalTimelineDuration]);

  const handlePlaybackTick = useCallback(() => {
    const primaryVideo = videoRef.current;
    if (!primaryVideo || renderTimeline.length === 0) return;

    const activeEntries = findRenderEntriesAtTime(renderTimeline, currentTimeRef.current);
    const primaryEntry = activeEntries[0] ?? renderTimeline[0];
    const primaryIndex = renderTimeline.findIndex((entry) => entry.clipId === primaryEntry.clipId);
    const nextEntry = activeEntries.find((entry) => entry.clipId !== primaryEntry.clipId)
      ?? (primaryIndex >= 0 ? renderTimeline[primaryIndex + 1] ?? null : null);
    const sourceTime = primaryVideo.currentTime;
    const entrySourceEnd = primaryEntry.sourceStart + primaryEntry.sourceDuration;

    if (sourceTime < entrySourceEnd - END_EPSILON) {
      const timelineTime = Math.max(
        primaryEntry.timelineStart,
        Math.min(primaryEntry.timelineEnd, primaryEntry.timelineStart + (sourceTime - primaryEntry.sourceStart) / primaryEntry.speed),
      );
      if (Math.abs(currentTimeRef.current - timelineTime) > 1 / 240) {
        currentTimeRef.current = timelineTime;
        setCurrentTime(timelineTime);
      }
      syncLayers(timelineTime, { allowPlay: true });

      const pending = pendingDeleteRangesRef.current;
      if (pending && pending.ranges.length > 0) {
        const sorted = [...pending.ranges].sort((a, b) => a.start - b.start);
        let skipEnd: number | null = null;
        for (const range of sorted) {
          if (timelineTime >= range.start && timelineTime < range.end) {
            skipEnd = range.end;
          } else if (skipEnd !== null && range.start <= skipEnd) {
            skipEnd = Math.max(skipEnd, range.end);
          }
        }
        if (skipEnd !== null) {
          seekToTimelineTime(skipEnd);
          return;
        }
      }
    } else if (nextEntry) {
      const handoffTime = Math.max(nextEntry.timelineStart, Math.min(primaryEntry.timelineEnd, currentTimeRef.current));
      currentTimeRef.current = handoffTime;
      setCurrentTime(handoffTime);
      const nextSourceTime = getEntrySourceTime(nextEntry, handoffTime);
      primaryVideo.currentTime = Math.max(0, nextSourceTime);
      syncLayers(handoffTime, { allowPlay: true });
      if (playbackIntentRef.current && primaryVideo.paused) {
        primaryVideo.play().catch(() => {});
      }
    } else {
      playbackIntentRef.current = false;
      primaryVideo.pause();
      pauseSecondaryVideo();
      currentTimeRef.current = totalTimelineDuration;
      setCurrentTime(totalTimelineDuration);
    }

    if (!primaryVideo.paused && !primaryVideo.ended) {
      animationFrameRef.current = window.requestAnimationFrame(() => playbackTickRef.current());
    }
  }, [pauseSecondaryVideo, renderTimeline, seekToTimelineTime, setCurrentTime, syncLayers, totalTimelineDuration, videoRef]);

  useEffect(() => {
    playbackTickRef.current = handlePlaybackTick;
  }, [handlePlaybackTick]);

  useEffect(() => {
    const primaryVideo = videoRef.current;
    if (!primaryVideo) return;

    const syncPlaybackState = () => {
      const isPlaying = !primaryVideo.paused && !primaryVideo.ended;
      setPlaybackActive(isPlaying);
      if (isPlaying) {
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
        }
        animationFrameRef.current = window.requestAnimationFrame(() => playbackTickRef.current());
      } else if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };

    syncPlaybackState();
    primaryVideo.addEventListener('play', syncPlaybackState);
    primaryVideo.addEventListener('pause', syncPlaybackState);
    primaryVideo.addEventListener('ended', syncPlaybackState);

    return () => {
      primaryVideo.removeEventListener('play', syncPlaybackState);
      primaryVideo.removeEventListener('pause', syncPlaybackState);
      primaryVideo.removeEventListener('ended', syncPlaybackState);
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      pauseSecondaryVideo();
      setPlaybackActive(false);
    };
  }, [handlePlaybackTick, pauseSecondaryVideo, setPlaybackActive, videoRef]);

  useEffect(() => {
    const primaryVideo = videoRef.current;
    if (!primaryVideo || !primaryVideo.paused || renderTimeline.length === 0) return;
    seekToTimelineTime(currentTimeRef.current);
  }, [renderTimeline, seekToTimelineTime, videoRef]);

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
      const primaryVideo = videoRef.current;
      if (!primaryVideo) return;
      if (primaryVideo.paused) {
        playbackIntentRef.current = true;
        syncLayers(currentTimeRef.current, { allowPlay: true });
        primaryVideo.play().catch(() => {});
      } else {
        playbackIntentRef.current = false;
        primaryVideo.pause();
        pauseSecondaryVideo();
      }
    },
  }), [pauseSecondaryVideo, seekToTimelineTime, syncLayers, videoRef]);

  const togglePlay = useCallback(() => {
    const primaryVideo = videoRef.current;
    if (!primaryVideo) return;
    if (primaryVideo.paused) {
      playbackIntentRef.current = true;
      syncLayers(currentTimeRef.current, { allowPlay: true });
      primaryVideo.play().catch(() => {});
    } else {
      playbackIntentRef.current = false;
      primaryVideo.pause();
      pauseSecondaryVideo();
    }
  }, [pauseSecondaryVideo, syncLayers, videoRef]);

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
            overflow: 'hidden',
            background: '#000',
          }}
        >
          <video
            ref={videoRef}
            src={videoUrl}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              cursor: 'pointer',
              opacity: transitionMix?.outgoingOpacity ?? 1,
            }}
            onLoadedMetadata={(event) => {
              const el = event.currentTarget;
              setVideoDimensions({ width: el.videoWidth, height: el.videoHeight });
              setVideoDuration(el.duration);
              setIsVideoReady(el.readyState >= 2);
              seekToTimelineTime(currentTimeRef.current);
            }}
            onLoadedData={(event) => setIsVideoReady(event.currentTarget.readyState >= 2)}
            onCanPlay={(event) => setIsVideoReady(event.currentTarget.readyState >= 2)}
            onLoadStart={() => setIsVideoReady(false)}
            onClick={togglePlay}
            playsInline
            preload="auto"
            crossOrigin="anonymous"
          />

          <video
            ref={secondaryVideoRef}
            src={videoUrl}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              pointerEvents: 'none',
              opacity: transitionMix?.incomingOpacity ?? 0,
              clipPath: transitionMix?.incomingClipPath ?? 'inset(0 0 0 0)',
            }}
            muted={false}
            playsInline
            preload="auto"
            crossOrigin="anonymous"
          />

          {transitionMix && transitionMix.blackOpacity > 0 && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: '#000',
                opacity: transitionMix.blackOpacity,
                pointerEvents: 'none',
              }}
            />
          )}

          {!isVideoReady && (
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

          {hasCaptionTrack && (
            <button
              type="button"
              onClick={() => setCaptionsEnabled((current) => !current)}
              style={{
                position: 'absolute',
                top: 12,
                right: 12,
                zIndex: 3,
                border: '1px solid rgba(255,255,255,0.18)',
                background: captionsEnabled ? 'rgba(0,0,0,0.72)' : 'rgba(0,0,0,0.38)',
                color: '#fff',
                borderRadius: 999,
                padding: '6px 10px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              CC
            </button>
          )}

          {videoDisplaySize.width > 0 && (activeCaption || activeTextOverlays.length > 0) && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {activeCaption && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: Math.max(18, videoDisplaySize.height * 0.065),
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 6,
                    padding: '0 6%',
                    boxSizing: 'border-box',
                  }}
                >
                  {activeCaption.lines.map((line, index) => (
                    <div
                      key={`${line}-${index}`}
                      style={{
                        maxWidth: '82%',
                        padding: '6px 12px',
                        background: 'rgba(0,0,0,0.74)',
                        borderRadius: 6,
                        color: '#fff',
                        fontSize: Math.max(14, Math.min(24, videoDisplaySize.width * 0.031)),
                        fontWeight: 800,
                        lineHeight: 1.18,
                        textAlign: 'center',
                        textShadow: '0 2px 10px rgba(0,0,0,0.9)',
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'break-word',
                      }}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              )}

              {activeTextOverlays.map((overlay) => (
                <div
                  key={overlay.id ?? overlay.text}
                  style={{
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
                  }}
                >
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
