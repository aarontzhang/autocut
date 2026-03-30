'use client';

import { forwardRef, useImperativeHandle, useCallback, useRef, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import {
  buildRenderTimeline,
  findRenderEntriesAtTime,
  shouldUseSeparateVideoLayerForPlaybackHandoff,
} from '@/lib/playbackEngine';
import { buildCaptionRenderWindows } from '@/lib/timelineUtils';
import type { RenderTimelineEntry, VideoClip } from '@/lib/types';
import { describeSourceResolutionFailure, resolveProjectSources } from '@/lib/sourceMedia';
import { getTextOverlayFontSize, getTextOverlayPreviewPositionStyle } from '@/lib/textOverlays';

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
const PRELOAD_SEEK_EPSILON = 1 / 12; // ≈83ms — wider than one frame at 24fps, prevents re-seek loop
const SAME_SOURCE_HANDOFF_PRELOAD_WINDOW = 2.0;

type VideoFrameRequestCallback = (now: number, metadata: unknown) => void;
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};
type LayerId = 'primary' | 'secondary';
type PendingLayerSourceState = {
  token: number;
  sourceId: string | null;
  clipId: string | null;
  url: string | null;
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

function getEntrySourceTime(entry: RenderTimelineEntry, timelineTime: number) {
  const clampedTimelineTime = Math.max(entry.timelineStart, Math.min(timelineTime, entry.timelineEnd));
  return entry.sourceStart + (clampedTimelineTime - entry.timelineStart) * entry.speed;
}

function getBoundaryFadeState(entry: RenderTimelineEntry | null, timelineTime: number) {
  if (!entry) return null;

  if (entry.transitionOut) {
    const halfDuration = entry.transitionOut.duration / 2;
    if (halfDuration > 0) {
      const fadeStart = entry.transitionOut.atTime - halfDuration;
      if (timelineTime >= fadeStart && timelineTime < entry.transitionOut.atTime) {
        const progress = Math.max(0, Math.min(1, (timelineTime - fadeStart) / halfDuration));
        return {
          boundary: entry.transitionOut,
          phase: 'outgoing' as const,
          blackOpacity: progress,
          volumeMultiplier: 1 - progress,
        };
      }
    }
  }

  if (entry.transitionIn) {
    const halfDuration = entry.transitionIn.duration / 2;
    if (halfDuration > 0) {
      const fadeEnd = entry.transitionIn.atTime + halfDuration;
      if (timelineTime >= entry.transitionIn.atTime && timelineTime < fadeEnd) {
        const progress = Math.max(0, Math.min(1, (timelineTime - entry.transitionIn.atTime) / halfDuration));
        return {
          boundary: entry.transitionIn,
          phase: 'incoming' as const,
          blackOpacity: 1 - progress,
          volumeMultiplier: progress,
        };
      }
    }
  }

  return null;
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

function clearVideoElementSource(video: HTMLVideoElement | null) {
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.volume = 0;
  video.playbackRate = 1;
  video.style.filter = '';
}

function getOtherLayer(layer: LayerId): LayerId {
  return layer === 'primary' ? 'secondary' : 'primary';
}

function getPlayableSourceUrl(source: { playerUrl?: string; processingUrl?: string } | null | undefined) {
  const playerUrl = source?.playerUrl?.trim();
  if (playerUrl) return playerUrl;
  return source?.processingUrl?.trim() ?? '';
}

function normalizeVideoUrl(url: string | null | undefined) {
  if (!url) return '';
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

function shouldStartPreloadingUpcomingEntry(
  currentEntry: RenderTimelineEntry,
  upcomingEntry: RenderTimelineEntry | null,
  timelineTime: number,
) {
  if (!upcomingEntry) return false;
  if (!shouldUseSeparateVideoLayerForPlaybackHandoff(currentEntry, upcomingEntry)) {
    return false;
  }
  if (currentEntry.sourceId !== upcomingEntry.sourceId) {
    return true;
  }

  const timeUntilBoundary = Math.max(0, currentEntry.timelineEnd - timelineTime);
  return timeUntilBoundary <= SAME_SOURCE_HANDOFF_PRELOAD_WINDOW;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(({ videoRef }, ref) => {
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isVideoReady, setIsVideoReady] = useState(false);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [hasDisplayedFrame, setHasDisplayedFrame] = useState(false);
  const hasDisplayedFrameRef = useRef(false);
  const [leadLayer, setLeadLayer] = useState<LayerId>('primary');

  const primaryVideoElementRef = useRef<HTMLVideoElement | null>(null);
  const secondaryVideoRef = useRef<HTMLVideoElement | null>(null);
  const currentTimeRef = useRef(0);
  const playbackIntentRef = useRef(false);
  const videoContainerRef = useRef<HTMLDivElement>(null);
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
  const pendingLayerSourceRef = useRef<Record<LayerId, PendingLayerSourceState>>({
    primary: {
      token: 0,
      sourceId: null,
      clipId: null,
      url: null,
    },
    secondary: {
      token: 0,
      sourceId: null,
      clipId: null,
      url: null,
    },
  });
  const layerLoadTokenRef = useRef(0);
  const missingSourceRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryMissingSourceRef = useRef<((sourceId: string) => void) | null>(null);

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
  const previewSnapshot = useEditorStore((s) => s.previewSnapshot);
  const activeReviewSession = useEditorStore((s) => s.activeReviewSession);
  const liveClips = useEditorStore((s) => s.clips);
  const liveCaptions = useEditorStore((s) => s.captions);
  const liveTransitions = useEditorStore((s) => s.transitions);
  const liveTextOverlays = useEditorStore((s) => s.textOverlays);
  const liveImageOverlays = useEditorStore((s) => s.imageOverlays);
  const selectedItem = useEditorStore((s) => s.selectedItem);
  const setSelectedItem = useEditorStore((s) => s.setSelectedItem);
  const updateCaption = useEditorStore((s) => s.updateCaption);
  const updateTextOverlay = useEditorStore((s) => s.updateTextOverlay);
  const updateImageOverlay = useEditorStore((s) => s.updateImageOverlay);

  const [editingCaptionId, setEditingCaptionId] = useState<string | null>(null);
  const [isDraggingCaption, setIsDraggingCaption] = useState(false);
  const [editingTextOverlayId, setEditingTextOverlayId] = useState<string | null>(null);
  const captionEditRef = useRef<HTMLDivElement>(null);
  const textOverlayEditRef = useRef<HTMLDivElement>(null);
  const captionDragRef = useRef<{
    startX: number;
    startY: number;
    startPosX: number;
    startPosY: number;
    captionId: string;
    moved: boolean;
  } | null>(null);
  const imageDragRef = useRef<{
    startX: number;
    startY: number;
    startPosX: number;
    startPosY: number;
    overlayId: string;
    moved: boolean;
  } | null>(null);
  const imageResizeRef = useRef<{
    startX: number;
    startWidth: number;
    overlayId: string;
  } | null>(null);
  const textDragRef = useRef<{
    startX: number;
    startY: number;
    startPosX: number;
    startPosY: number;
    overlayId: string;
    moved: boolean;
  } | null>(null);

  const reviewPlaybackUsesBase = Boolean(
    activeReviewSession?.items.some((item) => item.action.type === 'delete_range'),
  );
  const playbackSnapshot = reviewPlaybackUsesBase && activeReviewSession
    ? activeReviewSession.baseSnapshot
    : (previewSnapshot ?? {
        clips: liveClips,
        captions: liveCaptions,
        transitions: liveTransitions,
        markers: [],
        textOverlays: liveTextOverlays,
      });
  const clips = playbackSnapshot.clips;
  const manualCaptions = playbackSnapshot.captions;
  const transitions = playbackSnapshot.transitions;
  const textOverlays = playbackSnapshot.textOverlays;

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
  const sourceMetaById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const renderTimeline = useMemo(() => buildRenderTimeline(clips, transitions), [clips, transitions]);
  const totalTimelineDuration = renderTimeline.length > 0
    ? renderTimeline[renderTimeline.length - 1].timelineEnd
    : videoDuration;
  const videoDisplaySize = useMemo(
    () => fitVideoFrame(containerSize, videoDimensions),
    [containerSize, videoDimensions],
  );
  const captionFontSize = useMemo(
    () => Math.max(12, Math.min(22, videoDisplaySize.width * 0.028)),
    [videoDisplaySize.width],
  );
  const captionStrokeWidth = useMemo(
    () => Math.max(1.75, Math.min(2.75, captionFontSize * 0.16)),
    [captionFontSize],
  );
  const captionMaxCharsPerLine = useMemo(() => {
    if (videoDisplaySize.width <= 0) return 28;
    const usableWidth = Math.max(180, videoDisplaySize.width * 0.8);
    const estimatedCharacterWidth = Math.max(8, captionFontSize * 0.9);
    return Math.max(12, Math.floor(usableWidth / estimatedCharacterWidth));
  }, [captionFontSize, videoDisplaySize.width]);
  const captionWindows = useMemo(
    () => buildCaptionRenderWindows(manualCaptions, { maxCharsPerLine: captionMaxCharsPerLine }),
    [captionMaxCharsPerLine, manualCaptions],
  );

  const activeEntriesAtCurrentTime = useMemo(() => (
    findRenderEntriesAtTime(renderTimeline, currentTime)
  ), [currentTime, renderTimeline]);
  const activeEntryAtCurrentTime = activeEntriesAtCurrentTime[0] ?? null;
  const currentBoundaryFade = useMemo(
    () => getBoundaryFadeState(activeEntryAtCurrentTime, currentTime),
    [activeEntryAtCurrentTime, currentTime],
  );
  const primaryLayerSourceId = activeEntryAtCurrentTime?.sourceId ?? renderTimeline[0]?.sourceId ?? null;

  const activeCaption = useMemo(
    () => captionWindows.find((window) => currentTime >= window.startTime && currentTime < window.endTime) ?? null,
    [captionWindows, currentTime],
  );
  const activeTextOverlays = useMemo(
    () => textOverlays.filter((overlay) => currentTime >= overlay.startTime && currentTime < overlay.endTime),
    [currentTime, textOverlays],
  );
  const imageOverlays = previewSnapshot?.imageOverlays ?? liveImageOverlays;
  const activeImageOverlays = useMemo(
    () => imageOverlays.filter((overlay) => currentTime >= overlay.startTime && currentTime < overlay.endTime),
    [currentTime, imageOverlays],
  );
  const getSourceErrorMessage = useCallback((sourceId: string) => {
    const resolvedSource = sourceById.get(sourceId);
    if (resolvedSource?.missingReason) return resolvedSource.missingReason;
    const source = sourceMetaById.get(sourceId);
    return describeSourceResolutionFailure({
      sourceId,
      fileName: source?.fileName ?? resolvedSource?.fileName,
      status: source?.status ?? resolvedSource?.status,
      storagePath: source?.storagePath ?? resolvedSource?.storagePath,
    });
  }, [sourceById, sourceMetaById]);
  const getResolvedPlayableUrl = useCallback((sourceId: string | null) => {
    if (!sourceId) return '';
    return getPlayableSourceUrl(sourceById.get(sourceId));
  }, [sourceById]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    hasDisplayedFrameRef.current = hasDisplayedFrame;
  }, [hasDisplayedFrame]);

  const getVideoElement = useCallback((layer: LayerId) => (
    layer === 'primary' ? primaryVideoElementRef.current : secondaryVideoRef.current
  ), []);
  const isLayerReady = useCallback((layer: LayerId) => {
    const video = getVideoElement(layer);
    return Boolean(video && video.readyState >= 2 && !video.error);
  }, [getVideoElement]);
  const clearPendingLayerSource = useCallback((layer: LayerId) => {
    pendingLayerSourceRef.current[layer] = {
      token: 0,
      sourceId: null,
      clipId: null,
      url: null,
    };
  }, []);
  const markPendingLayerSource = useCallback((layer: LayerId, nextState: Omit<PendingLayerSourceState, 'token'>) => {
    pendingLayerSourceRef.current[layer] = {
      token: layerLoadTokenRef.current + 1,
      ...nextState,
    };
    layerLoadTokenRef.current = pendingLayerSourceRef.current[layer].token;
  }, []);
  const reconcileLayerLoadSuccess = useCallback((layer: LayerId, video: HTMLVideoElement | null) => {
    if (!video) return;
    const pending = pendingLayerSourceRef.current[layer];
    if (!pending.url) return;
    const currentUrl = normalizeVideoUrl(video.currentSrc || video.src);
    const pendingUrl = normalizeVideoUrl(pending.url);
    if (currentUrl && pendingUrl && currentUrl === pendingUrl) {
      clearPendingLayerSource(layer);
    }
  }, [clearPendingLayerSource]);

  const syncExternalVideoRef = useCallback((layer: LayerId) => {
    videoRef.current = getVideoElement(layer);
  }, [getVideoElement, videoRef]);

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
  const refreshLeadVideoState = useCallback(() => {
    const leadVideo = getLeadVideo();
    if (!leadVideo) {
      setIsVideoReady(false);
      return;
    }
    const ready = leadVideo.readyState >= 2 && !leadVideo.error;
    setIsVideoReady(ready);
    if (ready) {
      setHasDisplayedFrame(true);
      setVideoLoadError(null);
    }
  }, [getLeadVideo]);

  const setLeadLayerSafely = useCallback((nextLayer: LayerId) => {
    leadLayerRef.current = nextLayer;
    setLeadLayer(nextLayer);
    syncExternalVideoRef(nextLayer);
    const nextVideo = getVideoElement(nextLayer);
    if (nextVideo) {
      setIsVideoReady(nextVideo.readyState >= 2 && !nextVideo.error);
      if (nextVideo.videoWidth > 0 && nextVideo.videoHeight > 0) {
        setVideoDimensions({ width: nextVideo.videoWidth, height: nextVideo.videoHeight });
      }
    }
    refreshLeadVideoState();
  }, [getVideoElement, refreshLeadVideoState, syncExternalVideoRef]);

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

  const clearLayer = useCallback((layer: LayerId) => {
    const video = getVideoElement(layer);
    const hasAssignedSource = Boolean(layerClipIdRef.current[layer] || layerSourceIdRef.current[layer]);
    const hasLoadedSource = Boolean(video?.currentSrc || video?.src);
    if (video && !hasAssignedSource && !hasLoadedSource) {
      video.volume = 0;
      clearPendingLayerSource(layer);
      return;
    }
    clearVideoElementSource(video);
    layerClipIdRef.current[layer] = null;
    layerSourceIdRef.current[layer] = null;
    clearPendingLayerSource(layer);
  }, [clearPendingLayerSource, getVideoElement]);

  const activateMissingSourceState = useCallback((sourceId: string) => {
    playbackIntentRef.current = false;

    const currentLeadLayer = leadLayerRef.current;
    const leadVideo = getVideoElement(currentLeadLayer);
    const leadHasFrame = leadVideo && leadVideo.readyState >= 2 && !leadVideo.error;

    // Always clear the spare layer (not visible)
    clearLayer(getOtherLayer(currentLeadLayer));

    // Only clear the lead layer if it doesn't have a valid frame — preserve
    // the last displayed frame so the user doesn't see a blank preview
    if (!leadHasFrame) {
      clearLayer(currentLeadLayer);
      setHasDisplayedFrame(false);
      hasDisplayedFrameRef.current = false;
    }

    setIsVideoReady(false);
    setVideoLoadError(getSourceErrorMessage(sourceId));
    setPlaybackActive(false);

    // Schedule a retry to recover from transient missing sources
    if (missingSourceRetryRef.current !== null) {
      clearTimeout(missingSourceRetryRef.current);
    }
    missingSourceRetryRef.current = setTimeout(() => {
      missingSourceRetryRef.current = null;
      retryMissingSourceRef.current?.(sourceId);
    }, 200);
  }, [clearLayer, getSourceErrorMessage, getVideoElement, setPlaybackActive]);

  useEffect(() => {
    const validClipIds = new Set(renderTimeline.map((entry) => entry.clipId));
    const validSourceIds = new Set(renderTimeline.map((entry) => entry.sourceId));
    (['primary', 'secondary'] as LayerId[]).forEach((layer) => {
      const clipId = layerClipIdRef.current[layer];
      const sourceId = layerSourceIdRef.current[layer];
      if (clipId && !validClipIds.has(clipId)) {
        layerClipIdRef.current[layer] = null;
      }
      if (sourceId && !validSourceIds.has(sourceId)) {
        layerSourceIdRef.current[layer] = null;
      }
    });

    if (renderTimeline.length === 0) {
      clearLayer('primary');
      clearLayer('secondary');
      setIsVideoReady(false);
      setHasDisplayedFrame(false);
      setVideoLoadError(null);
    }
  }, [clearLayer, pauseVideo, renderTimeline]);

  const pauseInactiveVideo = useCallback(() => {
    pauseVideo(getSpareVideo());
  }, [getSpareVideo, pauseVideo]);

  const ensureLayerSource = useCallback((layer: LayerId, sourceId: string, sourceUrl: string, clipId?: string | null) => {
    const video = getVideoElement(layer);
    if (!video || !sourceUrl) return false;

    // If this is the lead layer, the source ID already matches, and we have a
    // ready frame, skip the URL comparison to avoid reloading due to URL format
    // changes (e.g., signed URL rotation for the same underlying media).
    const isLeadLayer = layer === leadLayerRef.current;
    const sourceIdAlreadyMatches = layerSourceIdRef.current[layer] === sourceId;
    if (isLeadLayer && sourceIdAlreadyMatches && video.readyState >= 2 && !video.error) {
      if (clipId !== undefined) {
        layerClipIdRef.current[layer] = clipId;
      }
      return false;
    }

    const changed = ensureVideoElementSource(video, sourceUrl);
    if (changed || layerSourceIdRef.current[layer] !== sourceId) {
      layerSourceIdRef.current[layer] = sourceId;
    }
    if (clipId !== undefined) {
      layerClipIdRef.current[layer] = clipId;
    }
    if (changed) {
      markPendingLayerSource(layer, {
        sourceId,
        clipId: clipId ?? null,
        url: sourceUrl,
      });
    } else if (isLayerReady(layer)) {
      clearPendingLayerSource(layer);
    }
    return changed;
  }, [clearPendingLayerSource, getVideoElement, isLayerReady, markPendingLayerSource]);

  const prepareLayerForEntry = useCallback((layer: LayerId, entry: RenderTimelineEntry, sourceTime: number) => {
    const sourceUrl = getResolvedPlayableUrl(entry.sourceId);
    if (!sourceUrl) {
      return {
        status: 'missing' as const,
        video: getVideoElement(layer),
      };
    }
    ensureLayerSource(layer, entry.sourceId, sourceUrl, entry.clipId);
    const video = getVideoElement(layer);
    if (!video) {
      return {
        status: 'loading' as const,
        video: null,
      };
    }
    if (Math.abs(video.currentTime - sourceTime) > DRIFT_EPSILON) {
      video.currentTime = Math.max(0, sourceTime);
    }
    return {
      status: isLayerReady(layer) ? 'ready' as const : 'loading' as const,
      video,
    };
  }, [ensureLayerSource, getResolvedPlayableUrl, getVideoElement, isLayerReady]);

  const maybePromotePreparedLayer = useCallback((entry: RenderTimelineEntry, targetSourceTime: number) => {
    const currentLeadLayer = leadLayerRef.current;
    if (layerClipIdRef.current[currentLeadLayer] === entry.clipId) return false;
    const spareLayer = getOtherLayer(currentLeadLayer);
    const currentLeadVideo = getVideoElement(currentLeadLayer);
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
    pauseVideo(currentLeadVideo);
    setLeadLayerSafely(spareLayer);
    return true;
  }, [getVideoElement, pauseVideo, setLeadLayerSafely]);

  const syncLayers = useCallback((timelineTime: number, options?: { allowPlay?: boolean }) => {
    const activeEntries = findRenderEntriesAtTime(renderTimeline, timelineTime);
    const primaryEntry = activeEntries[0];
    if (!primaryEntry) return;
    const primarySourceUrl = getResolvedPlayableUrl(primaryEntry.sourceId);
    if (!primarySourceUrl) {
      activateMissingSourceState(primaryEntry.sourceId);
      return;
    }
    const primarySourceTime = getEntrySourceTime(primaryEntry, timelineTime);
    maybePromotePreparedLayer(primaryEntry, primarySourceTime);

    const currentLeadLayer = leadLayerRef.current;
    const currentLeadVideo = getVideoElement(currentLeadLayer);
    const leadHasReadyFrame = Boolean(currentLeadVideo && currentLeadVideo.readyState >= 2 && !currentLeadVideo.error && hasDisplayedFrameRef.current);
    const leadMatchesPrimary = (
      layerSourceIdRef.current[currentLeadLayer] === primaryEntry.sourceId
      && layerClipIdRef.current[currentLeadLayer] === primaryEntry.clipId
    );
    if (!leadMatchesPrimary) {
      // If the lead has any source loaded, prepare on spare layer to avoid
      // blanking the visible video. Only load directly on lead when it's
      // completely empty (initial load) for fastest first-frame display.
      const leadHasAnySource = Boolean(layerSourceIdRef.current[currentLeadLayer]);
      const targetLayer = leadHasAnySource ? getOtherLayer(currentLeadLayer) : currentLeadLayer;
      const preparedPrimaryLayer = prepareLayerForEntry(targetLayer, primaryEntry, primarySourceTime);
      if (preparedPrimaryLayer.status === 'missing') {
        activateMissingSourceState(primaryEntry.sourceId);
        return;
      }
      if (targetLayer !== currentLeadLayer) {
        if (preparedPrimaryLayer.status === 'ready') {
          pauseVideo(currentLeadVideo);
          setLeadLayerSafely(targetLayer);
        }
        // If 'loading', keep the current lead visible until spare is ready.
        // syncAfterSourceLoad will re-trigger syncLayers when loading completes.
      }
    }

    const leadLayerId = leadLayerRef.current;
    const primaryVideo = getVideoElement(leadLayerId);
    if (!primaryVideo || renderTimeline.length === 0) return;
    if (layerSourceIdRef.current[leadLayerId] !== primaryEntry.sourceId) {
      refreshLeadVideoState();
      return;
    }
    const primaryClip = clipById.get(primaryEntry.clipId);
    if (!primaryClip) return;
    ensureLayerSource(leadLayerId, primaryEntry.sourceId, primarySourceUrl, primaryEntry.clipId);

    if (Math.abs(primaryVideo.currentTime - primarySourceTime) > SEEK_EPSILON) {
      primaryVideo.currentTime = Math.max(0, primarySourceTime);
    }
    layerClipIdRef.current[leadLayerId] = primaryEntry.clipId;

    const primaryIndex = renderTimeline.findIndex((entry) => entry.clipId === primaryEntry.clipId);
    const upcomingEntry = primaryIndex >= 0 ? renderTimeline[primaryIndex + 1] ?? null : null;
    const spareLayerId = getOtherLayer(leadLayerId);
    const secondaryVideo = getVideoElement(spareLayerId);
    const shouldPreloadUpcomingLayer = Boolean(
      upcomingEntry
      && secondaryVideo
      // Cross-source handoffs can stay warm the whole time. Same-source jumps
      // are only preloaded shortly before the cut so we avoid keeping two
      // decoders pinned to the same media asset during normal playback.
      && shouldStartPreloadingUpcomingEntry(primaryEntry, upcomingEntry, timelineTime),
    );

    if (
      shouldPreloadUpcomingLayer
      && upcomingEntry
      && secondaryVideo
    ) {
      const upcomingSourceUrl = getResolvedPlayableUrl(upcomingEntry.sourceId);
      if (upcomingSourceUrl) {
        ensureLayerSource(spareLayerId, upcomingEntry.sourceId, upcomingSourceUrl, upcomingEntry.clipId);
        const upcomingSourceTime = getEntrySourceTime(upcomingEntry, timelineTime);
        if (Math.abs(secondaryVideo.currentTime - upcomingSourceTime) > PRELOAD_SEEK_EPSILON) {
          secondaryVideo.currentTime = Math.max(0, upcomingSourceTime);
        }
        pauseVideo(secondaryVideo);
      } else {
        clearLayer(spareLayerId);
      }
    } else {
      clearLayer(spareLayerId);
    }

    const boundaryFade = getBoundaryFadeState(primaryEntry, timelineTime);
    applyClipEffects(primaryVideo, primaryClip, boundaryFade?.volumeMultiplier ?? 1);

    if (secondaryVideo) {
      secondaryVideo.volume = 0;
    }

    if (options?.allowPlay && playbackIntentRef.current && primaryVideo.paused) {
      primaryVideo.play().catch(() => {});
    }
    refreshLeadVideoState();
  }, [activateMissingSourceState, applyClipEffects, clearLayer, clipById, ensureLayerSource, getResolvedPlayableUrl, getVideoElement, maybePromotePreparedLayer, pauseVideo, prepareLayerForEntry, refreshLeadVideoState, renderTimeline, setLeadLayerSafely]);

  useEffect(() => {
    retryMissingSourceRef.current = (sourceId: string) => {
      const url = getResolvedPlayableUrl(sourceId);
      if (url) {
        setVideoLoadError(null);
        syncLayers(currentTimeRef.current, { allowPlay: playbackIntentRef.current });
      }
    };
  }, [getResolvedPlayableUrl, syncLayers]);

  useEffect(() => {
    return () => {
      if (missingSourceRetryRef.current !== null) {
        clearTimeout(missingSourceRetryRef.current);
      }
    };
  }, []);

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

    const primaryEntry = findRenderEntriesAtTime(renderTimeline, currentTimeRef.current)[0] ?? renderTimeline[0];
    if (layerSourceIdRef.current[leadLayerRef.current] !== primaryEntry.sourceId) {
      syncLayers(currentTimeRef.current, { allowPlay: playbackIntentRef.current });
      return;
    }
    const primaryIndex = renderTimeline.findIndex((entry) => entry.clipId === primaryEntry.clipId);
    const nextEntry = primaryIndex >= 0 ? renderTimeline[primaryIndex + 1] ?? null : null;
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
    } else if (nextEntry) {
      const handoffTime = Math.max(nextEntry.timelineStart, primaryEntry.timelineEnd);
      currentTimeRef.current = handoffTime;
      setCurrentTime(handoffTime);
      const nextSourceTime = getEntrySourceTime(nextEntry, handoffTime);
      const shouldStayOnLeadLayer = !shouldUseSeparateVideoLayerForPlaybackHandoff(primaryEntry, nextEntry);

      if (shouldStayOnLeadLayer) {
        if (Math.abs(primaryVideo.currentTime - nextSourceTime) > DRIFT_EPSILON) {
          primaryVideo.currentTime = Math.max(0, nextSourceTime);
        }
        layerClipIdRef.current[leadLayerRef.current] = nextEntry.clipId;
        syncLayers(handoffTime, { allowPlay: true });
        if (playbackIntentRef.current && primaryVideo.paused) {
          primaryVideo.play().catch(() => {});
        }
        return;
      }

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
        if (!getResolvedPlayableUrl(nextEntry.sourceId)) {
          activateMissingSourceState(nextEntry.sourceId);
          return;
        }
        prepareLayerForEntry(spareLayerId, nextEntry, nextSourceTime);
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
      syncLayers(totalTimelineDuration, { allowPlay: false });
    }
  }, [activateMissingSourceState, getLeadVideo, getResolvedPlayableUrl, getVideoElement, pauseInactiveVideo, pauseVideo, prepareLayerForEntry, renderTimeline, setCurrentTime, setLeadLayerSafely, syncLayers, totalTimelineDuration]);

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
    refreshLeadVideoState();
  }, [getLeadVideo, leadLayer, primaryLayerSourceId, refreshLeadVideoState, renderTimeline, schedulePlaybackMonitor, seekToTimelineTime, syncLayers, totalTimelineDuration]);

  const handleLayerError = useCallback((layer: LayerId, video: HTMLVideoElement) => {
    const errorCode = video.error?.code ?? 0;
    if (errorCode === 1 || video.readyState >= 2) {
      refreshLeadVideoState();
      return;
    }
    const sourceId = layerSourceIdRef.current[layer];
    const pending = pendingLayerSourceRef.current[layer];
    const currentUrl = normalizeVideoUrl(video.currentSrc || video.src);
    const pendingUrl = normalizeVideoUrl(pending.url);
    const pendingMatchesCurrentSource = Boolean(
      sourceId
      && pending.sourceId === sourceId
      && pendingUrl
      && (!currentUrl || currentUrl === pendingUrl),
    );
    if (!pendingMatchesCurrentSource) {
      refreshLeadVideoState();
      return;
    }
    if (getResolvedPlayableUrl(sourceId)) {
      refreshLeadVideoState();
      return;
    }
    if (sourceId) {
      activateMissingSourceState(sourceId);
      return;
    }
    if (leadLayerRef.current !== layer) return;
    setIsVideoReady(false);
    setHasDisplayedFrame(false);
    setVideoLoadError('Could not load this video source.');
  }, [activateMissingSourceState, getResolvedPlayableUrl, refreshLeadVideoState]);

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

  const primaryLayerOpacity = leadLayer === 'primary' ? 1 : 0;
  const secondaryLayerOpacity = leadLayer === 'secondary' ? 1 : 0;

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
            }}
            onLoadedMetadata={(event) => {
              const el = event.currentTarget;
              reconcileLayerLoadSuccess('primary', el);
              setVideoLoadError(null);
              const sourceId = layerSourceIdRef.current.primary;
              if (sourceId) {
                setSourceDuration(sourceId, el.duration);
              }
              if (leadLayerRef.current === 'primary') {
                setVideoDimensions({ width: el.videoWidth, height: el.videoHeight });
                setIsVideoReady(el.readyState >= 2 && !el.error);
                if (el.readyState >= 2) {
                  setHasDisplayedFrame(true);
                }
                seekToTimelineTime(currentTimeRef.current);
              }
              syncAfterSourceLoad('primary', el);
            }}
            onLoadedData={(event) => {
              reconcileLayerLoadSuccess('primary', event.currentTarget);
              setVideoLoadError(null);
              if (leadLayerRef.current === 'primary') {
                setIsVideoReady(event.currentTarget.readyState >= 2 && !event.currentTarget.error);
                if (event.currentTarget.readyState >= 2) {
                  setHasDisplayedFrame(true);
                }
              }
              syncAfterSourceLoad('primary', event.currentTarget);
            }}
            onCanPlay={(event) => {
              reconcileLayerLoadSuccess('primary', event.currentTarget);
              setVideoLoadError(null);
              if (leadLayerRef.current === 'primary') {
                setIsVideoReady(event.currentTarget.readyState >= 2 && !event.currentTarget.error);
                if (event.currentTarget.readyState >= 2) {
                  setHasDisplayedFrame(true);
                }
              }
              syncAfterSourceLoad('primary', event.currentTarget);
            }}
            onLoadStart={() => {
              if (!layerSourceIdRef.current.primary) return;
              setVideoLoadError(null);
              if (leadLayerRef.current === 'primary') {
                setIsVideoReady(false);
              }
            }}
            onError={(event) => {
              handleLayerError('primary', event.currentTarget);
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
            }}
            muted={false}
            playsInline
            preload="auto"
            onLoadedMetadata={(event) => {
              reconcileLayerLoadSuccess('secondary', event.currentTarget);
              setVideoLoadError(null);
              const sourceId = layerSourceIdRef.current.secondary;
              if (sourceId) {
                setSourceDuration(sourceId, event.currentTarget.duration);
              }
              if (leadLayerRef.current === 'secondary') {
                setVideoDimensions({
                  width: event.currentTarget.videoWidth,
                  height: event.currentTarget.videoHeight,
                });
                setIsVideoReady(event.currentTarget.readyState >= 2 && !event.currentTarget.error);
                if (event.currentTarget.readyState >= 2) {
                  setHasDisplayedFrame(true);
                }
                seekToTimelineTime(currentTimeRef.current);
              }
              syncAfterSourceLoad('secondary', event.currentTarget);
            }}
            onLoadedData={(event) => {
              reconcileLayerLoadSuccess('secondary', event.currentTarget);
              setVideoLoadError(null);
              if (leadLayerRef.current === 'secondary') {
                setIsVideoReady(event.currentTarget.readyState >= 2 && !event.currentTarget.error);
                if (event.currentTarget.readyState >= 2) {
                  setHasDisplayedFrame(true);
                }
              }
              syncAfterSourceLoad('secondary', event.currentTarget);
            }}
            onCanPlay={(event) => {
              reconcileLayerLoadSuccess('secondary', event.currentTarget);
              setVideoLoadError(null);
              if (leadLayerRef.current === 'secondary') {
                setIsVideoReady(event.currentTarget.readyState >= 2 && !event.currentTarget.error);
                if (event.currentTarget.readyState >= 2) {
                  setHasDisplayedFrame(true);
                }
              }
              syncAfterSourceLoad('secondary', event.currentTarget);
            }}
            onLoadStart={() => {
              if (!layerSourceIdRef.current.secondary) return;
              setVideoLoadError(null);
              if (leadLayerRef.current === 'secondary') {
                setIsVideoReady(false);
              }
            }}
            onError={(event) => {
              handleLayerError('secondary', event.currentTarget);
            }}
          />

          {currentBoundaryFade && currentBoundaryFade.blackOpacity > 0 && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: '#000',
                opacity: currentBoundaryFade.blackOpacity,
                pointerEvents: 'none',
              }}
            />
          )}

          {(videoLoadError || (!isVideoReady && !hasDisplayedFrame)) && (
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
              {videoLoadError ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: 'rgba(255,255,255,0.82)', textAlign: 'center', maxWidth: 220 }}>
                  <span style={{ fontSize: 12, fontFamily: 'var(--font-serif)' }}>{videoLoadError}</span>
                </div>
              ) : (
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
              )}
            </div>
          )}

          {videoDisplaySize.width > 0 && (activeCaption || activeTextOverlays.length > 0 || activeImageOverlays.length > 0) && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {activeCaption && (() => {
                const isSelected = selectedItem?.type === 'caption' && selectedItem.id === activeCaption.captionId;
                const isEditing = editingCaptionId === activeCaption.captionId;
                const hasCustomPosition = activeCaption.positionX != null && activeCaption.positionY != null;

                const positionStyle: React.CSSProperties = hasCustomPosition
                  ? {
                      position: 'absolute',
                      left: `${activeCaption.positionX}%`,
                      top: `${activeCaption.positionY}%`,
                      transform: 'translate(-50%, -50%)',
                      maxWidth: `${videoDisplaySize.width * 0.86}px`,
                      boxSizing: 'border-box',
                    }
                  : {
                      position: 'absolute',
                      bottom: Math.max(18, videoDisplaySize.height * 0.065),
                      left: '50%',
                      transform: 'translateX(-50%)',
                      width: videoDisplaySize.width,
                      padding: `0 ${Math.max(20, videoDisplaySize.width * 0.07)}px`,
                      boxSizing: 'border-box',
                    };

                const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
                  if (isEditing || !activeCaption.captionId) return;
                  e.stopPropagation();
                  const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                  captionDragRef.current = {
                    startX: e.clientX,
                    startY: e.clientY,
                    startPosX: activeCaption.positionX ?? 50,
                    startPosY: hasCustomPosition
                      ? activeCaption.positionY!
                      : ((1 - 0.065) * 100),
                    captionId: activeCaption.captionId,
                    moved: false,
                  };

                  const handlePointerMove = (ev: globalThis.PointerEvent) => {
                    if (!captionDragRef.current) return;
                    const dx = ev.clientX - captionDragRef.current.startX;
                    const dy = ev.clientY - captionDragRef.current.startY;
                    if (!captionDragRef.current.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
                    captionDragRef.current.moved = true;
                    setIsDraggingCaption(true);
                    const pctX = captionDragRef.current.startPosX + (dx / rect.width) * 100;
                    const pctY = captionDragRef.current.startPosY + (dy / rect.height) * 100;
                    const clampedX = Math.max(5, Math.min(95, pctX));
                    const clampedY = Math.max(5, Math.min(95, pctY));
                    updateCaption(captionDragRef.current.captionId, {
                      positionX: clampedX,
                      positionY: clampedY,
                    });
                  };

                  const handlePointerUp = () => {
                    window.removeEventListener('pointermove', handlePointerMove);
                    window.removeEventListener('pointerup', handlePointerUp);
                    const wasDrag = captionDragRef.current?.moved;
                    captionDragRef.current = null;
                    setIsDraggingCaption(false);
                    if (!wasDrag && activeCaption.captionId) {
                      setSelectedItem({ type: 'caption', id: activeCaption.captionId });
                    }
                  };

                  window.addEventListener('pointermove', handlePointerMove);
                  window.addEventListener('pointerup', handlePointerUp);
                };

                const handleDoubleClick = () => {
                  if (!activeCaption.captionId) return;
                  setSelectedItem({ type: 'caption', id: activeCaption.captionId });
                  setEditingCaptionId(activeCaption.captionId);
                  requestAnimationFrame(() => {
                    if (captionEditRef.current) {
                      captionEditRef.current.focus();
                      const sel = window.getSelection();
                      if (sel) {
                        sel.selectAllChildren(captionEditRef.current);
                        sel.collapseToEnd();
                      }
                    }
                  });
                };

                const handleBlur = () => {
                  if (!isEditing || !activeCaption.captionId) return;
                  const newText = captionEditRef.current?.innerText?.trim();
                  if (newText && newText !== activeCaption.text) {
                    updateCaption(activeCaption.captionId, { text: newText, words: undefined });
                  }
                  setEditingCaptionId(null);
                };

                const handleKeyDown = (e: React.KeyboardEvent) => {
                  if (!isEditing) return;
                  e.stopPropagation();
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    (e.target as HTMLElement).blur();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    if (captionEditRef.current) {
                      captionEditRef.current.innerText = activeCaption.text;
                    }
                    setEditingCaptionId(null);
                  }
                };

                return (
                  <div
                    style={{
                      ...positionStyle,
                      pointerEvents: 'auto',
                      cursor: isEditing ? 'text' : isDraggingCaption ? 'grabbing' : 'grab',
                    }}
                    onPointerDown={handlePointerDown}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={handleDoubleClick}
                  >
                    <div
                      ref={isEditing ? captionEditRef : undefined}
                      contentEditable={isEditing}
                      suppressContentEditableWarning
                      onBlur={handleBlur}
                      onKeyDown={handleKeyDown}
                      style={{
                        width: '100%',
                        color: '#fff',
                        fontSize: captionFontSize,
                        fontWeight: 900,
                        lineHeight: 1.12,
                        textAlign: 'center',
                        textShadow: '0 2px 8px rgba(0,0,0,0.45)',
                        WebkitTextStroke: `${captionStrokeWidth}px #000`,
                        paintOrder: 'stroke fill',
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'break-word',
                        wordBreak: 'break-word',
                        boxSizing: 'border-box',
                        outline: isSelected ? '2px solid rgba(33,212,255,0.7)' : 'none',
                        outlineOffset: 4,
                        borderRadius: 4,
                        caretColor: isEditing ? '#fff' : 'transparent',
                      }}
                    >
                      {activeCaption.text}
                    </div>
                  </div>
                );
              })()}

              {activeTextOverlays.map((overlay) => {
                const isTextSelected = selectedItem?.type === 'text' && selectedItem.id === overlay.id;
                const isTextEditing = editingTextOverlayId === overlay.id;
                const hasCustomPos = overlay.positionX != null && overlay.positionY != null;
                const textPositionStyle: React.CSSProperties = hasCustomPos
                  ? {
                      position: 'absolute',
                      left: `${overlay.positionX}%`,
                      top: `${overlay.positionY}%`,
                      transform: 'translate(-50%, -50%)',
                      maxWidth: '90%',
                    }
                  : {
                      position: 'absolute',
                      left: '50%',
                      maxWidth: '90%',
                      ...getTextOverlayPreviewPositionStyle(overlay.position, videoDisplaySize.height, overlay.positionX, overlay.positionY),
                    };
                return (
                  <div
                    key={overlay.id ?? overlay.text}
                    style={{
                      ...textPositionStyle,
                      color: '#fff',
                      fontSize: getTextOverlayFontSize(overlay),
                      fontWeight: 700,
                      lineHeight: 1.3,
                      textAlign: 'center',
                      textShadow: '0 2px 8px rgba(0,0,0,0.8), 0 1px 2px rgba(0,0,0,0.9)',
                      padding: '4px 12px',
                      whiteSpace: isTextEditing ? 'pre-wrap' : 'nowrap',
                      overflow: isTextEditing ? 'visible' : 'hidden',
                      textOverflow: isTextEditing ? 'unset' : 'ellipsis',
                      pointerEvents: 'auto',
                      cursor: isTextEditing ? 'text' : 'grab',
                      outline: isTextSelected ? '2px solid rgba(33,212,255,0.7)' : 'none',
                      outlineOffset: 4,
                      borderRadius: 4,
                      zIndex: isTextSelected ? 10 : 1,
                      userSelect: isTextEditing ? 'text' : 'none',
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isTextEditing) setSelectedItem({ type: 'text', id: overlay.id! });
                    }}
                    onPointerDown={(e) => {
                      if (isTextEditing || !overlay.id) return;
                      e.stopPropagation();
                      const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                      const defaultPosX = overlay.positionX ?? 50;
                      const defaultPosY = overlay.positionY ?? (
                        overlay.position === 'top' ? 10 : overlay.position === 'center' ? 50 : 85
                      );
                      textDragRef.current = {
                        startX: e.clientX,
                        startY: e.clientY,
                        startPosX: defaultPosX,
                        startPosY: defaultPosY,
                        overlayId: overlay.id,
                        moved: false,
                      };
                      const onMove = (ev: globalThis.PointerEvent) => {
                        if (!textDragRef.current) return;
                        const dx = ev.clientX - textDragRef.current.startX;
                        const dy = ev.clientY - textDragRef.current.startY;
                        if (!textDragRef.current.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
                        textDragRef.current.moved = true;
                        const pctX = textDragRef.current.startPosX + (dx / rect.width) * 100;
                        const pctY = textDragRef.current.startPosY + (dy / rect.height) * 100;
                        updateTextOverlay(textDragRef.current.overlayId, {
                          positionX: Math.max(5, Math.min(95, pctX)),
                          positionY: Math.max(5, Math.min(95, pctY)),
                        });
                      };
                      const onUp = () => {
                        window.removeEventListener('pointermove', onMove);
                        window.removeEventListener('pointerup', onUp);
                        if (!textDragRef.current?.moved && overlay.id) {
                          setSelectedItem({ type: 'text', id: overlay.id });
                        }
                        textDragRef.current = null;
                      };
                      window.addEventListener('pointermove', onMove);
                      window.addEventListener('pointerup', onUp);
                    }}
                    onDoubleClick={() => {
                      if (!overlay.id) return;
                      setSelectedItem({ type: 'text', id: overlay.id });
                      setEditingTextOverlayId(overlay.id);
                      requestAnimationFrame(() => {
                        if (textOverlayEditRef.current) {
                          textOverlayEditRef.current.focus();
                          const sel = window.getSelection();
                          if (sel) {
                            sel.selectAllChildren(textOverlayEditRef.current);
                            sel.collapseToEnd();
                          }
                        }
                      });
                    }}
                  >
                    <div
                      ref={isTextEditing ? textOverlayEditRef : undefined}
                      contentEditable={isTextEditing}
                      suppressContentEditableWarning
                      onBlur={() => {
                        if (!isTextEditing || !overlay.id) return;
                        const newText = textOverlayEditRef.current?.innerText?.trim();
                        if (newText && newText !== overlay.text) {
                          updateTextOverlay(overlay.id, { text: newText });
                        }
                        setEditingTextOverlayId(null);
                      }}
                      onKeyDown={(e) => {
                        if (!isTextEditing) return;
                        e.stopPropagation();
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          (e.target as HTMLElement).blur();
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditingTextOverlayId(null);
                        }
                      }}
                      style={{ caretColor: isTextEditing ? '#fff' : 'transparent' }}
                    >
                      {overlay.text}
                    </div>
                  </div>
                );
              })}

              {activeImageOverlays.map((overlay) => {
                const runtime = sourceRuntimeById[overlay.sourceId];
                const src = runtime?.objectUrl || runtime?.playerUrl || '';
                if (!src) return null;
                const isImgSelected = selectedItem?.type === 'image' && selectedItem.id === overlay.id;
                return (
                  <div
                    key={overlay.id}
                    style={{
                      position: 'absolute',
                      left: `${overlay.positionX}%`,
                      top: `${overlay.positionY}%`,
                      transform: 'translate(-50%, -50%)',
                      width: `${overlay.widthPercent}%`,
                      opacity: overlay.opacity,
                      pointerEvents: 'auto',
                      cursor: 'grab',
                      outline: isImgSelected ? '2px solid rgba(33,212,255,0.7)' : 'none',
                      outlineOffset: 2,
                      zIndex: isImgSelected ? 10 : 1,
                      userSelect: 'none',
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedItem({ type: 'image', id: overlay.id });
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                      imageDragRef.current = {
                        startX: e.clientX,
                        startY: e.clientY,
                        startPosX: overlay.positionX,
                        startPosY: overlay.positionY,
                        overlayId: overlay.id,
                        moved: false,
                      };
                      const onMove = (ev: globalThis.PointerEvent) => {
                        if (!imageDragRef.current) return;
                        const dx = ev.clientX - imageDragRef.current.startX;
                        const dy = ev.clientY - imageDragRef.current.startY;
                        if (!imageDragRef.current.moved && Math.abs(dx) + Math.abs(dy) > 3) {
                          imageDragRef.current.moved = true;
                        }
                        if (!imageDragRef.current.moved) return;
                        const pctX = imageDragRef.current.startPosX + (dx / rect.width) * 100;
                        const pctY = imageDragRef.current.startPosY + (dy / rect.height) * 100;
                        updateImageOverlay(imageDragRef.current.overlayId, {
                          positionX: Math.max(5, Math.min(95, pctX)),
                          positionY: Math.max(5, Math.min(95, pctY)),
                        });
                      };
                      const onUp = () => {
                        window.removeEventListener('pointermove', onMove);
                        window.removeEventListener('pointerup', onUp);
                        if (!imageDragRef.current?.moved) {
                          setSelectedItem({ type: 'image', id: overlay.id });
                        }
                        imageDragRef.current = null;
                      };
                      window.addEventListener('pointermove', onMove);
                      window.addEventListener('pointerup', onUp);
                    }}
                  >
                    <img
                      src={src}
                      draggable={false}
                      style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 4 }}
                      alt=""
                    />
                    {isImgSelected && (
                      <div
                        style={{
                          position: 'absolute',
                          bottom: -4,
                          right: -4,
                          width: 12,
                          height: 12,
                          background: 'rgba(33,212,255,0.9)',
                          borderRadius: 2,
                          cursor: 'nwse-resize',
                        }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const r = (e.currentTarget.parentElement!.parentElement as HTMLElement).getBoundingClientRect();
                          imageResizeRef.current = {
                            startX: e.clientX,
                            startWidth: overlay.widthPercent,
                            overlayId: overlay.id,
                          };
                          const onMove = (ev: globalThis.PointerEvent) => {
                            if (!imageResizeRef.current) return;
                            const dx = ev.clientX - imageResizeRef.current.startX;
                            const pctDelta = (dx / r.width) * 100;
                            updateImageOverlay(imageResizeRef.current.overlayId, {
                              widthPercent: Math.max(5, Math.min(100, imageResizeRef.current.startWidth + pctDelta)),
                            });
                          };
                          const onUp = () => {
                            imageResizeRef.current = null;
                            window.removeEventListener('pointermove', onMove);
                            window.removeEventListener('pointerup', onUp);
                          };
                          window.addEventListener('pointermove', onMove);
                          window.addEventListener('pointerup', onUp);
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer;
