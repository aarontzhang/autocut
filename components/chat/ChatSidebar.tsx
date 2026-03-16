'use client';

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { ChatMessage as ChatMessageType, CaptionEntry, EditAction, IndexedVideoFrame, MarkerEntry, SilenceCandidate, SourceIndexedFrame, SourceRangeRef, VisualSearchSession } from '@/lib/types';
import { buildTimelineSilenceCandidates, formatTime, formatTimePrecise, getSourceSegmentsForTimelineRange, buildTranscriptContext, getTimelineDuration, sourceRangesForAction, sourceRangeToTimelineRanges, sourceTimeToTimelineOccurrences, subtractSourceRanges } from '@/lib/timelineUtils';
import { extractVideoFrames } from '@/lib/ffmpegClient';
import { applyActionToSnapshot, expandActionForReview, EditSnapshot } from '@/lib/editActionUtils';
import { buildOverlappingRanges, dedupeCaptionEntries, transcribeSourceRanges } from '@/lib/transcriptionUtils';
import { buildClipSchedule, timelineTimeToSource } from '@/lib/playbackEngine';
import { resolveMainTrackSources } from '@/lib/sourceMedia';
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';
import AutocutMark from '@/components/branding/AutocutMark';

const FRAME_DESCRIPTION_BATCH_SIZE = 8;
const MAX_PARALLEL_FRAME_DESCRIPTION_REQUESTS = 6;
const OVERVIEW_FRAME_EXTRACTION_CONCURRENCY = 2;
const FRAME_DESCRIPTION_REQUEST_TIMEOUT_MS = 60000;
const MAX_FRAME_DESCRIPTION_REQUEST_RETRIES = 2;
const FRAME_DESCRIPTION_RETRY_BASE_DELAY_MS = 1500;
const REVIEW_PREROLL_SECONDS = 2.5;
const AGENT_MENU_ITEMS = [
  { id: 'cut', label: 'Cut Assistant', status: 'active' as const },
  { id: 'highlights', label: 'Highlights Assistant', status: 'coming_soon' as const },
  { id: 'story', label: 'Story Assistant', status: 'coming_soon' as const },
  { id: 'sound', label: 'Sound Assistant', status: 'coming_soon' as const },
];

type FrameDescriptionResponse = {
  descriptions?: Array<{ index: number; description: string }>;
  error?: string;
};

type FrameDescriptionBatch = {
  start: number;
  batchFrames: Array<{
    image: string;
    timelineTime: number;
    sourceTime: number;
  }>;
};

type ChatResponse = {
  message?: string;
  action?: EditAction | null;
  visualSearch?: VisualSearchSession | null;
  error?: string;
  retryAfterSeconds?: number;
  requestId?: string | null;
};

type ChatRequestMessage = {
  role: 'user' | 'assistant';
  content: string;
  action?: EditAction | null;
  actionType?: EditAction['type'];
  actionMessage?: string;
  actionStatus?: ChatMessageType['actionStatus'];
  actionResult?: string;
  autoApplied?: boolean;
};

type IndexingProgress = {
  stage: 'extracting_frames' | 'describing_frames' | 'transcribing';
  completed: number;
  total: number;
  label: string;
  etaSeconds?: number | null;
};

const CHAT_REQUEST_TIMEOUT_MS = 45000;
const MAX_CHAT_REQUEST_RETRIES = 2;
const CHAT_RETRY_BASE_DELAY_MS = 1500;
const MARKER_TAG_PATTERN = /(?:@|marker\s+|bookmark\s+)(\d+)/gi;

type ActiveMarkerMention = {
  query: string;
  start: number;
  end: number;
};

async function parseJsonResponse<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function postChatRequest(
  payload: {
    messages: ChatRequestMessage[];
    context: Record<string, unknown>;
  },
  ctrl: AbortController,
): Promise<ChatResponse> {
  const timeoutId = window.setTimeout(() => {
    try {
      ctrl.abort(new DOMException('The chat request timed out.', 'AbortError'));
    } catch {
      ctrl.abort();
    }
  }, CHAT_REQUEST_TIMEOUT_MS);

  try {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_CHAT_REQUEST_RETRIES; attempt += 1) {
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify(payload),
        });
        const data = await parseJsonResponse<ChatResponse>(res);
        if (!res.ok) {
          const retryAfterSeconds = Number(res.headers.get('Retry-After') ?? data?.retryAfterSeconds);
          const isRetriable = res.status === 429 || res.status >= 500;
          const errorMessage = res.status === 529 || /overloaded/i.test(data?.error ?? '')
            ? 'The chat provider is temporarily overloaded. Please try again in a moment.'
            : (data?.error ?? `Chat request failed (${res.status}).`);

          lastError = new Error(errorMessage);

          if (attempt < MAX_CHAT_REQUEST_RETRIES && isRetriable && !ctrl.signal.aborted) {
            const retryDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
              ? retryAfterSeconds * 1000
              : CHAT_RETRY_BASE_DELAY_MS * (attempt + 1);
            await sleep(retryDelay);
            continue;
          }

          throw lastError;
        }
        return data ?? {};
      } catch (error) {
        const nextError = error instanceof Error ? error : new Error('Chat request failed.');
        lastError = nextError;
        if (nextError.name === 'AbortError') {
          throw nextError;
        }
        if (attempt >= MAX_CHAT_REQUEST_RETRIES || ctrl.signal.aborted) {
          throw nextError;
        }
        await sleep(CHAT_RETRY_BASE_DELAY_MS * (attempt + 1));
      }
    }

    throw lastError ?? new Error('Chat request failed.');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function requestFrameDescriptions(batchFrames: Array<{
  image: string;
  timelineTime: number;
  sourceTime: number;
}>): Promise<FrameDescriptionResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_FRAME_DESCRIPTION_REQUEST_RETRIES; attempt += 1) {
    const ctrl = new AbortController();
    const timeoutId = window.setTimeout(() => {
      try {
        ctrl.abort(new DOMException('The frame description request timed out.', 'AbortError'));
      } catch {
        ctrl.abort();
      }
    }, FRAME_DESCRIPTION_REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch('/api/frame-descriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          batchSize: FRAME_DESCRIPTION_BATCH_SIZE,
          frames: batchFrames,
        }),
      });
      const data = await parseJsonResponse<FrameDescriptionResponse>(res);
      if (!res.ok) {
        const retryAfterSeconds = Number(res.headers.get('Retry-After'));
        const error = new Error(data?.error ?? 'Failed to describe video frames.');
        if (
          attempt < MAX_FRAME_DESCRIPTION_REQUEST_RETRIES
          && (res.status >= 500 || res.status === 429)
        ) {
          const retryDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : FRAME_DESCRIPTION_RETRY_BASE_DELAY_MS * (attempt + 1);
          lastError = error;
          await sleep(retryDelay);
          continue;
        }
        throw error;
      }
      return data ?? {};
    } catch (error) {
      const nextError = error instanceof Error ? error : new Error('Failed to describe video frames.');
      lastError = nextError;
      const isAbort = nextError.name === 'AbortError';
      if (attempt >= MAX_FRAME_DESCRIPTION_REQUEST_RETRIES) {
        break;
      }
      await sleep((isAbort ? FRAME_DESCRIPTION_RETRY_BASE_DELAY_MS * 2 : FRAME_DESCRIPTION_RETRY_BASE_DELAY_MS) * (attempt + 1));
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error('Failed to describe video frames.');
}

const FRAME_DESCRIPTION_UNAVAILABLE = 'Visual summary unavailable.';

function hasUsableFrameDescription(description?: string | null): boolean {
  if (typeof description !== 'string') return false;
  const normalized = description.trim();
  return normalized.length > 0 && normalized !== FRAME_DESCRIPTION_UNAVAILABLE;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : fallback;
  }
  return fallback;
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatEtaLabel(seconds?: number | null): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 10) return 'about 10s left';
  if (seconds < 60) return `about ${Math.ceil(seconds / 5) * 5}s left`;
  const roundedMinutes = Math.ceil((seconds / 60) * 2) / 2;
  return `about ${roundedMinutes} min left`;
}

function getActiveMarkerMention(text: string, caret: number | null): ActiveMarkerMention | null {
  if (caret === null) return null;
  const prefix = text.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const atIndex = prefix.lastIndexOf('@');
  if (atIndex === -1) return null;
  return {
    query: match[1] ?? '',
    start: atIndex,
    end: caret,
  };
}

function replaceMarkerMention(text: string, mention: ActiveMarkerMention, markerNumber: number): string {
  return `${text.slice(0, mention.start)}@${markerNumber} ${text.slice(mention.end)}`;
}

function appendMarkerReference(text: string, markerNumber: number): string {
  const token = `@${markerNumber}`;
  if (new RegExp(`(^|\\s)${token}\\b`).test(text)) return text;
  return text.trim().length > 0 ? `${text.replace(/\s+$/, '')} ${token} ` : `${token} `;
}

