'use client';

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import { ChatMessage as ChatMessageType, CaptionEntry, EditAction, IndexedVideoFrame, MarkerEntry, SilenceCandidate, SourceRangeRef, VisualSearchSession } from '@/lib/types';
import { buildTimelineSilenceCandidates, formatTime, formatTimePrecise, getSourceSegmentsForTimelineRange, buildTranscriptContext, getTimelineDuration, sourceRangesForAction, sourceRangeToTimelineRanges, sourceTimeToTimelineOccurrences, subtractSourceRanges } from '@/lib/timelineUtils';
import { extractVideoFrames } from '@/lib/ffmpegClient';
import { applyActionToSnapshot, expandActionForReview, EditSnapshot } from '@/lib/editActionUtils';
import { buildOverlappingRanges, dedupeCaptionEntries, transcribeSourceRanges } from '@/lib/transcriptionUtils';
import { buildClipSchedule } from '@/lib/playbackEngine';
import { resolveMainTrackSources } from '@/lib/sourceMedia';
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';
import AutocutMark from '@/components/branding/AutocutMark';
import HoverPillIconButton from '@/components/ui/HoverPillIconButton';

const FRAME_DESCRIPTION_BATCH_SIZE = 20;
const MAX_PARALLEL_FRAME_DESCRIPTION_REQUESTS = 6;
const OVERVIEW_FRAME_EXTRACTION_CONCURRENCY = 6;
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
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse<ChatResponse>(res);
    if (!res.ok) {
      throw new Error(data?.error ?? `Chat request failed (${res.status}).`);
    }
    return data ?? {};
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

