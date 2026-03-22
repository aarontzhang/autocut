'use client';

import { forwardRef, useImperativeHandle, useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import {
  buildRenderTimeline,
  findRenderEntriesAtTime,
} from '@/lib/playbackEngine';
import { buildCaptionCues, getCaptionCueDisplay } from '@/lib/timelineUtils';
import type { RenderTimelineEntry, ResolvedTransitionBoundary, VideoClip } from '@/lib/types';
import { resolveProjectSources } from '@/lib/sourceMedia';

export interface VideoPlayerHandle {
  seekTo: (timelineTime: number) => void;
  togglePlay: () => void;
}

interface VideoPlayerProps {
  videoRef: { current: HTMLVideoElement | null };
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

type VideoFrameRequestCallback = (now: number, metadata: unknown) => void;
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};
type LayerId = 'primary' | 'secondary';

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

function ensureVideoElementSource(video: HTMLVideoElement, nextUrl: string) {
  if (!nextUrl) return false;
  const currentUrl = video.currentSrc || video.src;
  const normalizedCurrent = currentUrl ? new URL(currentUrl, window.location.href).href : '';
  const normalizedNext = new URL(nextUrl, window.location.href).href;
  if (normalizedCurrent === normalizedNext) return false;
  video.src = nextUrl;
  video.load();
  return true;
}

function getOtherLayer(layer: LayerId): LayerId {
  return layer === 'primary' ? 'secondary' : 'primary';
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(({ videoRef }, ref) => {
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isVideoReady, setIsVideoReady] = useState(false);
  const [leadLayer, setLeadLayer] = useState<LayerId>('primary');

  const primaryVideoElementRef = useRef<HTMLVideoElement | null>(null);
  const secondaryVideoRef = useRef<HTMLVideoElement | null>(null);
  const currentTimeRef = useRef(0);
  const playbackIntentRef = useRef(false);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const pendingDeleteRangesRef = useRef<ReturnType<typeof useEditorStore.getState>['pendingDeleteRanges']>(null);
  const animationFrameRef = useRef<number | null>(null);
  const videoFrameRequestRef = useRef<number | null>(null);
  const playbackTickRef = useRef<() => void>(() => {});
  const leadLayerRef = useRef<LayerId>('primary');
  const layerSourceIdRef = useRef<Record<LayerId, string | null>>({
    primary: null,
    secondary: null,
  });
  const layerClipIdRef = useRef<Record<LayerId, string | null>>({
    primary: null,
    secondary: null,
  });

  const setSourceDuration = useEditorStore((s) => s.setSourceDuration);
  const setCurrentTime = useEditorStore((s) => s.setCurrentTime);
  const setPlaybackActive = useEditorStore((s) => s.setPlaybackActive);
  const requestedSeekTime = useEditorStore((s) => s.requestedSeekTime);
  const clearRequestedSeek = useEditorStore((s) => s.clearRequestedSeek);
  const sources = useEditorStore((s) => s.sources);
  const sourceRuntimeById = useEditorStore((s) => s.sourceRuntimeById);
  const videoUrl = useEditorStore((s) => s.videoUrl);
  const processingVideoUrl = useEditorStore((s) => s.processingVideoUrl);
  const videoFile = useEditorStore((s) => s.videoFile);
  const videoData = useEditorStore((s) => s.videoData);
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
  const resolvedSources = useMemo(() => resolveProjectSources({
    sources,
    runtimeBySourceId: sourceRuntimeById,
    primaryFallback: {
      videoData,
      videoFile,
      videoUrl,
      processingVideoUrl,
      videoDuration,
    },
  }), [processingVideoUrl, sourceRuntimeById, sources, videoData, videoDuration, videoFile, videoUrl]);
  const sourceById = useMemo(() => new Map(resolvedSources.map((source) => [source.sourceId, source])), [resolvedSources]);
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
  const activeEntriesAtCurrentTime = useMemo(
    () => findRenderEntriesAtTime(renderTimeline, currentTime),
    [currentTime, renderTimeline],
  );
  const primaryLayerSourceId = activeEntriesAtCurrentTime[0]?.sourceId ?? renderTimeline[0]?.sourceId ?? null;

  const transitionMix = useMemo(
    () => currentTransition ? getTransitionMix(currentTransition, currentTime) : null,
    [currentTime, currentTransition],
  );

  const activeCaptionCue = captionCues.find((cue) => currentTime >= cue.startTime && currentTime < cue.endTime) ?? null;
  const activeCaption = useMemo(() => {
    if (activeCaptionCue) {
      return getCaptionCueDisplay(activeCaptionCue, currentTime);
    }
    return null;
  }, [activeCaptionCue, currentTime]);
  const activeTextOverlays = textOverlays.filter((overlay) => currentTime >= overlay.startTime && currentTime < overlay.endTime);
  const videoDisplaySize = useMemo(
    () => fitVideoFrame(containerSize, videoDimensions),
    [containerSize, videoDimensions],
  );

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    pendingDeleteRangesRef.current = pendingDeleteRanges;
  }, [pendingDeleteRanges]);

  const getVideoElement = useCallback((layer: LayerId) => (
    layer === 'primary' ? primaryVideoElementRef.current : secondaryVideoRef.current
  ), []);

  const syncExternalVideoRef = useCallback((layer: LayerId) => {
    videoRef.current = getVideoElement(layer);
  }, [getVideoElement, videoRef]);

  const setLeadLayerSafely = useCallback((nextLayer: LayerId) => {
    leadLayerRef.current = nextLayer;
    setLeadLayer(nextLayer);
    syncExternalVideoRef(nextLayer);
    const nextVideo = getVideoElement(nextLayer);
    if (nextVideo) {
      setIsVideoReady(nextVideo.readyState >= 2);
      if (nextVideo.videoWidth > 0 && nextVideo.videoHeight > 0) {
        setVideoDimensions({ width: nextVideo.videoWidth, height: nextVideo.videoHeight });
      }
    }
  }, [getVideoElement, syncExternalVideoRef]);

  const setPrimaryVideoElement = useCallback((node: HTMLVideoElement | null) => {
    primaryVideoElementRef.current = node;
    if (leadLayerRef.current === 'primary') {
      videoRef.current = node;
    }
  }, [videoRef]);

  const setSecondaryVideoElement = useCallback((node: HTMLVideoElement | null) => {
    secondaryVideoRef.current = node;
    if (leadLayerRef.current === 'secondary') {
      videoRef.current = node;
    }
  }, [videoRef]);

  const getLeadVideo = useCallback(() => getVideoElement(leadLayerRef.current), [getVideoElement]);
  const getSpareVideo = useCallback(() => getVideoElement(getOtherLayer(leadLayerRef.current)), [getVideoElement]);

  useEffect(() => {
    syncExternalVideoRef(leadLayer);
  }, [leadLayer, syncExternalVideoRef]);

  useEffect(() => {
    const container = videoContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
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

  const pauseVideo = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    video.pause();
    video.volume = 0;
  }, []);

  const pauseInactiveVideo = useCallback(() => {
    pauseVideo(getSpareVideo());
  }, [getSpareVideo, pauseVideo]);

  const ensureLayerSource = useCallback((layer: LayerId, sourceId: string, sourceUrl: string) => {
    const video = getVideoElement(layer);
    if (!video || !sourceUrl) return;
    const changed = ensureVideoElementSource(video, sourceUrl);
    if (changed || layerSourceIdRef.current[layer] !== sourceId) {
      layerSourceIdRef.current[layer] = sourceId;
    }
  }, [getVideoElement]);

  const maybePromotePreparedLayer = useCallback((entry: RenderTimelineEntry, targetSourceTime: number) => {
    const currentLeadLayer = leadLayerRef.current;
    if (layerClipIdRef.current[currentLeadLayer] === entry.clipId) return false;
    const spareLayer = getOtherLayer(currentLeadLayer);
    const spareVideo = getVideoElement(spareLayer);
    if (
      !spareVideo
      || spareVideo.readyState < 2
      || layerClipIdRef.current[spareLayer] !== entry.clipId
      || layerSourceIdRef.current[spareLayer] !== entry.sourceId
    ) {
      return false;
    }
    if (Math.abs(spareVideo.currentTime - targetSourceTime) > DRIFT_EPSILON) {
      spareVideo.currentTime = Math.max(0, targetSourceTime);
    }
    setLeadLayerSafely(spareLayer);
    return true;
  }, [getVideoElement, setLeadLayerSafely]);

  const syncLayers = useCallback((timelineTime: number, options?: { allowPlay?: boolean }) => {
    const activeEntries = findRenderEntriesAtTime(renderTimeline, timelineTime);
    const primaryEntry = activeEntries[0];
    if (!primaryEntry) return;
    const primarySourceTime = getEntrySourceTime(primaryEntry, timelineTime);
    maybePromotePreparedLayer(primaryEntry, primarySourceTime);

    const leadLayerId = leadLayerRef.current;
    const primaryVideo = getVideoElement(leadLayerId);
    if (!primaryVideo || renderTimeline.length === 0) return;

    const primaryClip = clipById.get(primaryEntry.clipId);
    const primarySource = sourceById.get(primaryEntry.sourceId);
    if (!primaryClip) return;
    if (primarySource?.playerUrl) {
      ensureLayerSource(leadLayerId, primaryEntry.sourceId, primarySource.playerUrl);
    }

    if (Math.abs(primaryVideo.currentTime - primarySourceTime) > SEEK_EPSILON) {
      primaryVideo.currentTime = Math.max(0, primarySourceTime);
    }
    layerClipIdRef.current[leadLayerId] = primaryEntry.clipId;

    const primaryIndex = renderTimeline.findIndex((entry) => entry.clipId === primaryEntry.clipId);
    const upcomingEntry = activeEntries[1]
      ?? (primaryIndex >= 0 ? renderTimeline[primaryIndex + 1] ?? null : null);
    const spareLayerId = getOtherLayer(leadLayerId);
    const secondaryVideo = getVideoElement(spareLayerId);

    if (
      upcomingEntry
      && secondaryVideo
    ) {
      const upcomingSource = sourceById.get(upcomingEntry.sourceId);
      if (upcomingSource?.playerUrl) {
        ensureLayerSource(spareLayerId, upcomingEntry.sourceId, upcomingSource.playerUrl);
      }
      const upcomingSourceTime = getEntrySourceTime(upcomingEntry, timelineTime);
      if (Math.abs(secondaryVideo.currentTime - upcomingSourceTime) > DRIFT_EPSILON) {
        secondaryVideo.currentTime = Math.max(0, upcomingSourceTime);
      }
      layerClipIdRef.current[spareLayerId] = upcomingEntry.clipId;
    } else {
      layerClipIdRef.current[spareLayerId] = null;
    }

    if (activeEntries.length < 2) {
      applyClipEffects(primaryVideo, primaryClip, 1);
      pauseInactiveVideo();
      return;
    }

    const incomingEntry = activeEntries[1];
    const boundary = incomingEntry?.transitionIn;
    const incomingClip = incomingEntry ? clipById.get(incomingEntry.clipId) : null;

    if (!boundary || !incomingEntry || !incomingClip || !secondaryVideo) {
      applyClipEffects(primaryVideo, primaryClip, 1);
      pauseInactiveVideo();
      return;
    }

    const incomingSourceTime = getEntrySourceTime(incomingEntry, timelineTime);
    if (Math.abs(secondaryVideo.currentTime - incomingSourceTime) > DRIFT_EPSILON) {
      secondaryVideo.currentTime = Math.max(0, incomingSourceTime);
    }

    // Keep transition audio as a single active stream to avoid repeated speech
    // on jump-cut style transitions while still rendering the visual blend.
    applyClipEffects(primaryVideo, primaryClip, 1);
    applyClipEffects(secondaryVideo, incomingClip, 0);

    if (options?.allowPlay && playbackIntentRef.current) {
      if (primaryVideo.paused) {
        primaryVideo.play().catch(() => {});
      }
      if (secondaryVideo.paused) {
        secondaryVideo.play().catch(() => {});
      }
    } else {
      pauseVideo(secondaryVideo);
    }
  }, [applyClipEffects, clipById, ensureLayerSource, getVideoElement, maybePromotePreparedLayer, pauseInactiveVideo, pauseVideo, renderTimeline, sourceById]);

  const syncAfterSourceLoad = useCallback((layer: LayerId, video: HTMLVideoElement | null) => {
    if (!video) return;
    syncLayers(currentTimeRef.current, { allowPlay: playbackIntentRef.current });
    if (playbackIntentRef.current && leadLayerRef.current === layer && video.paused) {
      video.play().catch(() => {});
    }
  }, [syncLayers]);

  const seekToTimelineTime = useCallback((timelineTime: number) => {
    if (renderTimeline.length === 0) return;
    const clampedTimelineTime = Math.max(0, Math.min(totalTimelineDuration, timelineTime));
    currentTimeRef.current = clampedTimelineTime;
    setCurrentTime(clampedTimelineTime);
    syncLayers(clampedTimelineTime, { allowPlay: false });
  }, [renderTimeline.length, setCurrentTime, syncLayers, totalTimelineDuration]);

  const cancelPlaybackMonitor = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const primaryVideo = getLeadVideo() as VideoWithFrameCallback | null;
    if (
      videoFrameRequestRef.current !== null
      && primaryVideo
      && typeof primaryVideo.cancelVideoFrameCallback === 'function'
    ) {
      primaryVideo.cancelVideoFrameCallback(videoFrameRequestRef.current);
    }
    videoFrameRequestRef.current = null;
  }, [getLeadVideo]);

  const schedulePlaybackMonitor = useCallback(function schedulePlaybackMonitorImpl() {
    const primaryVideo = getLeadVideo() as VideoWithFrameCallback | null;
    if (!primaryVideo || primaryVideo.paused || primaryVideo.ended) return;
    if (videoFrameRequestRef.current !== null || animationFrameRef.current !== null) return;

    if (typeof primaryVideo.requestVideoFrameCallback === 'function') {
      videoFrameRequestRef.current = primaryVideo.requestVideoFrameCallback(() => {
        videoFrameRequestRef.current = null;
        playbackTickRef.current();
        schedulePlaybackMonitorImpl();
      });
      return;
    }

    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      playbackTickRef.current();
      schedulePlaybackMonitorImpl();
    });
  }, [getLeadVideo]);

  const handlePlaybackTick = useCallback(() => {
    const primaryVideo = getLeadVideo();
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
      const handoffTime = Math.max(nextEntry.timelineStart, primaryEntry.timelineEnd);
      currentTimeRef.current = handoffTime;
      setCurrentTime(handoffTime);
      const nextSourceTime = getEntrySourceTime(nextEntry, handoffTime);

      const spareLayerId = getOtherLayer(leadLayerRef.current);
      const spareVideo = getVideoElement(spareLayerId);
      const spareIsReady = Boolean(
        spareVideo
        && layerClipIdRef.current[spareLayerId] === nextEntry.clipId
        && layerSourceIdRef.current[spareLayerId] === nextEntry.sourceId
        && spareVideo.readyState >= 2,
      );

      if (spareVideo && spareIsReady) {
        if (Math.abs(spareVideo.currentTime - nextSourceTime) > DRIFT_EPSILON) {
          spareVideo.currentTime = Math.max(0, nextSourceTime);
        }
        pauseVideo(primaryVideo);
        setLeadLayerSafely(spareLayerId);
      } else {
        primaryVideo.currentTime = Math.max(0, nextSourceTime);
      }

      syncLayers(handoffTime, { allowPlay: true });
      const promotedVideo = getLeadVideo();
      if (playbackIntentRef.current && promotedVideo?.paused) {
        promotedVideo.play().catch(() => {});
      }
    } else {
      playbackIntentRef.current = false;
      primaryVideo.pause();
      pauseInactiveVideo();
      currentTimeRef.current = totalTimelineDuration;
      setCurrentTime(totalTimelineDuration);
    }
  }, [getLeadVideo, getVideoElement, pauseInactiveVideo, pauseVideo, renderTimeline, seekToTimelineTime, setCurrentTime, setLeadLayerSafely, syncLayers, totalTimelineDuration]);

  useEffect(() => {
    playbackTickRef.current = handlePlaybackTick;
  }, [handlePlaybackTick]);

  useEffect(() => {
    const primaryVideo = getLeadVideo();
    if (!primaryVideo) return;
    const syncTimelineFromMedia = () => {
      playbackTickRef.current();
    };

    const syncPlaybackState = () => {
      const isPlaying = !primaryVideo.paused && !primaryVideo.ended;
      setPlaybackActive(isPlaying);
      syncTimelineFromMedia();
      cancelPlaybackMonitor();
      if (isPlaying) {
        schedulePlaybackMonitor();
      }
    };

    syncPlaybackState();
    primaryVideo.addEventListener('play', syncPlaybackState);
    primaryVideo.addEventListener('pause', syncPlaybackState);
    primaryVideo.addEventListener('ended', syncPlaybackState);
    primaryVideo.addEventListener('timeupdate', syncTimelineFromMedia);
    primaryVideo.addEventListener('seeking', syncTimelineFromMedia);
    primaryVideo.addEventListener('seeked', syncTimelineFromMedia);
    primaryVideo.addEventListener('ratechange', syncTimelineFromMedia);

    return () => {
      primaryVideo.removeEventListener('play', syncPlaybackState);
      primaryVideo.removeEventListener('pause', syncPlaybackState);
      primaryVideo.removeEventListener('ended', syncPlaybackState);
      primaryVideo.removeEventListener('timeupdate', syncTimelineFromMedia);
      primaryVideo.removeEventListener('seeking', syncTimelineFromMedia);
      primaryVideo.removeEventListener('seeked', syncTimelineFromMedia);
      primaryVideo.removeEventListener('ratechange', syncTimelineFromMedia);
      cancelPlaybackMonitor();
      pauseInactiveVideo();
      setPlaybackActive(false);
    };
  }, [cancelPlaybackMonitor, getLeadVideo, handlePlaybackTick, leadLayer, pauseInactiveVideo, schedulePlaybackMonitor, setPlaybackActive]);

  useEffect(() => {
    const primaryVideo = getLeadVideo();
    if (!primaryVideo || renderTimeline.length === 0) return;

    const clampedTimelineTime = Math.max(0, Math.min(totalTimelineDuration, currentTimeRef.current));
    if (Math.abs(clampedTimelineTime - currentTimeRef.current) > SEEK_EPSILON) {
      seekToTimelineTime(clampedTimelineTime);
      return;
    }

    if (primaryVideo.paused) {
      seekToTimelineTime(clampedTimelineTime);
    } else {
      syncLayers(clampedTimelineTime, { allowPlay: true });
      schedulePlaybackMonitor();
    }
  }, [getLeadVideo, leadLayer, primaryLayerSourceId, renderTimeline, schedulePlaybackMonitor, seekToTimelineTime, syncLayers, totalTimelineDuration]);

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
      const primaryVideo = getLeadVideo();
      if (!primaryVideo) return;
      if (primaryVideo.paused) {
        playbackIntentRef.current = true;
        syncLayers(currentTimeRef.current, { allowPlay: true });
        const activeVideo = getLeadVideo();
        if (activeVideo) {
          activeVideo.play().catch(() => {});
        }
      } else {
        playbackIntentRef.current = false;
        primaryVideo.pause();
        pauseInactiveVideo();
      }
    },
  }), [getLeadVideo, pauseInactiveVideo, seekToTimelineTime, syncLayers]);

  const togglePlay = useCallback(() => {
    const primaryVideo = getLeadVideo();
    if (!primaryVideo) return;
    if (primaryVideo.paused) {
      playbackIntentRef.current = true;
      syncLayers(currentTimeRef.current, { allowPlay: true });
      const activeVideo = getLeadVideo();
      if (activeVideo) {
        activeVideo.play().catch(() => {});
      }
    } else {
      playbackIntentRef.current = false;
      primaryVideo.pause();
      pauseInactiveVideo();
    }
  }, [getLeadVideo, pauseInactiveVideo, syncLayers]);

  const primaryLayerOpacity = transitionMix
    ? (leadLayer === 'primary' ? transitionMix.outgoingOpacity : transitionMix.incomingOpacity)
    : (leadLayer === 'primary' ? 1 : 0);
  const secondaryLayerOpacity = transitionMix
    ? (leadLayer === 'secondary' ? transitionMix.outgoingOpacity : transitionMix.incomingOpacity)
    : (leadLayer === 'secondary' ? 1 : 0);
  const primaryLayerClipPath = transitionMix && leadLayer !== 'primary'
    ? transitionMix.incomingClipPath
    : 'inset(0 0 0 0)';
  const secondaryLayerClipPath = transitionMix && leadLayer !== 'secondary'
    ? transitionMix.incomingClipPath
    : 'inset(0 0 0 0)';

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
            cursor: 'pointer',
          }}
          onClick={togglePlay}
        >
          <video
            ref={setPrimaryVideoElement}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              pointerEvents: 'none',
              opacity: primaryLayerOpacity,
              clipPath: primaryLayerClipPath,
            }}
            onLoadedMetadata={(event) => {
              const el = event.currentTarget;
              const sourceId = layerSourceIdRef.current.primary;
              if (sourceId) {
                setSourceDuration(sourceId, el.duration);
              }
              if (leadLayerRef.current === 'primary') {
                setVideoDimensions({ width: el.videoWidth, height: el.videoHeight });
                setIsVideoReady(el.readyState >= 2);
                seekToTimelineTime(currentTimeRef.current);
              }
              syncAfterSourceLoad('primary', el);
            }}
            onLoadedData={(event) => {
              if (leadLayerRef.current === 'primary') {
                setIsVideoReady(event.currentTarget.readyState >= 2);
              }
              syncAfterSourceLoad('primary', event.currentTarget);
            }}
            onCanPlay={(event) => {
              if (leadLayerRef.current === 'primary') {
                setIsVideoReady(event.currentTarget.readyState >= 2);
              }
              syncAfterSourceLoad('primary', event.currentTarget);
            }}
            onLoadStart={() => {
              if (leadLayerRef.current === 'primary') {
                setIsVideoReady(false);
              }
            }}
            playsInline
            preload="auto"
          />

          <video
            ref={setSecondaryVideoElement}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              pointerEvents: 'none',
              opacity: secondaryLayerOpacity,
              clipPath: secondaryLayerClipPath,
            }}
            muted={false}
            playsInline
            preload="auto"
            onLoadedMetadata={(event) => {
              const sourceId = layerSourceIdRef.current.secondary;
              if (sourceId) {
                setSourceDuration(sourceId, event.currentTarget.duration);
              }
              if (leadLayerRef.current === 'secondary') {
                setVideoDimensions({
                  width: event.currentTarget.videoWidth,
                  height: event.currentTarget.videoHeight,
                });
                setIsVideoReady(event.currentTarget.readyState >= 2);
                seekToTimelineTime(currentTimeRef.current);
              }
              syncAfterSourceLoad('secondary', event.currentTarget);
            }}
            onLoadedData={(event) => {
              if (leadLayerRef.current === 'secondary') {
                setIsVideoReady(event.currentTarget.readyState >= 2);
              }
              syncAfterSourceLoad('secondary', event.currentTarget);
            }}
            onCanPlay={(event) => {
              if (leadLayerRef.current === 'secondary') {
                setIsVideoReady(event.currentTarget.readyState >= 2);
              }
              syncAfterSourceLoad('secondary', event.currentTarget);
            }}
            onLoadStart={() => {
              if (leadLayerRef.current === 'secondary') {
                setIsVideoReady(false);
              }
            }}
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
                  <div
                    style={{
                      maxWidth: '82%',
                      padding: '8px 14px',
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
                    {activeCaption.text}
                  </div>
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