function removeMarkerReference(text: string, markerNumber: number): string {
  return text
    .replace(new RegExp(`(^|[\\s])@${markerNumber}\\b`, 'g'), '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+/gm, '')
    .trimStart();
}

function extractTaggedMarkers(text: string, markers: MarkerEntry[]): MarkerEntry[] {
  const markerNumbers = new Set<number>();
  let match: RegExpExecArray | null;
  MARKER_TAG_PATTERN.lastIndex = 0;
  while ((match = MARKER_TAG_PATTERN.exec(text)) !== null) {
    const markerNumber = Number(match[1]);
    if (Number.isFinite(markerNumber)) markerNumbers.add(markerNumber);
  }
  return [...markerNumbers]
    .map((number) => markers.find((marker) => marker.number === number) ?? null)
    .filter((marker): marker is MarkerEntry => marker !== null)
    .sort((a, b) => a.number - b.number);
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function resolveMarkersById(ids: string[], markers: MarkerEntry[]): MarkerEntry[] {
  const byId = new Map(markers.map((marker) => [marker.id, marker]));
  return ids
    .map((id) => byId.get(id) ?? null)
    .filter((marker): marker is MarkerEntry => marker !== null)
    .sort((a, b) => a.number - b.number);
}

function getProgressValue(progress: IndexingProgress | null): number | null {
  if (!progress || progress.total <= 0) return null;
  return clampProgress(progress.completed / progress.total);
}

function getIndexingStageTitle(progress: IndexingProgress | null, fallback?: string | null): string {
  if (fallback) return fallback;
  if (!progress) return 'Preparing media…';

  switch (progress.stage) {
    case 'extracting_frames':
      return 'Sampling video frames…';
    case 'describing_frames':
      return 'Analyzing sampled frames…';
    case 'transcribing':
      return 'Transcribing audio…';
    default:
      return 'Preparing media…';
  }
}

function getOverviewFrameTarget(duration: number, preferredInterval: number, maxOverviewFrames: number): number {
  if (duration <= 0) return 0;
  const interval = duration <= preferredInterval * maxOverviewFrames
    ? preferredInterval
    : duration / maxOverviewFrames;
  return Math.floor(duration / interval) + 1;
}

function estimateTranscriptSeconds(duration: number): number {
  return Math.max(12, Math.min(600, duration * 0.16));
}

function estimateFrameExtractionSeconds(frameCount: number): number {
  return Math.max(8, Math.min(240, frameCount * 0.12));
}

function estimateFrameDescriptionSeconds(frameCount: number): number {
  const batches = Math.ceil(frameCount / FRAME_DESCRIPTION_BATCH_SIZE);
  const waves = Math.ceil(batches / MAX_PARALLEL_FRAME_DESCRIPTION_REQUESTS);
  return Math.max(6, waves * 5);
}

function estimateRemainingSecondsFromObservedRate(
  startedAtMs: number,
  completed: number,
  total: number,
  fallbackUnitSeconds: number,
): number {
  const remaining = Math.max(total - completed, 0);
  if (remaining <= 0) return 0;
  if (completed < Math.min(6, total)) {
    return Math.max(remaining * fallbackUnitSeconds, fallbackUnitSeconds);
  }

  const elapsedSeconds = Math.max((performance.now() - startedAtMs) / 1000, 0.001);
  const unitsPerSecond = completed / elapsedSeconds;
  if (!Number.isFinite(unitsPerSecond) || unitsPerSecond <= 0) {
    return Math.max(remaining * fallbackUnitSeconds, fallbackUnitSeconds);
  }

  return remaining / unitsPerSecond;
}

function serializeActionForComparison(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(serializeActionForComparison).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${key}:${serializeActionForComparison(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function actionsMatch(a?: EditAction, b?: EditAction): boolean {
  if (!a || !b) return false;
  return serializeActionForComparison(a) === serializeActionForComparison(b);
}

function buildChatRequestHistory(messages: ChatMessageType[], latestUserText?: string): ChatRequestMessage[] {
  const history: ChatRequestMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
    action: message.action ?? null,
    actionType: message.action?.type,
    actionMessage: message.action?.message,
    actionStatus: message.actionStatus,
    actionResult: message.actionResult,
    autoApplied: message.autoApplied,
  }));

  if (latestUserText) {
    history.push({ role: 'user', content: latestUserText });
  }

  return history;
}

function buildSilenceCandidatePayload(): SilenceCandidate[] {
  const state = useEditorStore.getState();
  const rawCaptions = state.sourceTranscriptCaptions;
  if (!rawCaptions || rawCaptions.length === 0) return [];

  return buildTimelineSilenceCandidates(state.clips, rawCaptions, state.aiSettings.silenceRemoval);
}

function mergeFrameDescriptions(
  frames: IndexedVideoFrame[],
  startIndex: number,
  descriptions: Array<{ index: number; description: string }>,
): IndexedVideoFrame[] {
  const nextFrames = [...frames];
  for (const item of descriptions) {
    const targetIndex = startIndex + item.index;
    if (!nextFrames[targetIndex]) continue;
    nextFrames[targetIndex] = {
      ...nextFrames[targetIndex],
      description: item.description.trim(),
    };
  }
  return nextFrames;
}

async function runFrameDescriptionBatches(
  batches: FrameDescriptionBatch[],
  callbacks: {
    onBatchStart?: (batch: FrameDescriptionBatch) => void;
    onBatchComplete: (result: { start: number; data: FrameDescriptionResponse }) => void;
    onBatchSettled?: (batch: FrameDescriptionBatch) => void;
  },
): Promise<Error[]> {
  if (batches.length === 0) return [];

  let nextBatchIndex = 0;
  const workerCount = Math.min(MAX_PARALLEL_FRAME_DESCRIPTION_REQUESTS, batches.length);
  const errors: Error[] = [];

  const runWorker = async () => {
    while (nextBatchIndex < batches.length) {
      const batchIndex = nextBatchIndex;
      nextBatchIndex += 1;
      const batch = batches[batchIndex];
      callbacks.onBatchStart?.(batch);
      try {
        const data = await requestFrameDescriptions(batch.batchFrames);
        callbacks.onBatchComplete({ start: batch.start, data });
      } catch (error) {
        const nextError = error instanceof Error ? error : new Error('Failed to describe video frames.');
        console.warn('Failed to describe a frame batch.', nextError);
        errors.push(nextError);
      } finally {
        callbacks.onBatchSettled?.(batch);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return errors;
}

function buildFrameContextPayload(frames: IndexedVideoFrame[], clips: ReturnType<typeof useEditorStore.getState>['clips']): IndexedVideoFrame[] {
  return frames
    .filter((frame) => frame.kind === 'dense' || hasUsableFrameDescription(frame.description))
    .map((frame) => {
      if (frame.kind === 'dense') {
        return {
          ...frame,
          projectedTimelineTime: frame.timelineTime,
          visibleOnTimeline: true,
        };
      }

      if (frame.projectedTimelineTime !== undefined || frame.visibleOnTimeline !== undefined) {
        return {
          ...frame,
          image: undefined,
          projectedTimelineTime: frame.projectedTimelineTime ?? frame.timelineTime,
          visibleOnTimeline: frame.visibleOnTimeline ?? true,
        };
      }

      const timelineOccurrences = sourceTimeToTimelineOccurrences(clips, frame.sourceTime, frame.sourceId);
      return {
        ...frame,
        image: undefined,
        projectedTimelineTime: timelineOccurrences[0] ?? null,
        visibleOnTimeline: timelineOccurrences.length > 0,
      };
    });
}

function getAssistantFallbackMessage(action?: EditAction | null): string {
  switch (action?.type) {
    case 'request_frames':
      return 'I need a closer visual inspection before I can place that cut precisely.';
    case 'inspect_frames':
      return 'I need a closer look at that section before making the edit.';
    case 'search_transcript':
      return 'Searching the transcript for relevant moments.';
    case 'transcribe_request':
      return 'I need a transcript for that section before I can finish the edit.';
    case 'delete_range':
    case 'delete_ranges':
      return 'I found the section to remove.';
    default:
      return 'I checked that section, but I need a clearer target before making an edit.';
  }
}

function formatFrameDescriptionProgressLabel(params: {
  completedFrames: number;
  totalFrames: number;
  completedBatches: number;
  totalBatches: number;
  activeBatches: number;
}): string {
  const { completedFrames, totalFrames } = params;
  return `Analyzing visuals ${completedFrames}/${totalFrames}`;
}

function isMarkerMutationAction(action?: EditAction | null): action is EditAction {
  return action?.type === 'add_marker'
    || action?.type === 'add_markers'
    || action?.type === 'update_marker'
    || action?.type === 'remove_marker';
}

function getMarkerActionResult(action: EditAction): string {
  if (action.type === 'add_marker') return 'Marker added.';
  if (action.type === 'add_markers') {
    const count = action.markers?.length ?? 0;
    return `${count} marker${count === 1 ? '' : 's'} added.`;
  }
  if (action.type === 'update_marker') return 'Marker updated.';
  if (action.type === 'remove_marker') return 'Marker removed.';
  return 'Marker updated.';
}

function getMarkerActionSeekTime(
  action: EditAction,
  existingMarkers: MarkerEntry[],
): number | null {
  if (action.type === 'add_marker') {
    return typeof action.marker?.timelineTime === 'number' ? action.marker.timelineTime : null;
  }
  if (action.type === 'add_markers') {
    const firstMarker = action.markers?.find((marker) => typeof marker.timelineTime === 'number');
    return typeof firstMarker?.timelineTime === 'number' ? firstMarker.timelineTime : null;
  }
  if (action.type === 'update_marker') {
    if (typeof action.marker?.timelineTime === 'number') return action.marker.timelineTime;
    if (!action.markerId) return null;
    return existingMarkers.find((marker) => marker.id === action.markerId)?.timelineTime ?? null;
  }
  if (action.type === 'remove_marker') {
    if (!action.markerId) return null;
    return existingMarkers.find((marker) => marker.id === action.markerId)?.timelineTime ?? null;
  }
  return null;
}

function getReviewAnchorTime(snapshot: EditSnapshot, action: EditAction): number | null {
  if (action.type === 'split_clip') {
    return action.splitTime ?? null;
  }

  if (action.type === 'delete_range') {
    return action.deleteStartTime ?? null;
  }

  if (action.type === 'delete_ranges') {
    return action.ranges?.[0]?.start ?? null;
  }

  if (action.type === 'add_captions') {
    return action.captions?.[0]?.startTime ?? null;
  }

  if (action.type === 'add_transition') {
    return action.transitions?.[0]?.atTime ?? null;
  }

  if (action.type === 'add_text_overlay') {
    return action.textOverlays?.[0]?.startTime ?? null;
  }

  if (action.type === 'replace_text_overlay') {
    return action.textOverlays?.[0]?.startTime ?? null;
  }

  if (
    action.type === 'delete_clip'
    || action.type === 'reorder_clip'
    || action.type === 'set_clip_speed'
    || action.type === 'set_clip_volume'
    || action.type === 'set_clip_filter'
  ) {
    const clipIndex = action.clipIndex ?? 0;
    const schedule = buildClipSchedule(snapshot.clips);
    return schedule[clipIndex]?.timelineStart ?? null;
  }

  return null;
}

function getReviewSeekTime(snapshot: EditSnapshot, action: EditAction): number | null {
  const anchor = getReviewAnchorTime(snapshot, action);
  if (anchor === null) return null;
  return Math.max(0, anchor - REVIEW_PREROLL_SECONDS);
}

function resolveReviewStep(
  baseSnapshot: EditSnapshot,
  currentSnapshot: EditSnapshot,
  action: EditAction,
  acceptedSourceRanges: SourceRangeRef[],
): { action: EditAction; sourceRanges: SourceRangeRef[] } | null {
  if (action.type !== 'delete_range') {
    return {
      action,
      sourceRanges: sourceRangesForAction(currentSnapshot.clips, action),
    };
  }

  const originalSourceRanges = sourceRangesForAction(baseSnapshot.clips, action);
  const remainingSourceRanges = originalSourceRanges.flatMap((range) => subtractSourceRanges(range, acceptedSourceRanges));
  const timelineRanges = remainingSourceRanges
    .flatMap((range) => sourceRangeToTimelineRanges(currentSnapshot.clips, range.sourceId, range.sourceStart, range.sourceEnd))
    .filter((range) => range.timelineEnd > range.timelineStart + 1e-3)
    .sort((a, b) => a.timelineStart - b.timelineStart || a.timelineEnd - b.timelineEnd);

  if (timelineRanges.length === 0) return null;

  if (timelineRanges.length === 1) {
    return {
      action: {
        ...action,
        deleteStartTime: timelineRanges[0].timelineStart,
        deleteEndTime: timelineRanges[0].timelineEnd,
      },
      sourceRanges: remainingSourceRanges,
    };
  }

  return {
    action: {
      type: 'delete_ranges',
      ranges: timelineRanges.map((range) => ({ start: range.timelineStart, end: range.timelineEnd })),
      message: action.message,
    },
    sourceRanges: remainingSourceRanges,
  };
}

function combineResolvedReviewActions(
  originalAction: EditAction,
  resolvedActions: EditAction[],
): EditAction | null {
  if (resolvedActions.length === 0) return null;
  if (resolvedActions.length === 1 && originalAction.type !== 'delete_ranges') {
    return {
      ...resolvedActions[0],
      message: originalAction.message,
    };
  }

  if (originalAction.type === 'delete_range' || originalAction.type === 'delete_ranges') {
    const ranges = resolvedActions.flatMap((action) => {
      if (action.type === 'delete_range' && action.deleteStartTime !== undefined && action.deleteEndTime !== undefined) {
        return [{ start: action.deleteStartTime, end: action.deleteEndTime }];
      }
      if (action.type === 'delete_ranges') {
        return action.ranges ?? [];
      }
      return [];
    });
    if (ranges.length === 0) return null;
    if (ranges.length === 1) {
      return {
        type: 'delete_range',
        deleteStartTime: ranges[0].start,
        deleteEndTime: ranges[0].end,
        message: originalAction.message,
      };
    }
    return {
      type: 'delete_ranges',
      ranges,
      message: originalAction.message,
    };
  }

  if (originalAction.type === 'add_captions') {
    const captions = resolvedActions.flatMap((action) => action.type === 'add_captions' ? action.captions ?? [] : []);
    return captions.length > 0 ? { type: 'add_captions', captions, message: originalAction.message } : null;
  }

  if (originalAction.type === 'add_transition') {
    const transitions = resolvedActions.flatMap((action) => action.type === 'add_transition' ? action.transitions ?? [] : []);
    return transitions.length > 0 ? { type: 'add_transition', transitions, message: originalAction.message } : null;
  }

  if (originalAction.type === 'add_markers') {
    const markers = resolvedActions.flatMap((action) => {
      if (action.type === 'add_marker' && action.marker) return [action.marker];
      if (action.type === 'add_markers') return action.markers ?? [];
      return [];
    });
    if (markers.length === 0) return null;
    if (markers.length === 1) {
      return {
        type: 'add_marker',
        marker: markers[0],
        message: originalAction.message,
      };
    }
    return {
      type: 'add_markers',
      markers,
      message: originalAction.message,
    };
  }

  if (originalAction.type === 'add_text_overlay') {
    const textOverlays = resolvedActions.flatMap((action) => action.type === 'add_text_overlay' ? action.textOverlays ?? [] : []);
    return textOverlays.length > 0 ? { type: 'add_text_overlay', textOverlays, message: originalAction.message } : null;
  }

  return {
    ...resolvedActions[0],
    message: originalAction.message,
  };
}

function formatChatTime(seconds: number): string {
  return Math.abs(seconds - Math.round(seconds)) < 0.001
    ? formatTime(seconds)
    : formatTimePrecise(seconds);
}

function looksLikeVisualSearchQuery(text: string): boolean {
  return /\bframe|screen|overlay|visual|scene|show|appears?|look|image|logo|transition|cloud|clouds|black\b/i.test(text);
}

function upsertMarkersFromVisualSearch(
  query: string,
  session: VisualSearchSession | null | undefined,
  addMarker: ReturnType<typeof useEditorStore.getState>['addMarker'],
) {
  if (!session) return;
  const proposalRanges = session.proposal?.timelineRanges ?? [];
  const fallbackRanges = proposalRanges.length > 0
    ? []
    : session.candidates.slice(0, 3).map((candidate) => ({
        timelineStart: candidate.sourceStart,
        timelineEnd: candidate.sourceEnd,
      }));
  const ranges = proposalRanges.length > 0 ? proposalRanges : fallbackRanges;
  if (ranges.length === 0) return;

  const existing = useEditorStore.getState().markers;
  ranges.forEach((range, index) => {
    const timelineTime = range.timelineStart;
    const alreadyExists = existing.some((marker) => (
      marker.note === query && Math.abs(marker.timelineTime - timelineTime) < 0.1
    ));
    if (alreadyExists) return;
    addMarker({
      timelineTime,
      label: `Finding ${index + 1}`,
      createdBy: 'ai',
      status: 'open',
      linkedRange: { startTime: range.timelineStart, endTime: range.timelineEnd },
      confidence: session.confidenceBand === 'high' ? 0.9 : session.confidenceBand === 'medium' ? 0.7 : 0.5,
      note: query,
    });
  });
}

// ─── Action card config ────────────────────────────────────────────────────────
function getActionMeta(action: EditAction): { label: string; color: string; summary: string } {
  switch (action.type) {
    case 'split_clip':
      return {
        label: 'Split clip',
        color: '#f59e0b',
        summary: action.splitTime !== undefined ? `at ${formatChatTime(action.splitTime)}` : '',
      };
    case 'delete_clip':
      return {
        label: `Delete clip ${(action.clipIndex ?? 0) + 1}`,
        color: '#ef4444',
        summary: '',
      };
    case 'delete_range':
      return {
        label: 'Cut range',
        color: '#ef4444',
        summary: action.deleteStartTime !== undefined && action.deleteEndTime !== undefined
          ? `${formatChatTime(action.deleteStartTime)} → ${formatChatTime(action.deleteEndTime)}`
          : '',
      };
    case 'delete_ranges':
      return {
        label: `Cut ${action.ranges?.length ?? 0} section${(action.ranges?.length ?? 0) !== 1 ? 's' : ''}`,
        color: '#ef4444',
        summary: `${action.ranges?.length ?? 0} range${(action.ranges?.length ?? 0) !== 1 ? 's' : ''}`,
      };
    case 'set_clip_speed':
      return {
        label: `Speed clip ${(action.clipIndex ?? 0) + 1}`,
        color: '#f87171',
        summary: action.speed !== undefined ? `${action.speed}×` : '',
      };
    case 'set_clip_volume':
      return {
        label: `Volume clip ${(action.clipIndex ?? 0) + 1}`,
        color: '#34d399',
        summary: [
          action.volume !== undefined ? `${Math.round(action.volume * 100)}%` : '',
          action.fadeIn ? `fade in ${action.fadeIn}s` : '',
          action.fadeOut ? `fade out ${action.fadeOut}s` : '',
        ].filter(Boolean).join(', '),
      };
    case 'set_clip_filter':
      return {
        label: `Filter clip ${(action.clipIndex ?? 0) + 1}`,
        color: '#818cf8',
        summary: action.filter?.type ?? 'none',
      };
    case 'transcribe_request': {
      const seg = action.segments?.[0];
      return {
        label: 'Transcribe audio',
        color: '#f59e0b',
        summary: seg ? `${formatChatTime(seg.startTime)} → ${formatChatTime(seg.endTime)}` : '',
      };
    }
    case 'request_frames': {
      const req = action.frameRequest;
      return {
        label: 'Inspect frames',
        color: '#60a5fa',
        summary: req ? `${formatChatTime(req.startTime)} → ${formatChatTime(req.endTime)}` : '',
      };
    }
    case 'inspect_frames': {
      const req = action.inspectRequest;
      const fps = req?.fps ?? 1;
      return {
        label: 'Inspect frames',
        color: '#60a5fa',
        summary: req ? `${formatChatTime(req.startTime)}→${formatChatTime(req.endTime)} @${fps}fps` : '',
      };
    }
    case 'search_transcript': {
      return {
        label: 'Search transcript',
        color: '#34d399',
        summary: action.transcriptQuery ? `"${action.transcriptQuery}"` : '',
      };
    }
    case 'update_ai_settings':
      return {
        label: 'Update AI settings',
        color: '#facc15',
        summary: 'Defaults updated',
      };
    case 'add_captions':
      return {
        label: `Add ${action.captions?.length ?? 0} caption${(action.captions?.length ?? 0) !== 1 ? 's' : ''}`,
        color: '#f59e0b',
        summary: 'Subtitle track',
      };
    case 'reorder_clip':
      return {
        label: `Move clip ${(action.clipIndex ?? 0) + 1}`,
        color: '#38bdf8',
        summary: action.newIndex === 0 ? 'to front' : `to position ${(action.newIndex ?? 0) + 1}`,
      };
    case 'add_transition':
      return {
        label: `Add ${action.transitions?.length ?? 0} transition${(action.transitions?.length ?? 0) !== 1 ? 's' : ''}`,
        color: 'rgba(255,255,255,0.6)',
        summary: (action.transitions ?? []).map(t => t.type).join(', '),
      };
    case 'add_marker':
      return {
        label: 'Add marker',
        color: '#facc15',
        summary: action.marker?.timelineTime !== undefined ? formatChatTime(action.marker.timelineTime) : '',
      };
    case 'add_markers':
      return {
        label: `Add ${action.markers?.length ?? 0} marker${(action.markers?.length ?? 0) !== 1 ? 's' : ''}`,
        color: '#facc15',
        summary: 'Review findings',
      };
    case 'add_text_overlay':
      return {
        label: `Add ${action.textOverlays?.length ?? 0} text overlay${(action.textOverlays?.length ?? 0) !== 1 ? 's' : ''}`,
        color: '#a78bfa',
        summary: 'Text track',
      };
    default:
      return { label: 'Edit', color: 'var(--accent)', summary: '' };
  }
}

function ActionDetails({ action }: { action: EditAction }) {
  if (action.type === 'delete_ranges') {
    const ranges = action.ranges ?? [];
    return (
      <div style={{ padding: '6px 12px 8px', maxHeight: 184, overflowY: 'auto' }}>
        {ranges.map((r, i) => (
          <div key={i} style={{
            padding: '4px 0',
            borderBottom: i < ranges.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
          }}>
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-muted)' }}>
              {formatChatTime(r.start)} – {formatChatTime(r.end)}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (action.type === 'split_clip') {
    return (
      <div style={{ padding: '6px 12px 8px' }}>
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-secondary)' }}>
          Split at {action.splitTime !== undefined ? formatChatTime(action.splitTime) : '—'}
        </span>
      </div>
    );
  }

  if (action.type === 'delete_range') {
    return (
      <div style={{ padding: '6px 12px 8px' }}>
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-secondary)' }}>
          Remove {action.deleteStartTime !== undefined ? formatChatTime(action.deleteStartTime) : '—'} – {action.deleteEndTime !== undefined ? formatChatTime(action.deleteEndTime) : '—'}
        </span>
      </div>
    );
  }

  if (action.type === 'set_clip_speed') {
    return (
      <div style={{ padding: '6px 12px 8px' }}>
        <span style={{
          fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-serif)',
          color: (action.speed ?? 1) > 1 ? '#f87171' : '#60a5fa',
        }}>
          {action.speed}×
        </span>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', marginLeft: 6 }}>
          {(action.speed ?? 1) > 1 ? 'fast forward' : (action.speed ?? 1) < 1 ? 'slow motion' : 'normal'}
        </span>
      </div>
    );
  }

  if (action.type === 'set_clip_volume') {
    return (
      <div style={{ padding: '6px 12px 8px' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--fg-primary)' }}>
            Level: <strong>{Math.round((action.volume ?? 1) * 100)}%</strong>
          </span>
          {action.fadeIn ? <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>fade in {action.fadeIn}s</span> : null}
          {action.fadeOut ? <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>fade out {action.fadeOut}s</span> : null}
        </div>
      </div>
    );
  }

  if (action.type === 'set_clip_filter') {
    const f = action.filter;
    return (
      <div style={{ padding: '6px 12px 8px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{
            width: 28, height: 18, borderRadius: 3,
            background: f?.type === 'bw' ? 'linear-gradient(90deg, #888, #ccc)' :
                        f?.type === 'warm' ? 'linear-gradient(90deg, #c76b2e, #e8a950)' :
                        f?.type === 'cool' ? 'linear-gradient(90deg, #2e6bc7, #50a0e8)' :
                        f?.type === 'vintage' ? 'linear-gradient(90deg, #8B6914, #c9a227)' :
                        f?.type === 'cinematic' ? 'linear-gradient(90deg, #1a1a3e, #4a2080)' :
                        'rgba(255,255,255,0.1)',
          }} />
          <span style={{ fontSize: 12, color: 'var(--fg-primary)', fontWeight: 500 }}>
            {f?.type ?? 'none'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            {Math.round((f?.intensity ?? 1) * 100)}%
          </span>
        </div>
      </div>
    );
  }

  if (action.type === 'add_captions') {
    return (
      <div style={{ padding: '6px 12px 8px' }}>
        {(action.captions ?? []).slice(0, 3).map((c, i) => (
          <div key={i} style={{
            padding: '3px 0',
            borderBottom: i < Math.min((action.captions ?? []).length - 1, 2) ? '1px solid rgba(255,255,255,0.04)' : 'none',
          }}>
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-muted)', marginRight: 6 }}>
              {formatChatTime(c.startTime)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--fg-secondary)' }}>{c.text}</span>
          </div>
        ))}
        {(action.captions?.length ?? 0) > 3 && (
          <p style={{ fontSize: 10, color: 'var(--fg-muted)', padding: '3px 0', margin: 0 }}>
            +{(action.captions?.length ?? 0) - 3} more…
          </p>
        )}
      </div>
    );
  }

  if (action.type === 'update_ai_settings') {
    const settings = action.settings;
    const details = [
      settings?.silenceRemoval?.paddingSeconds !== undefined ? `silence padding ${settings.silenceRemoval.paddingSeconds}s` : '',
      settings?.silenceRemoval?.minDurationSeconds !== undefined ? `min silence ${settings.silenceRemoval.minDurationSeconds}s` : '',
      settings?.frameInspection?.defaultFrameCount !== undefined ? `inspect ${settings.frameInspection.defaultFrameCount} frames` : '',
      settings?.frameInspection?.overviewIntervalSeconds !== undefined ? `overview every ${settings.frameInspection.overviewIntervalSeconds}s` : '',
      settings?.captions?.wordsPerCaption !== undefined ? `${settings.captions.wordsPerCaption} words per caption` : '',
      settings?.transitions?.defaultDuration !== undefined ? `${settings.transitions.defaultDuration}s transitions` : '',
      settings?.textOverlays?.defaultFontSize !== undefined ? `${settings.textOverlays.defaultFontSize}px text` : '',
    ].filter(Boolean);
    return (
      <div style={{ padding: '6px 12px 8px' }}>
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-secondary)' }}>
          {details.length > 0 ? details.join(', ') : 'AI editing defaults updated for future requests.'}
        </span>
      </div>
    );
  }

  if (action.type === 'add_transition') {
    return (
      <div style={{ padding: '6px 12px 8px' }}>
        {(action.transitions ?? []).map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-muted)' }}>
              {formatChatTime(t.atTime)}
            </span>
            <span style={{ fontSize: 10, color: 'var(--fg-secondary)' }}>{t.type}</span>
            <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>{t.duration}s</span>
          </div>
        ))}
      </div>
    );
  }

  if (action.type === 'add_marker' || action.type === 'add_markers') {
    const markers = action.type === 'add_marker' ? [action.marker] : action.markers;
    return (
      <div style={{ padding: '6px 12px 8px' }}>
        {(markers ?? []).filter(Boolean).map((marker, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-muted)' }}>
              {marker?.number ? `@${marker.number}` : 'Marker'}
            </span>
            <span style={{ fontSize: 10, color: 'var(--fg-secondary)' }}>
              {marker?.timelineTime !== undefined ? formatChatTime(marker.timelineTime) : '—'}
            </span>
            {marker?.label && <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>{marker.label}</span>}
          </div>
        ))}
      </div>
    );
  }

  if (action.type === 'add_text_overlay') {
    return (
      <div style={{ padding: '6px 12px 8px' }}>
        {(action.textOverlays ?? []).slice(0, 3).map((t, i) => (
          <div key={i} style={{ padding: '2px 0' }}>
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-muted)', marginRight: 6 }}>
              {formatChatTime(t.startTime)}–{formatChatTime(t.endTime)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--fg-secondary)' }}>{t.text}</span>
            <span style={{ fontSize: 10, color: 'var(--fg-muted)', marginLeft: 5 }}>({t.position})</span>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

type TimelineFrameSample = {
  index: number;
  timelineTime: number;
  sourceTime: number;
  sourceId: string;
};

type SourceFrameSample = {
  index: number;
  sourceTime: number;
};

async function extractSourceOverviewFrames(
  input: {
    sourceId: string;
    source: Uint8Array | File | string;
    duration: number;
    overviewIntervalSeconds: number;
    maxOverviewFrames: number;
    explicitTimestamps?: number[];
    onProgress?: (progress: { completed: number; total: number }) => void;
  },
): Promise<SourceIndexedFrame[]> {
  if (input.duration <= 0) return [];

  let sampleTimes: number[];

  if (input.explicitTimestamps && input.explicitTimestamps.length > 0) {
    sampleTimes = input.explicitTimestamps;
  } else {
    const preferredInterval = Math.max(0.1, input.overviewIntervalSeconds);
    const interval = input.duration <= preferredInterval * input.maxOverviewFrames
      ? preferredInterval
      : input.duration / input.maxOverviewFrames;
    const sampleEnd = Math.max(input.duration - 0.05, 0);
    sampleTimes = [];
    for (let t = 0; t < sampleEnd; t += interval) {
      sampleTimes.push(t);
    }
    if (sampleTimes.length === 0 || sampleTimes[sampleTimes.length - 1] < sampleEnd) {
      sampleTimes.push(sampleEnd);
    }
  }

  const samples: SourceFrameSample[] = sampleTimes.map((t, i) => ({ index: i, sourceTime: t }));
  if (samples.length === 0) return [];

  const images = await extractVideoFrames(
    input.source,
    samples.map((sample) => sample.sourceTime),
    {
      concurrency: OVERVIEW_FRAME_EXTRACTION_CONCURRENCY,
      onProgress: ({ completed, total }) => {
        input.onProgress?.({ completed, total });
      },
    },
  );

  return samples.map((sample, index) => ({
    sourceId: input.sourceId,
    sourceTime: sample.sourceTime,
    image: images[index],
  }));
}

function computeSilenceAwareTimestamps(
  duration: number,
  captions: CaptionEntry[],
  minSilenceSeconds = 0.5,
): number[] {
  const timestamps: number[] = [];
  const sorted = [...captions].sort((a, b) => a.startTime - b.startTime);

  function pushGapSamples(gapStart: number, gapEnd: number) {
    const gapDuration = gapEnd - gapStart;
    if (gapDuration < minSilenceSeconds) return;
    const sampleCount = Math.floor(gapDuration); // 1 per second
    if (sampleCount === 0) {
      timestamps.push((gapStart + gapEnd) / 2); // short gap: single midpoint
      return;
    }
    for (let i = 0; i < sampleCount; i++) {
      timestamps.push(gapStart + i + 0.5); // center of each 1s bucket
    }
  }

  if (sorted.length > 0 && sorted[0].startTime >= minSilenceSeconds) {
    pushGapSamples(0, sorted[0].startTime);
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    pushGapSamples(sorted[i].endTime, sorted[i + 1].startTime);
  }

  if (sorted.length > 0 && duration - sorted[sorted.length - 1].endTime >= minSilenceSeconds) {
    pushGapSamples(sorted[sorted.length - 1].endTime, duration);
  }

  return timestamps
    .map(t => Math.round(t * 10) / 10)
    .filter(t => t >= 0 && t < duration)
    .sort((a, b) => a - b);
}

async function extractTimelineFramesFromSources(
  input: {
    clips: ReturnType<typeof useEditorStore.getState>['clips'];
    videoData: Uint8Array | null;
    videoFile: File | null;
    videoUrl: string;
    videoDuration: number;
    timelineTimestamps: number[];
    kind: IndexedVideoFrame['kind'];
    onProgress?: (progress: { completed: number; total: number }) => void;
  },
): Promise<IndexedVideoFrame[]> {
  if (input.timelineTimestamps.length === 0) return [];

  const schedule = buildClipSchedule(input.clips);
  const samples = input.timelineTimestamps
    .map((timelineTime, index) => {
      const resolved = timelineTimeToSource(schedule, timelineTime);
      if (!resolved) return null;
      return {
        index,
        timelineTime,
        sourceTime: resolved.sourceTime,
        sourceId: resolved.entry.sourceId ?? MAIN_SOURCE_ID,
      } satisfies TimelineFrameSample;
    })
    .filter((sample): sample is TimelineFrameSample => !!sample);

  if (samples.length === 0) return [];

  const sourceEntry = resolveMainTrackSources({
    videoData: input.videoData,
    videoFile: input.videoFile,
    videoUrl: input.videoUrl,
    videoDuration: input.videoDuration,
  })[0];
  if (!sourceEntry?.source) {
    throw new Error('Missing source video for frame extraction.');
  }

  const frames = new Array<IndexedVideoFrame | null>(samples.length).fill(null);
  input.onProgress?.({ completed: 0, total: samples.length });
  const images = await extractVideoFrames(
    sourceEntry.source,
    samples.map((sample) => sample.sourceTime),
    {
      concurrency: OVERVIEW_FRAME_EXTRACTION_CONCURRENCY,
      onProgress: ({ completed }) => {
        input.onProgress?.({ completed, total: samples.length });
      },
    },
  );

  samples.forEach((sample, imageIndex) => {
    frames[sample.index] = {
      image: images[imageIndex],
      timelineTime: sample.timelineTime,
      sourceTime: sample.sourceTime,
      sourceId: MAIN_SOURCE_ID,
      kind: input.kind,
    };
  });

  return frames.filter((frame): frame is IndexedVideoFrame => !!frame);
}

// ─── Markdown renderer ─────────────────────────────────────────────────────────
function renderMarkdown(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

function MarkerAwareText({ text }: { text: string }) {
  const markers = useEditorStore(s => s.markers);
  const requestSeek = useEditorStore(s => s.requestSeek);
  const setSelectedItem = useEditorStore(s => s.setSelectedItem);
  const parts = text.split(/((?:marker|bookmark)\s+\d+|@\d+)/gi);

  return parts.map((part, index) => {
    const match = part.match(/(?:marker\s+|bookmark\s+|@)(\d+)/i);
    if (!match) return <span key={index}>{renderMarkdown(part)}</span>;
    const markerNumber = Number(match[1]);
    const marker = markers.find((entry) => entry.number === markerNumber);
    if (!marker) return <span key={index}>{part}</span>;
    return (
      <button
        key={index}
        onClick={() => {
          setSelectedItem({ type: 'marker', id: marker.id });
          requestSeek(marker.timelineTime);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          margin: '0 2px',
          padding: '1px 6px',
          borderRadius: 999,
          border: '1px solid rgba(250,204,21,0.28)',
          background: 'rgba(250,204,21,0.12)',
          color: '#fde68a',
          fontSize: 11,
          fontFamily: 'var(--font-serif)',
          cursor: 'pointer',
        }}
      >
        @{marker.number}
      </button>
    );
  });
}

// ─── Message bubbles ───────────────────────────────────────────────────────────
function UserMessage({ msg }: { msg: ChatMessageType }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2 }}>
      <div style={{
        maxWidth: '85%',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '10px 10px 2px 10px',
        padding: '8px 12px',
        fontSize: 13,
        color: 'var(--fg-primary)',
        lineHeight: 1.55,
        fontFamily: 'var(--font-serif)',
      }}>
        <MarkerAwareText text={msg.content} />
      </div>
    </div>
  );
}

function AssistantMessage({
  msg,
  onTranscriptReady,
}: {
  msg: ChatMessageType;
  onTranscriptReady: (messageId: string) => Promise<void>;
}) {
  const videoUrl = useEditorStore(s => s.videoUrl);
  const videoFile = useEditorStore(s => s.videoFile);
  const videoData = useEditorStore(s => s.videoData);
  const clips = useEditorStore(s => s.previewSnapshot?.clips ?? s.clips);
  const previewOwnerId = useEditorStore(s => s.previewOwnerId);
  const setPreviewSnapshot = useEditorStore(s => s.setPreviewSnapshot);
  const clearPreviewSnapshot = useEditorStore(s => s.clearPreviewSnapshot);
  const commitPreviewSnapshot = useEditorStore(s => s.commitPreviewSnapshot);
  const requestSeek = useEditorStore(s => s.requestSeek);
  const applyStoredAction = useEditorStore(s => s.applyAction);
  const recordAppliedAction = useEditorStore(s => s.recordAppliedAction);
  const updateMessage = useEditorStore(s => s.updateMessage);
  const appliedActions = useEditorStore(s => s.appliedActions);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [reviewBaseSnapshot, setReviewBaseSnapshot] = useState<EditSnapshot | null>(null);
  const [reviewDraft, setReviewDraft] = useState<EditSnapshot | null>(null);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [acceptedSteps, setAcceptedSteps] = useState(0);
  const [skippedSteps, setSkippedSteps] = useState(0);
  const [reviewResult, setReviewResult] = useState<string | null>(null);
  const [acceptedSourceRanges, setAcceptedSourceRanges] = useState<SourceRangeRef[]>([]);
  const [acceptedReviewActions, setAcceptedReviewActions] = useState<EditAction[]>([]);
  const [transcriptionDone, setTranscriptionDone] = useState(false);

  const setBackgroundTranscript = useEditorStore(s => s.setBackgroundTranscript);
  const setTranscriptProgress = useEditorStore(s => s.setTranscriptProgress);
  const existingSourceTranscriptCaptions = useEditorStore(s => s.sourceTranscriptCaptions);
  const addMessage = useEditorStore(s => s.addMessage);

  const action = msg.action;
  const hasAction = action && action.type !== 'none';
  const reviewSteps = useMemo(() => (action ? expandActionForReview(action) : []), [action]);
  const reviewInProgress = reviewDraft !== null && reviewIndex < reviewSteps.length;
  const resolvedReviewStep = useMemo(() => {
    if (!reviewInProgress || !reviewBaseSnapshot || !reviewDraft) return null;
    const step = reviewSteps[reviewIndex];
    if (!step) return null;
    return resolveReviewStep(reviewBaseSnapshot, reviewDraft, step, acceptedSourceRanges);
  }, [acceptedSourceRanges, reviewBaseSnapshot, reviewDraft, reviewInProgress, reviewIndex, reviewSteps]);
  const activeReviewAction = reviewInProgress
    ? (resolvedReviewStep?.action ?? reviewSteps[reviewIndex] ?? null)
    : action ?? null;
  const anotherReviewActive = previewOwnerId !== null && previewOwnerId !== msg.id;
  const actionPreviouslyApplied = useMemo(() => (
    !!action && appliedActions.some(record => actionsMatch(record.action, action))
  ), [action, appliedActions]);
  const actionResolved = msg.actionStatus === 'completed'
    || msg.actionStatus === 'rejected'
    || msg.autoApplied
    || actionPreviouslyApplied;
  const meta = activeReviewAction ? getActionMeta(activeReviewAction) : null;
  const actionResultText = msg.actionResult ?? (
    msg.actionStatus === 'rejected'
      ? 'No changes applied.'
      : msg.autoApplied
        ? 'Auto-applied ✓'
        : actionPreviouslyApplied
          ? 'Already applied.'
          : null
  );

  useEffect(() => () => clearPreviewSnapshot(msg.id), [clearPreviewSnapshot, msg.id]);

  useEffect(() => {
    if (!actionPreviouslyApplied || msg.actionStatus === 'completed' || msg.actionStatus === 'rejected') return;
    updateMessage(msg.id, { actionStatus: 'completed', actionResult: actionResultText ?? 'Already applied.' });
  }, [actionPreviouslyApplied, actionResultText, msg.actionStatus, msg.id, updateMessage]);

  const finalizeReview = useCallback((
    draft: EditSnapshot,
    accepted: number,
    skipped: number,
    committedSourceRanges: SourceRangeRef[],
    committedReviewActions: EditAction[],
  ) => {
    clearPreviewSnapshot(msg.id);
    if (accepted > 0) {
      commitPreviewSnapshot(draft);
      if (action) {
        const committedAction = combineResolvedReviewActions(action, committedReviewActions) ?? action;
        recordAppliedAction(committedAction, committedAction.message, { sourceRanges: committedSourceRanges });
      }
    }
    const result = accepted > 0 ? `Committed ${accepted} change${accepted === 1 ? '' : 's'}.` : 'No changes applied.';
    updateMessage(msg.id, {
      actionStatus: 'completed',
      actionResult: result,
    });
    setReviewBaseSnapshot(null);
    setReviewDraft(null);
    setReviewIndex(reviewSteps.length);
    setAcceptedSteps(accepted);
    setSkippedSteps(skipped);
    setAcceptedSourceRanges([]);
    setAcceptedReviewActions([]);
    setReviewResult(result);
  }, [action, clearPreviewSnapshot, commitPreviewSnapshot, msg.id, recordAppliedAction, reviewSteps.length, updateMessage]);

  const startReview = useCallback(() => {
    if (
      !action
      || action.type === 'none'
      || action.type === 'transcribe_request'
      || action.type === 'update_ai_settings'
      || anotherReviewActive
    ) return;
    const state = useEditorStore.getState();
    const baseSnapshot: EditSnapshot = {
      clips: state.clips,
      captions: state.captions,
      transitions: state.transitions,
      markers: state.markers,
      textOverlays: state.textOverlays,
    };
    const firstStep = reviewSteps[0];
    if (!firstStep) return;
    const firstResolvedStep = resolveReviewStep(baseSnapshot, baseSnapshot, firstStep, []);
    if (!firstResolvedStep) return;
    setReviewBaseSnapshot(baseSnapshot);
    setReviewDraft(baseSnapshot);
    setReviewIndex(0);
    setAcceptedSteps(0);
    setSkippedSteps(0);
    setAcceptedSourceRanges([]);
    setAcceptedReviewActions([]);
    setReviewResult(null);
    setPreviewSnapshot(msg.id, applyActionToSnapshot(baseSnapshot, firstResolvedStep.action));
    const reviewSeekTime = getReviewSeekTime(baseSnapshot, firstResolvedStep.action);
    if (reviewSeekTime !== null) requestSeek(reviewSeekTime);
  }, [action, anotherReviewActive, msg.id, requestSeek, reviewSteps, setPreviewSnapshot]);

  const handleApplyStep = useCallback(() => {
    if (!reviewBaseSnapshot || !reviewDraft || !reviewSteps[reviewIndex]) return;
    const resolvedStep = resolveReviewStep(reviewBaseSnapshot, reviewDraft, reviewSteps[reviewIndex], acceptedSourceRanges);
    if (!resolvedStep) return;
    const stepAction = resolvedStep.action;
    const nextCommittedSourceRanges = [...acceptedSourceRanges, ...resolvedStep.sourceRanges];
    const nextCommittedReviewActions = [...acceptedReviewActions, stepAction];
    const nextDraft = applyActionToSnapshot(reviewDraft, stepAction);
    const accepted = acceptedSteps + 1;
    const nextIndex = reviewIndex + 1;
    if (nextIndex >= reviewSteps.length) {
      finalizeReview(nextDraft, accepted, skippedSteps, nextCommittedSourceRanges, nextCommittedReviewActions);
      return;
    }
    const nextStep = reviewSteps[nextIndex];
    const nextResolvedStep = resolveReviewStep(reviewBaseSnapshot, nextDraft, nextStep, nextCommittedSourceRanges);
    if (!nextResolvedStep) {
      finalizeReview(nextDraft, accepted, skippedSteps + 1, nextCommittedSourceRanges, nextCommittedReviewActions);
      return;
    }
    setReviewDraft(nextDraft);
    setReviewIndex(nextIndex);
    setAcceptedSteps(accepted);
    setAcceptedSourceRanges(nextCommittedSourceRanges);
    setAcceptedReviewActions(nextCommittedReviewActions);
    setPreviewSnapshot(msg.id, applyActionToSnapshot(nextDraft, nextResolvedStep.action));
    const reviewSeekTime = getReviewSeekTime(nextDraft, nextResolvedStep.action);
    if (reviewSeekTime !== null) requestSeek(reviewSeekTime);
  }, [acceptedReviewActions, acceptedSourceRanges, acceptedSteps, finalizeReview, msg.id, requestSeek, reviewBaseSnapshot, reviewDraft, reviewIndex, reviewSteps, setPreviewSnapshot, skippedSteps]);

  const handleSkipStep = useCallback(() => {
    if (!reviewBaseSnapshot || !reviewDraft || !reviewSteps[reviewIndex]) return;
    const skipped = skippedSteps + 1;
    const nextIndex = reviewIndex + 1;
    if (nextIndex >= reviewSteps.length) {
      finalizeReview(reviewDraft, acceptedSteps, skipped, acceptedSourceRanges, acceptedReviewActions);
      return;
    }
    const nextStep = reviewSteps[nextIndex];
    const nextResolvedStep = resolveReviewStep(reviewBaseSnapshot, reviewDraft, nextStep, acceptedSourceRanges);
    if (!nextResolvedStep) {
      finalizeReview(reviewDraft, acceptedSteps, skipped, acceptedSourceRanges, acceptedReviewActions);
      return;
    }
    setReviewIndex(nextIndex);
    setSkippedSteps(skipped);
    setPreviewSnapshot(msg.id, applyActionToSnapshot(reviewDraft, nextResolvedStep.action));
    const reviewSeekTime = getReviewSeekTime(reviewDraft, nextResolvedStep.action);
    if (reviewSeekTime !== null) requestSeek(reviewSeekTime);
  }, [acceptedReviewActions, acceptedSourceRanges, acceptedSteps, finalizeReview, msg.id, requestSeek, reviewBaseSnapshot, reviewDraft, reviewIndex, reviewSteps, setPreviewSnapshot, skippedSteps]);

  const cancelReview = useCallback(() => {
    clearPreviewSnapshot(msg.id);
    setReviewBaseSnapshot(null);
    setReviewDraft(null);
    setReviewIndex(0);
    setAcceptedSteps(0);
    setSkippedSteps(0);
    setAcceptedSourceRanges([]);
    setAcceptedReviewActions([]);
    setReviewResult(null);
  }, [clearPreviewSnapshot, msg.id]);

  const handleTranscribe = useCallback(async () => {
    if (!action || action.type !== 'transcribe_request') return;
    const seg = action.segments?.[0];
    if (!seg) return;

    setIsTranscribing(true);
    setTranscribeError(null);
    try {
      // Map the timeline range to source segments so timestamps reflect the current edit state
      const sourceSegs = getSourceSegmentsForTimelineRange(clips, seg.startTime, seg.endTime);
      if (sourceSegs.length === 0) throw new Error('No source segments found for requested range');

      const state = useEditorStore.getState();
      const sourceEntry = resolveMainTrackSources({
        videoData,
        videoFile,
        videoUrl,
        videoDuration: state.videoDuration,
      })[0];
      const rangesBySource = new Map<string, Array<{ startTime: number; endTime: number }>>();
      sourceSegs.forEach((sourceSeg) => {
        const ranges = buildOverlappingRanges(sourceSeg.sourceStart, sourceSeg.sourceStart + sourceSeg.sourceDuration);
        const existing = rangesBySource.get(sourceSeg.sourceId) ?? [];
        rangesBySource.set(sourceSeg.sourceId, [...existing, ...ranges]);
      });

      const totalChunks = [...rangesBySource.values()].reduce((sum, ranges) => sum + ranges.length, 0);
      if (totalChunks === 0) throw new Error('No source ranges found for requested transcript');
      let completedChunks = 0;
      const rawCaptions: CaptionEntry[] = [];
      setTranscriptProgress({ completed: 0, total: totalChunks });

      for (const [sourceId, ranges] of rangesBySource) {
        if (!sourceEntry?.source) {
          throw new Error(`Missing media source for transcript request (${sourceId}).`);
        }
        const captionsForSource = await transcribeSourceRanges(
          sourceEntry.source,
          ranges,
          state.aiSettings.captions.wordsPerCaption,
          {
            sourceId,
            onProgress: ({ completed }) => {
              setTranscriptProgress({ completed: completedChunks + completed, total: totalChunks });
            },
          },
        );
        completedChunks += ranges.length;
        rawCaptions.push(...captionsForSource);
      }

      const mergedCaptions = dedupeCaptionEntries([...(existingSourceTranscriptCaptions ?? []), ...rawCaptions]);
      const transcriptText = buildTranscriptContext(clips, mergedCaptions);
      setBackgroundTranscript(transcriptText, 'done', mergedCaptions);
      addMessage({
        role: 'assistant',
        content: `Transcript ready for ${formatTime(seg.startTime)} to ${formatTime(seg.endTime)}. Continuing with your request.`,
      });
      setTranscriptionDone(true);
      updateMessage(msg.id, { actionStatus: 'completed', actionResult: 'Transcript ready ✓' });
      await onTranscriptReady(msg.id);
    } catch (err) {
      setTranscribeError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsTranscribing(false);
    }
  }, [action, addMessage, clips, existingSourceTranscriptCaptions, msg.id, onTranscriptReady, setBackgroundTranscript, setTranscriptProgress, updateMessage, videoData, videoFile, videoUrl]);

  const handleApplySettings = useCallback(() => {
    if (!action || action.type !== 'update_ai_settings') return;
    applyStoredAction(action);
    recordAppliedAction(action, action.message);
    updateMessage(msg.id, { actionStatus: 'completed', actionResult: 'AI settings updated.' });
    setReviewResult('AI settings updated.');
  }, [action, applyStoredAction, msg.id, recordAppliedAction, updateMessage]);

  return (
    <div style={{ marginBottom: 4 }}>
      {/* Claude indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <AutocutMark size={13} />
      </div>

      {/* Message text */}
      <div style={{
        fontSize: 13, color: 'var(--fg-secondary)',
        lineHeight: 1.65, paddingLeft: 22,
        fontFamily: 'var(--font-serif)',
      }}>
        <MarkerAwareText text={msg.content} />
      </div>

      {/* Action card */}
      {hasAction && meta && (
        <div style={{
          marginTop: 10, marginLeft: 22,
          border: `1px solid rgba(255,255,255,0.08)`,
          borderRadius: 7,
          overflow: 'hidden',
          background: 'var(--bg-elevated)',
        }}>
          {/* Card header */}
          <div style={{
            padding: '7px 12px',
            background: 'rgba(255,255,255,0.03)',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
            <span style={{
              fontSize: 12, color: 'var(--fg-primary)', fontWeight: 600,
              fontFamily: 'var(--font-serif)',
            }}>
              {meta.label}
            </span>
            {meta.summary && (
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-serif)' }}>
                — {meta.summary}
              </span>
            )}
          </div>

          {/* Details */}
          <ActionDetails action={activeReviewAction!} />

          {/* Buttons */}
          {actionResolved ? (
            <div style={{
              padding: '8px 12px',
              borderTop: '1px solid rgba(255,255,255,0.05)',
            }}>
              <span style={{
                fontSize: 11,
                color: 'var(--fg-muted)',
                fontFamily: 'var(--font-serif)',
              }}>
                {actionResultText ?? 'Completed.'}
              </span>
            </div>
          ) : reviewResult ? (
            <div style={{ padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-serif)' }}>
                {reviewResult}
              </span>
            </div>
          ) : (
            <div style={{ padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              {reviewSteps.length > 1 && activeReviewAction && action?.type !== 'transcribe_request' && action?.type !== 'update_ai_settings' && (
                <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '0 0 8px', fontFamily: 'var(--font-serif)' }}>
                  {reviewInProgress
                    ? `Previewing step ${reviewIndex + 1} of ${reviewSteps.length}. Accepted ${acceptedSteps}, skipped ${skippedSteps}.`
                    : `Review ${reviewSteps.length} proposed changes.`}
                </p>
              )}
              {anotherReviewActive && !reviewInProgress && action?.type !== 'transcribe_request' && action?.type !== 'update_ai_settings' && (
                <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '0 0 8px', fontFamily: 'var(--font-serif)' }}>
                  Finish the active review before opening another one.
                </p>
              )}
              {action?.type === 'update_ai_settings' ? (
                <button
                  onClick={handleApplySettings}
                  style={{
                    width: '100%', padding: '5px 0',
                    fontSize: 12, fontWeight: 500,
                    background: 'var(--accent)',
                    border: 'none',
                    color: '#000',
                    borderRadius: 4, cursor: 'pointer',
                    fontFamily: 'var(--font-serif)',
                    transition: 'all 0.15s',
                  }}
                >
                  Apply settings
                </button>
              ) : action?.type === 'transcribe_request' ? (
                <>
                  {transcribeError && (
                    <p style={{ fontSize: 11, color: '#f87171', margin: '0 0 6px', fontFamily: 'var(--font-serif)' }}>
                      {transcribeError}
                    </p>
                  )}
                  <button
                    onClick={handleTranscribe}
                    disabled={isTranscribing || transcriptionDone}
                    style={{
                      width: '100%', padding: '5px 0',
                      fontSize: 12, fontWeight: 500,
                      background: isTranscribing || transcriptionDone ? 'rgba(255,255,255,0.06)' : 'var(--accent)',
                      border: 'none',
                      color: isTranscribing || transcriptionDone ? 'var(--fg-muted)' : '#000',
                      borderRadius: 4, cursor: isTranscribing || transcriptionDone ? 'default' : 'pointer',
                      fontFamily: 'var(--font-serif)',
                      transition: 'all 0.15s',
                    }}
                  >
                    {isTranscribing ? 'Transcribing…' : transcriptionDone ? 'Transcript ready ✓' : 'Transcribe'}
                  </button>
                </>
              ) : reviewInProgress ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={handleApplyStep}
                    style={{
                      flex: 1,
                      padding: '5px 0',
                      fontSize: 12,
                      fontWeight: 500,
                      background: 'var(--accent)',
                      border: 'none',
                      color: '#000',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-serif)',
                    }}
                  >
                    Apply
                  </button>
                  <button
                    onClick={handleSkipStep}
                    style={{
                      flex: 1,
                      padding: '5px 0',
                      fontSize: 12,
                      fontWeight: 500,
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: 'var(--fg-secondary)',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-serif)',
                    }}
                  >
                    Skip
                  </button>
                  <button
                    onClick={cancelReview}
                    style={{
                      padding: '5px 10px',
                      fontSize: 12,
                      background: 'none',
                      border: 'none',
                      color: 'var(--fg-muted)',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-serif)',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={startReview}
                  disabled={anotherReviewActive}
                  style={{
                    width: '100%', padding: '5px 0',
                    fontSize: 12, fontWeight: 500,
                    background: anotherReviewActive ? 'rgba(255,255,255,0.06)' : 'var(--accent)',
                    border: 'none',
                    color: anotherReviewActive ? 'var(--fg-muted)' : '#000',
                    borderRadius: 4, cursor: anotherReviewActive ? 'default' : 'pointer',
                    fontFamily: 'var(--font-serif)',
                    transition: 'all 0.15s',
                  }}
                >
                  {reviewSteps.length > 1 ? 'Start review' : 'Preview edit'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Thinking indicator ────────────────────────────────────────────────────────
function ThinkingIndicator({ status }: { status?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <div style={{ flexShrink: 0, marginTop: 3 }}>
        <AutocutMark size={13} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 3, paddingTop: 4 }}>
          {[0, 1, 2].map(i => (
            <div key={i} className="dot-bar" style={{
              width: 3, height: 14,
              background: 'rgba(255,255,255,0.25)',
              borderRadius: 2,
              animationDelay: `${i * 0.15}s`,
            }} />
          ))}
        </div>
        {status && (
          <span style={{
            fontSize: 10,
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-serif)',
            lineHeight: 1.4,
          }}>
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

function ProgressStatusCard({
  title,
  progress,
  detail,
  secondaryLabel,
}: {
  title: string;
  progress: IndexingProgress | null;
  detail?: string | null;
  secondaryLabel?: string | null;
}) {
  const targetProgress = getProgressValue(progress);
  const etaLabel = formatEtaLabel(progress?.etaSeconds);

  return (
    <div style={{
      marginLeft: 22,
      padding: '12px 13px',
      borderRadius: 10,
      border: '1px solid rgba(255,255,255,0.08)',
      background: 'linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.02))',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: 'rgba(33,212,255,0.9)',
                opacity: 0.28,
                animation: `dotPulse 1.2s ease-in-out ${index * 0.12}s infinite`,
              }}
            />
          ))}
        </div>
        <span style={{ fontSize: 11, color: 'var(--fg-secondary)', fontFamily: 'var(--font-serif)' }}>
          {title}
        </span>
      </div>
      {targetProgress !== null && (
        <div style={{
          width: '100%',
          height: 6,
          borderRadius: 999,
          background: 'rgba(255,255,255,0.06)',
          overflow: 'hidden',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04)',
        }}>
          <div style={{
            width: `${Math.max((targetProgress ?? 0.06) * 100, 4)}%`,
            height: '100%',
            background: 'linear-gradient(90deg, rgba(33,212,255,0.78), rgba(125,211,252,1))',
            boxShadow: '0 0 18px rgba(33,212,255,0.22)',
            transition: 'width 0.45s cubic-bezier(0.22, 1, 0.36, 1)',
          }} />
        </div>
      )}
      {(progress?.label || etaLabel) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-serif)' }}>
            {progress?.label ?? ''}
          </span>
          {etaLabel && (
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.42)', fontFamily: 'var(--font-serif)', whiteSpace: 'nowrap' }}>
              {etaLabel}
            </span>
          )}
        </div>
      )}
      {secondaryLabel && (
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.48)', fontFamily: 'var(--font-serif)', lineHeight: 1.45 }}>
          {secondaryLabel}
        </span>
      )}
      {detail && (
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.38)', fontFamily: 'var(--font-serif)', lineHeight: 1.5 }}>
          {detail}
        </span>
      )}
    </div>
  );
}

function StatusNoticeCard({
  title,
  detail,
  tone = 'info',
}: {
  title: string;
  detail: string;
  tone?: 'info' | 'error';
}) {
  const isError = tone === 'error';

  return (
    <div style={{
      marginLeft: 22,
      padding: '12px 13px',
      borderRadius: 10,
      border: isError ? '1px solid rgba(248,113,113,0.28)' : '1px solid rgba(255,255,255,0.08)',
      background: isError
        ? 'linear-gradient(180deg, rgba(127,29,29,0.22), rgba(69,10,10,0.14))'
        : 'linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.02))',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <span style={{
        fontSize: 11,
        color: isError ? '#fca5a5' : 'var(--fg-secondary)',
        fontFamily: 'var(--font-serif)',
      }}>
        {title}
      </span>
      <span style={{
        fontSize: 10,
        color: isError ? 'rgba(254,202,202,0.9)' : 'rgba(255,255,255,0.38)',
        fontFamily: 'var(--font-serif)',
        lineHeight: 1.5,
      }}>
        {detail}
      </span>
    </div>
  );
}

// ─── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({
  isIndexing,
  indexingReason,
  indexingProgress,
  secondaryProgress,
  secondaryProgressTitle,
  indexingDetail,
  statusNotice,
  errorNotice,
}: {
  isIndexing: boolean;
  indexingReason: string | null;
  indexingProgress: IndexingProgress | null;
  secondaryProgress?: IndexingProgress | null;
  secondaryProgressTitle?: string | null;
  indexingDetail?: string | null;
  statusNotice?: string | null;
  errorNotice?: string | null;
}) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px 16px', gap: 8, textAlign: 'center',
    }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-primary)', margin: 0, fontFamily: 'var(--font-serif)' }}>
        Find moments. Tag them. Review the cut.
      </p>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: 0, lineHeight: 1.6, fontFamily: 'var(--font-serif)' }}>
        Describe the event you want to find, then review the markers and proposed cuts before applying them.
      </p>
      {isIndexing && (
        <div style={{ width: '100%', maxWidth: 290, marginTop: 10 }}>
          <ProgressStatusCard
            title={getIndexingStageTitle(indexingProgress, indexingReason)}
            progress={indexingProgress}
            detail={indexingDetail}
          />
        </div>
      )}
      {secondaryProgress && (
        <div style={{ width: '100%', maxWidth: 290, marginTop: 6 }}>
          <ProgressStatusCard
            title={secondaryProgressTitle ?? getIndexingStageTitle(secondaryProgress, null)}
            progress={secondaryProgress}
            detail={null}
          />
        </div>
      )}
      {statusNotice && (
        <div style={{ width: '100%', maxWidth: 290, marginTop: isIndexing ? 0 : 10 }}>
          <StatusNoticeCard
            title="Transcript unavailable"
            detail={statusNotice}
          />
        </div>
      )}
      {errorNotice && (
        <div style={{ width: '100%', maxWidth: 290 }}>
          <StatusNoticeCard
            title="Visual analysis error"
            detail={errorNotice}
            tone="error"
          />
        </div>
      )}
    </div>
  );
}

