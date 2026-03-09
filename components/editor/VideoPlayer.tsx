'use client';

import { forwardRef, useImperativeHandle, useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { formatTimeDetailed } from '@/lib/timelineUtils';
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

function findActiveTrackClip(clips: TrackClip[], timelineTime: number): TrackClip | null {
  return clips.find(c => {
    const end = c.timelineStart + c.sourceDuration / c.speed;
    return timelineTime >= c.timelineStart && timelineTime < end;
  }) ?? null;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(({ videoRef }, ref) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoDisplaySize, setVideoDisplaySize] = useState({ width: 0, height: 0 });
  const setVideoDuration = useEditorStore(s => s.setVideoDuration);
  const setCurrentTime = useEditorStore(s => s.setCurrentTime);
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
    let targetEntry = sched.find(e => ct >= e.timelineStart && ct <= e.timelineEnd);
    if (!targetEntry) targetEntry = sched[sched.length - 1];
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

  // Ref for the inner video container div (for ResizeObserver)
  const videoContainerRef = useRef<HTMLDivElement>(null);

  // Track the video element's actual rendered size so captions stay inside the frame
  useEffect(() => {
    const container = videoContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const video = videoRef.current;
      if (video) setVideoDisplaySize({ width: video.offsetWidth, height: video.offsetHeight });
    });
    observer.observe(container);
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

  // Activate a source URL — show its element, hide others, update videoRef
  const activateSource = useCallback((sourceUrl: string) => {
    if (activeSourceUrlRef.current === sourceUrl) return;
    activeSourceUrlRef.current = sourceUrl;
    setActiveSourceUrl(sourceUrl);
    for (const [url, el] of sourceVideoMapRef.current) {
      const isActive = url === sourceUrl;
      el.style.display = isActive ? 'block' : 'none';
      el.style.visibility = isActive ? 'visible' : 'hidden';
      el.style.pointerEvents = isActive ? 'auto' : 'none';
    }
    const el = sourceVideoMapRef.current.get(sourceUrl);
    if (el) (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
  }, [videoRef]);

  // The time update handler (named so it can be passed to each video element)
  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;
    const sourceTime = videoRef.current.currentTime;
    const curClips = clipsRef.current;
    if (curClips.length === 0) {
      setCurrentTime(sourceTime);
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
      setCurrentTime(timelineTime);
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
    setCurrentTime(totalTimelineDuration);
  }, [applyClipEffects, videoRef, videoUrl, setCurrentTime, syncExtraTracks, activateSource, totalTimelineDuration]);

  useImperativeHandle(ref, () => ({
    seekTo: (timelineTime: number) => {
      const sched = buildClipSchedule(clipsRef.current);
      let targetEntry = sched.find(e => timelineTime >= e.timelineStart && timelineTime <= e.timelineEnd);
      if (!targetEntry && sched.length > 0) targetEntry = sched[sched.length - 1];
      if (!targetEntry) return;

      const clip = clipsRef.current.find(c => c.id === targetEntry!.clipId);
      const targetSourceUrl = clip?.sourceUrl ?? videoUrl;
      const wasPlaying = Array.from(sourceVideoMapRef.current.values()).some(el => !el.paused);
      for (const el of sourceVideoMapRef.current.values()) {
        if (!el.paused) el.pause();
      }
      activateSource(targetSourceUrl);

      const activeEl = sourceVideoMapRef.current.get(targetSourceUrl);
      if (!activeEl) return;
      const offsetInTimeline = timelineTime - targetEntry.timelineStart;
      const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
      activeEl.currentTime = Math.max(0, sourceTime);
      setCurrentTime(timelineTime);
      applyClipEffects(sourceTime);
      syncExtraTracks(timelineTime, !wasPlaying);
      if (wasPlaying) activeEl.play().catch(() => {});

      // Seek extra tracks
      for (const track of extraTracksRef.current) {
        const map = track.type === 'video' ? extraVideoRefs.current : extraAudioRefs.current;
        const el = map.get(track.id);
        if (!el) continue;
        const activeClip = findActiveTrackClip(track.clips, timelineTime);
        if (activeClip) {
          el.currentTime = activeClip.sourceStart + (timelineTime - activeClip.timelineStart) * activeClip.speed;
        }
      }
    },
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
  }), [activateSource, applyClipEffects, setCurrentTime, setupAudio, syncExtraTracks, videoRef, videoUrl]);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#000' }}>
      {/* Video */}
      <div
        ref={videoContainerRef}
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}
      >
        {uniqueSourceUrls.map((srcUrl, idx) => (
          <video
            key={srcUrl}
            ref={el => {
              if (!el) { sourceVideoMapRef.current.delete(srcUrl); return; }
              sourceVideoMapRef.current.set(srcUrl, el);
              // Initialize active source to the first URL
              if (!activeSourceUrlRef.current && idx === 0) {
                activeSourceUrlRef.current = srcUrl;
                setActiveSourceUrl(srcUrl);
              }
              // Update videoRef if this is the active source
              if (srcUrl === (activeSourceUrlRef.current || uniqueSourceUrls[0])) {
                (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
              }
            }}
            src={srcUrl}
            style={{
              maxWidth: '100%', maxHeight: '100%',
              display: srcUrl === (activeSourceUrl || uniqueSourceUrls[0]) ? 'block' : 'none',
              visibility: srcUrl === (activeSourceUrl || uniqueSourceUrls[0]) ? 'visible' : 'hidden',
              pointerEvents: srcUrl === (activeSourceUrl || uniqueSourceUrls[0]) ? 'auto' : 'none',
              cursor: 'pointer',
            }}
            onLoadedMetadata={() => {
              if (srcUrl === videoUrl) {
                const el = sourceVideoMapRef.current.get(srcUrl);
                if (el) setVideoDuration(el.duration);
              }
            }}
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onClick={togglePlay}
            playsInline
            preload="auto"
            crossOrigin="anonymous"
          />
        ))}

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
            if (targetEntry) {
              const clip = clipsRef.current.find(c => c.id === targetEntry!.clipId);
              const targetSourceUrl = clip?.sourceUrl ?? videoUrl;
              activateSource(targetSourceUrl);
              const activeEl = sourceVideoMapRef.current.get(targetSourceUrl);
              if (activeEl) {
                const offsetInTimeline = timelineTime - targetEntry.timelineStart;
                const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
                activeEl.currentTime = Math.max(0, sourceTime);
              }
            }
          }}
        >
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${progress * 100}%`,
            background: '#ffffff', borderRadius: 2, transition: 'width 0.05s linear',
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
              width: 34, height: 34, borderRadius: '50%', background: '#ffffff',
              border: '1px solid rgba(255,255,255,0.92)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              boxShadow: '0 6px 16px rgba(0,0,0,0.28)',
            }}
          >
            {isPlaying ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="#111">
                <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="#111" style={{ marginLeft: 1 }}>
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
