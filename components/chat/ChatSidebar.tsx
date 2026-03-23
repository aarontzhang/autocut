'use client';

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useEditorStore } from '@/lib/useEditorStore';
import {
  AnalysisProgress,
  AppliedActionRecord,
  ChatMessage as ChatMessageType,
  CaptionEntry,
  EditAction,
  IndexedVideoFrame,
  MarkerEntry,
  SilenceCandidate,
  SourceIndexAnalysisStateMap,
  SourceIndexTaskState,
  SourceIndexedFrame,
  VisualSearchSession,
} from '@/lib/types';
import { buildTimelineSilenceCandidates, formatTime, formatTimePrecise, getSourceSegmentsForTimelineRange, buildTranscriptContext, getTimelineDuration, sourceRangesForAction, sourceTimeToTimelineOccurrences } from '@/lib/timelineUtils';
import { extractVideoFrames } from '@/lib/ffmpegClient';
import {
  buildReviewGroupWithUpdatedItems,
  buildReviewPreviewSnapshot,
  collapseReviewItemsToAction,
  createReviewGroup,
  EditSnapshot,
} from '@/lib/editActionUtils';
import { buildOverlappingRanges, dedupeCaptionEntries, transcribeSourceRanges } from '@/lib/transcriptionUtils';
import { buildClipSchedule, timelineTimeToSource } from '@/lib/playbackEngine';
import { buildCoarseRepresentativeWindows, buildDenseTimelineTimestamps, buildRepresentativeCandidateTimes, getAdaptiveCoarseFrameBudget } from '@/lib/indexer/representativeFrames';
import { resolveProjectSources } from '@/lib/sourceMedia';
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';
import { getInitialIndexingReady } from '@/lib/sourceIndexGate';
import {
  actionsMatch,
  buildRequestChainContinuationMessage,
  RequestChainContinuationPayload,
  RequestChainTranscriptAvailability,
  serializeActionForComparison,
} from '@/lib/requestChain';
import AutocutMark from '@/components/branding/AutocutMark';

const FRAME_DESCRIPTION_BATCH_SIZE = 8;
const MAX_PARALLEL_FRAME_DESCRIPTION_REQUESTS = 3;
const OVERVIEW_FRAME_EXTRACTION_CONCURRENCY = 2;
const FRAME_DESCRIPTION_REQUEST_TIMEOUT_MS = 60000;
const MAX_FRAME_DESCRIPTION_REQUEST_RETRIES = 2;
const FRAME_DESCRIPTION_RETRY_BASE_DELAY_MS = 1500;
const REVIEW_PREROLL_SECONDS = 2.5;
const DEFAULT_DENSE_MAX_SPACING_SECONDS = 1;

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
  requestChainId?: string;
  action?: EditAction | null;
  actionType?: EditAction['type'];
  actionMessage?: string;
  actionStatus?: ChatMessageType['actionStatus'];
  actionResult?: string;
  autoApplied?: boolean;
};

type LiveMessageActionState = {
  actionMessage?: string;
  actionStatus?: ChatMessageType['actionStatus'];
  actionResult?: string;
  autoApplied?: boolean;
  isApplied: boolean;
  wasUndone: boolean;
};

type IndexingProgress = AnalysisProgress;

type ProgressCardTone = 'active' | 'completed';

type AnalysisStatusCard = {
  key: string;
  title: string;
  progress: IndexingProgress | null;
  detail?: string | null;
  secondaryLabel?: string | null;
  tone?: ProgressCardTone;
};

const CHAT_REQUEST_TIMEOUT_MS = 45000;
const MAX_CHAT_REQUEST_RETRIES = 2;
const CHAT_RETRY_BASE_DELAY_MS = 1500;
const MARKER_TAG_PATTERN = /(?:@|marker\s+|bookmark\s+)(\d+)/gi;
const MAX_CHAT_OVERVIEW_FRAMES = 96;

type RequestChainState = {
  requestChainId: string;
  originalRequest: string;
  remainingObjective: string | null;
  completedActions: EditAction[];
  duplicateActionBlacklist: EditAction['type'][];
  transcript: RequestChainTranscriptAvailability;
  duplicateRerunCount: number;
};

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

function formatTranscriptFailureNotice(error: string | null): string {
  const normalized = error?.trim();
  if (!normalized) {
    return 'Audio transcription did not finish, but the assistant is ready to work from the video and visual analysis.';
  }
  if (normalized.includes('OPENAI_API_KEY')) {
    return 'Audio transcription is not configured on this deployment. Missing OPENAI_API_KEY. The assistant is ready to work from the video and visual analysis.';
  }
  if (normalized === 'Unauthorized') {
    return 'Audio transcription was rejected because the current session was not authorized. The assistant is ready to work from the video and visual analysis.';
  }
  return `${normalized} The assistant is ready to work from the video and visual analysis.`;
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatCountdownLabel(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')} left`;
}

function evenlySampleFrameIndices(count: number, targetCount: number): number[] {
  if (count <= 0 || targetCount <= 0) return [];
  if (count <= targetCount) return Array.from({ length: count }, (_, index) => index);

  const selected: number[] = [];
  for (let index = 0; index < targetCount; index += 1) {
    const sampleIndex = Math.min(count - 1, Math.round(index * (count - 1) / Math.max(targetCount - 1, 1)));
    if (selected[selected.length - 1] !== sampleIndex) {
      selected.push(sampleIndex);
    }
  }
  return selected;
}

function selectEvenlySampledFrames(frames: IndexedVideoFrame[], targetCount: number): IndexedVideoFrame[] {
  return evenlySampleFrameIndices(frames.length, targetCount)
    .map((index) => frames[index] ?? null)
    .filter((frame): frame is IndexedVideoFrame => !!frame);
}

type FrameCoverageSummary = {
  totalOverviewFrames: number;
  coveredSourceCount: number;
  averageGapSeconds: number | null;
};

function summarizeFrameCoverage(frames: IndexedVideoFrame[]): FrameCoverageSummary {
  const overviewFrames = frames
    .filter((frame) => frame.kind === 'overview')
    .sort((a, b) => a.timelineTime - b.timelineTime);
  const coveredSourceCount = new Set(
    overviewFrames
      .map((frame) => normalizeKnownSourceId(frame.sourceId))
      .filter((sourceId) => sourceId.length > 0),
  ).size;
  if (overviewFrames.length < 2) {
    return {
      totalOverviewFrames: overviewFrames.length,
      coveredSourceCount,
      averageGapSeconds: null,
    };
  }

  const totalGap = overviewFrames.reduce((sum, frame, index) => {
    if (index === 0) return sum;
    return sum + Math.max(0, frame.timelineTime - overviewFrames[index - 1].timelineTime);
  }, 0);

  return {
    totalOverviewFrames: overviewFrames.length,
    coveredSourceCount,
    averageGapSeconds: totalGap / Math.max(overviewFrames.length - 1, 1),
  };
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
    case 'queued':
      return 'Queued…';
    case 'preparing_media':
      return 'Preparing media…';
    case 'transcribing_audio':
      return 'Transcribing audio…';
    case 'detecting_scenes':
      return 'Detecting scenes…';
    case 'choosing_representative_frames':
      return 'Analyzing sampled frames…';
    case 'describing_representative_frames':
      return 'Analyzing sampled frames…';
    case 'dense_refinement':
      return 'Dense local refinement…';
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

function buildCompletedProgress(stage: IndexingProgress['stage']): IndexingProgress {
  return {
    stage,
    completed: 1,
    total: 1,
    label: 'Completed',
    etaSeconds: 0,
  };
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

function normalizeKnownSourceId(sourceId?: string | null): string {
  return sourceId && sourceId.trim().length > 0 ? sourceId : MAIN_SOURCE_ID;
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

async function measureFrameHeuristics(imageBase64: string): Promise<{
  brightness: number;
  contrast: number;
  edgeDensity: number;
  sharpness: number;
  darknessScore: number;
  textUiScore: number;
}> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const nextImage = new Image();
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = () => reject(new Error('Failed to load extracted frame.'));
    nextImage.src = `data:image/jpeg;base64,${imageBase64}`;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, image.naturalWidth || image.width || 320);
  canvas.height = Math.max(1, image.naturalHeight || image.height || 180);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Canvas context unavailable for frame scoring.');
  }
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixelCount = Math.max(1, width * height);
  const gray = new Float32Array(pixelCount);
  let brightnessSum = 0;
  let brightnessSqSum = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const luma = (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255;
    gray[index] = luma;
    brightnessSum += luma;
    brightnessSqSum += luma * luma;
  }

  const brightness = brightnessSum / pixelCount;
  const variance = Math.max(0, brightnessSqSum / pixelCount - brightness * brightness);
  const contrast = Math.min(1, Math.sqrt(variance) / 0.5);

  let edgeSum = 0;
  let strongEdges = 0;
  let horizontalLineEvidence = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const gx = Math.abs(gray[index + 1] - gray[index - 1]);
      const gy = Math.abs(gray[index + width] - gray[index - width]);
      const laplacian = Math.abs((4 * gray[index]) - gray[index - 1] - gray[index + 1] - gray[index - width] - gray[index + width]);
      edgeSum += laplacian;
      if (gx + gy > 0.18) strongEdges += 1;
      if (gx > 0.12 && gy < 0.08) horizontalLineEvidence += 1;
    }
  }

  const edgeDensity = Math.min(1, strongEdges / pixelCount * 8);
  const sharpness = Math.min(1, edgeSum / pixelCount * 3.5);
  const darknessScore = brightness < 0.16 ? (0.16 - brightness) / 0.16 : 0;
  const textUiScore = Math.min(1, horizontalLineEvidence / pixelCount * 18 + edgeDensity * 0.35);

  return {
    brightness,
    contrast,
    edgeDensity,
    sharpness,
    darknessScore,
    textUiScore,
  };
}

function scoreFrameHeuristics(
  metrics: {
    brightness: number;
    contrast: number;
    edgeDensity: number;
    sharpness: number;
    darknessScore: number;
    textUiScore: number;
  },
  sceneBoundaryDistanceSeconds: number,
): number {
  const exposureScore = 1 - Math.min(1, Math.abs(metrics.brightness - 0.52) / 0.52);
  const washedOutPenalty = metrics.contrast < 0.16 ? (0.16 - metrics.contrast) / 0.16 : 0;
  const transitionPenalty = sceneBoundaryDistanceSeconds < 0.18
    ? 1 - sceneBoundaryDistanceSeconds / 0.18
    : 0;
  return (
    metrics.sharpness * 0.36 +
    metrics.edgeDensity * 0.22 +
    metrics.textUiScore * 0.16 +
    exposureScore * 0.18 +
    metrics.contrast * 0.08 -
    metrics.darknessScore * 0.18 -
    washedOutPenalty * 0.12 -
    transitionPenalty * 0.45
  );
}

function getLiveMessageActionState(
  message: Pick<ChatMessageType, 'action' | 'actionStatus' | 'actionResult' | 'autoApplied'>,
  appliedActions: AppliedActionRecord[],
): LiveMessageActionState {
  const action = message.action;
  if (!action || action.type === 'none') {
    return {
      actionMessage: undefined,
      actionStatus: message.actionStatus,
      actionResult: message.actionResult,
      autoApplied: message.autoApplied,
      isApplied: false,
      wasUndone: false,
    };
  }

  const isApplied = appliedActions.some((record) => actionsMatch(record.action, action));
  const wasPreviouslyApplied = message.actionStatus === 'completed' || message.autoApplied === true;

  if (message.actionStatus === 'rejected') {
    return {
      actionMessage: action.message,
      actionStatus: 'rejected',
      actionResult: message.actionResult,
      autoApplied: undefined,
      isApplied: false,
      wasUndone: false,
    };
  }

  if (isApplied) {
    return {
      actionMessage: action.message,
      actionStatus: 'completed',
      actionResult: message.actionResult,
      autoApplied: message.autoApplied === true ? true : undefined,
      isApplied: true,
      wasUndone: false,
    };
  }

  if (wasPreviouslyApplied) {
    return {
      actionMessage: `Previously applied, then undone: ${action.message}`,
      actionStatus: 'pending',
      actionResult: 'Undone via undo/redo. Reapply if you still want this edit.',
      autoApplied: undefined,
      isApplied: false,
      wasUndone: true,
    };
  }

  return {
    actionMessage: action.message,
    actionStatus: message.actionStatus,
    actionResult: message.actionResult,
    autoApplied: undefined,
    isApplied: false,
    wasUndone: false,
  };
}

