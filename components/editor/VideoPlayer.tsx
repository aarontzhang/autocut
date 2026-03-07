'use client';

import { forwardRef, useImperativeHandle, useCallback, useState, useRef, useEffect } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { formatTime, formatTimeDetailed } from '@/lib/timelineUtils';
import { buildClipSchedule } from '@/lib/playbackEngine';

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

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(({ videoRef }, ref) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoDisplaySize, setVideoDisplaySize] = useState({ width: 0, height: 0 });
  const setVideoDuration = useEditorStore(s => s.setVideoDuration);
  const setCurrentTime = useEditorStore(s => s.setCurrentTime);
  const videoUrl = useEditorStore(s => s.videoUrl);
  const currentTime = useEditorStore(s => s.currentTime);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const clips = useEditorStore(s => s.clips);
  const captions = useEditorStore(s => s.captions);
  const textOverlays = useEditorStore(s => s.textOverlays);

  const clipsRef = useRef(clips);
  useEffect(() => { clipsRef.current = clips; }, [clips]);

  // Track the video element's actual rendered size so captions stay inside the frame
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const observer = new ResizeObserver(() => {
      setVideoDisplaySize({ width: video.offsetWidth, height: video.offsetHeight });
    });
    observer.observe(video);
    return () => observer.disconnect();
  }, [videoRef, videoUrl]);

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

  // Find active caption and text overlay
  const activeCaption = captions.find(c => currentTime >= c.startTime && currentTime < c.endTime);
  const activeTextOverlays = textOverlays.filter(t => currentTime >= t.startTime && currentTime < t.endTime);

  // Build total timeline duration
  const schedule = buildClipSchedule(clips);
  const totalTimelineDuration = schedule.length > 0 ? schedule[schedule.length - 1].timelineEnd : videoDuration;

  useImperativeHandle(ref, () => ({
    seekTo: (timelineTime: number) => {
      if (!videoRef.current) return;
      const sched = buildClipSchedule(clipsRef.current);
      let targetEntry = sched.find(e => timelineTime >= e.timelineStart && timelineTime <= e.timelineEnd);
      if (!targetEntry && sched.length > 0) targetEntry = sched[sched.length - 1];
      if (!targetEntry) return;
      const offsetInTimeline = timelineTime - targetEntry.timelineStart;
      const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
      videoRef.current.currentTime = Math.max(0, sourceTime);
    },
    togglePlay: () => {
      if (!videoRef.current) return;
      if (videoRef.current.paused) {
        setupAudio();
        if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
        videoRef.current.play();
      } else {
        videoRef.current.pause();
      }
    },
  }));

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      setupAudio();
      if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
      videoRef.current.play();
    } else {
      videoRef.current.pause();
    }
  }, [videoRef, setupAudio]);

  const skipFrames = useCallback((frames: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, Math.min(videoDuration, videoRef.current.currentTime + frames / 30));
  }, [videoRef, videoDuration]);

  const skipSeconds = useCallback((s: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, Math.min(videoDuration, videoRef.current.currentTime + s));
  }, [videoRef, videoDuration]);

  // Compute progress based on timeline time
  const progress = totalTimelineDuration > 0 ? currentTime / totalTimelineDuration : 0;

  // Apply active clip's CSS filter and speed
  const applyClipEffects = useCallback((sourceTime: number) => {
    const curClips = clipsRef.current;
    const video = videoRef.current;
    if (!video) return;

    // Find active clip by source time
    let activeClip = null;
    for (const clip of curClips) {
      if (sourceTime >= clip.sourceStart && sourceTime < clip.sourceStart + clip.sourceDuration) {
        activeClip = clip;
        break;
      }
    }
    if (!activeClip && curClips.length > 0) {
      activeClip = curClips[curClips.length - 1];
    }
    if (!activeClip) return;

    // Apply playback rate
    if (video.playbackRate !== activeClip.speed) {
      video.playbackRate = activeClip.speed;
    }

    // Apply CSS filter
    const filterStr = activeClip.filter && activeClip.filter.type !== 'none'
      ? (CSS_FILTERS[activeClip.filter.type] ?? '')
      : '';
    if (video.style.filter !== filterStr) {
      video.style.filter = filterStr;
    }

    // Apply volume via GainNode
    if (gainNodeRef.current && audioCtxRef.current) {
      const targetGain = activeClip.volume;
      gainNodeRef.current.gain.setTargetAtTime(targetGain, audioCtxRef.current.currentTime, 0.05);
    }
  }, [videoRef]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#000' }}>
      {/* Video */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
        <video
          ref={videoRef as React.RefObject<HTMLVideoElement>}
          src={videoUrl}
          style={{ maxWidth: '100%', maxHeight: '100%', display: 'block', cursor: 'pointer' }}
          onLoadedMetadata={() => {
            if (videoRef.current) setVideoDuration(videoRef.current.duration);
          }}
          onTimeUpdate={() => {
            if (!videoRef.current) return;
            const sourceTime = videoRef.current.currentTime;
            const curClips = clipsRef.current;
            if (curClips.length === 0) {
              setCurrentTime(sourceTime);
              return;
            }

            // Apply effects for current source position
            applyClipEffects(sourceTime);

            // Check if we've passed the end of the current active clip
            let foundClip = false;
            let timelineTime = 0;
            let cumTimeline = 0;

            for (const clip of curClips) {
              const clipTimelineDuration = clip.sourceDuration / clip.speed;
              if (sourceTime >= clip.sourceStart && sourceTime < clip.sourceStart + clip.sourceDuration) {
                const offsetInSource = sourceTime - clip.sourceStart;
                timelineTime = cumTimeline + offsetInSource / clip.speed;
                foundClip = true;
                break;
              }
              cumTimeline += clipTimelineDuration;
            }

            if (!foundClip) {
              // sourceTime is in a deleted gap — find the next clip and jump to it
              let nextClip: (typeof curClips)[0] | null = null;
              for (const clip of curClips) {
                if (clip.sourceStart >= sourceTime) {
                  if (!nextClip || clip.sourceStart < nextClip.sourceStart) {
                    nextClip = clip;
                  }
                }
              }
              if (nextClip && videoRef.current) {
                videoRef.current.currentTime = nextClip.sourceStart;
                return;
              }
              // Past all kept clips — end of timeline
              if (videoRef.current) {
                videoRef.current.pause();
                // Seek back to the last frame of the last kept clip
                const lastClip = [...curClips].sort((a, b) => (a.sourceStart + a.sourceDuration) - (b.sourceStart + b.sourceDuration)).pop();
                if (lastClip) {
                  videoRef.current.currentTime = lastClip.sourceStart + lastClip.sourceDuration - 0.001;
                }
              }
              setCurrentTime(totalTimelineDuration);
              return;
            }

            setCurrentTime(timelineTime);
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onClick={togglePlay}
          playsInline
        />

        {/* Overlays anchored to the actual video frame */}
        {videoDisplaySize.width > 0 && (activeCaption || activeTextOverlays.length > 0) && (
          <div style={{
            position: 'absolute',
            left: '50%', top: '50%',
            transform: 'translate(-50%, -50%)',
            width: videoDisplaySize.width,
            height: videoDisplaySize.height,
            pointerEvents: 'none',
          }}>
            {/* Caption */}
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

            {/* Text overlays */}
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

      {/* Controls */}
      <div style={{
        flexShrink: 0, background: 'rgba(0,0,0,0.65)',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {/* Progress bar */}
        <div
          style={{ height: 3, background: 'rgba(255,255,255,0.12)', borderRadius: 2, cursor: 'pointer', position: 'relative' }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            const timelineTime = ratio * totalTimelineDuration;
            const sched = buildClipSchedule(clipsRef.current);
            let targetEntry = sched.find(e2 => timelineTime >= e2.timelineStart && timelineTime <= e2.timelineEnd);
            if (!targetEntry && sched.length > 0) targetEntry = sched[sched.length - 1];
            if (targetEntry && videoRef.current) {
              const offsetInTimeline = timelineTime - targetEntry.timelineStart;
              const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
              videoRef.current.currentTime = Math.max(0, sourceTime);
            }
          }}
        >
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${progress * 100}%`,
            background: 'var(--accent)', borderRadius: 2, transition: 'width 0.05s linear',
          }} />
        </div>

        {/* Buttons row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <CtrlBtn onClick={() => skipSeconds(-5)} title="-5s">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1 4 1 10 7 10"/>
              <path d="M3.51 15a9 9 0 1 0 .49-3.96"/>
            </svg>
          </CtrlBtn>
          <CtrlBtn onClick={() => skipFrames(-1)} title="Prev frame">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="19 20 9 12 19 4 19 20"/>
              <line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" strokeWidth="2"/>
            </svg>
          </CtrlBtn>
          <button
            onClick={togglePlay}
            style={{
              width: 34, height: 34, borderRadius: '50%', background: 'var(--accent)',
              border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >
            {isPlaying ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="#000">
                <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="#000" style={{ marginLeft: 1 }}>
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            )}
          </button>
          <CtrlBtn onClick={() => skipFrames(1)} title="Next frame">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 4 15 12 5 20 5 4"/>
              <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2"/>
            </svg>
          </CtrlBtn>
          <CtrlBtn onClick={() => skipSeconds(5)} title="+5s">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-.49-3.96"/>
            </svg>
          </CtrlBtn>

          <div style={{ flex: 1 }} />

          <span style={{ fontFamily: 'var(--font-serif)', fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
            {formatTimeDetailed(currentTime)} / {formatTimeDetailed(totalTimelineDuration)}
          </span>
        </div>
      </div>
    </div>
  );
});

function CtrlBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick} title={title}
      style={{
        width: 28, height: 28, borderRadius: 5, background: 'transparent',
        border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'rgba(255,255,255,0.6)', transition: 'background 0.15s, color 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = 'rgba(255,255,255,0.9)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; }}
    >
      {children}
    </button>
  );
}

VideoPlayer.displayName = 'VideoPlayer';
export default VideoPlayer;
