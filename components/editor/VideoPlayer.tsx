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

type PlaybackTarget = {
  sourceUrl: string;
  slot: number;
};

const CSS_FILTERS: Record<string, string> = {
  cinematic: 'contrast(1.2) saturate(0.8) brightness(0.95)',
  vintage: 'contrast(1.1) saturate(0.7) sepia(0.3) brightness(1.05)',
  warm: 'saturate(1.2) brightness(1.05) hue-rotate(10deg)',
  cool: 'saturate(1.1) hue-rotate(-10deg)',
  bw: 'grayscale(1)',
  none: '',
};

const SOURCE_SLOT_COUNT = 2;
const AUTO_ADVANCE_EPSILON = 0.05;

function getInstanceKey(sourceUrl: string, slot: number) {
  return `${sourceUrl}::${slot}`;
}

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
  const [sourceDimensions, setSourceDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const [sourceReadyState, setSourceReadyState] = useState<Record<string, boolean>>({});
  const [activePlayback, setActivePlayback] = useState<PlaybackTarget | null>(null);

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

  const clipsRef = useRef(clips);
  useEffect(() => { clipsRef.current = clips; }, [clips]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !video.paused || clips.length === 0) return;
    const schedule = buildClipSchedule(clips);
    if (schedule.length === 0) return;
    const timelineTime = useEditorStore.getState().currentTime;
    const targetEntry = findTimelineEntryAtTime(schedule, timelineTime);
    if (!targetEntry) return;
    const offsetInTimeline = Math.max(0, timelineTime - targetEntry.timelineStart);
    const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
    video.currentTime = Math.max(0, sourceTime);
  }, [clips, videoRef]);

  const sourceVideoMapRef = useRef<Map<string, Array<HTMLVideoElement | null>>>(new Map());
  const activePlaybackRef = useRef<PlaybackTarget | null>(null);
  const playbackIntentRef = useRef(false);
  const currentTimeRef = useRef(currentTime);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);

  const videoContainerRef = useRef<HTMLDivElement>(null);

  const getVideoInstance = useCallback((sourceUrl: string, slot: number) => {
    return sourceVideoMapRef.current.get(sourceUrl)?.[slot] ?? null;
  }, []);

  const getAllVideoInstances = useCallback(() => (
    [...sourceVideoMapRef.current.values()].flatMap((instances) => instances.filter((el): el is HTMLVideoElement => el !== null))
  ), []);

  const pauseInactiveVideoInstances = useCallback((activeEl?: HTMLVideoElement | null) => {
    for (const el of getAllVideoInstances()) {
      if (activeEl && el === activeEl) continue;
      if (!el.paused) el.pause();
    }
  }, [getAllVideoInstances]);

  useEffect(() => {
    const container = videoContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setContainerSize({ width: container.clientWidth, height: container.clientHeight });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [videoUrl]);

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
      // AudioContext may fail if already connected.
    }
  }, [videoRef]);

  const activeCaption = captions.find(caption => currentTime >= caption.startTime && currentTime < caption.endTime);
  const activeTextOverlays = textOverlays.filter(overlay => currentTime >= overlay.startTime && currentTime < overlay.endTime);

  const schedule = buildClipSchedule(clips);
  const totalTimelineDuration = schedule.length > 0 ? schedule[schedule.length - 1].timelineEnd : videoDuration;

  const primeSourceAtTime = useCallback((
    sourceUrl: string,
    sourceTime: number,
    options?: { preferredSlot?: number; avoidActive?: boolean },
  ) => {
    const instances = sourceVideoMapRef.current.get(sourceUrl) ?? [];
    const active = activePlaybackRef.current;
    const usableSlots = instances
      .map((instance, slot) => ({ instance, slot }))
      .filter((entry): entry is { instance: HTMLVideoElement; slot: number } => entry.instance !== null);
    if (usableSlots.length === 0) return { ready: false, slot: null as number | null };

    let selected = usableSlots.find((entry) => entry.slot === options?.preferredSlot) ?? usableSlots[0];
    if (options?.avoidActive && active?.sourceUrl === sourceUrl && selected.slot === active.slot) {
      selected = usableSlots.find((entry) => entry.slot !== active.slot) ?? selected;
    }

    const sourceEl = selected.instance;
    if (sourceEl.networkState === HTMLMediaElement.NETWORK_EMPTY) {
      sourceEl.load();
    }

    if (Number.isFinite(sourceTime) && Math.abs(sourceEl.currentTime - sourceTime) > 0.2) {
      try {
        sourceEl.currentTime = Math.max(0, sourceTime);
      } catch {
        // Ignore browsers that reject pre-seeks before metadata is ready.
      }
    }

    return { ready: sourceEl.readyState >= 2, slot: selected.slot };
  }, []);

  const applyClipEffects = useCallback((sourceTime: number) => {
    const currentClips = clipsRef.current;
    const video = videoRef.current;
    if (!video) return;

    const currentSchedule = buildClipSchedule(currentClips);
    const currentTimelineEntry = findTimelineEntryAtTime(currentSchedule, currentTimeRef.current);
    const activeClip = currentTimelineEntry
      ? currentClips.find((clip) => clip.id === currentTimelineEntry.clipId) ?? null
      : currentClips[currentClips.length - 1] ?? null;
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
      gainNodeRef.current.gain.setTargetAtTime(activeClip.volume, audioCtxRef.current.currentTime, 0.05);
    }
  }, [videoRef, videoUrl]);

  const uniqueSourceUrls = useMemo(() => {
    const urls = new Set<string>();
    if (videoUrl) urls.add(videoUrl);
    for (const clip of clips) {
      if (clip.sourceUrl) urls.add(clip.sourceUrl);
    }
    return [...urls].filter(Boolean);
  }, [clips, videoUrl]);

  const desiredSourceUrl = useMemo(() => {
    const currentSchedule = buildClipSchedule(clips);
    const targetEntry = findTimelineEntryAtTime(currentSchedule, currentTime) ?? currentSchedule[0];
    const targetClip = targetEntry ? clips.find(clip => clip.id === targetEntry.clipId) : null;
    return targetClip?.sourceUrl ?? videoUrl ?? uniqueSourceUrls[0] ?? '';
  }, [clips, currentTime, uniqueSourceUrls, videoUrl]);

  const resolvedActivePlayback = activePlayback && uniqueSourceUrls.includes(activePlayback.sourceUrl)
    ? activePlayback
    : null;
  const activeSlot = resolvedActivePlayback?.slot ?? 0;
  const resolvedActiveSourceUrl = resolvedActivePlayback?.sourceUrl ?? '';
  const displaySourceUrl = resolvedActiveSourceUrl || desiredSourceUrl;
  const displayInstanceKey = getInstanceKey(displaySourceUrl, activeSlot);
  const isDisplaySourceReady = Boolean(sourceReadyState[displayInstanceKey]);
  const activeDimensions = sourceDimensions[displaySourceUrl || uniqueSourceUrls[0] || videoUrl] ?? null;
  const videoDisplaySize = useMemo(
    () => fitVideoFrame(containerSize, activeDimensions),
    [activeDimensions, containerSize],
  );

  useEffect(() => {
    const activeEl = displaySourceUrl ? getVideoInstance(displaySourceUrl, activeSlot) : null;
    if (!activeEl) return;

    const currentSchedule = buildClipSchedule(clipsRef.current);
    const targetEntry = findTimelineEntryAtTime(currentSchedule, currentTimeRef.current);
    if (!targetEntry) return;

    const targetClip = clipsRef.current.find((clip) => clip.id === targetEntry.clipId);
    const targetSourceUrl = targetClip?.sourceUrl ?? videoUrl;
    if (targetSourceUrl !== displaySourceUrl) return;

    const offsetInTimeline = Math.max(0, currentTimeRef.current - targetEntry.timelineStart);
    const targetSourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
    const wasPlaying = getAllVideoInstances().some((el) => !el.paused);

    if (Math.abs(activeEl.currentTime - targetSourceTime) > 1 / 120) {
      activeEl.currentTime = Math.max(0, targetSourceTime);
    }
    if (wasPlaying && activeEl.paused) {
      activeEl.play().catch(() => {});
    }
  }, [activeSlot, displaySourceUrl, getAllVideoInstances, getVideoInstance, uniqueSourceUrls, videoUrl]);

  const activateSource = useCallback((sourceUrl: string, slot: number) => {
    const nextTarget = { sourceUrl, slot };
    const currentTarget = activePlaybackRef.current;
    if (currentTarget?.sourceUrl === nextTarget.sourceUrl && currentTarget.slot === nextTarget.slot) return;
    activePlaybackRef.current = nextTarget;
    setActivePlayback(nextTarget);
    const el = getVideoInstance(sourceUrl, slot);
    if (el) {
      (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    }
  }, [getVideoInstance, videoRef]);

  useEffect(() => {
    if (schedule.length === 0) return;

    const targetEntry = findTimelineEntryAtTime(schedule, currentTime);
    if (!targetEntry) return;

    const targetIndex = schedule.findIndex((entry) => (
      entry.clipId === targetEntry.clipId
      && entry.timelineStart === targetEntry.timelineStart
      && entry.sourceStart === targetEntry.sourceStart
    ));
    const nextEntry = targetIndex >= 0 ? schedule[targetIndex + 1] : null;
    if (!nextEntry) return;

    const nextClip = clips.find((clip) => clip.id === nextEntry.clipId);
    const nextSource = nextClip?.sourceUrl ?? videoUrl;
    if (!nextSource) return;

    const activeTarget = activePlaybackRef.current;
    const preferredSlot = nextSource === (activeTarget?.sourceUrl ?? videoUrl)
      ? ((activeTarget?.slot ?? 0) + 1) % SOURCE_SLOT_COUNT
      : 0;

    primeSourceAtTime(nextSource, nextEntry.sourceStart, {
      preferredSlot,
      avoidActive: nextSource === (activeTarget?.sourceUrl ?? videoUrl),
    });
  }, [clips, currentTime, primeSourceAtTime, schedule, videoUrl]);

  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;

    const sourceTime = videoRef.current.currentTime;
    const currentClips = clipsRef.current;
    if (currentClips.length === 0) {
      if (Math.abs(currentTimeRef.current - sourceTime) > 1 / 240) {
        currentTimeRef.current = sourceTime;
        setCurrentTime(sourceTime);
      }
      return;
    }

    applyClipEffects(sourceTime);

    const currentSource = activePlaybackRef.current?.sourceUrl || videoUrl;
    const currentSlot = activePlaybackRef.current?.slot ?? 0;
    const currentSchedule = buildClipSchedule(currentClips);
    const currentTimelineEntry = findTimelineEntryAtTime(
      currentSchedule,
      Math.min(currentTimeRef.current, totalTimelineDuration),
    );
    const currentTimelineClip = currentTimelineEntry
      ? currentClips.find((clip) => clip.id === currentTimelineEntry.clipId) ?? null
      : null;
    const currentTimelineSource = currentTimelineClip?.sourceUrl ?? videoUrl;

    if (
      currentTimelineEntry
      && currentTimelineSource === currentSource
      && sourceTime >= currentTimelineEntry.sourceStart - AUTO_ADVANCE_EPSILON
      && sourceTime < currentTimelineEntry.sourceStart + currentTimelineEntry.sourceDuration - AUTO_ADVANCE_EPSILON / 2
    ) {
      const timelineTime = currentTimelineEntry.timelineStart + (sourceTime - currentTimelineEntry.sourceStart) / currentTimelineEntry.speed;
      if (Math.abs(currentTimeRef.current - timelineTime) > 1 / 240) {
        currentTimeRef.current = timelineTime;
        setCurrentTime(timelineTime);
      }
      return;
    }

    const boundaryTime = Math.min(
      currentTimeRef.current + AUTO_ADVANCE_EPSILON,
      totalTimelineDuration,
    );
    const anchoredTimelineEntry = currentTimelineEntry ?? findTimelineEntryAtTime(
      currentSchedule,
      Math.max(0, currentTimeRef.current - AUTO_ADVANCE_EPSILON),
    );
    const timelineTarget = findTimelineEntryAtTime(currentSchedule, boundaryTime);
    const timelineTargetClip = timelineTarget
      ? currentClips.find(item => item.id === timelineTarget.clipId)
      : null;
    const timelineTargetSource = timelineTargetClip?.sourceUrl ?? videoUrl;
    const nextEntry = timelineTarget && (
      timelineTargetSource !== currentSource
      || timelineTarget.clipId !== anchoredTimelineEntry?.clipId
    )
      ? timelineTarget
      : (
        timelineTarget
          && sourceTime >= timelineTarget.sourceStart + timelineTarget.sourceDuration - AUTO_ADVANCE_EPSILON
          ? currentSchedule[currentSchedule.findIndex(entry => entry.clipId === timelineTarget.clipId) + 1] ?? null
          : null
      );

    if (nextEntry) {
      const nextClip = currentClips.find(item => item.id === nextEntry.clipId);
      const nextSource = nextClip?.sourceUrl ?? videoUrl;
      const shouldContinuePlayback = playbackIntentRef.current || !videoRef.current.paused;
      const nextTimelineTime = Math.max(currentTimeRef.current, nextEntry.timelineStart);
      const nextSourceTime = Math.min(
        nextEntry.sourceStart + Math.max(0, nextTimelineTime - nextEntry.timelineStart) * nextEntry.speed,
        nextEntry.sourceStart + nextEntry.sourceDuration,
      );
      const { ready: nextReady, slot: nextSlot } = primeSourceAtTime(nextSource, nextSourceTime, {
        preferredSlot: nextSource === currentSource
          ? (currentSlot + 1) % SOURCE_SLOT_COUNT
          : 0,
        avoidActive: nextSource === currentSource,
      });
      const resolvedNextSlot = nextSlot ?? (nextSource === currentSource ? currentSlot : 0);
      const nextEl = getVideoInstance(nextSource, resolvedNextSlot);

      if (nextEl && (nextSource !== currentSource || resolvedNextSlot !== currentSlot)) {
        activateSource(nextSource, resolvedNextSlot);
        if (Math.abs(nextEl.currentTime - nextSourceTime) > 1 / 120) {
          nextEl.currentTime = nextSourceTime;
        }
        if (shouldContinuePlayback) {
          playbackIntentRef.current = true;
          if (nextReady) {
            pauseInactiveVideoInstances(nextEl);
            nextEl.play().catch(() => {});
          } else {
            const resumePlayback = () => {
              pauseInactiveVideoInstances(nextEl);
              nextEl.play().catch(() => {});
            };
            nextEl.addEventListener('canplay', resumePlayback, { once: true });
          }
        } else {
          pauseInactiveVideoInstances(nextEl);
        }
      } else {
        videoRef.current.currentTime = nextSourceTime;
      }
      currentTimeRef.current = nextTimelineTime;
      setCurrentTime(nextTimelineTime);
      return;
    }

    playbackIntentRef.current = false;
    videoRef.current.pause();
    pauseInactiveVideoInstances();
    const lastEntry = currentSchedule[currentSchedule.length - 1];
    if (lastEntry) {
      const lastClip = currentClips.find(clip => clip.id === lastEntry.clipId);
      const lastSource = lastClip?.sourceUrl ?? videoUrl;
      const lastEl = getVideoInstance(lastSource, activePlaybackRef.current?.sourceUrl === lastSource ? (activePlaybackRef.current?.slot ?? 0) : 0);
      if (lastEl) lastEl.currentTime = lastEntry.sourceStart + lastEntry.sourceDuration - 0.001;
    }
    currentTimeRef.current = totalTimelineDuration;
    setCurrentTime(totalTimelineDuration);
  }, [activateSource, applyClipEffects, getVideoInstance, pauseInactiveVideoInstances, primeSourceAtTime, setCurrentTime, totalTimelineDuration, videoRef, videoUrl]);

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
      scheduleNext();
    };

    const scheduleNext = () => {
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

    scheduleNext();

    return () => {
      cancelled = true;
      if (rafHandle) window.cancelAnimationFrame(rafHandle);
      if (frameHandle && 'cancelVideoFrameCallback' in activeVideo) {
        (activeVideo as HTMLVideoElement & {
          cancelVideoFrameCallback: (handle: number) => void;
        }).cancelVideoFrameCallback(frameHandle);
      }
    };
  }, [activePlayback, handleTimeUpdate, videoRef]);

  const seekToTimelineTime = useCallback((timelineTime: number) => {
    const currentSchedule = buildClipSchedule(clipsRef.current);
    const targetEntry = findTimelineEntryAtTime(currentSchedule, timelineTime);
    if (!targetEntry) return;

    const clip = clipsRef.current.find(entry => entry.id === targetEntry.clipId);
    const targetSourceUrl = clip?.sourceUrl ?? videoUrl;
    const currentTarget = activePlaybackRef.current;
    const currentSource = currentTarget?.sourceUrl ?? videoUrl;
    const currentSlot = currentTarget?.slot ?? 0;
    const preferredSlot = targetSourceUrl === currentSource
      ? (currentSlot + 1) % SOURCE_SLOT_COUNT
      : 0;
    const { ready: targetReady, slot: targetSlotCandidate } = primeSourceAtTime(targetSourceUrl, targetEntry.sourceStart + (timelineTime - targetEntry.timelineStart) * targetEntry.speed, {
      preferredSlot,
      avoidActive: targetSourceUrl === currentSource,
    });
    const targetSlot = targetSlotCandidate ?? (targetSourceUrl === currentSource ? currentSlot : 0);
    const activeEl = getVideoInstance(targetSourceUrl, targetSlot);
    if (!activeEl) return;

    const previousActiveEl = videoRef.current;
    const switchingSource = previousActiveEl !== activeEl;
    const shouldResumePlayback = playbackIntentRef.current || getAllVideoInstances().some(el => !el.paused);
    const offsetInTimeline = timelineTime - targetEntry.timelineStart;
    const sourceTime = targetEntry.sourceStart + offsetInTimeline * targetEntry.speed;
    const shouldApplySeek =
      switchingSource
      || activeEl.seeking
      || Math.abs(activeEl.currentTime - sourceTime) > 1 / 120;

    if (switchingSource) {
      activateSource(targetSourceUrl, targetSlot);
    }

    if (shouldApplySeek) {
      activeEl.currentTime = Math.max(0, sourceTime);
    }
    if (Math.abs(currentTimeRef.current - timelineTime) > 1 / 240) {
      currentTimeRef.current = timelineTime;
      setCurrentTime(timelineTime);
    }
    applyClipEffects(sourceTime);
    if (switchingSource && shouldResumePlayback) {
      playbackIntentRef.current = true;
      if (targetReady) {
        pauseInactiveVideoInstances(activeEl);
        activeEl.play().catch(() => {});
      } else {
        const resumePlayback = () => {
          pauseInactiveVideoInstances(activeEl);
          activeEl.play().catch(() => {});
        };
        activeEl.addEventListener('canplay', resumePlayback, { once: true });
      }
    }
  }, [activateSource, applyClipEffects, getAllVideoInstances, getVideoInstance, pauseInactiveVideoInstances, primeSourceAtTime, setCurrentTime, videoRef, videoUrl]);

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
        setupAudio();
        if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
        video.play().catch(() => {});
      } else {
        playbackIntentRef.current = false;
        pauseInactiveVideoInstances();
        video.pause();
      }
    },
  }), [pauseInactiveVideoInstances, seekToTimelineTime, setupAudio, videoRef]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      playbackIntentRef.current = true;
      setupAudio();
      if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
      video.play().catch(() => {});
    } else {
      playbackIntentRef.current = false;
      pauseInactiveVideoInstances();
      video.pause();
    }
  }, [pauseInactiveVideoInstances, setupAudio, videoRef]);

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
          {uniqueSourceUrls.flatMap((srcUrl) => (
            Array.from({ length: SOURCE_SLOT_COUNT }, (_, slot) => {
              const instanceKey = getInstanceKey(srcUrl, slot);
              const isDisplayedInstance = srcUrl === displaySourceUrl && slot === activeSlot;
              return (
                <video
                  key={instanceKey}
                  ref={el => {
                    const instances = sourceVideoMapRef.current.get(srcUrl) ?? Array.from({ length: SOURCE_SLOT_COUNT }, () => null);
                    instances[slot] = el;
                    if (instances.some((instance) => instance !== null)) {
                      sourceVideoMapRef.current.set(srcUrl, instances);
                    } else {
                      sourceVideoMapRef.current.delete(srcUrl);
                    }
                    if (!el) return;

                    setSourceReadyState(prev => (
                      prev[instanceKey] === (el.readyState >= 2)
                        ? prev
                        : { ...prev, [instanceKey]: el.readyState >= 2 }
                    ));

                    if (isDisplayedInstance) {
                      activePlaybackRef.current = { sourceUrl: srcUrl, slot };
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
                    opacity: isDisplayedInstance ? 1 : 0,
                    pointerEvents: isDisplayedInstance ? 'auto' : 'none',
                    cursor: 'pointer',
                    transition: 'opacity 0.12s linear',
                    willChange: 'opacity',
                  }}
                  onLoadedMetadata={() => {
                    const el = getVideoInstance(srcUrl, slot);
                    if (!el) return;
                    setSourceDimensions(prev => (
                      prev[srcUrl]?.width === el.videoWidth && prev[srcUrl]?.height === el.videoHeight
                        ? prev
                        : { ...prev, [srcUrl]: { width: el.videoWidth, height: el.videoHeight } }
                    ));
                    if (srcUrl === videoUrl && slot === 0) {
                      setVideoDuration(el.duration);
                    }
                    setSourceReadyState(prev => (
                      prev[instanceKey] === (el.readyState >= 2)
                        ? prev
                        : { ...prev, [instanceKey]: el.readyState >= 2 }
                    ));
                  }}
                  onLoadedData={e => {
                    const isReady = (e.currentTarget as HTMLVideoElement).readyState >= 2;
                    setSourceReadyState(prev => (prev[instanceKey] === isReady ? prev : { ...prev, [instanceKey]: isReady }));
                  }}
                  onCanPlay={e => {
                    const isReady = (e.currentTarget as HTMLVideoElement).readyState >= 2;
                    setSourceReadyState(prev => (prev[instanceKey] === isReady ? prev : { ...prev, [instanceKey]: isReady }));
                  }}
                  onLoadStart={() => {
                    setSourceReadyState(prev => (prev[instanceKey] === false ? prev : { ...prev, [instanceKey]: false }));
                  }}
                  onTimeUpdate={isDisplayedInstance ? handleTimeUpdate : undefined}
                  onClick={togglePlay}
                  playsInline
                  preload="auto"
                  crossOrigin="anonymous"
                />
              );
            })
          ))}

          {!isDisplaySourceReady && (
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