function buildFallbackFrameDescriptions(frameCount: number): FrameDescriptionResponse {
  return {
    descriptions: Array.from({ length: frameCount }, (_, index) => ({
      index,
      description: 'Visual summary unavailable.',
    })),
  };
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
  return Math.max(12, Math.min(90, duration * 0.16));
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
  const rawCaptions = state.rawTranscriptCaptions;
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
  onBatchComplete: (result: { start: number; data: FrameDescriptionResponse }) => void,
): Promise<void> {
  if (batches.length === 0) return;

  let nextBatchIndex = 0;
  const workerCount = Math.min(MAX_PARALLEL_FRAME_DESCRIPTION_REQUESTS, batches.length);

  const runWorker = async () => {
    while (nextBatchIndex < batches.length) {
      const batchIndex = nextBatchIndex;
      nextBatchIndex += 1;
      const batch = batches[batchIndex];
      let data: FrameDescriptionResponse;
      try {
        data = await requestFrameDescriptions(batch.batchFrames);
      } catch (error) {
        console.warn('Failed to describe a frame batch; using fallback summaries.', error);
        data = buildFallbackFrameDescriptions(batch.batchFrames.length);
      }
      onBatchComplete({ start: batch.start, data });
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

function buildFrameContextPayload(frames: IndexedVideoFrame[], clips: ReturnType<typeof useEditorStore.getState>['clips']): IndexedVideoFrame[] {
  return frames.map((frame) => {
    if (frame.kind === 'dense') {
      return {
        ...frame,
        projectedTimelineTime: frame.timelineTime,
        visibleOnTimeline: true,
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
    case 'transcribe_request':
      return 'I need a transcript for that section before I can finish the edit.';
    case 'delete_range':
    case 'delete_ranges':
      return 'I found the section to remove.';
    default:
      return 'I checked that section, but I need a clearer target before making an edit.';
  }
}

function getReviewMessage(message: string, action?: EditAction | null): string {
  if (action?.type === 'delete_ranges' && action.ranges) {
    const count = action.ranges.length;
    return `Prepared ${count} cut ${count === 1 ? 'range' : 'ranges'} for review.`;
  }
  if (action?.type === 'delete_range') {
    return 'Prepared 1 cut range for review.';
  }
  return message.trim() || getAssistantFallbackMessage(action);
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

function buildReviewSelectionPreview(
  baseSnapshot: EditSnapshot,
  reviewSteps: EditAction[],
  selectedSteps: boolean[],
): {
  snapshot: EditSnapshot;
  sourceRanges: SourceRangeRef[];
  resolvedActions: EditAction[];
} {
  let draft = baseSnapshot;
  let committedSourceRanges: SourceRangeRef[] = [];
  const resolvedActions: EditAction[] = [];

  reviewSteps.forEach((step, index) => {
    if (!selectedSteps[index]) return;
    const resolvedStep = resolveReviewStep(baseSnapshot, draft, step, committedSourceRanges);
    if (!resolvedStep) return;
    draft = applyActionToSnapshot(draft, resolvedStep.action);
    committedSourceRanges = [...committedSourceRanges, ...resolvedStep.sourceRanges];
    resolvedActions.push(resolvedStep.action);
  });

  return {
    snapshot: draft,
    sourceRanges: committedSourceRanges,
    resolvedActions,
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
  const mediaLibrary = useEditorStore(s => s.mediaLibrary);
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
  const [selectedReviewSteps, setSelectedReviewSteps] = useState<boolean[]>([]);
  const [transcriptionDone, setTranscriptionDone] = useState(false);

  const setBackgroundTranscript = useEditorStore(s => s.setBackgroundTranscript);
  const setTranscriptProgress = useEditorStore(s => s.setTranscriptProgress);
  const existingRawTranscriptCaptions = useEditorStore(s => s.rawTranscriptCaptions);
  const addMessage = useEditorStore(s => s.addMessage);

  const action = msg.action;
  const hasAction = action && action.type !== 'none';
  const reviewSteps = useMemo(() => (action ? expandActionForReview(action) : []), [action]);
  const reviewSelection = useMemo(() => (
    reviewBaseSnapshot && action
      ? buildReviewSelectionPreview(reviewBaseSnapshot, reviewSteps, selectedReviewSteps)
      : null
  ), [action, reviewBaseSnapshot, reviewSteps, selectedReviewSteps]);
  const reviewItems = useMemo(() => (
    reviewSteps.map((step, index) => ({
      id: `${msg.id}-review-step-${index}`,
      index,
      selected: selectedReviewSteps[index] ?? false,
      meta: getActionMeta(step),
    }))
  ), [msg.id, reviewSteps, selectedReviewSteps]);
  const anotherReviewActive = previewOwnerId !== null && previewOwnerId !== msg.id;
  const actionPreviouslyApplied = useMemo(() => (
    !!action && appliedActions.some(record => actionsMatch(record.action, action))
  ), [action, appliedActions]);
  const actionResolved = msg.actionStatus === 'completed'
    || msg.actionStatus === 'rejected'
    || msg.autoApplied
    || actionPreviouslyApplied;
  const displayAction = useMemo(() => {
    if (!action) return null;
    if (!reviewSelection || reviewSelection.resolvedActions.length === 0) return action;
    return combineResolvedReviewActions(action, reviewSelection.resolvedActions) ?? action;
  }, [action, reviewSelection]);
  const meta = displayAction ? getActionMeta(displayAction) : null;
  const selectedReviewCount = reviewItems.filter((item) => item.selected).length;
  const resolvedReviewCount = reviewSelection?.resolvedActions.length ?? 0;
  const multipleReviewOptions = reviewItems.length > 1;
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

  useEffect(() => {
    if (
      !action
      || action.type === 'none'
      || action.type === 'transcribe_request'
      || action.type === 'update_ai_settings'
      || actionResolved
    ) {
      setReviewBaseSnapshot(null);
      setSelectedReviewSteps([]);
      return;
    }
    if (anotherReviewActive) return;
    setReviewBaseSnapshot((current) => {
      if (current) return current;
      const state = useEditorStore.getState();
      return {
        clips: state.clips,
        captions: state.captions,
        transitions: state.transitions,
        markers: state.markers,
        textOverlays: state.textOverlays,
      };
    });
    setSelectedReviewSteps((current) => (
      current.length === reviewSteps.length && current.some(Boolean)
        ? current
        : reviewSteps.map(() => true)
    ));
  }, [action, actionResolved, anotherReviewActive, reviewSteps]);

  useEffect(() => {
    if (!action || !reviewBaseSnapshot || actionResolved || anotherReviewActive) return;
    if (!reviewSelection || reviewSelection.resolvedActions.length === 0) {
      clearPreviewSnapshot(msg.id);
      return;
    }
    setPreviewSnapshot(msg.id, reviewSelection.snapshot);
    const reviewSeekTime = getReviewSeekTime(reviewBaseSnapshot, reviewSelection.resolvedActions[0]);
    if (reviewSeekTime !== null) requestSeek(reviewSeekTime);
  }, [
    action,
    actionResolved,
    anotherReviewActive,
    clearPreviewSnapshot,
    msg.id,
    requestSeek,
    reviewBaseSnapshot,
    reviewSelection,
    setPreviewSnapshot,
  ]);

  const handleToggleReviewStep = useCallback((index: number) => {
    setSelectedReviewSteps((current) => current.map((selected, stepIndex) => (
      stepIndex === index ? !selected : selected
    )));
  }, []);

  const handleApplyReviewedChanges = useCallback(() => {
    if (!action || !reviewSelection || reviewSelection.resolvedActions.length === 0) return;
    const committedAction = combineResolvedReviewActions(action, reviewSelection.resolvedActions);
    if (!committedAction) return;
    clearPreviewSnapshot(msg.id);
    commitPreviewSnapshot(reviewSelection.snapshot);
    recordAppliedAction(committedAction, committedAction.message, { sourceRanges: reviewSelection.sourceRanges });
    updateMessage(msg.id, {
      actionStatus: 'completed',
      actionResult: reviewItems.length > 1
        ? `Applied ${reviewSelection.resolvedActions.length} of ${reviewItems.length} changes.`
        : 'Applied edit.',
    });
    setReviewBaseSnapshot(null);
    setSelectedReviewSteps([]);
  }, [action, clearPreviewSnapshot, commitPreviewSnapshot, msg.id, recordAppliedAction, reviewItems.length, reviewSelection, updateMessage]);

  const handleRejectReview = useCallback(() => {
    clearPreviewSnapshot(msg.id);
    updateMessage(msg.id, {
      actionStatus: 'rejected',
      actionResult: 'No changes applied.',
    });
    setReviewBaseSnapshot(null);
    setSelectedReviewSteps([]);
  }, [clearPreviewSnapshot, msg.id, updateMessage]);

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
      const availableSources = resolveMainTrackSources({
        clips,
        mediaLibrary,
        videoData,
        videoFile,
        videoUrl,
        videoDuration: state.videoDuration,
      });
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
        const sourceEntry = availableSources.find((entry) => entry.sourceId === sourceId);
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

      const mergedCaptions = dedupeCaptionEntries([...(existingRawTranscriptCaptions ?? []), ...rawCaptions]);
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
  }, [action, addMessage, clips, existingRawTranscriptCaptions, mediaLibrary, msg.id, onTranscriptReady, setBackgroundTranscript, setTranscriptProgress, updateMessage, videoData, videoFile, videoUrl]);

  const handleApplySettings = useCallback(() => {
    if (!action || action.type !== 'update_ai_settings') return;
    applyStoredAction(action);
    recordAppliedAction(action, action.message);
    updateMessage(msg.id, { actionStatus: 'completed', actionResult: 'AI settings updated.' });
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
          <ActionDetails action={displayAction!} />

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
          ) : (
            <div style={{ padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              {multipleReviewOptions && action?.type !== 'transcribe_request' && action?.type !== 'update_ai_settings' && (
                <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '0 0 8px', fontFamily: 'var(--font-serif)' }}>
                  {selectedReviewCount > 0
                    ? `Previewing ${selectedReviewCount} selected change${selectedReviewCount === 1 ? '' : 's'}.`
                    : `Select which of the ${reviewItems.length} proposed changes you want to apply.`}
                </p>
              )}
              {anotherReviewActive && action?.type !== 'transcribe_request' && action?.type !== 'update_ai_settings' && (
                <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '0 0 8px', fontFamily: 'var(--font-serif)' }}>
                  Finish the active review before opening another one.
                </p>
              )}
              {multipleReviewOptions && action?.type !== 'transcribe_request' && action?.type !== 'update_ai_settings' && (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  marginBottom: 10,
                  maxHeight: 156,
                  overflowY: 'auto',
                  paddingRight: 2,
                }}>
                  {reviewItems.map((item) => {
                    return (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => handleToggleReviewStep(item.index)}
                        disabled={anotherReviewActive}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '7px 8px',
                          borderRadius: 6,
                          border: '1px solid rgba(255,255,255,0.06)',
                          background: item.selected ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                          cursor: anotherReviewActive ? 'default' : 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span style={{
                          width: 16,
                          height: 16,
                          marginTop: 1,
                          borderRadius: 4,
                          border: `1px solid ${item.selected ? 'var(--accent)' : 'rgba(255,255,255,0.16)'}`,
                          background: item.selected ? 'var(--accent)' : 'rgba(255,255,255,0.02)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          {item.selected && (
                            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M2.5 6.3 4.8 8.6 9.5 3.7" />
                            </svg>
                          )}
                        </span>
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontSize: 11, color: 'var(--fg-primary)', fontFamily: 'var(--font-serif)' }}>
                            {item.meta.label}
                          </span>
                          {item.meta.summary && (
                            <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-serif)' }}>
                              {item.meta.summary}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
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
              ) : (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={handleApplyReviewedChanges}
                    disabled={anotherReviewActive || selectedReviewCount === 0 || resolvedReviewCount === 0}
                    style={{
                      flex: 1,
                      padding: '5px 0',
                      fontSize: 12,
                      fontWeight: 500,
                      background: anotherReviewActive || selectedReviewCount === 0 || resolvedReviewCount === 0 ? 'rgba(255,255,255,0.06)' : 'var(--accent)',
                      border: 'none',
                      color: anotherReviewActive || selectedReviewCount === 0 || resolvedReviewCount === 0 ? 'var(--fg-muted)' : '#000',
                      borderRadius: 4,
                      cursor: anotherReviewActive || selectedReviewCount === 0 || resolvedReviewCount === 0 ? 'default' : 'pointer',
                      fontFamily: 'var(--font-serif)',
                    }}
                  >
                    {multipleReviewOptions ? 'Apply selected' : 'Apply'}
                  </button>
                  <button
                    onClick={handleRejectReview}
                    disabled={anotherReviewActive}
                    style={{
                      flex: 1,
                      padding: '5px 0',
                      fontSize: 12,
                      fontWeight: 500,
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: 'var(--fg-secondary)',
                      borderRadius: 4,
                      cursor: anotherReviewActive ? 'default' : 'pointer',
                      fontFamily: 'var(--font-serif)',
                    }}
                  >
                    Reject
                  </button>
                </div>
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
}: {
  title: string;
  progress: IndexingProgress | null;
  detail?: string | null;
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
      {detail && (
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.38)', fontFamily: 'var(--font-serif)', lineHeight: 1.5 }}>
          {detail}
        </span>
      )}
    </div>
  );
}

// ─── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({
  isIndexing,
  indexingReason,
  indexingProgress,
  statusNotice,
}: {
  isIndexing: boolean;
  indexingReason: string | null;
  indexingProgress: IndexingProgress | null;
  statusNotice?: string | null;
}) {
  const indexingDetail = indexingReason?.includes('take a while')
    ? null
    : 'Deep indexing can take a while on longer videos.';
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
      {statusNotice && (
        <div style={{
          width: '100%',
          maxWidth: 290,
          marginTop: isIndexing ? 0 : 10,
          padding: '12px 14px',
          borderRadius: 14,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--fg-secondary)', fontFamily: 'var(--font-serif)' }}>
            {statusNotice}
          </p>
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
  const frameDescriptionPromiseRef = useRef<Promise<IndexedVideoFrame[]> | null>(null);
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
  const videoUrl = useEditorStore(s => s.videoUrl);
  const videoData = useEditorStore(s => s.videoData);
  const videoFile = useEditorStore(s => s.videoFile);
  const transcriptStatus = useEditorStore(s => s.transcriptStatus);
  const transcriptProgress = useEditorStore(s => s.transcriptProgress);
  const videoFrames = useEditorStore(s => s.videoFrames);
  const videoFramesFresh = useEditorStore(s => s.videoFramesFresh);
  const setVideoFrames = useEditorStore(s => s.setVideoFrames);
  const currentProjectId = useEditorStore(s => s.currentProjectId);
  const setVisualSearchSession = useEditorStore(s => s.setVisualSearchSession);
  const addMarker = useEditorStore(s => s.addMarker);
  const applyStoredAction = useEditorStore(s => s.applyAction);
  const recordAppliedAction = useEditorStore(s => s.recordAppliedAction);
  const requestSeek = useEditorStore(s => s.requestSeek);
  const previewOwnerId = useEditorStore(s => s.previewOwnerId);
  const reviewLocked = previewOwnerId !== null;
  const mainTimelineDuration = useMemo(() => getTimelineDuration(clips), [clips]);

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

  // Extract frames on first load, and re-extract in background when stale after edits
  useEffect(() => {
    if ((!videoFile && !videoUrl && !videoData) || videoDuration <= 0) return;
    if (videoFrames === null || !videoFramesFresh) {
      void (async () => {
        try {
          const frames = await ensureFramesExtracted(!videoFramesFresh);
          await ensureFrameDescriptions(frames, !videoFramesFresh);
        } catch {
          // Keep the editor usable even if background indexing fails.
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoData, videoDuration, videoFile, videoFramesFresh, videoUrl]);

  const ensureFramesExtracted = useCallback(async (force = false): Promise<IndexedVideoFrame[]> => {
    if (videoFrames !== null && !force) return videoFrames;
    const source = videoData ?? videoFile ?? videoUrl;
    if (!source || videoDuration <= 0) return videoFrames ?? [];
    try {
      const currentDuration = useEditorStore.getState().videoDuration;
      const { overviewIntervalSeconds, maxOverviewFrames } = useEditorStore.getState().aiSettings.frameInspection;
      const preferredInterval = Math.max(0.1, overviewIntervalSeconds);
      const frameTarget = getOverviewFrameTarget(currentDuration, preferredInterval, maxOverviewFrames);
      const interval = currentDuration <= preferredInterval * maxOverviewFrames
        ? preferredInterval
        : currentDuration / maxOverviewFrames;
      const sampleEnd = Math.max(currentDuration - 0.05, 0);
      const sourceTimestamps: number[] = [];
      for (let t = 0; t < sampleEnd; t += interval) sourceTimestamps.push(t);
      if (sourceTimestamps.length === 0 || sourceTimestamps[sourceTimestamps.length - 1] < sampleEnd) {
        sourceTimestamps.push(sampleEnd);
      }
      const extractionStartedAt = performance.now();
      const extractionFallbackPerFrame = estimateFrameExtractionSeconds(sourceTimestamps.length) / Math.max(sourceTimestamps.length, 1);
      let lastProgressPaintAt = 0;
      setFrameIndexingProgress({
        stage: 'extracting_frames',
        completed: 0,
        total: Math.max(sourceTimestamps.length, 1),
        label: `Sampling ${frameTarget} frame${frameTarget === 1 ? '' : 's'}`,
        etaSeconds: estimateFrameExtractionSeconds(sourceTimestamps.length),
      });
      const images = await extractVideoFrames(source, sourceTimestamps, {
        concurrency: OVERVIEW_FRAME_EXTRACTION_CONCURRENCY,
        onProgress: ({ completed, total }) => {
          const now = performance.now();
          if (completed < total && now - lastProgressPaintAt < 120) return;
          lastProgressPaintAt = now;
          setFrameIndexingProgress({
            stage: 'extracting_frames',
            completed,
            total: Math.max(total, 1),
            label: `Sampling frames ${completed}/${total}`,
            etaSeconds: estimateRemainingSecondsFromObservedRate(
              extractionStartedAt,
              completed,
              total,
              extractionFallbackPerFrame,
            ),
          });
        },
      });
      const frames = images.map((image, index) => ({
        image,
        timelineTime: sourceTimestamps[index],
        sourceTime: sourceTimestamps[index],
        sourceId: MAIN_SOURCE_ID,
        kind: 'overview' as const,
      }));
      setVideoFrames(frames);
      setFrameIndexingProgress({
        stage: 'extracting_frames',
        completed: frames.length,
        total: Math.max(frames.length, 1),
        label: `Sampled ${frames.length} frame${frames.length === 1 ? '' : 's'}`,
        etaSeconds: 0,
      });
      return frames;
    } catch {
      setFrameIndexingProgress(null);
      return videoFrames ?? [];
    }
  }, [videoData, videoDuration, videoFile, videoFrames, videoUrl, setVideoFrames]);

  const ensureFrameDescriptions = useCallback(async (
    frames: IndexedVideoFrame[],
    force = false,
  ): Promise<IndexedVideoFrame[]> => {
    const overviewFrames = frames.filter((frame) => frame.kind === 'overview');
    if (overviewFrames.length === 0) return frames;
    if (!force && overviewFrames.every((frame) => frame.description && frame.description.trim().length > 0)) {
      return frames;
    }
    if (frameDescriptionPromiseRef.current && !force) {
      return frameDescriptionPromiseRef.current;
    }

    const promise = (async () => {
      let nextFrames = [...frames];
      const totalOverviewFrames = nextFrames.filter((frame) => frame.kind === 'overview').length;
      const initialCompleted = nextFrames.filter((frame) => (
        frame.kind === 'overview' && !!frame.description && frame.description.trim().length > 0
      )).length;
      const descriptionStartedAt = performance.now();
      const descriptionFallbackPerFrame = estimateFrameDescriptionSeconds(totalOverviewFrames) / Math.max(totalOverviewFrames, 1);
      setFrameIndexingProgress({
        stage: 'describing_frames',
        completed: initialCompleted,
        total: Math.max(totalOverviewFrames, 1),
        label: `Analyzing visuals ${initialCompleted}/${totalOverviewFrames}`,
        etaSeconds: estimateFrameDescriptionSeconds(Math.max(totalOverviewFrames - initialCompleted, 0)),
      });
      const batches: FrameDescriptionBatch[] = [];
      for (let start = 0; start < nextFrames.length; start += FRAME_DESCRIPTION_BATCH_SIZE) {
        const batch = nextFrames.slice(start, start + FRAME_DESCRIPTION_BATCH_SIZE);
        const shouldDescribeBatch = force || batch.some((frame) => (
          frame.kind === 'overview' && (!frame.description || frame.description.trim().length === 0)
        ));
        if (!shouldDescribeBatch) continue;

        const batchFrames = batch
          .filter((frame): frame is IndexedVideoFrame & { image: string } => (
            frame.kind === 'overview' && typeof frame.image === 'string' && frame.image.length > 0
          ))
          .map((frame) => ({
            image: frame.image,
            timelineTime: frame.timelineTime,
            sourceTime: frame.sourceTime,
          }));
        if (batchFrames.length === 0) continue;
        batches.push({ start, batchFrames });
      }

      await runFrameDescriptionBatches(batches, (result) => {
        nextFrames = mergeFrameDescriptions(nextFrames, result.start, result.data.descriptions ?? []);
        setVideoFrames(nextFrames);
        const completed = nextFrames.filter((frame) => (
          frame.kind === 'overview' && !!frame.description && frame.description.trim().length > 0
        )).length;
        const remaining = Math.max(totalOverviewFrames - completed, 0);
        setFrameIndexingProgress({
          stage: 'describing_frames',
          completed,
          total: Math.max(totalOverviewFrames, 1),
          label: `Analyzing visuals ${completed}/${totalOverviewFrames}`,
          etaSeconds: remaining > 0
            ? estimateRemainingSecondsFromObservedRate(
              descriptionStartedAt,
              completed,
              totalOverviewFrames,
              descriptionFallbackPerFrame,
            )
            : 0,
        });
      });
      return nextFrames;
    })();

    frameDescriptionPromiseRef.current = promise;
    try {
      return await promise;
    } catch {
      setFrameIndexingProgress(null);
      return frames;
    } finally {
      if (frameDescriptionPromiseRef.current === promise) {
        frameDescriptionPromiseRef.current = null;
      }
    }
  }, [setVideoFrames]);

  const frameDescriptionsReady = useMemo(() => {
    if (videoFrames === null) return false;
    return videoFrames
      .filter((frame) => frame.kind === 'overview')
      .every((frame) => !!frame.description && frame.description.trim().length > 0);
  }, [videoFrames]);

  const buildCurrentTranscript = useCallback(() => {
    const freshState = useEditorStore.getState();
    const rawCaptions = freshState.rawTranscriptCaptions;
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
    if (!preferSourceVisualRetrieval) {
      currentFrames = await ensureFrameDescriptions(currentFrames);
    }
    let producedVisibleResponse = false;

    for (let round = 0; round < 2; round++) {
      if (stopRequestedRef.current) break;
      const freshState = useEditorStore.getState();
      const currentClips = freshState.clips;
      const currentTranscript = buildCurrentTranscript();
      const silenceCandidates = buildSilenceCandidatePayload();
      const source = freshState.videoData ?? freshState.videoFile ?? freshState.videoUrl;

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
      const assistantMessage = getReviewMessage(message, action);

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
        const sourceTimestamps = timelineTimestamps.map(t => timelineToSourceTime(currentClips, t));
        if (!source) throw new Error('No video source available for frame extraction');
        const images = await extractVideoFrames(source, sourceTimestamps);
        currentFrames = images.map((image, index) => ({
          image,
          timelineTime: timelineTimestamps[index],
          sourceTime: sourceTimestamps[index],
          sourceId: MAIN_SOURCE_ID,
          kind: 'dense' as const,
          rangeStart: req.startTime,
          rangeEnd: req.endTime,
        }));
        setLoadingStatus('');
        history.push({ role: 'assistant', content: assistantMessage });
        history.push({ role: 'user', content: `[${count} dense frames extracted from ${formatTime(req.startTime)} to ${formatTime(req.endTime)}. Now answer with these frames.]` });
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
  }, [addMarker, addMessage, applyStoredAction, buildCurrentTranscript, ensureFrameDescriptions, ensureFramesExtracted, recordAppliedAction, requestSeek, selectedClipContext, selectedMarkerContext, setVisualSearchSession, taggedMarkers]);

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
  const framesReady = videoFrames !== null && frameDescriptionsReady;
  const transcriptFailed = transcriptStatus === 'error';
  const agentContextReady = framesReady && (transcriptStatus === 'done' || transcriptFailed);
  const isReindexingFrames = videoFrames !== null && !videoFramesFresh;
  const estimatedTranscriptEta = estimateTranscriptSeconds(mainTimelineDuration || videoDuration);
  const estimatedTranscriptRemainingEta = transcriptProgress && transcriptProgress.total > 0
    ? estimatedTranscriptEta * Math.max(0, transcriptProgress.total - transcriptProgress.completed) / transcriptProgress.total
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
    ? (transcriptStatus === 'loading' && videoFrames === null)
      ? 'Transcribing audio and sampling frames…'
      : transcriptStatus === 'loading'
        ? 'Transcribing audio…'
        : videoFrames === null
          ? 'Sampling video frames…'
          : !frameDescriptionsReady
            ? 'Analyzing sampled frames…'
          : null
    : null;
  const transcriptUnavailableNotice = hasVideoSource && framesReady && transcriptFailed
    ? 'Audio transcription did not finish, but the assistant is ready to work from the video and visual analysis.'
    : null;
  const pendingVisualQuery = looksLikeVisualSearchQuery(input.trim()) && !!currentProjectId;
  const canSendDespiteIndexing = pendingVisualQuery;
  const isAnalyzingSampledFrames = hasVideoSource
    && (transcriptStatus === 'done' || transcriptFailed)
    && videoFrames !== null
    && !frameDescriptionsReady;
  const mediaPreparationBlockingSend = hasVideoSource
    && !agentContextReady
    && !canSendDespiteIndexing
    && !isAnalyzingSampledFrames;
  const composerInputDisabled = isChatLoading || reviewLocked;
  const composerMuted = composerInputDisabled || mediaPreparationBlockingSend;
  const canSubmitMessage = input.trim().length > 0 && !composerInputDisabled && !mediaPreparationBlockingSend;

  const resizeComposer = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
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
          <AutocutMark size={18} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-primary)', fontFamily: 'var(--font-serif)' }}>
              Cut Assistant
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
                          {active ? 'Live' : 'Coming soon'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <HoverPillIconButton
              label="Clear chat"
              onClick={handleClearChat}
              disabled={isChatLoading || reviewLocked || messages.length === 0}
              buttonStyle={{
                width: 28,
                height: 28,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
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
            </HoverPillIconButton>
          </div>
        </div>

        {/* Non-blocking re-index badge */}
        {isReindexingFrames && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '3px 8px',
            background: 'rgba(232,255,0,0.06)',
            border: '1px solid rgba(232,255,0,0.15)',
            borderRadius: 4,
          }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" stroke="rgba(232,255,0,0.2)" strokeWidth="2.5"/>
              <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
            <span style={{ fontSize: 10, color: 'var(--accent)', fontFamily: 'var(--font-serif)', opacity: 0.7 }}>
              Updating frames…
            </span>
          </div>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 12px' }}>
        {messages.length === 0 ? (
          <EmptyState
            isIndexing={hasVideoSource && !agentContextReady}
            indexingReason={agentNotReadyReason}
            indexingProgress={indexingProgress}
            statusNotice={transcriptUnavailableNotice}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {messages.map(msg => msg.role === 'user'
              ? <UserMessage key={msg.id} msg={msg} />
              : <AssistantMessage key={msg.id} msg={msg} onTranscriptReady={handleTranscriptReady} />
            )}
            {transcriptUnavailableNotice && (
              <ProgressStatusCard
                title="Transcript unavailable"
                progress={null}
                detail={transcriptUnavailableNotice}
              />
            )}
            {!isChatLoading && hasVideoSource && !agentContextReady && !canSendDespiteIndexing && (
              <ProgressStatusCard
                title={getIndexingStageTitle(indexingProgress, agentNotReadyReason)}
                progress={indexingProgress}
                detail="Deep indexing can take a while on longer videos."
              />
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
              maxHeight: 140,
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