// ─── Main sidebar ──────────────────────────────────────────────────────────────
export default function ChatSidebar() {
  const [input, setInput] = useState('');
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);
  const [activeMarkerMention, setActiveMarkerMention] = useState<ActiveMarkerMention | null>(null);
  const [highlightedMarkerIndex, setHighlightedMarkerIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const frameDescriptionPromiseRef = useRef<Promise<SourceIndexedFrame[]> | null>(null);
  const extractionPromiseRef = useRef<Promise<IndexedVideoFrame[]> | null>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const syncingTaggedMarkersRef = useRef(false);
  const previousTaggedMarkerIdsRef = useRef<string[]>([]);

  const messages = useEditorStore(s => s.messages);
  const isChatLoading = useEditorStore(s => s.isChatLoading);
  const addMessage = useEditorStore(s => s.addMessage);
  const setIsChatLoading = useEditorStore(s => s.setIsChatLoading);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const clips = useEditorStore(s => s.clips);
  const markers = useEditorStore(s => s.markers);
  const selectedItem = useEditorStore(s => s.selectedItem);
  const taggedMarkerIds = useEditorStore(s => s.taggedMarkerIds);
  const setSelectedItem = useEditorStore(s => s.setSelectedItem);
  const setTaggedMarkerIds = useEditorStore(s => s.setTaggedMarkerIds);
  const clearTaggedMarkers = useEditorStore(s => s.clearTaggedMarkers);
  const clearChatHistory = useEditorStore(s => s.clearChatHistory);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [frameIndexingProgress, setFrameIndexingProgress] = useState<IndexingProgress | null>(null);
  const [frameAnalysisError, setFrameAnalysisError] = useState<string | null>(null);
  const videoUrl = useEditorStore(s => s.videoUrl);
  const videoData = useEditorStore(s => s.videoData);
  const videoFile = useEditorStore(s => s.videoFile);
  const transcriptStatus = useEditorStore(s => s.transcriptStatus);
  const transcriptProgress = useEditorStore(s => s.transcriptProgress);
  const transcriptStartedAtRef = useRef<number | null>(null);
  const projectedOverviewFrames = useEditorStore(s => s.projectedOverviewFrames);
  const sourceIndexFreshBySourceId = useEditorStore(s => s.sourceIndexFreshBySourceId);
  const setSourceOverviewFrames = useEditorStore(s => s.setSourceOverviewFrames);
  const playbackActive = useEditorStore(s => s.playbackActive);
  const currentProjectId = useEditorStore(s => s.currentProjectId);
  const setVisualSearchSession = useEditorStore(s => s.setVisualSearchSession);
  const addMarker = useEditorStore(s => s.addMarker);
  const applyStoredAction = useEditorStore(s => s.applyAction);
  const recordAppliedAction = useEditorStore(s => s.recordAppliedAction);
  const requestSeek = useEditorStore(s => s.requestSeek);
  const previewOwnerId = useEditorStore(s => s.previewOwnerId);
  const reviewLocked = previewOwnerId !== null;
  const mainTimelineDuration = useMemo(() => getTimelineDuration(clips), [clips]);
  const availableSources = useMemo(() => (
    resolveMainTrackSources({
      videoData,
      videoFile,
      videoUrl,
      videoDuration,
    }).filter((entry) => entry.source && entry.duration > 0)
  ), [videoData, videoDuration, videoFile, videoUrl]);
  const missingOverviewSources = useMemo(() => (
    availableSources.filter((entry) => !sourceIndexFreshBySourceId[entry.sourceId]?.overview)
  ), [availableSources, sourceIndexFreshBySourceId]);

  useEffect(() => {
    setFrameAnalysisError(null);
  }, [currentProjectId]);

  useEffect(() => {
    if (transcriptStatus === 'loading' && (transcriptProgress === null || transcriptProgress.completed === 0)) {
      transcriptStartedAtRef.current = performance.now();
    } else if (transcriptStatus !== 'loading') {
      transcriptStartedAtRef.current = null;
    }
  }, [transcriptStatus, transcriptProgress]);

  // Build selected clip context for the API
  const selectedClipContext = (() => {
    if (!selectedItem || selectedItem.type !== 'clip') return null;
    const idx = clips.findIndex(c => c.id === selectedItem.id);
    if (idx === -1) return null;
    return { index: idx, duration: clips[idx].sourceDuration };
  })();
  const taggedMarkers = useMemo(() => resolveMarkersById(taggedMarkerIds, markers), [markers, taggedMarkerIds]);
  const selectedMarkerContext = (() => {
    const selectedMarker = selectedItem && selectedItem.type === 'marker'
      ? markers.find((marker) => marker.id === selectedItem.id) ?? null
      : null;
    if (selectedMarker) return selectedMarker;
    return taggedMarkers.length === 1 ? taggedMarkers[0] : null;
  })();
  const inputTaggedMarkers = useMemo(() => extractTaggedMarkers(input, markers), [input, markers]);
  const markerSuggestions = useMemo(() => {
    if (!activeMarkerMention) return [];
    const query = activeMarkerMention.query.trim().toLowerCase();
    return [...markers]
      .sort((a, b) => a.number - b.number)
      .filter((marker) => {
        if (!query) return true;
        const label = marker.label?.toLowerCase() ?? '';
        return marker.number.toString().startsWith(query) || label.includes(query);
      })
      .slice(0, 6);
  }, [activeMarkerMention, markers]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isChatLoading]);

  useEffect(() => {
    if (areStringArraysEqual(previousTaggedMarkerIdsRef.current, taggedMarkerIds)) return;
    previousTaggedMarkerIdsRef.current = taggedMarkerIds;

    const nextTaggedMarkers = resolveMarkersById(taggedMarkerIds, markers);
    const currentTaggedMarkers = extractTaggedMarkers(input, markers);
    const currentIds = currentTaggedMarkers.map((marker) => marker.id);

    let nextInput = input;
    for (const marker of currentTaggedMarkers) {
      if (!taggedMarkerIds.includes(marker.id)) {
        nextInput = removeMarkerReference(nextInput, marker.number);
      }
    }
    for (const marker of nextTaggedMarkers) {
      if (!currentIds.includes(marker.id)) {
        nextInput = appendMarkerReference(nextInput, marker.number);
      }
    }

    if (nextInput !== input) {
      syncingTaggedMarkersRef.current = true;
      setInput(nextInput);
      setActiveMarkerMention(null);
    }
  }, [input, markers, taggedMarkerIds]);

  useEffect(() => {
    if (syncingTaggedMarkersRef.current) {
      syncingTaggedMarkersRef.current = false;
      return;
    }
    const nextTaggedIds = inputTaggedMarkers.map((marker) => marker.id);
    if (!areStringArraysEqual(nextTaggedIds, taggedMarkerIds)) {
      previousTaggedMarkerIdsRef.current = nextTaggedIds;
      setTaggedMarkerIds(nextTaggedIds);
    }
  }, [inputTaggedMarkers, setTaggedMarkerIds, taggedMarkerIds]);

  useEffect(() => {
    setHighlightedMarkerIndex(0);
  }, [activeMarkerMention?.query, markerSuggestions.length]);

  useEffect(() => {
    if (!isAgentMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!agentMenuRef.current?.contains(event.target as Node)) {
        setIsAgentMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [isAgentMenuOpen]);

  // Source overview indexing runs only when a source is missing canonical frame data.
  // Waits for transcript to complete so silence-aware timestamps can be computed.
  useEffect(() => {
    if ((!videoFile && !videoUrl && !videoData) || videoDuration <= 0) return;
    if (document.hidden || playbackActive || missingOverviewSources.length === 0) return;
    if (transcriptStatus !== 'done') return;
    void (async () => {
      try {
        await ensureFramesExtracted();
      } catch {
        // Keep the editor usable even if background indexing fails.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingOverviewSources, playbackActive, transcriptStatus, videoData, videoDuration, videoFile, videoUrl]);

  const ensureFramesExtracted = useCallback(async (): Promise<IndexedVideoFrame[]> => {
    if (extractionPromiseRef.current) return extractionPromiseRef.current;
    const promise = (async () => {
      const state = useEditorStore.getState();
      const sourcesToIndex = availableSources.filter(
        (entry) => !state.sourceIndexFreshBySourceId[entry.sourceId]?.overview
      );
      if (sourcesToIndex.length === 0) {
        return state.projectedOverviewFrames ?? [];
      }
      if (document.hidden || state.playbackActive) {
        return state.projectedOverviewFrames ?? [];
      }
      try {
        setFrameAnalysisError(null);
        const { overviewIntervalSeconds, maxOverviewFrames } = state.aiSettings.frameInspection;

        // Compute silence-aware timestamps from the transcript, if available.
        const captions = state.sourceTranscriptCaptions;

        let completedFrames = 0;
        let totalTargetFrames = 1; // placeholder; updated once we know explicit timestamps

        for (const entry of sourcesToIndex) {
          const explicitTimestamps = captions && captions.length > 0
            ? computeSilenceAwareTimestamps(entry.duration, captions)
            : undefined;

          const frameCount = explicitTimestamps
            ? explicitTimestamps.length
            : getOverviewFrameTarget(entry.duration, Math.max(0.1, overviewIntervalSeconds), maxOverviewFrames);
          totalTargetFrames = completedFrames + frameCount;

          const extractionStartedAt = performance.now();
          const extractionFallbackPerFrame = estimateFrameExtractionSeconds(frameCount) / Math.max(frameCount, 1);
          let lastProgressPaintAt = 0;
          setFrameIndexingProgress({
            stage: 'extracting_frames',
            completed: completedFrames,
            total: Math.max(totalTargetFrames, 1),
            label: `Sampling source frames`,
            etaSeconds: estimateFrameExtractionSeconds(frameCount),
          });

          const frames = await extractSourceOverviewFrames({
            sourceId: entry.sourceId,
            source: entry.source!,
            duration: entry.duration,
            overviewIntervalSeconds,
            maxOverviewFrames,
            explicitTimestamps,
            onProgress: ({ completed, total }) => {
              const now = performance.now();
              if (completed < total && now - lastProgressPaintAt < 120) return;
              lastProgressPaintAt = now;
              setFrameIndexingProgress({
                stage: 'extracting_frames',
                completed: completedFrames + completed,
                total: Math.max(totalTargetFrames, 1),
                label: `Sampling frames ${Math.min(completedFrames + completed, totalTargetFrames)}/${totalTargetFrames}`,
                etaSeconds: estimateRemainingSecondsFromObservedRate(
                  extractionStartedAt,
                  completedFrames + completed,
                  totalTargetFrames,
                  extractionFallbackPerFrame,
                ),
              });
            },
          });

          const describedFrames = await ensureFrameDescriptions(frames, true);
          setSourceOverviewFrames(entry.sourceId, describedFrames, {
            fresh: describedFrames.every((frame) => hasUsableFrameDescription(frame.description)),
          });
          completedFrames += frames.length;
        }

        const refreshedState = useEditorStore.getState();
        setFrameIndexingProgress({
          stage: 'extracting_frames',
          completed: totalTargetFrames,
          total: Math.max(totalTargetFrames, 1),
          label: `Sampled source frames`,
          etaSeconds: 0,
        });
        return refreshedState.projectedOverviewFrames ?? [];
      } catch (error) {
        setFrameAnalysisError(getErrorMessage(error, 'Failed to analyze sampled video frames.'));
        setFrameIndexingProgress(null);
        return useEditorStore.getState().projectedOverviewFrames ?? [];
      }
    })();
    extractionPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      if (extractionPromiseRef.current === promise) {
        extractionPromiseRef.current = null;
      }
    }
  }, [availableSources, setSourceOverviewFrames]);

  async function ensureFrameDescriptions(
    frames: SourceIndexedFrame[],
    force = false,
  ): Promise<SourceIndexedFrame[]> {
    if (frames.length === 0) return frames;
    if (!force && frames.every((frame) => hasUsableFrameDescription(frame.description))) {
      return frames;
    }
    if (frameDescriptionPromiseRef.current && !force) {
      return frameDescriptionPromiseRef.current;
    }

    const promise = (async () => {
      let nextFrames = [...frames];
      const totalOverviewFrames = nextFrames.length;
      const initialCompleted = nextFrames.filter((frame) => hasUsableFrameDescription(frame.description)).length;
      const completedBeforeRequests = initialCompleted;
      const descriptionStartedAt = performance.now();
      const descriptionFallbackPerFrame = estimateFrameDescriptionSeconds(totalOverviewFrames) / Math.max(totalOverviewFrames, 1);
      const batches: FrameDescriptionBatch[] = [];
      for (let start = 0; start < nextFrames.length; start += FRAME_DESCRIPTION_BATCH_SIZE) {
        const batch = nextFrames.slice(start, start + FRAME_DESCRIPTION_BATCH_SIZE);
        const shouldDescribeBatch = force || batch.some((frame) => !hasUsableFrameDescription(frame.description));
        if (!shouldDescribeBatch) continue;

        const batchFrames = batch
          .filter((frame): frame is SourceIndexedFrame & { image: string } => (
            typeof frame.image === 'string' && frame.image.length > 0
          ))
          .map((frame) => ({
            image: frame.image,
            timelineTime: frame.sourceTime,
            sourceTime: frame.sourceTime,
        }));
        if (batchFrames.length === 0) continue;
        batches.push({ start, batchFrames });
      }

      let completedBatchCount = 0;
      let activeBatchCount = 0;
      const totalBatches = batches.length;
      setFrameIndexingProgress({
        stage: 'describing_frames',
        completed: initialCompleted,
        total: Math.max(totalOverviewFrames, 1),
        label: formatFrameDescriptionProgressLabel({
          completedFrames: initialCompleted,
          totalFrames: totalOverviewFrames,
          completedBatches: 0,
          totalBatches: Math.max(totalBatches, 1),
          activeBatches: 0,
        }),
        etaSeconds: estimateFrameDescriptionSeconds(Math.max(totalOverviewFrames - initialCompleted, 0)),
      });

      const errors = await runFrameDescriptionBatches(batches, {
        onBatchStart: () => {
          activeBatchCount += 1;
          const completed = nextFrames.filter((frame) => hasUsableFrameDescription(frame.description)).length;
          setFrameIndexingProgress({
            stage: 'describing_frames',
            completed,
            total: Math.max(totalOverviewFrames, 1),
            label: formatFrameDescriptionProgressLabel({
              completedFrames: completed,
              totalFrames: totalOverviewFrames,
              completedBatches: completedBatchCount,
              totalBatches: Math.max(totalBatches, 1),
              activeBatches: activeBatchCount,
            }),
            etaSeconds: estimateRemainingSecondsFromObservedRate(
              descriptionStartedAt,
              completed,
              totalOverviewFrames,
              descriptionFallbackPerFrame,
            ),
          });
        },
        onBatchComplete: (result) => {
          nextFrames = mergeFrameDescriptions(
            nextFrames.map((frame) => ({
              timelineTime: frame.sourceTime,
              sourceTime: frame.sourceTime,
              sourceId: frame.sourceId,
              kind: 'overview' as const,
              image: frame.image,
              description: frame.description,
            })),
            result.start,
            result.data.descriptions ?? [],
          ).map((frame) => ({
            sourceId: frame.sourceId ?? MAIN_SOURCE_ID,
            sourceTime: frame.sourceTime,
            image: frame.image,
            description: frame.description,
          }));
          completedBatchCount += 1;
          const completed = nextFrames.filter((frame) => hasUsableFrameDescription(frame.description)).length;
          const remaining = Math.max(totalOverviewFrames - completed, 0);
          setFrameIndexingProgress({
            stage: 'describing_frames',
            completed,
            total: Math.max(totalOverviewFrames, 1),
            label: formatFrameDescriptionProgressLabel({
              completedFrames: completed,
              totalFrames: totalOverviewFrames,
              completedBatches: completedBatchCount,
              totalBatches: Math.max(totalBatches, 1),
              activeBatches: activeBatchCount,
            }),
            etaSeconds: remaining > 0
              ? estimateRemainingSecondsFromObservedRate(
                descriptionStartedAt,
                completed,
                totalOverviewFrames,
                descriptionFallbackPerFrame,
              )
              : 0,
          });
        },
        onBatchSettled: () => {
          activeBatchCount = Math.max(0, activeBatchCount - 1);
          const completed = nextFrames.filter((frame) => hasUsableFrameDescription(frame.description)).length;
          setFrameIndexingProgress({
            stage: 'describing_frames',
            completed,
            total: Math.max(totalOverviewFrames, 1),
            label: formatFrameDescriptionProgressLabel({
              completedFrames: completed,
              totalFrames: totalOverviewFrames,
              completedBatches: completedBatchCount,
              totalBatches: Math.max(totalBatches, 1),
              activeBatches: activeBatchCount,
            }),
            etaSeconds: completed >= totalOverviewFrames
              ? 0
              : estimateRemainingSecondsFromObservedRate(
                descriptionStartedAt,
                Math.max(completed, completedBeforeRequests),
                totalOverviewFrames,
                descriptionFallbackPerFrame,
              ),
          });
        },
      });
      if (errors.length > 0) {
        const firstError = getErrorMessage(errors[0], 'Failed to analyze sampled video frames.');
        setFrameAnalysisError(
          errors.length === 1
            ? firstError
            : `${firstError} (${errors.length} frame-description requests failed.)`
        );
      } else {
        setFrameAnalysisError(null);
      }
      return nextFrames;
    })();

    frameDescriptionPromiseRef.current = promise;
    try {
      return await promise;
    } catch (error) {
      setFrameAnalysisError(getErrorMessage(error, 'Failed to analyze sampled video frames.'));
      setFrameIndexingProgress(null);
      return frames;
    } finally {
      if (frameDescriptionPromiseRef.current === promise) {
        frameDescriptionPromiseRef.current = null;
      }
    }
  }

  const frameDescriptionsReady = useMemo(() => {
    if (projectedOverviewFrames === null) return false;
    return projectedOverviewFrames.every((frame) => hasUsableFrameDescription(frame.description));
  }, [projectedOverviewFrames]);

  const buildCurrentTranscript = useCallback(() => {
    const freshState = useEditorStore.getState();
    const rawCaptions = freshState.sourceTranscriptCaptions;
    if (rawCaptions && rawCaptions.length > 0) {
      return buildTranscriptContext(freshState.clips, rawCaptions);
    }
    return freshState.backgroundTranscript;
  }, []);

  const runSingleTurn = useCallback(async (
    history: ChatRequestMessage[],
    ctrl: AbortController,
  ) => {
    const latestUserInput = [...history].reverse().find((entry) => entry.role === 'user')?.content ?? '';
    const preferSourceVisualRetrieval = looksLikeVisualSearchQuery(latestUserInput) && !!useEditorStore.getState().currentProjectId;
    let currentFrames = preferSourceVisualRetrieval ? [] : await ensureFramesExtracted();
    let producedVisibleResponse = false;

    for (let round = 0; round < 4; round++) {
      if (stopRequestedRef.current) break;
      const freshState = useEditorStore.getState();
      const currentClips = freshState.clips;
      const currentTranscript = buildCurrentTranscript();
      const silenceCandidates = buildSilenceCandidatePayload();

      const { message = '', action, visualSearch } = await postChatRequest({
        messages: history,
        context: {
          projectId: freshState.currentProjectId,
          visualSearchSession: freshState.visualSearchSession,
          videoDuration: getTimelineDuration(currentClips),
          clipCount: currentClips.length,
          clips: currentClips.map((c, i) => ({
            index: i,
            sourceId: c.sourceId,
            sourceStart: c.sourceStart,
            sourceDuration: c.sourceDuration,
            speed: c.speed,
          })),
          selectedClip: selectedClipContext,
          selectedMarker: selectedMarkerContext ? {
            number: selectedMarkerContext.number,
            timelineTime: selectedMarkerContext.timelineTime,
            label: selectedMarkerContext.label ?? null,
          } : null,
          markers: freshState.markers.map((marker) => ({
            id: marker.id,
            number: marker.number,
            timelineTime: marker.timelineTime,
            label: marker.label ?? null,
            status: marker.status,
            linkedRange: marker.linkedRange ?? null,
            note: marker.note ?? null,
          })),
          taggedMarkers: taggedMarkers.map((marker) => ({
            id: marker.id,
            number: marker.number,
            timelineTime: marker.timelineTime,
            label: marker.label ?? null,
          })),
          textOverlayCount: freshState.textOverlays.length,
          transcript: currentTranscript,
          silenceCandidates,
          settings: freshState.aiSettings,
          appliedActions: freshState.appliedActions,
          frames: buildFrameContextPayload(currentFrames, currentClips),
        },
      }, ctrl);
      setVisualSearchSession(visualSearch ?? null);
      const markerAction = isMarkerMutationAction(action);
      if (!markerAction) {
        upsertMarkersFromVisualSearch(latestUserInput, visualSearch, addMarker);
      }
      const assistantMessage = message.trim() || getAssistantFallbackMessage(action);

      if (action?.type === 'request_frames' && action.frameRequest) {
        const req = action.frameRequest as { startTime: number; endTime: number; count?: number };
        const spanSeconds = Math.max(req.endTime - req.startTime, 0.5);
        const count = Math.min(
          req.count ?? Math.max(freshState.aiSettings.frameInspection.defaultFrameCount, Math.ceil(spanSeconds * 4)),
          60,
        );
        addMessage({ role: 'assistant', content: assistantMessage, visualSearch: visualSearch ?? undefined });
        producedVisibleResponse = true;
        setLoadingStatus(`Inspecting ${count} precise frames (${formatTime(req.startTime)}–${formatTime(req.endTime)})…`);
        const interval = (req.endTime - req.startTime) / count;
        const timelineTimestamps = Array.from({ length: count }, (_, i) => req.startTime + i * interval);
        currentFrames = (await extractTimelineFramesFromSources({
          clips: currentClips,
          videoData: freshState.videoData,
          videoFile: freshState.videoFile,
          videoUrl: freshState.videoUrl,
          videoDuration: freshState.videoDuration,
          timelineTimestamps,
          kind: 'dense',
        })).map((frame) => ({
          ...frame,
          rangeStart: req.startTime,
          rangeEnd: req.endTime,
        }));
        setLoadingStatus('');
        history.push({ role: 'assistant', content: assistantMessage });
        history.push({ role: 'user', content: `[${count} dense frames extracted from ${formatTime(req.startTime)} to ${formatTime(req.endTime)}. Now answer with these frames.]` });
        continue;
      }

      if (action?.type === 'inspect_frames' && action.inspectRequest) {
        const req = action.inspectRequest;
        const fps = Math.max(0.1, Math.min(4, req.fps ?? 1));
        const spanSeconds = Math.max(req.endTime - req.startTime, 0.5);
        const count = Math.min(Math.ceil(spanSeconds * fps), 60);
        addMessage({ role: 'assistant', content: getAssistantFallbackMessage(action), action, visualSearch: visualSearch ?? undefined });
        producedVisibleResponse = true;
        setLoadingStatus(`Inspecting ${count} frames (${formatTime(req.startTime)}–${formatTime(req.endTime)} @${fps}fps)…`);
        const interval = (req.endTime - req.startTime) / count;
        const timelineTimestamps = Array.from({ length: count }, (_, i) => req.startTime + i * interval);
        currentFrames = (await extractTimelineFramesFromSources({
          clips: currentClips,
          videoData: freshState.videoData,
          videoFile: freshState.videoFile,
          videoUrl: freshState.videoUrl,
          videoDuration: freshState.videoDuration,
          timelineTimestamps,
          kind: 'dense',
        })).map((frame) => ({
          ...frame,
          rangeStart: req.startTime,
          rangeEnd: req.endTime,
        }));
        setLoadingStatus('');
        history.push({ role: 'assistant', content: assistantMessage });
        history.push({ role: 'user', content: `[${count} dense frames extracted from ${formatTime(req.startTime)} to ${formatTime(req.endTime)} at ${fps}fps. Now answer with these frames.]` });
        continue;
      }

      if (action?.type === 'search_transcript' && action.transcriptQuery) {
        const query = action.transcriptQuery;
        const transcript = buildCurrentTranscript() ?? '';
        const lines = transcript.split('\n').filter(line => line.toLowerCase().includes(query.toLowerCase()));
        const MAX_RESULTS = 40;
        const truncated = lines.length > MAX_RESULTS;
        const resultLines = lines.slice(0, MAX_RESULTS);
        const resultText = lines.length === 0
          ? `[Transcript search for "${query}" returned no results.]`
          : `[Transcript search for "${query}" found ${lines.length} line(s)${truncated ? ` (showing first ${MAX_RESULTS})` : ''}:\n${resultLines.join('\n')}\nNow decide what to inspect or edit.]`;
        addMessage({ role: 'assistant', content: getAssistantFallbackMessage(action), action, visualSearch: visualSearch ?? undefined });
        producedVisibleResponse = true;
        history.push({ role: 'assistant', content: assistantMessage });
        history.push({ role: 'user', content: resultText });
        continue;
      }

      const markerActionPreviouslyApplied = markerAction && action
        ? freshState.appliedActions.some((record) => actionsMatch(record.action, action))
        : false;
      const hasPendingAction = !!action && action.type !== 'none';
      const nextActionStatus = markerAction
        ? 'completed'
        : hasPendingAction
          ? 'pending'
          : undefined;

      if (markerAction && action && !markerActionPreviouslyApplied) {
        applyStoredAction(action);
        recordAppliedAction(action, action.message);
        const markerSeekTime = getMarkerActionSeekTime(action, freshState.markers);
        if (markerSeekTime !== null) requestSeek(markerSeekTime);
      }

      addMessage({
        role: 'assistant',
        content: assistantMessage,
        action: action ?? undefined,
        visualSearch: visualSearch ?? undefined,
        autoApplied: markerAction && !markerActionPreviouslyApplied ? true : undefined,
        actionStatus: nextActionStatus,
        actionResult: markerAction && action
          ? markerActionPreviouslyApplied
            ? 'Already applied.'
            : getMarkerActionResult(action)
          : undefined,
      });
      producedVisibleResponse = true;
      return;
    }

    if (!producedVisibleResponse) {
      addMessage({
        role: 'assistant',
        content: 'I inspected that section but did not finish with a concrete edit. The frame search was too broad and needs a narrower visual target.',
      });
    }
  }, [addMarker, addMessage, applyStoredAction, buildCurrentTranscript, ensureFramesExtracted, recordAppliedAction, requestSeek, selectedClipContext, selectedMarkerContext, setVisualSearchSession, taggedMarkers]);

  const handleSendSingle = useCallback(async () => {
    const text = input.trim();
    if (!text || isChatLoading || reviewLocked) return;

    setInput('');
    previousTaggedMarkerIdsRef.current = [];
    clearTaggedMarkers();
    setActiveMarkerMention(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    addMessage({ role: 'user', content: text });
    setIsChatLoading(true);
    setLoadingStatus('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    stopRequestedRef.current = false;

    try {
      const history = buildChatRequestHistory(messages, text);
      await runSingleTurn(history, ctrl);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        addMessage({ role: 'assistant', content: `Network error: ${err instanceof Error ? err.message : 'Unknown'}` });
      }
    } finally {
      setIsChatLoading(false);
      setLoadingStatus('');
    }
  }, [addMessage, clearTaggedMarkers, input, isChatLoading, messages, reviewLocked, runSingleTurn, setIsChatLoading]);

  const handleTranscriptReady = useCallback(async (messageId: string) => {
    if (isChatLoading || reviewLocked) return;
    const currentMessages = useEditorStore.getState().messages;
    const assistantIndex = currentMessages.findIndex(m => m.id === messageId);
    if (assistantIndex === -1) return;

    const triggeringUser = [...currentMessages.slice(0, assistantIndex)].reverse().find(m => m.role === 'user');
    if (!triggeringUser) return;

    setIsChatLoading(true);
    setLoadingStatus('Continuing with transcript…');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    stopRequestedRef.current = false;

    try {
      const history = buildChatRequestHistory(currentMessages, `Continue my previous request now that the requested transcript is available. Original request: "${triggeringUser.content}". Do not ask to transcribe the same section again.`);
      await runSingleTurn(history, ctrl);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        addMessage({ role: 'assistant', content: `Network error: ${err instanceof Error ? err.message : 'Unknown'}` });
      }
    } finally {
      setIsChatLoading(false);
      setLoadingStatus('');
    }
  }, [addMessage, isChatLoading, reviewLocked, runSingleTurn, setIsChatLoading]);

  const handleStop = useCallback(() => {
    stopRequestedRef.current = true;
    const ctrl = abortRef.current;
    abortRef.current = null;
    if (ctrl) {
      try {
        ctrl.abort(new DOMException('User stopped the current request', 'AbortError'));
      } catch {
        // Some runtimes reject custom abort reasons; fall back to a plain abort.
        try {
          ctrl.abort();
        } catch {
          // Ignore stop failures and just reset local loading state.
        }
      }
    }
    setIsChatLoading(false);
    setLoadingStatus('');
  }, [setIsChatLoading]);

  const handleClearChat = useCallback(() => {
    if (isChatLoading || reviewLocked || messages.length === 0) return;
    clearChatHistory();
    setInput('');
    setActiveMarkerMention(null);
    setHighlightedMarkerIndex(0);
    previousTaggedMarkerIdsRef.current = [];
    clearTaggedMarkers();
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [clearChatHistory, clearTaggedMarkers, isChatLoading, messages.length, reviewLocked]);

  const hasVideoSource = !!(videoFile || videoUrl || videoData);
  const framesReady = frameAnalysisError !== null || (projectedOverviewFrames !== null && frameDescriptionsReady);
  const transcriptFailed = transcriptStatus === 'error';
  const agentContextReady = framesReady && (transcriptStatus === 'done' || transcriptFailed);
  const estimatedTranscriptEta = estimateTranscriptSeconds(mainTimelineDuration || videoDuration);
  const estimatedTranscriptRemainingEta =
    transcriptProgress && transcriptProgress.total > 0 && transcriptStartedAtRef.current !== null
      ? estimateRemainingSecondsFromObservedRate(
          transcriptStartedAtRef.current,
          transcriptProgress.completed,
          transcriptProgress.total,
          estimatedTranscriptEta / Math.max(transcriptProgress.total, 1),
        )
      : estimatedTranscriptEta;
  const indexingProgress = transcriptStatus === 'loading'
    ? {
        stage: 'transcribing' as const,
        completed: transcriptProgress?.completed ?? 0,
        total: transcriptProgress?.total ?? 1,
        label: transcriptProgress && transcriptProgress.total > 0
          ? `Transcribing audio ${Math.min(transcriptProgress.completed, transcriptProgress.total)}/${transcriptProgress.total}`
          : 'Transcribing audio',
        etaSeconds: estimatedTranscriptRemainingEta,
      }
    : framesReady
      ? null
      : frameIndexingProgress;
  const agentNotReadyReason = !agentContextReady && hasVideoSource
    ? (transcriptStatus === 'loading' && projectedOverviewFrames === null)
      ? 'Preparing media…'
      : transcriptStatus === 'loading'
        ? 'Transcribing audio…'
        : projectedOverviewFrames === null
          ? 'Sampling video frames…'
          : !frameDescriptionsReady
            ? 'Analyzing sampled frames…'
          : null
    : null;
  const transcriptUnavailableNotice = hasVideoSource && framesReady && transcriptFailed
    ? 'Audio transcription did not finish, but the assistant is ready to work from the video and visual analysis.'
    : null;
  const frameAnalysisErrorNotice = hasVideoSource && frameAnalysisError
    ? `${frameAnalysisError} The assistant will continue without visual frame summaries until analysis succeeds.`
    : null;
  const pendingVisualQuery = looksLikeVisualSearchQuery(input.trim()) && !!currentProjectId;
  const canSendDespiteIndexing = pendingVisualQuery;
  const isAnalyzingSampledFrames = hasVideoSource
    && (transcriptStatus === 'done' || transcriptFailed)
    && projectedOverviewFrames !== null
    && frameAnalysisError === null
    && !frameDescriptionsReady;
  const mediaPreparationBlockingSend = hasVideoSource
    && !agentContextReady
    && !canSendDespiteIndexing
    && !isAnalyzingSampledFrames;
  const secondaryIndexingProgress: IndexingProgress | null = (transcriptStatus === 'loading' && !framesReady && frameIndexingProgress)
    ? frameIndexingProgress
    : null;
  const indexingDetail = (!framesReady && !secondaryIndexingProgress)
    ? 'Deep indexing can take a while on longer videos.'
    : null;
  const composerInputDisabled = isChatLoading || reviewLocked;
  const composerMuted = composerInputDisabled || mediaPreparationBlockingSend;
  const canSubmitMessage = input.trim().length > 0 && !composerInputDisabled && !mediaPreparationBlockingSend;

  const resizeComposer = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 300)}px`;
    }
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [input, resizeComposer]);

  const syncActiveMarkerMention = useCallback((value: string, caret: number | null) => {
    setActiveMarkerMention(getActiveMarkerMention(value, caret));
  }, []);

  const focusComposer = useCallback((selectionStart?: number, selectionEnd?: number) => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      if (selectionStart !== undefined) {
        ta.selectionStart = selectionStart;
        ta.selectionEnd = selectionEnd ?? selectionStart;
      }
      resizeComposer();
    });
  }, [resizeComposer]);

  const applyMarkerSuggestion = useCallback((marker: MarkerEntry) => {
    if (!activeMarkerMention) return;
    const nextValue = replaceMarkerMention(input, activeMarkerMention, marker.number);
    const nextCaret = activeMarkerMention.start + `@${marker.number} `.length;
    setInput(nextValue);
    setActiveMarkerMention(null);
    focusComposer(nextCaret);
  }, [activeMarkerMention, focusComposer, input]);

  const untagMarker = useCallback((marker: MarkerEntry) => {
    const nextTaggedIds = taggedMarkerIds.filter((id) => id !== marker.id);
    previousTaggedMarkerIdsRef.current = nextTaggedIds;
    setTaggedMarkerIds(nextTaggedIds);
    const nextValue = removeMarkerReference(input, marker.number);
    syncingTaggedMarkersRef.current = true;
    setInput(nextValue);
    setActiveMarkerMention(null);
    focusComposer(nextValue.length);
  }, [focusComposer, input, setTaggedMarkerIds, taggedMarkerIds]);

  useEffect(() => {
    if (framesReady) {
      setFrameIndexingProgress(null);
    }
  }, [framesReady]);

  const handleSend = useCallback(() => {
    if (!canSubmitMessage) return;
    handleSendSingle();
  }, [canSubmitMessage, handleSendSingle]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (reviewLocked) return;
    if (markerSuggestions.length > 0 && activeMarkerMention) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedMarkerIndex((current) => Math.min(current + 1, markerSuggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedMarkerIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        applyMarkerSuggestion(markerSuggestions[highlightedMarkerIndex] ?? markerSuggestions[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setActiveMarkerMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    syncActiveMarkerMention(e.target.value, e.target.selectionStart);
    resizeComposer();
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%',
      background: 'var(--bg-panel)',
    }}>
      {/* Header */}
      <div style={{
        minHeight: 52,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 14px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <AutocutMark size={24} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-primary)', fontFamily: 'var(--font-serif)' }}>
              Cut Agent
            </span>
            <div ref={agentMenuRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setIsAgentMenuOpen((open) => !open)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 999,
                  color: 'var(--fg-secondary)',
                  fontSize: 10,
                  fontFamily: 'var(--font-serif)',
                  cursor: 'pointer',
                }}
              >
                <span>Agents</span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{ transform: isAgentMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {isAgentMenuOpen && (
                <div style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  right: 0,
                  width: 210,
                  maxWidth: 'calc(100vw - 32px)',
                  padding: 6,
                  borderRadius: 10,
                  background: 'rgba(14,14,16,0.98)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  boxShadow: '0 18px 30px rgba(0,0,0,0.28)',
                  zIndex: 20,
                }}>
                  {AGENT_MENU_ITEMS.map((agent) => {
                    const active = agent.status === 'active';
                    return (
                      <div
                        key={agent.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                          padding: '9px 10px',
                          borderRadius: 8,
                          background: active ? 'rgba(255,255,255,0.04)' : 'transparent',
                          color: active ? 'var(--fg-primary)' : 'rgba(255,255,255,0.38)',
                        }}
                      >
                        <span style={{ fontSize: 11, fontFamily: 'var(--font-serif)', fontWeight: active ? 600 : 500 }}>
                          {agent.label}
                        </span>
                        <span style={{
                          fontSize: 10,
                          fontFamily: 'var(--font-serif)',
                          color: active ? 'var(--accent-strong)' : 'rgba(255,255,255,0.34)',
                        }}>
                          {active ? 'Available now' : 'In progress'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handleClearChat}
              disabled={isChatLoading || reviewLocked || messages.length === 0}
              aria-label="Clear chat"
              title="Clear chat"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 10px',
                height: 28,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 999,
                color: isChatLoading || reviewLocked || messages.length === 0 ? 'rgba(255,255,255,0.24)' : 'var(--fg-secondary)',
                cursor: isChatLoading || reviewLocked || messages.length === 0 ? 'default' : 'pointer',
                transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7h16" />
                <path d="M9 7V4h6v3" />
                <path d="M7 7l1 12h8l1-12" />
                <path d="M10 11v5" />
                <path d="M14 11v5" />
              </svg>
              <span style={{ fontSize: 10, fontFamily: 'var(--font-serif)' }}>Clear chat</span>
            </button>
          </div>
        </div>

      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 12px' }}>
        {messages.length === 0 ? (
          <EmptyState
            isIndexing={hasVideoSource && !agentContextReady}
            indexingReason={agentNotReadyReason}
            indexingProgress={indexingProgress}
            secondaryProgress={secondaryIndexingProgress}
            secondaryProgressTitle={secondaryIndexingProgress ? getIndexingStageTitle(secondaryIndexingProgress, null) : null}
            indexingDetail={indexingDetail}
            statusNotice={transcriptUnavailableNotice}
            errorNotice={frameAnalysisErrorNotice}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {messages.map(msg => msg.role === 'user'
              ? <UserMessage key={msg.id} msg={msg} />
              : <AssistantMessage key={msg.id} msg={msg} onTranscriptReady={handleTranscriptReady} />
            )}
            {transcriptUnavailableNotice && (
              <StatusNoticeCard
                title="Transcript unavailable"
                detail={transcriptUnavailableNotice}
              />
            )}
            {frameAnalysisErrorNotice && (
              <StatusNoticeCard
                title="Visual analysis error"
                detail={frameAnalysisErrorNotice}
                tone="error"
              />
            )}
            {!isChatLoading && hasVideoSource && !agentContextReady && !canSendDespiteIndexing && (
              <>
                <ProgressStatusCard
                  title={getIndexingStageTitle(indexingProgress, agentNotReadyReason)}
                  progress={indexingProgress}
                  detail={indexingDetail}
                />
                {secondaryIndexingProgress && (
                  <ProgressStatusCard
                    title={getIndexingStageTitle(secondaryIndexingProgress, null)}
                    progress={secondaryIndexingProgress}
                    detail={null}
                  />
                )}
              </>
            )}
            {isChatLoading && <ThinkingIndicator status={loadingStatus || undefined} />}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        flexShrink: 0,
        padding: '8px 10px 10px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-panel)',
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6,
          background: 'var(--bg-elevated)',
          border: `1px solid ${composerMuted ? 'rgba(255,255,255,0.06)' : 'var(--border-mid)'}`,
          borderRadius: 8,
          padding: '9px 11px 7px',
          transition: 'border-color 0.2s ease, opacity 0.2s ease',
          opacity: composerMuted ? 0.82 : 1,
        }}>
          {selectedClipContext && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '2px 6px 2px 6px',
                background: 'rgba(56,189,248,0.12)',
                border: '1px solid rgba(56,189,248,0.3)',
                borderRadius: 4,
                fontSize: 11,
                color: '#7dd3fc',
                fontFamily: 'var(--font-serif)',
              }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20"/>
                </svg>
                Clip {selectedClipContext.index + 1}
                <button
                  onClick={() => setSelectedItem(null)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: 0, marginLeft: 1, color: 'rgba(125,211,252,0.6)',
                    lineHeight: 1,
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>
          )}
          {taggedMarkers.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              {taggedMarkers.map((marker) => (
                <button
                  key={marker.id}
                  onClick={() => untagMarker(marker)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '2px 7px',
                    background: 'rgba(250,204,21,0.12)',
                    border: '1px solid rgba(250,204,21,0.28)',
                    borderRadius: 999,
                    fontSize: 11,
                    color: '#fde68a',
                    fontFamily: 'var(--font-serif)',
                    cursor: 'pointer',
                  }}
                  title="Remove this marker tag from the message"
                >
                  <span>@{marker.number}</span>
                  <span>{marker.label ?? formatChatTime(marker.timelineTime)}</span>
                  <span style={{ color: 'rgba(253,230,138,0.72)' }}>×</span>
                </button>
              ))}
            </div>
          )}
          {activeMarkerMention && markerSuggestions.length > 0 && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              padding: '4px',
              borderRadius: 8,
              background: 'rgba(0,0,0,0.18)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}>
              {markerSuggestions.map((marker, index) => {
                const isHighlighted = index === highlightedMarkerIndex;
                return (
                  <button
                    key={marker.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyMarkerSuggestion(marker)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: 'none',
                      background: isHighlighted ? 'rgba(250,204,21,0.16)' : 'transparent',
                      color: isHighlighted ? '#fde68a' : 'var(--fg-secondary)',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-serif)',
                      fontSize: 11,
                      textAlign: 'left',
                    }}
                  >
                    <span>@{marker.number}</span>
                    <span style={{ flex: 1, color: 'var(--fg-primary)' }}>
                      {marker.label ?? formatChatTime(marker.timelineTime)}
                    </span>
                    <span style={{ color: 'var(--fg-muted)' }}>{formatChatTime(marker.timelineTime)}</span>
                  </button>
                );
              })}
            </div>
          )}
          {reviewLocked && (
            <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: 0, fontFamily: 'var(--font-serif)' }}>
              Finish the active edit review before sending another request.
            </p>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onClick={(event) => syncActiveMarkerMention(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyUp={(event) => syncActiveMarkerMention(event.currentTarget.value, event.currentTarget.selectionStart)}
            placeholder={
              reviewLocked
                ? 'Complete the active review…'
                : isChatLoading
                  ? 'Autocut is working…'
                  : isAnalyzingSampledFrames
                    ? 'Autocut is analyzing frames. You can send now…'
                  : mediaPreparationBlockingSend
                    ? 'Autocut is preparing the media. You can keep typing…'
                  : 'Find events, reference markers, and review cuts…'
            }
            rows={1}
            disabled={composerInputDisabled}
            style={{
              resize: 'none',
              background: 'transparent',
              border: 'none',
              color: composerInputDisabled ? 'var(--fg-muted)' : 'var(--fg-primary)',
              fontSize: 13,
              lineHeight: 1.55,
              minHeight: 20,
              maxHeight: 300,
              width: '100%',
              fontFamily: 'var(--font-serif)',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
            {isChatLoading ? (
              <button
                onClick={handleStop}
                style={{
                  width: 28, height: 28,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(255,255,255,0.08)',
                  border: '1.5px solid rgba(255,255,255,0.18)',
                  borderRadius: '50%',
                  cursor: 'pointer',
                  flexShrink: 0,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
              >
                <div style={{ width: 8, height: 8, borderRadius: 1.5, background: 'rgba(255,255,255,0.8)' }} />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!canSubmitMessage}
                style={{
                  width: 28, height: 28,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: canSubmitMessage ? 'var(--accent)' : 'rgba(255,255,255,0.06)',
                  border: 'none', borderRadius: 6,
                  cursor: canSubmitMessage ? 'pointer' : 'default',
                  flexShrink: 0,
                  transition: 'background 0.15s',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill={canSubmitMessage ? '#000' : 'rgba(255,255,255,0.25)'}>
                  <line x1="22" y1="2" x2="11" y2="13" stroke={canSubmitMessage ? '#000' : 'rgba(255,255,255,0.25)'} strokeWidth="2" fill="none"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