function buildChatRequestHistory(
  messages: ChatMessageType[],
  appliedActions: AppliedActionRecord[],
  latestUserText?: string,
  requestChainId?: string,
): ChatRequestMessage[] {
  const history: ChatRequestMessage[] = messages.map((message) => {
    const liveActionState = getLiveMessageActionState(message, appliedActions);
    return {
      role: message.role,
      content: message.content,
      requestChainId: message.requestChainId,
      action: message.action ?? null,
      actionType: message.action?.type,
      actionMessage: liveActionState.actionMessage,
      actionStatus: liveActionState.actionStatus,
      actionResult: liveActionState.actionResult,
      autoApplied: liveActionState.autoApplied,
    };
  });

  if (latestUserText) {
    history.push({ role: 'user', content: latestUserText, requestChainId });
  }

  return history;
}

function normalizeRequestObjective(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildContinuationPayload(
  chainState: RequestChainState,
  trigger: RequestChainContinuationPayload['trigger'],
  explicitInstruction?: string | null,
): string {
  return buildRequestChainContinuationMessage({
    requestChainId: chainState.requestChainId,
    originalRequest: chainState.originalRequest,
    remainingObjective: chainState.remainingObjective,
    completedActions: chainState.completedActions.map((action) => ({
      type: action.type,
      signature: serializeActionForComparison(action),
      summary: action.message,
    })),
    duplicateActionBlacklist: chainState.duplicateActionBlacklist,
    transcript: chainState.transcript,
    trigger,
    explicitInstruction: normalizeRequestObjective(explicitInstruction),
  });
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

async function describeIndexedFrames(
  frames: IndexedVideoFrame[],
  onProgress?: (progress: { completed: number; total: number }) => void,
): Promise<IndexedVideoFrame[]> {
  if (frames.length === 0) return frames;

  let nextFrames = [...frames];
  const batches: FrameDescriptionBatch[] = [];
  for (let start = 0; start < nextFrames.length; start += FRAME_DESCRIPTION_BATCH_SIZE) {
    const batchFrames = nextFrames
      .slice(start, start + FRAME_DESCRIPTION_BATCH_SIZE)
      .filter((frame): frame is IndexedVideoFrame & { image: string } => typeof frame.image === 'string' && frame.image.length > 0)
      .map((frame) => ({
        image: frame.image,
        timelineTime: frame.timelineTime,
        sourceTime: frame.sourceTime,
      }));
    if (batchFrames.length === 0) continue;
    batches.push({ start, batchFrames });
  }

  let completed = 0;
  const total = nextFrames.length;
  onProgress?.({ completed, total });
  const errors = await runFrameDescriptionBatches(batches, {
    onBatchComplete: (result) => {
      nextFrames = mergeFrameDescriptions(nextFrames, result.start, result.data.descriptions ?? []);
      completed = nextFrames.filter((frame) => hasUsableFrameDescription(frame.description)).length;
      onProgress?.({ completed, total });
    },
  });
  if (errors.length > 0) {
    throw errors[0];
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
    .filter((frame) => hasUsableFrameDescription(frame.description))
    .map((frame) => {
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

function formatSourceScopedProgressLabel(params: {
  sourceIndex: number;
  totalSources: number;
  fileName: string;
  actionLabel: string;
  completed: number;
  total: number;
}): string {
  const { sourceIndex, totalSources, fileName, actionLabel, completed, total } = params;
  return `Clip ${sourceIndex}/${totalSources} • ${fileName} • ${actionLabel} ${completed}/${Math.max(total, 1)}`;
}

function buildServerAnalysisStatusCards(params: {
  sources: Array<{
    sourceId: string;
    fileName: string;
    status: string;
    duration: number;
    storagePath: string | null;
    assetId: string | null;
  }>;
  analysisBySourceId: SourceIndexAnalysisStateMap;
  freshnessBySourceId: Record<string, { transcript?: boolean; overview?: boolean } | null | undefined>;
}): AnalysisStatusCard[] {
  const buildFallbackTask = (
    kind: 'audio' | 'visual',
    source: { status: string },
    freshness: { transcript?: boolean; overview?: boolean } | null,
  ): SourceIndexTaskState => {
    if (source.status === 'error') {
      return {
        status: 'failed',
        completed: 0,
        total: 1,
        etaSeconds: null,
        reason: 'Upload failed.',
      };
    }
    const isReady = kind === 'audio' ? freshness?.transcript === true : freshness?.overview === true;
    return {
      status: isReady ? 'completed' : 'queued',
      completed: isReady ? 1 : 0,
      total: 1,
      etaSeconds: null,
      reason: null,
    };
  };

  const getDisplayTask = (
    kind: 'audio' | 'visual',
    source: { status: string },
    task: SourceIndexTaskState | null | undefined,
    freshness: { transcript?: boolean; overview?: boolean } | null,
  ): SourceIndexTaskState => {
    const isReady = kind === 'audio' ? freshness?.transcript === true : freshness?.overview === true;
    if (isReady) {
      const total = Math.max(task?.total ?? 1, 1);
      return {
        status: 'completed',
        completed: total,
        total,
        etaSeconds: null,
        reason: null,
      };
    }
    return task ?? buildFallbackTask(kind, source, freshness);
  };

  const trackedSources = params.sources.filter((source) => (
    Boolean(source.storagePath || source.assetId || params.analysisBySourceId[source.sourceId])
  ));
  if (trackedSources.length === 0) return [];

  const buildAggregateCard = (kind: 'audio' | 'visual'): AnalysisStatusCard => {
    const tasks = trackedSources.map((source) => {
      const analysis = params.analysisBySourceId[source.sourceId] ?? null;
      const freshness = params.freshnessBySourceId[source.sourceId] ?? null;
      return getDisplayTask(kind, source, kind === 'audio' ? analysis?.audio : analysis?.visual, freshness);
    });
    const total = tasks.length;
    const completed = tasks.filter((task) => (
      task.status === 'completed' || (kind === 'audio' && task.status === 'unavailable')
    )).length;
    const title = kind === 'audio' ? 'Audio analysis' : 'Visual analysis';
    const completedStage = kind === 'audio' ? 'transcribing' : 'describing_frames';
    const activeStage = kind === 'audio' ? 'transcribing_audio' : 'describing_representative_frames';
    const firstReason = tasks.find((task) => task.reason)?.reason ?? null;
    const aggregateStatus = tasks.some((task) => task.status === 'running')
      ? 'running'
      : tasks.some((task) => task.status === 'paused')
        ? 'paused'
        : tasks.some((task) => task.status === 'failed')
          ? 'failed'
          : 'queued';

    if (completed >= total) {
      return {
        key: `${kind}-analysis`,
        title,
        progress: buildCompletedProgress(completedStage),
        tone: 'completed',
      };
    }

    return {
      key: `${kind}-analysis`,
      title,
      progress: {
        stage: activeStage,
        completed,
        total,
        label: aggregateStatus === 'running'
          ? `${kind === 'audio' ? 'Transcribing audio' : 'Analyzing visuals'} ${completed}/${total}`
          : aggregateStatus === 'paused'
            ? `${kind === 'audio' ? 'Audio analysis paused' : 'Visual analysis paused'} ${completed}/${total}`
            : aggregateStatus === 'failed'
              ? `${kind === 'audio' ? 'Audio analysis needs attention' : 'Visual analysis needs attention'} ${completed}/${total}`
              : `${kind === 'audio' ? 'Preparing audio analysis' : 'Preparing visual analysis'} ${completed}/${total}`,
        etaSeconds: aggregateStatus === 'running'
          ? Math.max(...tasks.map((task) => Math.max(task.etaSeconds ?? 0, 0)), 0) || null
          : null,
      },
      secondaryLabel: aggregateStatus === 'running'
        ? `${completed}/${total} clips ready`
        : aggregateStatus === 'paused'
          ? 'Paused'
          : aggregateStatus === 'failed'
            ? firstReason ?? 'Analysis needs attention.'
            : 'Waiting to start',
      detail: aggregateStatus === 'failed' && firstReason ? firstReason : null,
    };
  };

  return [
    buildAggregateCard('audio'),
    buildAggregateCard('visual'),
  ];
}

function packFramesForChat(
  frames: IndexedVideoFrame[],
  availableSources: Array<{ sourceId: string; duration: number }>,
): IndexedVideoFrame[] {
  const overviewFrames = frames
    .filter((frame) => frame.kind === 'overview' && hasUsableFrameDescription(frame.description))
    .sort((a, b) => a.timelineTime - b.timelineTime || a.sourceTime - b.sourceTime);
  if (overviewFrames.length <= MAX_CHAT_OVERVIEW_FRAMES) return overviewFrames;

  const framesBySource = new Map<string, IndexedVideoFrame[]>();
  overviewFrames.forEach((frame) => {
    const sourceId = normalizeKnownSourceId(frame.sourceId);
    const existing = framesBySource.get(sourceId) ?? [];
    framesBySource.set(sourceId, [...existing, frame]);
  });

  const orderedSourceIds = availableSources
    .map((source) => source.sourceId)
    .filter((sourceId) => framesBySource.has(sourceId));
  const fallbackSourceIds = [...framesBySource.keys()].filter((sourceId) => !orderedSourceIds.includes(sourceId));
  const sourceIds = [...orderedSourceIds, ...fallbackSourceIds];

  const reservedSelections = new Map<string, IndexedVideoFrame[]>();
  const reservedKeys = new Set<string>();
  sourceIds.forEach((sourceId) => {
    const selected = selectEvenlySampledFrames(framesBySource.get(sourceId) ?? [], 4);
    reservedSelections.set(sourceId, selected);
    selected.forEach((frame) => {
      reservedKeys.add(`${sourceId}:${frame.timelineTime}:${frame.sourceTime}`);
    });
  });

  let packed = sourceIds.flatMap((sourceId) => reservedSelections.get(sourceId) ?? []);
  if (packed.length >= MAX_CHAT_OVERVIEW_FRAMES) {
    return selectEvenlySampledFrames(packed, MAX_CHAT_OVERVIEW_FRAMES)
      .sort((a, b) => a.timelineTime - b.timelineTime || a.sourceTime - b.sourceTime);
  }

  const remainingSlots = MAX_CHAT_OVERVIEW_FRAMES - packed.length;
  const sourceDurationById = new Map(availableSources.map((source) => [source.sourceId, Math.max(source.duration, 0)]));
  const remainingPools = sourceIds.map((sourceId) => {
    const pool = (framesBySource.get(sourceId) ?? []).filter((frame) => !reservedKeys.has(`${sourceId}:${frame.timelineTime}:${frame.sourceTime}`));
    return {
      sourceId,
      pool,
      duration: sourceDurationById.get(sourceId) ?? pool.length,
    };
  });
  const totalDuration = remainingPools.reduce((sum, entry) => sum + entry.duration, 0);
  let leftoverSlots = remainingSlots;

  remainingPools.forEach((entry, index) => {
    if (leftoverSlots <= 0 || entry.pool.length === 0) return;
    const proportionalTarget = totalDuration > 0
      ? Math.round((entry.duration / totalDuration) * remainingSlots)
      : Math.floor(remainingSlots / Math.max(remainingPools.length - index, 1));
    const target = Math.min(entry.pool.length, Math.max(0, proportionalTarget));
    const selected = selectEvenlySampledFrames(entry.pool, target);
    packed = [...packed, ...selected];
    leftoverSlots -= selected.length;
  });

  if (leftoverSlots > 0) {
    const spillover = remainingPools.flatMap((entry) => entry.pool)
      .filter((frame) => !packed.includes(frame))
      .sort((a, b) => a.timelineTime - b.timelineTime || a.sourceTime - b.sourceTime);
    packed = [...packed, ...selectEvenlySampledFrames(spillover, leftoverSlots)];
  }

  return packed
    .sort((a, b) => a.timelineTime - b.timelineTime || a.sourceTime - b.sourceTime)
    .slice(0, MAX_CHAT_OVERVIEW_FRAMES);
}

function isMarkerMutationAction(action?: EditAction | null): action is EditAction {
  return action?.type === 'add_marker'
    || action?.type === 'add_markers'
    || action?.type === 'update_marker'
    || action?.type === 'remove_marker';
}

function messageRequestsMarkerPlacement(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;

  return (
    /\bmarkers?|bookmarks?|tags?\b/.test(normalized)
    && /\b(add|create|drop|find|help|locate|mark|place|point(?:\s+out)?|set|tag|put)\b/.test(normalized)
  ) || /\bmark\b/.test(normalized);
}

function messageIncludesSecondaryEditRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;

  return /\b(cut|trim|delete|remove|caption|subtitle|transcribe|split|move|reorder|transition|fade|overlay|title|text|mute|volume|speed|slow|fast|silence|silent)\b/.test(normalized);
}

function isEvidenceGatheringAction(action?: EditAction | null): boolean {
  return action?.type === 'transcribe_request' || action?.type === 'request_frames';
}

function shouldPrioritizeMarkerStepFirst(
  requestText: string,
  action?: EditAction | null,
): boolean {
  if (!action || action.type === 'none') return false;
  if (!messageRequestsMarkerPlacement(requestText)) return false;
  if (!messageIncludesSecondaryEditRequest(requestText)) return false;
  if (isMarkerMutationAction(action)) return false;
  if (isEvidenceGatheringAction(action)) return false;
  if (action.type === 'update_ai_settings') return false;
  return true;
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

function getMarkerPrimaryLabel(marker: Pick<MarkerEntry, 'number'>): string {
  return `Marker ${marker.number}`;
}

function getMarkerSecondaryLabel(marker: Pick<MarkerEntry, 'timelineTime' | 'label'>): string {
  return marker.label?.trim() || formatChatTime(marker.timelineTime);
}

function getClipPrimaryLabel(index: number): string {
  return `Clip ${index + 1}`;
}

function getReviewItemCount(action?: EditAction | null): number {
  if (!action || action.type === 'none') return 0;
  if (action.type === 'delete_ranges') return action.ranges?.length ?? 0;
  if (action.type === 'add_captions') return action.captions?.length ?? (action.transcriptRange ? 1 : 0);
  if (action.type === 'add_transition') return action.transitions?.length ?? 0;
  if (action.type === 'add_markers') return action.markers?.length ?? 0;
  if (action.type === 'add_text_overlay') return action.textOverlays?.length ?? 0;
  return 1;
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
    return action.captions?.[0]?.startTime ?? action.transcriptRange?.startTime ?? null;
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
    const schedule = buildClipSchedule(snapshot.clips, snapshot.transitions);
    return schedule[clipIndex]?.timelineStart ?? null;
  }

  return null;
}

function getReviewSeekTime(snapshot: EditSnapshot, action: EditAction): number | null {
  const anchor = getReviewAnchorTime(snapshot, action);
  if (anchor === null) return null;
  const timelineDuration = getTimelineDuration(snapshot.clips, snapshot.transitions);
  return Math.max(0, Math.min(Math.max(0, timelineDuration), anchor - REVIEW_PREROLL_SECONDS));
}

function getReviewApplyResult(action: EditAction, reviewCount: number): string {
  if (action.type === 'add_captions') {
    const count = action.captions?.length ?? 0;
    return count > 0
      ? `Added ${count} caption${count === 1 ? '' : 's'}.`
      : 'Added captions.';
  }

  if (action.type === 'add_transition') {
    const count = action.transitions?.length ?? 0;
    return `Added ${count} transition${count === 1 ? '' : 's'}.`;
  }

  if (action.type === 'add_markers') {
    const count = action.markers?.length ?? 0;
    return `${count} marker${count === 1 ? '' : 's'} added.`;
  }

  if (action.type === 'add_text_overlay') {
    const count = action.textOverlays?.length ?? 0;
    return `Added ${count} text overlay${count === 1 ? '' : 's'}.`;
  }

  if (reviewCount > 1) {
    return `Committed ${reviewCount} changes.`;
  }

  return 'Change applied.';
}

function formatChatTime(seconds: number): string {
  return Math.abs(seconds - Math.round(seconds)) < 0.001
    ? formatTime(seconds)
    : formatTimePrecise(seconds);
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
    case 'update_ai_settings':
      return {
        label: 'Update AI settings',
        color: '#facc15',
        summary: 'Defaults updated',
      };
    case 'add_captions':
      {
        const summary = action.transcriptRange
          ? `${formatChatTime(action.transcriptRange.startTime)} → ${formatChatTime(action.transcriptRange.endTime)}`
          : 'Subtitle track';
        if (action.transcriptRange && !action.captions?.length) {
          return {
            label: 'Add captions',
            color: '#f59e0b',
            summary,
          };
        }
        const captionCount = action.captions?.length ?? 0;
        return {
          label: `Add ${captionCount} caption${captionCount !== 1 ? 's' : ''}`,
          color: '#f59e0b',
          summary,
        };
      }
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

function ReviewCheckboxButton({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-checked={checked ? 'true' : 'false'}
      className="chat-review-checkbox"
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="chat-review-checkbox__box" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{
            width: 14,
            height: 14,
            opacity: checked ? 1 : 0,
            transform: checked ? 'scale(1)' : 'scale(0.72)',
            transition: 'opacity 140ms ease, transform 140ms ease',
          }}
        >
          <path
            d="M3.5 8.4L6.4 11.2L12.5 4.8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );
}

function ActionDetails({ action }: { action: EditAction }) {
  if (action.type === 'delete_ranges') {
    const ranges = action.ranges ?? [];
    return (
      <div style={{ padding: '6px 12px 8px', display: 'flex', flexDirection: 'column' }}>
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
    if (!action.captions?.length && action.transcriptRange) {
      return (
        <div style={{ padding: '6px 12px 8px' }}>
          <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-secondary)' }}>
            Transcript-backed captions for {formatChatTime(action.transcriptRange.startTime)} to {formatChatTime(action.transcriptRange.endTime)}.
          </span>
        </div>
      );
    }
    return (
      <div style={{ padding: '6px 12px 8px', display: 'flex', flexDirection: 'column' }}>
        {(action.captions ?? []).map((c, i) => (
          <div key={i} style={{
            padding: '3px 0',
            borderBottom: i < (action.captions ?? []).length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
          }}>
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-muted)', marginRight: 6 }}>
              {formatChatTime(c.startTime)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--fg-secondary)' }}>{c.text}</span>
          </div>
        ))}
      </div>
    );
  }

  if (action.type === 'update_ai_settings') {
    const settings = action.settings;
    const details = [
      settings?.silenceRemoval?.paddingSeconds !== undefined ? `silence padding ${settings.silenceRemoval.paddingSeconds}s` : '',
      settings?.silenceRemoval?.minDurationSeconds !== undefined ? `min silence ${settings.silenceRemoval.minDurationSeconds}s` : '',
      settings?.frameInspection?.defaultFrameCount !== undefined ? `inspect ${settings.frameInspection.defaultFrameCount} frames` : '',
      settings?.frameInspection?.overviewIntervalSeconds !== undefined ? `long-video coarse spacing ~${settings.frameInspection.overviewIntervalSeconds}s` : '',
      settings?.frameInspection?.maxOverviewFrames !== undefined ? `max ${settings.frameInspection.maxOverviewFrames} coarse frames` : '',
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
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 10, color: 'var(--fg-secondary)' }}>
              {typeof marker?.number === 'number' ? getMarkerPrimaryLabel({ number: marker.number }) : `Marker ${i + 1}`}
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
      <div style={{ padding: '6px 12px 8px', display: 'flex', flexDirection: 'column' }}>
        {(action.textOverlays ?? []).map((t, i) => (
          <div key={i} style={{
            padding: '2px 0',
            borderBottom: i < (action.textOverlays ?? []).length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
          }}>
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

async function extractSourceOverviewFrames(
  input: {
    sourceId: string;
    source: Uint8Array | File | string;
    duration: number;
    overviewIntervalSeconds: number;
    maxOverviewFrames: number;
    onProgress?: (progress: {
      stage: 'extracting_frames' | 'choosing_representative_frames';
      completed: number;
      total: number;
      label: string;
    }) => void;
  },
): Promise<SourceIndexedFrame[]> {
  if (input.duration <= 0) return [];

  const preferredInterval = Math.max(0.1, input.overviewIntervalSeconds);
  const windows = buildCoarseRepresentativeWindows(input.duration, preferredInterval, input.maxOverviewFrames);
  if (windows.length === 0) return [];

  const candidateSamples = windows.flatMap((window) => (
    buildRepresentativeCandidateTimes(window).map((sourceTime) => ({
      windowIndex: window.index,
      sourceTime,
      windowStart: window.startTime,
      windowEnd: window.endTime,
    }))
  ));
  if (candidateSamples.length === 0) return [];

  const images = await extractVideoFrames(
    input.source,
    candidateSamples.map((sample) => sample.sourceTime),
    {
      concurrency: OVERVIEW_FRAME_EXTRACTION_CONCURRENCY,
      onProgress: ({ completed, total }) => {
        input.onProgress?.({
          stage: 'extracting_frames',
          completed,
          total,
          label: `Sampling video frames ${completed}/${total}`,
        });
      },
    },
  );

  const scoredCandidates: Array<(typeof candidateSamples)[number] & { image: string; score: number }> = [];
  for (let index = 0; index < candidateSamples.length; index += 1) {
    const sample = candidateSamples[index];
    const image = images[index];
    const metrics = await measureFrameHeuristics(image);
    const score = scoreFrameHeuristics(metrics, Number.POSITIVE_INFINITY);
    scoredCandidates.push({
      ...sample,
      image,
      score,
    });
    input.onProgress?.({
      stage: 'choosing_representative_frames',
      completed: index + 1,
      total: candidateSamples.length,
      label: `Scoring frame candidates ${index + 1}/${candidateSamples.length}`,
    });
  }

  const bestByWindow = new Map<number, (typeof scoredCandidates)[number]>();
  for (const candidate of scoredCandidates) {
    const currentBest = bestByWindow.get(candidate.windowIndex);
    if (!currentBest || candidate.score > currentBest.score) {
      bestByWindow.set(candidate.windowIndex, candidate);
    }
  }

  return [...bestByWindow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, candidate]) => ({
      sourceId: input.sourceId,
      sourceTime: candidate.sourceTime,
      image: candidate.image,
      sampleKind: 'coarse_window_rep',
      score: Number(candidate.score.toFixed(4)),
    }));
}

async function extractTimelineFramesFromSources(
  input: {
    clips: ReturnType<typeof useEditorStore.getState>['clips'];
    availableSources: Array<ReturnType<typeof resolveProjectSources>[number]>;
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
  const availableSourceById = new Map(input.availableSources.map((entry) => [entry.sourceId, entry]));

  const frames = new Array<IndexedVideoFrame | null>(samples.length).fill(null);
  input.onProgress?.({ completed: 0, total: samples.length });
  let completedAcrossSources = 0;
  const samplesBySource = new Map<string, TimelineFrameSample[]>();
  for (const sample of samples) {
    const existing = samplesBySource.get(sample.sourceId) ?? [];
    samplesBySource.set(sample.sourceId, [...existing, sample]);
  }

  for (const [sourceId, sourceSamples] of samplesBySource) {
    const sourceEntry = availableSourceById.get(sourceId);
    if (!sourceEntry?.source) {
      throw new Error(`Missing source video for frame extraction (${sourceId}).`);
    }

    const images = await extractVideoFrames(
      sourceEntry.source,
      sourceSamples.map((sample) => sample.sourceTime),
      {
        concurrency: OVERVIEW_FRAME_EXTRACTION_CONCURRENCY,
        onProgress: ({ completed }) => {
          input.onProgress?.({ completed: completedAcrossSources + completed, total: samples.length });
        },
      },
    );

    sourceSamples.forEach((sample, imageIndex) => {
      frames[sample.index] = {
        image: images[imageIndex],
        timelineTime: sample.timelineTime,
        sourceTime: sample.sourceTime,
        sourceId,
        kind: input.kind,
      };
    });
    completedAcrossSources += sourceSamples.length;
  }

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

function AutoAvatar({ size = 28 }: { size?: number }) {
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: 10,
      background: '#0A0A0A',
      border: '1px solid rgba(255,255,255,0.12)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
      flexShrink: 0,
    }}>
      <AutocutMark
        size={Math.max(16, Math.round(size * 0.78))}
        withTile={false}
      />
    </div>
  );
}

function AutoIdentity({
  subtitle,
}: {
  subtitle?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span style={{
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--fg-primary)',
        fontFamily: 'var(--font-serif)',
        letterSpacing: 0.1,
      }}>
        Auto
      </span>
      {subtitle && (
        <span style={{
          fontSize: 10,
          color: 'var(--fg-muted)',
          fontFamily: 'var(--font-serif)',
          whiteSpace: 'nowrap',
        }}>
          {subtitle}
        </span>
      )}
    </div>
  );
}

// ─── Message bubbles ───────────────────────────────────────────────────────────
function UserMessage({ msg }: { msg: ChatMessageType }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%', marginBottom: 8 }}>
      <div style={{
        display: 'inline-block',
        maxWidth: '72%',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '10px 10px 2px 10px',
        padding: '8px 12px',
        fontSize: 13,
        color: 'var(--fg-primary)',
        lineHeight: 1.55,
        fontFamily: 'var(--font-serif)',
        marginLeft: 'auto',
        textAlign: 'left',
      }}>
        <MarkerAwareText text={msg.content} />
      </div>
    </div>
  );
}

function AssistantMessage({
  msg,
  onTranscriptReady,
  onActionResolved,
}: {
  msg: ChatMessageType;
  onTranscriptReady: (messageId: string) => Promise<void>;
  onActionResolved: (messageId: string, action: EditAction, actionResult?: string | null) => Promise<void>;
}) {
  const videoUrl = useEditorStore(s => s.videoUrl);
  const processingVideoUrl = useEditorStore(s => s.processingVideoUrl);
  const videoFile = useEditorStore(s => s.videoFile);
  const videoData = useEditorStore(s => s.videoData);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const sources = useEditorStore(s => s.sources);
  const sourceRuntimeById = useEditorStore(s => s.sourceRuntimeById);
  const clips = useEditorStore(s => s.previewSnapshot?.clips ?? s.clips);
  const previewOwnerId = useEditorStore(s => s.previewOwnerId);
  const commitPreviewSnapshot = useEditorStore(s => s.commitPreviewSnapshot);
  const activeReviewSession = useEditorStore(s => s.activeReviewSession);
  const activeReviewFocusItemId = useEditorStore(s => s.activeReviewFocusItemId);
  const setActiveReviewSession = useEditorStore(s => s.setActiveReviewSession);
  const setActiveReviewFocusItemId = useEditorStore(s => s.setActiveReviewFocusItemId);
  const requestSeek = useEditorStore(s => s.requestSeek);
  const applyStoredAction = useEditorStore(s => s.applyAction);
  const recordAppliedAction = useEditorStore(s => s.recordAppliedAction);
  const updateMessage = useEditorStore(s => s.updateMessage);
  const appliedActions = useEditorStore(s => s.appliedActions);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [reviewResult, setReviewResult] = useState<string | null>(null);
  const [transcriptionDone, setTranscriptionDone] = useState(false);

  const setBackgroundTranscript = useEditorStore(s => s.setBackgroundTranscript);
  const setTranscriptProgress = useEditorStore(s => s.setTranscriptProgress);
  const existingSourceTranscriptCaptions = useEditorStore(s => s.sourceTranscriptCaptions);
  const availableSourcesById = useMemo(
    () => new Map(resolveProjectSources({
      sources,
      runtimeBySourceId: sourceRuntimeById,
      primaryFallback: {
        videoData,
        videoFile,
        videoUrl,
        processingVideoUrl,
        videoDuration,
      },
    }).map((entry) => [entry.sourceId, entry])),
    [processingVideoUrl, sourceRuntimeById, sources, videoData, videoDuration, videoFile, videoUrl],
  );
  const addMessage = useEditorStore(s => s.addMessage);

  const action = msg.action;
  const hasAction = action && action.type !== 'none';
  const activeReviewAction = action ?? null;
  const anotherReviewActive = previewOwnerId !== null && previewOwnerId !== msg.id;
  const reviewSessionForMessage = activeReviewSession?.ownerId === msg.id ? activeReviewSession : null;
  const reviewSteps = reviewSessionForMessage?.items ?? [];
  const liveActionState = useMemo(
    () => getLiveMessageActionState(msg, appliedActions),
    [appliedActions, msg],
  );
  const actionPreviouslyApplied = liveActionState.isApplied;
  const actionResolved = liveActionState.actionStatus === 'completed'
    || liveActionState.actionStatus === 'rejected';
  const reviewableAction = !!action
    && action.type !== 'none'
    && action.type !== 'transcribe_request'
    && action.type !== 'update_ai_settings';
  const batchReviewActive = !!reviewSessionForMessage && reviewableAction;
  const meta = activeReviewAction ? getActionMeta(activeReviewAction) : null;
  const reviewableItemCount = getReviewItemCount(action);
  const actionResultText = liveActionState.actionResult ?? (
    liveActionState.actionStatus === 'rejected'
      ? 'No changes applied.'
      : liveActionState.autoApplied
        ? 'Auto-applied ✓'
        : actionPreviouslyApplied
          ? 'Already applied.'
          : null
  );

  useEffect(() => () => {
    if (useEditorStore.getState().activeReviewSession?.ownerId === msg.id) {
      useEditorStore.getState().setActiveReviewSession(null);
    }
  }, [msg.id]);

  useEffect(() => {
    if (!actionPreviouslyApplied || msg.actionStatus === 'completed' || msg.actionStatus === 'rejected') return;
    updateMessage(msg.id, { actionStatus: 'completed', actionResult: actionResultText ?? 'Already applied.' });
  }, [actionPreviouslyApplied, actionResultText, msg.actionStatus, msg.id, updateMessage]);

  const reviewedAction = useMemo(
    () => (reviewSessionForMessage ? collapseReviewItemsToAction(reviewSessionForMessage) : null),
    [reviewSessionForMessage],
  );
  const allReviewItemsChecked = reviewSteps.length > 0 && reviewSteps.every((item) => item.checked);
  const checkedReviewCount = reviewSteps.filter((item) => item.checked).length;

  const startReview = useCallback(() => {
    if (
      !action
      || !reviewableAction
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
    const nextReviewGroup = createReviewGroup(msg.id, action, baseSnapshot, {
      sourceTranscriptCaptions: existingSourceTranscriptCaptions,
    });
    if (!nextReviewGroup) return;
    setReviewResult(null);
    setActiveReviewSession(nextReviewGroup);
    const reviewSeekTime = getReviewSeekTime(baseSnapshot, action);
    if (reviewSeekTime !== null) requestSeek(reviewSeekTime);
  }, [action, anotherReviewActive, existingSourceTranscriptCaptions, msg.id, requestSeek, reviewableAction, setActiveReviewSession]);

  const cancelReview = useCallback(() => {
    setActiveReviewSession(null);
    setReviewResult(null);
  }, [setActiveReviewSession]);

  const toggleReviewAll = useCallback((checked: boolean) => {
    if (!reviewSessionForMessage) return;
    const nextGroup = buildReviewGroupWithUpdatedItems(
      reviewSessionForMessage,
      (items) => items.map((item) => ({ ...item, checked })),
    );
    setActiveReviewSession(nextGroup);
    setReviewResult(null);
  }, [reviewSessionForMessage, setActiveReviewSession]);

  const toggleReviewItem = useCallback((itemId: string, checked: boolean) => {
    if (!reviewSessionForMessage) return;
    const nextGroup = buildReviewGroupWithUpdatedItems(
      reviewSessionForMessage,
      (items) => items.map((item) => (item.id === itemId ? { ...item, checked } : item)),
    );
    setActiveReviewSession(nextGroup);
    setReviewResult(null);
  }, [reviewSessionForMessage, setActiveReviewSession]);

  const focusReviewItem = useCallback((itemId: string) => {
    if (!reviewSessionForMessage) return;
    const target = reviewSessionForMessage.items.find((item) => item.id === itemId);
    if (!target) return;
    setActiveReviewFocusItemId(itemId);
    const anchor = target.anchorTime;
    if (anchor !== null) {
      const previewSnapshot = buildReviewPreviewSnapshot(reviewSessionForMessage);
      const removedDurationBeforeAnchor = target.action.type === 'delete_range'
        ? reviewSessionForMessage.items.reduce((sum, item) => {
            if (!item.checked || item.id === target.id || item.action.type !== 'delete_range') return sum;
            const start = item.action.deleteStartTime ?? 0;
            const end = item.action.deleteEndTime ?? 0;
            return end <= anchor ? sum + Math.max(0, end - start) : sum;
          }, 0)
        : 0;
      const adjustedAnchor = Math.max(0, anchor - removedDurationBeforeAnchor);
      const reviewSeekTime = target.action.type === 'delete_range'
        ? Math.max(0, adjustedAnchor - REVIEW_PREROLL_SECONDS)
        : (getReviewSeekTime(previewSnapshot, target.action) ?? Math.max(0, adjustedAnchor - REVIEW_PREROLL_SECONDS));
      requestSeek(reviewSeekTime);
    }
  }, [requestSeek, reviewSessionForMessage, setActiveReviewFocusItemId]);

  const handleApplyReviewedAction = useCallback(() => {
    if (!reviewSessionForMessage || !reviewedAction) return;
    const nextSnapshot = buildReviewPreviewSnapshot(reviewSessionForMessage);
    const sourceRanges = sourceRangesForAction(reviewSessionForMessage.baseSnapshot.clips, reviewedAction);
    commitPreviewSnapshot(nextSnapshot);
    recordAppliedAction(reviewedAction, reviewedAction.message, {
      sourceRanges,
      requestChainId: msg.requestChainId,
    });
    const result = getReviewApplyResult(reviewedAction, checkedReviewCount);
    updateMessage(msg.id, {
      actionStatus: 'completed',
      actionResult: result,
    });
    setActiveReviewSession(null);
    setActiveReviewFocusItemId(null);
    setReviewResult(result);
    void onActionResolved(msg.id, reviewedAction, result);
  }, [checkedReviewCount, commitPreviewSnapshot, msg.id, msg.requestChainId, onActionResolved, recordAppliedAction, reviewSessionForMessage, reviewedAction, setActiveReviewFocusItemId, setActiveReviewSession, updateMessage]);

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
        const sourceEntry = availableSourcesById.get(sourceId);
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
      setBackgroundTranscript(transcriptText, 'done', mergedCaptions, null, { markFresh: false });
      addMessage({
        role: 'assistant',
        content: `Transcript ready for ${formatTime(seg.startTime)} to ${formatTime(seg.endTime)}. Continuing with your request.`,
        requestChainId: msg.requestChainId,
      });
      setTranscriptionDone(true);
      updateMessage(msg.id, { actionStatus: 'completed', actionResult: 'Transcript ready ✓' });
      await onTranscriptReady(msg.id);
    } catch (err) {
      setTranscribeError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsTranscribing(false);
    }
  }, [action, addMessage, availableSourcesById, clips, existingSourceTranscriptCaptions, msg.id, msg.requestChainId, onTranscriptReady, setBackgroundTranscript, setTranscriptProgress, updateMessage]);

  const handleApplySettings = useCallback(() => {
    if (!action || action.type !== 'update_ai_settings') return;
    applyStoredAction(action);
    recordAppliedAction(action, action.message, { requestChainId: msg.requestChainId });
    updateMessage(msg.id, { actionStatus: 'completed', actionResult: 'AI settings updated.' });
    setReviewResult('AI settings updated.');
    void onActionResolved(msg.id, action, 'AI settings updated.');
  }, [action, applyStoredAction, msg.id, msg.requestChainId, onActionResolved, recordAppliedAction, updateMessage]);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', gap: 10, width: '100%', marginBottom: 10 }}>
      <AutoAvatar />
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', maxWidth: '72%' }}>
        <div style={{ marginBottom: 6 }}>
          <AutoIdentity />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-start', width: '100%' }}>
          <div style={{
            display: 'inline-block',
            fontSize: 13,
            color: 'var(--fg-secondary)',
            lineHeight: 1.65,
            fontFamily: 'var(--font-serif)',
            padding: '10px 12px',
            borderRadius: '10px 10px 10px 2px',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.025))',
            border: '1px solid rgba(255,255,255,0.07)',
            maxWidth: '100%',
            alignSelf: 'flex-start',
            textAlign: 'left',
          }}>
            <MarkerAwareText text={msg.content} />
          </div>
        </div>

        {hasAction && meta && (
          <div style={{
            marginTop: 10,
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 7,
            overflow: 'hidden',
            background: 'var(--bg-elevated)',
            width: '100%',
          }}>
            <div style={{
              padding: '7px 12px',
              background: 'rgba(255,255,255,0.03)',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              display: 'flex', alignItems: 'center', gap: 8,
              cursor: reviewableAction && !anotherReviewActive ? 'pointer' : 'default',
            }}
              onClick={() => {
                if (!reviewableAction) return;
                if (batchReviewActive) {
                  setActiveReviewFocusItemId(null);
                  return;
                }
                startReview();
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
              <span style={{
                fontSize: 12, color: 'var(--fg-primary)', fontWeight: 600,
                fontFamily: 'var(--font-serif)',
              }}>
                {meta.label}
              </span>
              {meta.summary && (
                <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-serif)' }}>
                  - {meta.summary}
                </span>
              )}
            </div>

            <ActionDetails action={activeReviewAction!} />
            {batchReviewActive && reviewSteps.length > 0 && (
              <div style={{ padding: '8px 12px 10px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    marginBottom: 10,
                    fontSize: 11,
                    color: 'var(--fg-secondary)',
                    fontFamily: 'var(--font-serif)',
                    cursor: 'pointer',
                  }}
                  onClick={() => toggleReviewAll(!allReviewItemsChecked)}
                >
                  <ReviewCheckboxButton
                    checked={allReviewItemsChecked}
                    onChange={toggleReviewAll}
                    ariaLabel={allReviewItemsChecked ? 'Deselect all proposed edits' : 'Select all proposed edits'}
                  />
                  <span>Select all</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--fg-muted)' }}>{checkedReviewCount}/{reviewSteps.length} selected</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {reviewSteps.map((item) => {
                    const isFocused = activeReviewFocusItemId === item.id;
                    return (
                      <div
                        key={item.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '10px 12px',
                          borderRadius: 12,
                          border: isFocused ? '1px solid rgba(33,212,255,0.34)' : '1px solid rgba(255,255,255,0.08)',
                          background: isFocused
                            ? 'linear-gradient(180deg, rgba(33,212,255,0.12), rgba(255,255,255,0.04))'
                            : 'linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.02))',
                          boxShadow: isFocused ? '0 0 0 1px rgba(33,212,255,0.08)' : 'inset 0 1px 0 rgba(255,255,255,0.03)',
                        }}
                      >
                        <ReviewCheckboxButton
                          checked={item.checked}
                          onChange={(checked) => toggleReviewItem(item.id, checked)}
                          ariaLabel={`${item.checked ? 'Deselect' : 'Select'} ${item.label}`}
                        />
                        <button
                          type="button"
                          onClick={() => focusReviewItem(item.id)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                            flex: 1,
                            background: 'transparent',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            textAlign: 'left',
                            color: 'inherit',
                            fontFamily: 'inherit',
                          }}
                        >
                          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                            <span style={{ fontSize: 11, color: 'var(--fg-primary)', fontWeight: 600, fontFamily: 'var(--font-serif)' }}>
                              {item.label}
                            </span>
                            <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-serif)', lineHeight: 1.45 }}>
                              {item.summary || item.action.message}
                            </span>
                          </span>
                          <span style={{
                            fontSize: 10,
                            color: isFocused ? 'var(--accent-strong)' : 'var(--fg-muted)',
                            fontFamily: 'var(--font-serif)',
                            flexShrink: 0,
                          }}>
                            {isFocused ? 'Previewing' : 'Preview'}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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
                {reviewableAction && reviewableItemCount > 0 && activeReviewAction && (
                  <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '0 0 8px', fontFamily: 'var(--font-serif)' }}>
                    {batchReviewActive
                      ? `Previewing ${reviewSteps.length} proposed change${reviewSteps.length === 1 ? '' : 's'}. Apply commits only the checked edits.`
                      : `Review ${reviewableItemCount} proposed change${reviewableItemCount === 1 ? '' : 's'} at once.`}
                  </p>
                )}
                {liveActionState.wasUndone && (
                  <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '0 0 8px', fontFamily: 'var(--font-serif)' }}>
                    This edit was undone from the timeline, so it can be applied again.
                  </p>
                )}
                {anotherReviewActive && !batchReviewActive && reviewableAction && (
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
                ) : batchReviewActive ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={handleApplyReviewedAction}
                      disabled={!reviewedAction}
                      style={{
                        flex: 1,
                        padding: '5px 0',
                        fontSize: 12,
                        fontWeight: 500,
                        background: reviewedAction ? 'var(--accent)' : 'rgba(255,255,255,0.06)',
                        border: 'none',
                        color: reviewedAction ? '#000' : 'var(--fg-muted)',
                        borderRadius: 4,
                        cursor: reviewedAction ? 'pointer' : 'default',
                        fontFamily: 'var(--font-serif)',
                      }}
                    >
                      {reviewedAction ? 'Apply selected' : 'No edits selected'}
                    </button>
                    <button
                      onClick={cancelReview}
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
                    {reviewableItemCount > 1 ? 'Review changes' : 'Review change'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Thinking indicator ────────────────────────────────────────────────────────
function ThinkingIndicator({ status }: { status?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', gap: 10, width: '100%' }}>
      <AutoAvatar />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, alignItems: 'flex-start', width: '100%', maxWidth: '72%' }}>
        <AutoIdentity subtitle="Thinking..." />
        <div style={{ display: 'flex', justifyContent: 'flex-start', width: '100%' }}>
          <div style={{
            display: 'inline-flex',
            gap: 3,
            padding: '10px 12px',
            borderRadius: '10px 10px 10px 2px',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.025))',
            border: '1px solid rgba(255,255,255,0.07)',
            width: 'fit-content',
          }}>
            {[0, 1, 2].map(i => (
              <div key={i} className="dot-bar" style={{
                width: 3, height: 14,
                background: 'rgba(255,255,255,0.25)',
                borderRadius: 2,
                animationDelay: `${i * 0.15}s`,
              }} />
            ))}
          </div>
        </div>
        {status && (
          <span style={{
            fontSize: 10,
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-serif)',
            lineHeight: 1.4,
            paddingLeft: 2,
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
  tone = 'active',
}: {
  title: string;
  progress: IndexingProgress | null;
  detail?: string | null;
  secondaryLabel?: string | null;
  tone?: ProgressCardTone;
}) {
  const targetProgress = getProgressValue(progress);
  const isCompleted = tone === 'completed';
  const statusText = progress?.label ?? null;
  const etaKey = `${progress?.etaSeconds ?? 'na'}:${progress?.completed ?? 'na'}:${progress?.total ?? 'na'}:${progress?.stage ?? 'na'}:${progress?.label ?? 'na'}:${isCompleted ? 'done' : 'active'}`;

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
        {isCompleted ? (
          <div style={{
            width: 14,
            height: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(33,212,255,0.92)',
            flexShrink: 0,
          }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
            </svg>
          </div>
        ) : (
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
        )}
        <span style={{
          fontSize: 11,
          color: 'var(--fg-secondary)',
          fontFamily: 'var(--font-serif)',
        }}>
          {title}
        </span>
      </div>
      {!isCompleted && targetProgress !== null && (
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
      {statusText && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{
            fontSize: 10,
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-serif)',
          }}>
            {statusText}
          </span>
          <LiveEtaLabel
            key={etaKey}
            etaSeconds={progress?.etaSeconds ?? null}
            isCompleted={isCompleted}
          />
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

function LiveEtaLabel({
  etaSeconds,
  isCompleted,
}: {
  etaSeconds?: number | null;
  isCompleted: boolean;
}) {
  const [targetMs] = useState<number | null>(() => {
    if (!etaSeconds || !Number.isFinite(etaSeconds) || etaSeconds <= 0 || isCompleted) {
      return null;
    }
    return Date.now() + etaSeconds * 1000;
  });
  const [countdownNow, setCountdownNow] = useState(() => Date.now());

  useEffect(() => {
    if (targetMs === null || isCompleted) return;
    const intervalId = window.setInterval(() => {
      setCountdownNow(Date.now());
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [isCompleted, targetMs]);

  if (isCompleted || targetMs === null) return null;

  const remainingSeconds = Math.ceil((targetMs - countdownNow) / 1000);
  const label = remainingSeconds <= 0 ? 'Finishing up…' : formatCountdownLabel(remainingSeconds);

  return (
    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.42)', fontFamily: 'var(--font-serif)', whiteSpace: 'nowrap' }}>
      {label}
    </span>
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
}: Record<string, never>) {
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
    </div>
  );
}

// ─── Main sidebar ──────────────────────────────────────────────────────────────
export default function ChatSidebar() {
  const [input, setInput] = useState('');
  const [activeMarkerMention, setActiveMarkerMention] = useState<ActiveMarkerMention | null>(null);
  const [highlightedMarkerIndex, setHighlightedMarkerIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const frameDescriptionPromiseRef = useRef<Promise<SourceIndexedFrame[]> | null>(null);
  const extractionPromiseRef = useRef<Promise<IndexedVideoFrame[]> | null>(null);
  const syncingTaggedMarkersRef = useRef(false);
  const previousTaggedMarkerIdsRef = useRef<string[]>([]);
  const requestChainStateRef = useRef<Record<string, RequestChainState>>({});

  const messages = useEditorStore(s => s.messages);
  const isChatLoading = useEditorStore(s => s.isChatLoading);
  const addMessage = useEditorStore(s => s.addMessage);
  const setIsChatLoading = useEditorStore(s => s.setIsChatLoading);
  const videoDuration = useEditorStore(s => s.videoDuration);
  const clips = useEditorStore(s => s.clips);
  const markers = useEditorStore(s => s.markers);
  const selectedItem = useEditorStore(s => s.selectedItem);
  const taggedMarkerIds = useEditorStore(s => s.taggedMarkerIds);
  const taggedClipIds = useEditorStore(s => s.taggedClipIds);
  const setSelectedItem = useEditorStore(s => s.setSelectedItem);
  const setTaggedMarkerIds = useEditorStore(s => s.setTaggedMarkerIds);
  const setTaggedClipIds = useEditorStore(s => s.setTaggedClipIds);
  const clearTaggedMarkers = useEditorStore(s => s.clearTaggedMarkers);
  const clearTaggedClips = useEditorStore(s => s.clearTaggedClips);
  const clearChatHistory = useEditorStore(s => s.clearChatHistory);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [loadingPhaseId, setLoadingPhaseId] = useState<string | null>(null);
  const [frameIndexingProgress, setFrameIndexingProgress] = useState<IndexingProgress | null>(null);
  const [frameAnalysisError, setFrameAnalysisError] = useState<string | null>(null);
  const videoUrl = useEditorStore(s => s.videoUrl);
  const processingVideoUrl = useEditorStore(s => s.processingVideoUrl);
  const videoData = useEditorStore(s => s.videoData);
  const videoFile = useEditorStore(s => s.videoFile);
  const sources = useEditorStore(s => s.sources);
  const sourceRuntimeById = useEditorStore(s => s.sourceRuntimeById);
  const transcriptStatus = useEditorStore(s => s.transcriptStatus);
  const transcriptError = useEditorStore(s => s.transcriptError);
  const transcriptProgress = useEditorStore(s => s.transcriptProgress);
  const transcriptStartedAtRef = useRef<number | null>(null);
  const analysisOverviewFrames = useEditorStore(s => s.analysisOverviewFrames);
  const displayOverviewFrames = useEditorStore(s => s.displayOverviewFrames);
  const sourceOverviewFrames = useEditorStore(s => s.sourceOverviewFrames);
  const sourceIndexFreshBySourceId = useEditorStore(s => s.sourceIndexFreshBySourceId);
  const sourceIndexAnalysis = useEditorStore(s => s.sourceIndexAnalysis);
  const sourceIndexAnalysisBySourceId = useEditorStore(s => s.sourceIndexAnalysisBySourceId);
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
    resolveProjectSources({
      sources,
      runtimeBySourceId: sourceRuntimeById,
      primaryFallback: {
        videoData,
        videoFile,
        videoUrl,
        processingVideoUrl,
        videoDuration,
      },
    }).filter((entry) => entry.source && entry.duration > 0)
  ), [processingVideoUrl, sourceRuntimeById, sources, videoData, videoDuration, videoFile, videoUrl]);
  const useServerSourceIndex = Boolean(currentProjectId && sources.some((source) => !!source.storagePath));
  const initialIndexingReady = useMemo(
    () => getInitialIndexingReady(sources, sourceIndexAnalysisBySourceId, sourceIndexFreshBySourceId),
    [sourceIndexAnalysisBySourceId, sourceIndexFreshBySourceId, sources],
  );
  const overviewReadySourceIds = useMemo(() => new Set(
    (sourceOverviewFrames ?? []).map((frame) => normalizeKnownSourceId(frame.sourceId)),
  ), [sourceOverviewFrames]);
  const missingOverviewSources = useMemo(() => (
    availableSources.filter((entry) => (
      !sourceIndexFreshBySourceId[entry.sourceId]?.overview
      && !overviewReadySourceIds.has(entry.sourceId)
    ))
  ), [availableSources, overviewReadySourceIds, sourceIndexFreshBySourceId]);
  useEffect(() => {
    setFrameAnalysisError(null);
    requestChainStateRef.current = {};
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
    return { index: idx, duration: clips[idx].sourceDuration, id: clips[idx].id };
  })();
  const taggedClips = useMemo(() => (
    taggedClipIds
      .map((clipId) => clips.find((clip) => clip.id === clipId) ?? null)
      .filter((clip): clip is typeof clips[number] => clip !== null)
      .map((clip) => ({
        id: clip.id,
        index: clips.findIndex((entry) => entry.id === clip.id),
        duration: clip.sourceDuration,
      }))
      .filter((clip) => clip.index >= 0)
  ), [clips, taggedClipIds]);
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

  // Source overview indexing runs only when a source is missing canonical frame data.
  useEffect(() => {
    if (!initialIndexingReady || useServerSourceIndex) return;
    if (availableSources.length === 0) return;
    if (document.hidden || playbackActive || missingOverviewSources.length === 0) return;
    void (async () => {
      try {
        await ensureFramesExtracted();
      } catch {
        // Keep the editor usable even if background indexing fails.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableSources.length, initialIndexingReady, missingOverviewSources, playbackActive, useServerSourceIndex]);

  const ensureFramesExtracted = useCallback(async (force = false): Promise<IndexedVideoFrame[]> => {
    if (!initialIndexingReady) {
      return useEditorStore.getState().analysisOverviewFrames ?? [];
    }
    if (!force && extractionPromiseRef.current) return extractionPromiseRef.current;
    const promise = (async () => {
    const state = useEditorStore.getState();
    const sourcesToIndex = availableSources.filter(
      (entry) => force || !state.sourceIndexFreshBySourceId[entry.sourceId]?.overview
    );
    if (sourcesToIndex.length === 0) {
      return state.analysisOverviewFrames ?? [];
    }
    if (document.hidden || state.playbackActive) {
      return state.analysisOverviewFrames ?? [];
    }
    try {
      setFrameAnalysisError(null);
      const { overviewIntervalSeconds, maxOverviewFrames } = state.aiSettings.frameInspection;

      for (let sourceOffset = 0; sourceOffset < sourcesToIndex.length; sourceOffset += 1) {
        const entry = sourcesToIndex[sourceOffset];
        const frameCount = getAdaptiveCoarseFrameBudget(entry.duration, Math.max(0.1, overviewIntervalSeconds), maxOverviewFrames);
        const extractionStartedAt = performance.now();
        const extractionFallbackPerFrame = estimateFrameExtractionSeconds(frameCount) / Math.max(frameCount, 1);
        let lastProgressPaintAt = 0;
        setFrameIndexingProgress({
          stage: 'extracting_frames',
          completed: 0,
          total: Math.max(frameCount, 1),
          label: formatSourceScopedProgressLabel({
            sourceIndex: sourceOffset + 1,
            totalSources: sourcesToIndex.length,
            fileName: entry.fileName,
            actionLabel: 'Sampling frames',
            completed: 0,
            total: Math.max(frameCount, 1),
          }),
          etaSeconds: estimateFrameExtractionSeconds(frameCount),
        });

        const frames = await extractSourceOverviewFrames({
          sourceId: entry.sourceId,
          source: entry.source!,
          duration: entry.duration,
          overviewIntervalSeconds,
          maxOverviewFrames,
          onProgress: ({ stage, completed, total }) => {
            const now = performance.now();
            if (completed < total && now - lastProgressPaintAt < 120) return;
            lastProgressPaintAt = now;
            setFrameIndexingProgress({
              stage,
              completed,
              total: Math.max(total, 1),
              label: formatSourceScopedProgressLabel({
                sourceIndex: sourceOffset + 1,
                totalSources: sourcesToIndex.length,
                fileName: entry.fileName,
                actionLabel: stage === 'extracting_frames' ? 'Sampling frames' : 'Preparing visuals',
                completed,
                total,
              }),
              etaSeconds: estimateRemainingSecondsFromObservedRate(
                extractionStartedAt,
                completed,
                Math.max(total, 1),
                extractionFallbackPerFrame,
              ),
            });
          },
        });

        const describedFrames = await ensureFrameDescriptions(frames, true, {
          sourceIndex: sourceOffset + 1,
          totalSources: sourcesToIndex.length,
          fileName: entry.fileName,
        });
        setSourceOverviewFrames(entry.sourceId, describedFrames, {
          fresh: describedFrames.every((frame) => hasUsableFrameDescription(frame.description)),
        });
      }

      const refreshedState = useEditorStore.getState();
      setFrameIndexingProgress({
        stage: 'extracting_frames',
        completed: 1,
        total: 1,
        label: `Representative frames ready`,
        etaSeconds: 0,
      });
      return refreshedState.analysisOverviewFrames ?? [];
    } catch (error) {
      setFrameAnalysisError(getErrorMessage(error, 'Failed to analyze sampled video frames.'));
      setFrameIndexingProgress(null);
      return useEditorStore.getState().analysisOverviewFrames ?? [];
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
  }, [availableSources, initialIndexingReady, setSourceOverviewFrames]);

  const extractDenseFramesForRange = useCallback(async (
    frameRequest: { startTime: number; endTime: number; count?: number },
  ): Promise<IndexedVideoFrame[]> => {
    const requestedDuration = Math.max(0, frameRequest.endTime - frameRequest.startTime);
    const timelineTimestamps = buildDenseTimelineTimestamps(
      frameRequest.startTime,
      frameRequest.endTime,
      Math.max(
        frameRequest.count ?? useEditorStore.getState().aiSettings.frameInspection.defaultFrameCount,
        Math.ceil(requestedDuration / DEFAULT_DENSE_MAX_SPACING_SECONDS) + 1,
      ),
      DEFAULT_DENSE_MAX_SPACING_SECONDS,
    );
    if (timelineTimestamps.length === 0) return [];

    const extractionStartedAt = performance.now();
    setFrameIndexingProgress({
      stage: 'dense_refinement',
      completed: 0,
      total: timelineTimestamps.length,
      label: `Dense local refinement 0/${timelineTimestamps.length}`,
      etaSeconds: estimateFrameExtractionSeconds(timelineTimestamps.length),
    });

    const denseFrames = await extractTimelineFramesFromSources({
      clips: useEditorStore.getState().clips,
      availableSources,
      timelineTimestamps,
      kind: 'dense',
      onProgress: ({ completed, total }) => {
        setFrameIndexingProgress({
          stage: 'dense_refinement',
          completed,
          total,
          label: `Dense local refinement ${completed}/${total}`,
          etaSeconds: estimateRemainingSecondsFromObservedRate(
            extractionStartedAt,
            completed,
            total,
            estimateFrameExtractionSeconds(total) / Math.max(total, 1),
          ),
        });
      },
    });

    const describedDenseFrames = await describeIndexedFrames(denseFrames, ({ completed, total }) => {
      setFrameIndexingProgress({
        stage: 'dense_refinement',
        completed,
        total,
        label: `Dense local refinement ${completed}/${total}`,
        etaSeconds: estimateRemainingSecondsFromObservedRate(
          extractionStartedAt,
          completed,
          total,
          estimateFrameDescriptionSeconds(total) / Math.max(total, 1),
        ),
      });
    });

    setFrameIndexingProgress(null);
    return describedDenseFrames.map((frame) => ({
      ...frame,
      rangeStart: frameRequest.startTime,
      rangeEnd: frameRequest.endTime,
    }));
  }, [availableSources]);

  async function ensureFrameDescriptions(
    frames: SourceIndexedFrame[],
    force = false,
    sourceContext?: {
      sourceIndex: number;
      totalSources: number;
      fileName: string;
    },
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
        label: sourceContext
          ? formatSourceScopedProgressLabel({
              sourceIndex: sourceContext.sourceIndex,
              totalSources: sourceContext.totalSources,
              fileName: sourceContext.fileName,
              actionLabel: 'Analyzing visuals',
              completed: initialCompleted,
              total: totalOverviewFrames,
            })
          : formatFrameDescriptionProgressLabel({
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
            label: sourceContext
              ? formatSourceScopedProgressLabel({
                  sourceIndex: sourceContext.sourceIndex,
                  totalSources: sourceContext.totalSources,
                  fileName: sourceContext.fileName,
                  actionLabel: 'Analyzing visuals',
                  completed,
                  total: totalOverviewFrames,
                })
              : formatFrameDescriptionProgressLabel({
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
            label: sourceContext
              ? formatSourceScopedProgressLabel({
                  sourceIndex: sourceContext.sourceIndex,
                  totalSources: sourceContext.totalSources,
                  fileName: sourceContext.fileName,
                  actionLabel: 'Analyzing visuals',
                  completed,
                  total: totalOverviewFrames,
                })
              : formatFrameDescriptionProgressLabel({
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
            label: sourceContext
              ? formatSourceScopedProgressLabel({
                  sourceIndex: sourceContext.sourceIndex,
                  totalSources: sourceContext.totalSources,
                  fileName: sourceContext.fileName,
                  actionLabel: 'Analyzing visuals',
                  completed,
                  total: totalOverviewFrames,
                })
              : formatFrameDescriptionProgressLabel({
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
    if (analysisOverviewFrames === null) return false;
    return analysisOverviewFrames.every((frame) => hasUsableFrameDescription(frame.description));
  }, [analysisOverviewFrames]);

  const buildCurrentTranscript = useCallback(() => {
    const freshState = useEditorStore.getState();
    const rawCaptions = freshState.sourceTranscriptCaptions;
    if (rawCaptions && rawCaptions.length > 0) {
      return buildTranscriptContext(freshState.clips, rawCaptions);
    }
    return freshState.backgroundTranscript;
  }, []);

  const updateRequestChainState = useCallback((
    requestChainId: string,
    updater: (current: RequestChainState) => RequestChainState,
  ) => {
    const current = requestChainStateRef.current[requestChainId];
    if (!current) return null;
    const next = updater(current);
    requestChainStateRef.current[requestChainId] = next;
    return next;
  }, []);

  const recordCompletedChainAction = useCallback((requestChainId: string | undefined, action: EditAction) => {
    if (!requestChainId || action.type === 'none') return null;
    return updateRequestChainState(requestChainId, (current) => ({
      ...current,
      completedActions: [...current.completedActions, action],
      duplicateRerunCount: 0,
      remainingObjective: current.remainingObjective,
      duplicateActionBlacklist: [],
      transcript: {
        ...current.transcript,
        missing: !current.transcript.canonicalAvailable && !current.transcript.requestedDuringChain,
      },
    }));
  }, [updateRequestChainState]);

  const runSingleTurn = useCallback(async (
    history: ChatRequestMessage[],
    ctrl: AbortController,
    requestChainId?: string,
  ) => {
    if (!initialIndexingReady) return;
    const latestUserInput = [...history].reverse().find((entry) => entry.role === 'user')?.content ?? '';
    const baseFrames = useServerSourceIndex
      ? (useEditorStore.getState().analysisOverviewFrames ?? [])
      : await ensureFramesExtracted();
    let currentFrames = [...baseFrames];
    let nextHistory = [...history];
    let producedVisibleResponse = false;

    for (let round = 0; round < 3; round++) {
      if (!initialIndexingReady) break;
      if (stopRequestedRef.current) break;
      const freshState = useEditorStore.getState();
      const chainState = requestChainId ? requestChainStateRef.current[requestChainId] ?? null : null;
      const activeObjective = chainState?.remainingObjective?.trim()
        || chainState?.originalRequest?.trim()
        || latestUserInput;
      const currentClips = freshState.clips;
      const currentTranscript = buildCurrentTranscript();
      const silenceCandidates = buildSilenceCandidatePayload();
      const packedFrames = packFramesForChat(currentFrames, availableSources);
      const frameCoverage = summarizeFrameCoverage(currentFrames);
      const transcriptAvailability = chainState?.transcript ?? {
        canonicalAvailable: Boolean((freshState.sourceTranscriptCaptions ?? []).length),
        requestedDuringChain: false,
        missing: !(freshState.sourceTranscriptCaptions && freshState.sourceTranscriptCaptions.length > 0),
      };

      const { message = '', action, visualSearch } = await postChatRequest({
        messages: nextHistory,
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
          selectedClips: taggedClips.map((clip) => ({
            index: clip.index,
            duration: clip.duration,
          })),
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
          taggedClips: taggedClips.map((clip) => ({
            index: clip.index,
            duration: clip.duration,
          })),
          textOverlayCount: freshState.textOverlays.length,
          transcript: currentTranscript,
          transcriptAvailability,
          silenceCandidates,
          settings: freshState.aiSettings,
          appliedActions: freshState.appliedActions,
          frameCoverage,
          frames: buildFrameContextPayload([...packedFrames, ...currentFrames.filter((frame) => frame.kind === 'dense')], currentClips),
        },
      }, ctrl);

      if (action?.type === 'request_frames' && action.frameRequest && round < 2) {
        if (!initialIndexingReady) break;
        setLoadingStatus('Dense local refinement…');
        setLoadingPhaseId('continuing_remaining_step');
        const denseFrames = await extractDenseFramesForRange(action.frameRequest);
        currentFrames = [...baseFrames, ...denseFrames];
        nextHistory = [
          ...nextHistory,
          {
            role: 'assistant',
            content: action.message,
            requestChainId,
            action,
            actionType: action.type,
            actionMessage: action.message,
            actionStatus: 'completed',
            actionResult: 'Dense local frame refinement ready.',
          },
          {
            role: 'user',
            content: `[${denseFrames.length} dense frames extracted from ${formatTime(action.frameRequest.startTime)} to ${formatTime(action.frameRequest.endTime)}, now answer with these frames.]`,
            requestChainId,
          },
        ];
        continue;
      }

      setVisualSearchSession(visualSearch ?? null);
      const markerAction = isMarkerMutationAction(action);
      if (!markerAction) {
        upsertMarkersFromVisualSearch(latestUserInput, visualSearch, addMarker);
      }
      const assistantMessage = message.trim() || getAssistantFallbackMessage(action);
      const duplicateAction = Boolean(
        requestChainId
        && action
        && action.type !== 'none'
        && chainState?.completedActions.some((completedAction) => actionsMatch(completedAction, action)),
      );
      const blacklistedAction = Boolean(
        requestChainId
        && action
        && action.type !== 'none'
        && chainState?.duplicateActionBlacklist.includes(action.type),
      );
      if ((duplicateAction || blacklistedAction) && requestChainId && chainState && chainState.duplicateRerunCount < 1) {
        const rerunState = updateRequestChainState(requestChainId, (current) => ({
          ...current,
          duplicateActionBlacklist: action && action.type !== 'none'
            ? [action.type]
            : current.duplicateActionBlacklist,
          duplicateRerunCount: current.duplicateRerunCount + 1,
        }));
        if (rerunState) {
          nextHistory = buildChatRequestHistory(
            useEditorStore.getState().messages,
            useEditorStore.getState().appliedActions,
            buildContinuationPayload(
              rerunState,
              'duplicate_action_retry',
              'Step already complete; continue remaining work only.',
            ),
            requestChainId,
          );
          continue;
        }
      }

      if (
        requestChainId
        && chainState
        && round < 2
        && chainState.completedActions.length === 0
        && chainState.duplicateRerunCount < 1
        && shouldPrioritizeMarkerStepFirst(activeObjective, action)
      ) {
        const rerunState = updateRequestChainState(requestChainId, (current) => ({
          ...current,
          duplicateActionBlacklist: action && action.type !== 'none'
            ? [...new Set([...current.duplicateActionBlacklist, action.type])]
            : current.duplicateActionBlacklist,
          duplicateRerunCount: current.duplicateRerunCount + 1,
        }));
        if (rerunState) {
          nextHistory = buildChatRequestHistory(
            useEditorStore.getState().messages,
            useEditorStore.getState().appliedActions,
            buildContinuationPayload(
              rerunState,
              'duplicate_action_retry',
              'The original request includes a marker step plus another edit. If you already have enough evidence for the marker, emit the best add_marker/add_markers action first, then continue the remaining edit in the chain.',
            ),
            requestChainId,
          );
          continue;
        }
      }

      if (
        requestChainId
        && chainState
        && round < 2
        && chainState.duplicateRerunCount < 1
        && messageRequestsMarkerPlacement(activeObjective)
        && (!action || action.type === 'none')
        && (Boolean(currentTranscript?.trim()) || currentFrames.length > 0)
      ) {
        const rerunState = updateRequestChainState(requestChainId, (current) => ({
          ...current,
          duplicateRerunCount: current.duplicateRerunCount + 1,
        }));
        if (rerunState) {
          nextHistory = buildChatRequestHistory(
            useEditorStore.getState().messages,
            useEditorStore.getState().appliedActions,
            buildContinuationPayload(
              rerunState,
              'duplicate_action_retry',
              'The user asked for marker placement. Use the available transcript and frame evidence to emit a best-effort add_marker/add_markers action now. Do not answer with type:none unless there is truly no plausible target.',
            ),
            requestChainId,
          );
          continue;
        }
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
        recordAppliedAction(action, action.message, { requestChainId });
        recordCompletedChainAction(requestChainId, action);
        const markerSeekTime = getMarkerActionSeekTime(action, freshState.markers);
        if (markerSeekTime !== null) requestSeek(markerSeekTime);
      }

      if (requestChainId && action?.type === 'transcribe_request') {
        updateRequestChainState(requestChainId, (current) => ({
          ...current,
          transcript: {
            ...current.transcript,
            requestedDuringChain: true,
            missing: true,
          },
        }));
      }

      addMessage({
        role: 'assistant',
        content: assistantMessage,
        requestChainId,
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
      if (requestChainId && markerAction && action && !markerActionPreviouslyApplied && round < 2) {
        const nextChainState = requestChainStateRef.current[requestChainId] ?? null;
        if (nextChainState) {
          setLoadingStatus('Continuing with remaining steps…');
          setLoadingPhaseId('continuing_remaining_step');
          nextHistory = buildChatRequestHistory(
            useEditorStore.getState().messages,
            useEditorStore.getState().appliedActions,
            buildContinuationPayload(
              nextChainState,
              'action_resolved',
              'The previous action is already applied. Decide what distinct work, if any, still remains from the original request. Do not repeat that same edit.',
            ),
            requestChainId,
          );
          continue;
        }
      }
      return;
    }

    if (!producedVisibleResponse) {
      addMessage({
        role: 'assistant',
        content: 'I inspected that section but did not finish with a concrete edit. The frame search was too broad and needs a narrower visual target.',
        requestChainId,
      });
    }
  }, [addMarker, addMessage, applyStoredAction, availableSources, buildCurrentTranscript, ensureFramesExtracted, extractDenseFramesForRange, initialIndexingReady, recordAppliedAction, recordCompletedChainAction, requestSeek, selectedClipContext, selectedMarkerContext, setVisualSearchSession, taggedClips, taggedMarkers, updateRequestChainState, useServerSourceIndex]);

  const handleSendSingle = useCallback(async () => {
    const text = input.trim();
    if (!text || isChatLoading || reviewLocked || !initialIndexingReady) return;
    const requestChainId = crypto.randomUUID();
    requestChainStateRef.current[requestChainId] = {
      requestChainId,
      originalRequest: text,
      remainingObjective: null,
      completedActions: [],
      duplicateActionBlacklist: [],
      transcript: {
        canonicalAvailable: Boolean((useEditorStore.getState().sourceTranscriptCaptions ?? []).length),
        requestedDuringChain: false,
        missing: !(useEditorStore.getState().sourceTranscriptCaptions?.length),
      },
      duplicateRerunCount: 0,
    };

    setInput('');
    previousTaggedMarkerIdsRef.current = [];
    clearTaggedMarkers();
    clearTaggedClips();
    setActiveMarkerMention(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    addMessage({ role: 'user', content: text, requestChainId });
    setIsChatLoading(true);
    setLoadingStatus('');
    setLoadingPhaseId(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    stopRequestedRef.current = false;

    try {
      const history = buildChatRequestHistory(messages, useEditorStore.getState().appliedActions, text, requestChainId);
      await runSingleTurn(history, ctrl, requestChainId);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        addMessage({
          role: 'assistant',
          content: `Network error: ${err instanceof Error ? err.message : 'Unknown'}`,
          requestChainId,
        });
      }
    } finally {
      setIsChatLoading(false);
      setLoadingStatus('');
      setLoadingPhaseId(null);
    }
  }, [addMessage, clearTaggedClips, clearTaggedMarkers, initialIndexingReady, input, isChatLoading, messages, reviewLocked, runSingleTurn, setIsChatLoading]);

  const handleTranscriptReady = useCallback(async (messageId: string) => {
    if (!initialIndexingReady) return;
    const storeState = useEditorStore.getState();
    if (storeState.isChatLoading || storeState.previewOwnerId !== null) return;
    const currentMessages = useEditorStore.getState().messages;
    const assistantMessage = currentMessages.find((message) => message.id === messageId && message.role === 'assistant');
    const requestChainId = assistantMessage?.requestChainId;
    if (!requestChainId) return;
    const chainState = requestChainStateRef.current[requestChainId];
    if (!chainState || chainState.transcript.canonicalAvailable || !chainState.transcript.requestedDuringChain) {
      return;
    }
    const nextChainState = updateRequestChainState(requestChainId, (current) => ({
      ...current,
      transcript: {
        ...current.transcript,
        missing: false,
      },
      duplicateRerunCount: 0,
    }));
    if (!nextChainState) return;

    setIsChatLoading(true);
    setLoadingStatus('Continuing with transcript…');
    setLoadingPhaseId('continuing_remaining_step');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    stopRequestedRef.current = false;

    try {
      const history = buildChatRequestHistory(
        currentMessages,
        useEditorStore.getState().appliedActions,
        buildContinuationPayload(
          nextChainState,
          'transcript_ready',
          'The transcript is now ready. Continue the original request, using the completed-action history to skip anything already done.',
        ),
        requestChainId,
      );
      await runSingleTurn(history, ctrl, requestChainId);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        addMessage({ role: 'assistant', content: `Network error: ${err instanceof Error ? err.message : 'Unknown'}` });
      }
    } finally {
      setIsChatLoading(false);
      setLoadingStatus('');
      setLoadingPhaseId(null);
    }
  }, [addMessage, initialIndexingReady, runSingleTurn, setIsChatLoading, updateRequestChainState]);

  const handleActionResolved = useCallback(async (
    messageId: string,
    action: EditAction,
  ) => {
    if (action.type === 'transcribe_request' || !initialIndexingReady) return;

    const currentMessages = useEditorStore.getState().messages;
    const assistantMessage = currentMessages.find((message) => message.id === messageId && message.role === 'assistant');
    const requestChainId = assistantMessage?.requestChainId;
    if (!requestChainId) return;
    const nextChainState = recordCompletedChainAction(requestChainId, action);
    if (!nextChainState) return;

    const storeState = useEditorStore.getState();
    if (storeState.isChatLoading || storeState.previewOwnerId !== null) return;

    setIsChatLoading(true);
    setLoadingStatus('Continuing with remaining steps…');
    setLoadingPhaseId('continuing_remaining_step');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    stopRequestedRef.current = false;

    try {
      const history = buildChatRequestHistory(
        currentMessages,
        useEditorStore.getState().appliedActions,
        buildContinuationPayload(
          nextChainState,
          'action_resolved',
          'The previous action is already applied. Decide what distinct work, if any, still remains from the original request. If the request is complete, finish without proposing another edit.',
        ),
        requestChainId,
      );
      await runSingleTurn(history, ctrl, requestChainId);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        addMessage({ role: 'assistant', content: `Network error: ${err instanceof Error ? err.message : 'Unknown'}` });
      }
    } finally {
      setIsChatLoading(false);
      setLoadingStatus('');
      setLoadingPhaseId(null);
    }
  }, [addMessage, initialIndexingReady, recordCompletedChainAction, runSingleTurn, setIsChatLoading]);

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
    setLoadingPhaseId(null);
  }, [setIsChatLoading]);

  const handleClearChat = useCallback(() => {
    if (isChatLoading || reviewLocked || messages.length === 0) return;
    requestChainStateRef.current = {};
    clearChatHistory();
    setInput('');
    setActiveMarkerMention(null);
    setHighlightedMarkerIndex(0);
    previousTaggedMarkerIdsRef.current = [];
    clearTaggedMarkers();
    clearTaggedClips();
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [clearChatHistory, clearTaggedClips, clearTaggedMarkers, isChatLoading, messages.length, reviewLocked]);

  const hasVideoSource = availableSources.length > 0;
  const overviewFramesForUi = displayOverviewFrames ?? analysisOverviewFrames;
  const usingServerSourceIndex = useServerSourceIndex;
  const coarseFramesAvailable = (overviewFramesForUi ?? []).some((frame) => hasUsableFrameDescription(frame.description));
  const frameAnalysisReady = analysisOverviewFrames !== null && frameDescriptionsReady;
  const framesReady = usingServerSourceIndex
    ? frameAnalysisError !== null || frameAnalysisReady || coarseFramesAvailable
    : frameAnalysisError !== null || frameAnalysisReady;
  const transcriptFailed = transcriptStatus === 'error';
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
  const transcriptUnavailableNotice = hasVideoSource && framesReady && transcriptFailed
    ? formatTranscriptFailureNotice(transcriptError)
    : null;
  const frameAnalysisErrorNotice = hasVideoSource && frameAnalysisError
    ? `${frameAnalysisError} The assistant will continue without visual frame summaries until analysis succeeds.`
    : hasVideoSource && sourceIndexAnalysis?.status === 'failed' && sourceIndexAnalysis.error
      ? `${sourceIndexAnalysis.error} Retry the failed source analysis to finish initial indexing.`
      : null;
  const isAnalyzingSampledFrames = hasVideoSource
    && (transcriptStatus === 'done' || transcriptFailed)
    && analysisOverviewFrames !== null
    && frameAnalysisError === null
    && !frameDescriptionsReady;
  const mediaPreparationBlockingSend = hasVideoSource && !initialIndexingReady;
  const secondaryIndexingProgress: IndexingProgress | null = (!usingServerSourceIndex && transcriptStatus === 'loading' && !framesReady && frameIndexingProgress)
    ? frameIndexingProgress
    : null;
  const indexingDetail = (!usingServerSourceIndex && !framesReady && !secondaryIndexingProgress)
    ? 'Coarse indexing can take a while on longer videos.'
    : null;
  const analysisStatusCards: AnalysisStatusCard[] = [];
  if (hasVideoSource) {
    if (usingServerSourceIndex) {
      analysisStatusCards.push(...buildServerAnalysisStatusCards({
        sources: availableSources,
        analysisBySourceId: sourceIndexAnalysisBySourceId,
        freshnessBySourceId: sourceIndexFreshBySourceId,
      }));
    } else if (transcriptStatus === 'loading') {
      analysisStatusCards.push({
        key: 'audio-analysis',
        title: 'Audio analysis',
        progress: {
          stage: 'transcribing',
          completed: transcriptProgress?.completed ?? 0,
          total: transcriptProgress?.total ?? 1,
          label: transcriptProgress && transcriptProgress.total > 0
            ? `Transcribing audio ${Math.min(transcriptProgress.completed, transcriptProgress.total)}/${transcriptProgress.total}`
            : 'Transcribing audio',
          etaSeconds: estimatedTranscriptRemainingEta,
        },
        secondaryLabel: 'Transcribing audio…',
      });
    } else if (!usingServerSourceIndex && transcriptStatus === 'done') {
      analysisStatusCards.push({
        key: 'audio-analysis',
        title: 'Audio analysis',
        progress: buildCompletedProgress('transcribing'),
        tone: 'completed',
      });
    }

    if (frameIndexingProgress && frameIndexingProgress.stage === 'dense_refinement' && frameAnalysisError === null) {
      analysisStatusCards.push({
        key: 'dense-refinement',
        title: 'Visual analysis',
        progress: frameIndexingProgress,
        secondaryLabel: 'Local follow-up only inside the narrowed range.',
      });
    } else if (!usingServerSourceIndex && frameIndexingProgress && !frameAnalysisReady && frameAnalysisError === null) {
      analysisStatusCards.push({
        key: 'frame-analysis',
        title: 'Visual analysis',
        progress: frameIndexingProgress,
        detail: indexingDetail,
        secondaryLabel: getIndexingStageTitle(frameIndexingProgress, null),
      });
    } else if (!usingServerSourceIndex && frameAnalysisReady) {
      analysisStatusCards.push({
        key: 'frame-analysis',
        title: 'Visual analysis',
        progress: buildCompletedProgress('describing_frames'),
        tone: 'completed',
      });
    }
  }
  const composerInputDisabled = isChatLoading || reviewLocked;
  const composerMuted = composerInputDisabled || mediaPreparationBlockingSend;
  const canSubmitMessage = input.trim().length > 0 && !composerInputDisabled && !mediaPreparationBlockingSend;
  const activeLoadingPhaseId = loadingPhaseId ?? (mediaPreparationBlockingSend ? 'initial_indexing_required' : null);

  const resizeComposer = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      const nextHeight = Math.min(ta.scrollHeight, 96);
      ta.style.height = `${Math.max(nextHeight, 22)}px`;
      ta.style.overflowY = ta.scrollHeight > 96 ? 'auto' : 'hidden';
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

  const untagClip = useCallback((clipId: string) => {
    const nextTaggedIds = taggedClipIds.filter((id) => id !== clipId);
    setTaggedClipIds(nextTaggedIds);
    if (selectedItem?.type === 'clip' && selectedItem.id === clipId) {
      setSelectedItem(null);
    }
    focusComposer();
  }, [focusComposer, selectedItem, setSelectedItem, setTaggedClipIds, taggedClipIds]);

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
    }} data-loading-phase={activeLoadingPhaseId ?? undefined}>
      {/* Header */}
      <div style={{
        minHeight: 52,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 14px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <AutoAvatar size={30} />
          <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-primary)', fontFamily: 'var(--font-serif)' }}>
              Auto
            </span>
          </div>
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
            flexShrink: 0,
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

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 12px' }}>
        {(analysisStatusCards.length > 0 || transcriptUnavailableNotice || frameAnalysisErrorNotice) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: messages.length === 0 ? 18 : 12 }}>
            {analysisStatusCards.map((card) => (
              <ProgressStatusCard
                key={card.key}
                title={card.title}
                progress={card.progress}
                detail={card.detail}
                secondaryLabel={card.secondaryLabel}
                tone={card.tone}
              />
            ))}
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
          </div>
        )}
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {messages.map(msg => msg.role === 'user'
              ? <UserMessage key={msg.id} msg={msg} />
              : <AssistantMessage key={msg.id} msg={msg} onTranscriptReady={handleTranscriptReady} onActionResolved={handleActionResolved} />
            )}
            {isChatLoading && <ThinkingIndicator status={loadingStatus || undefined} />}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        flexShrink: 0,
        padding: '7px 10px 9px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-panel)',
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6,
          background: 'var(--bg-elevated)',
          border: `1px solid ${composerMuted ? 'rgba(255,255,255,0.06)' : 'var(--border-mid)'}`,
          borderRadius: 8,
          padding: '7px 11px 8px',
          minHeight: 56,
          transition: 'border-color 0.2s ease, opacity 0.2s ease',
          opacity: composerMuted ? 0.82 : 1,
        }}>
          {taggedClips.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              {taggedClips.map((clip) => (
                <button
                  key={clip.id}
                  onClick={() => untagClip(clip.id)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '2px 7px',
                    background: 'rgba(56,189,248,0.12)',
                    border: '1px solid rgba(56,189,248,0.28)',
                    borderRadius: 999,
                    fontSize: 11,
                    color: '#7dd3fc',
                    fontFamily: 'var(--font-serif)',
                    cursor: 'pointer',
                  }}
                  title="Remove this clip tag from the message"
                >
                  <span>{getClipPrimaryLabel(clip.index)}</span>
                  <span style={{ color: 'rgba(125,211,252,0.72)' }}>{formatChatTime(clip.duration)}</span>
                  <span style={{ color: 'rgba(125,211,252,0.72)' }}>×</span>
                </button>
              ))}
            </div>
          )}
          {!taggedClips.length && selectedClipContext && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '2px 7px',
                background: 'rgba(56,189,248,0.08)',
                border: '1px solid rgba(56,189,248,0.22)',
                borderRadius: 999,
                fontSize: 11,
                color: '#7dd3fc',
                fontFamily: 'var(--font-serif)',
              }}>
                {getClipPrimaryLabel(selectedClipContext.index)}
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
                  <span>{getMarkerPrimaryLabel(marker)}</span>
                  <span>{getMarkerSecondaryLabel(marker)}</span>
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
                    <span>{getMarkerPrimaryLabel(marker)}</span>
                    <span style={{ flex: 1, color: 'var(--fg-primary)' }}>
                      {getMarkerSecondaryLabel(marker)}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 34 }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onClick={(event) => syncActiveMarkerMention(event.currentTarget.value, event.currentTarget.selectionStart)}
              onKeyUp={(event) => syncActiveMarkerMention(event.currentTarget.value, event.currentTarget.selectionStart)}
              placeholder={
                reviewLocked
                  ? 'Finish the active review…'
                  : isChatLoading
                    ? 'Autocut is working…'
                    : isAnalyzingSampledFrames
                      ? 'Visuals are loading. You can type…'
                    : mediaPreparationBlockingSend
                      ? 'Media is loading. You can type…'
                    : 'Ask about the video or review cuts…'
              }
              rows={1}
              disabled={composerInputDisabled}
              style={{
                resize: 'none',
                overflowY: 'hidden',
                background: 'transparent',
                border: 'none',
                color: composerInputDisabled ? 'var(--fg-muted)' : 'var(--fg-primary)',
                fontSize: 13,
                lineHeight: 1.45,
                minHeight: 24,
                maxHeight: 96,
                width: '100%',
                fontFamily: 'var(--font-serif)',
                flex: 1,
                padding: '1px 0 0',
              }}
            />
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
