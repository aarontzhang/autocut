'use client';

import { forwardRef, useImperativeHandle, useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { buildClipSchedule, findTimelineEntryAtTime } from '@/lib/playbackEngine';

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

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(({ videoRef }, ref) => {
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isVideoReady, setIsVideoReady] = useState(false);

  const setVideoDuration = useEditorStore(s => s.setVideoDuration);
  const setCurrentTime = useEditorStore(s => s.setCurrentTime);
  const setPlaybackActive = useEditorStore(s => s.setPlaybackActive);
  const requestedSeekTime = useEditorStore(s => s.requestedSeekTime);
  const clearRequestedSeek = useEditorStore(s => s.clearRequestedSeek);
  const videoUrl = useEditorStore(s => s.videoUrl);
  const currentTime = useEditorStore(s => s.currentTime);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const clips = useEditorStore(s => s.previewSnapshot?.clips ?? s.clips);
  const captions = useEditorStore(s => s.previewSnapshot?.captions ?? s.captions);
  const textOverlays = useEditorStore(s => s.previewSnapshot?.textOverlays ?? s.textOverlays);

  const currentTimeRef = useRef(currentTime);
  const playbackIntentRef = useRef(false);
  const videoContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    const container = videoContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setContainerSize({ width: container.clientWidth, height: container.clientHeight });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const syncPlaybackState = () => setPlaybackActive(!video.paused && !video.ended);
    syncPlaybackState();
    video.addEventListener('play', syncPlaybackState);
    video.addEventListener('pause', syncPlaybackState);
    video.addEventListener('ended', syncPlaybackState);
    return () => {
      video.removeEventListener('play', syncPlaybackState);
      video.removeEventListener('pause', syncPlaybackState);
      video.removeEventListener('ended', syncPlaybackState);
      setPlaybackActive(false);
    };
  }, [setPlaybackActive, videoRef]);

  const schedule = useMemo(() => buildClipSchedule(clips), [clips]);
  const totalTimelineDuration = schedule.length > 0 ? schedule[schedule.length - 1].timelineEnd : videoDuration;

  const applyClipEffects = useCallback((timelineTime: number) => {
    const video = videoRef.current;
    if (!video) return;
    const entry = findTimelineEntryAtTime(schedule, timelineTime);
    const activeClip = entry ? clips.find((clip) => clip.id === entry.clipId) ?? null : null;
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
    video.volume = Math.max(0, Math.min(1, activeClip.volume));
  }, [clips, schedule, videoRef]);

  const seekToTimelineTime = useCallback((timelineTime: number) => {
    const video = videoRef.current;
    if (!video || schedule.length === 0) return;
    const targetEntry = findTimelineEntryAtTime(schedule, timelineTime);
    if (!targetEntry) return;

    const clampedTimelineTime = Math.max(targetEntry.timelineStart, Math.min(timelineTime, targetEntry.timelineEnd));
    const sourceTime = targetEntry.sourceStart + (clampedTimelineTime - targetEntry.timelineStart) * targetEntry.speed;
    if (Math.abs(video.currentTime - sourceTime) > 1 / 120) {
      video.currentTime = Math.max(0, sourceTime);
    }
    currentTimeRef.current = clampedTimelineTime;
    setCurrentTime(clampedTimelineTime);
    applyClipEffects(clampedTimelineTime);
  }, [applyClipEffects, schedule, setCurrentTime, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !video.paused || schedule.length === 0) return;
    seekToTimelineTime(currentTimeRef.current);
  }, [schedule, seekToTimelineTime, videoRef]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (schedule.length === 0) {
      currentTimeRef.current = video.currentTime;
      setCurrentTime(video.currentTime);
      return;
    }

    const currentEntry = findTimelineEntryAtTime(schedule, currentTimeRef.current) ?? schedule[0];
    const sourceTime = video.currentTime;
    const entrySourceEnd = currentEntry.sourceStart + currentEntry.sourceDuration;

    if (sourceTime < entrySourceEnd - END_EPSILON) {
      const timelineTime = currentEntry.timelineStart + (sourceTime - currentEntry.sourceStart) / currentEntry.speed;
      if (Math.abs(currentTimeRef.current - timelineTime) > 1 / 240) {
        currentTimeRef.current = timelineTime;
        setCurrentTime(timelineTime);
      }
      applyClipEffects(timelineTime);
      return;
    }

    const currentIndex = schedule.findIndex((entry) => entry.clipId === currentEntry.clipId);
    const nextEntry = currentIndex >= 0 ? schedule[currentIndex + 1] ?? null : null;
    if (nextEntry) {
      currentTimeRef.current = nextEntry.timelineStart;
      setCurrentTime(nextEntry.timelineStart);
      video.currentTime = nextEntry.sourceStart;
      applyClipEffects(nextEntry.timelineStart);
      if (playbackIntentRef.current && video.paused) {
        video.play().catch(() => {});
      }
      return;
    }

    playbackIntentRef.current = false;
    video.pause();
    const finalTime = totalTimelineDuration;
    currentTimeRef.current = finalTime;
    setCurrentTime(finalTime);
    if (schedule.length > 0) {
      const lastEntry = schedule[schedule.length - 1];
      video.currentTime = Math.max(0, lastEntry.sourceStart + lastEntry.sourceDuration - 0.001);
    }
  }, [applyClipEffects, schedule, setCurrentTime, totalTimelineDuration, videoRef]);

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
        playbackIntentRef.current = true;
        video.play().catch(() => {});
      } else {
        playbackIntentRef.current = false;
        video.pause();
      }
    },
  }), [seekToTimelineTime, videoRef]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      playbackIntentRef.current = true;
      video.play().catch(() => {});
    } else {
      playbackIntentRef.current = false;
      video.pause();
    }
  }, [videoRef]);

  const activeCaption = captions.find(caption => currentTime >= caption.startTime && currentTime < caption.endTime);
  const activeTextOverlays = textOverlays.filter(overlay => currentTime >= overlay.startTime && currentTime < overlay.endTime);
  const videoDisplaySize = useMemo(
    () => fitVideoFrame(containerSize, videoDimensions),
    [containerSize, videoDimensions],
  );

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
          <video
            ref={videoRef}
            src={videoUrl}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              cursor: 'pointer',
            }}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              setVideoDimensions({ width: el.videoWidth, height: el.videoHeight });
              setVideoDuration(el.duration);
              setIsVideoReady(el.readyState >= 2);
            }}
            onLoadedData={(e) => setIsVideoReady(e.currentTarget.readyState >= 2)}
            onCanPlay={(e) => setIsVideoReady(e.currentTarget.readyState >= 2)}
            onLoadStart={() => setIsVideoReady(false)}
            onTimeUpdate={handleTimeUpdate}
            onClick={togglePlay}
            playsInline
            preload="auto"
            crossOrigin="anonymous"
          />

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

          {videoDisplaySize.width > 0 && (activeCaption || activeTextOverlays.length > 0) && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {activeCaption && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 24,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    maxWidth: '85%',
                    background: 'rgba(0,0,0,0.78)',
                    color: '#fff',
                    fontSize: 18,
                    fontWeight: 700,
                    lineHeight: 1.3,
                    padding: '6px 14px',
                    borderRadius: 5,
                    textAlign: 'center',
                    textShadow: '0 1px 3px rgba(0,0,0,0.5)',
                  }}
                >
                  {activeCaption.text}
                </div>
              )}

              {activeTextOverlays.map(overlay => (
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
