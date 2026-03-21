import type { ProjectSource } from './types';
import { MAIN_SOURCE_ID } from './sourceUtils';

export type SourceMedia = Uint8Array | File | string;

export interface SourceRuntimeMedia {
  file: File | null;
  objectUrl: string;
  playerUrl: string;
  processingUrl: string;
}

export type SourceRuntimeMediaMap = Record<string, SourceRuntimeMedia | undefined>;

export interface ResolvedProjectSourceMedia {
  sourceId: string;
  source: SourceMedia | null;
  duration: number;
  fileName: string;
  storagePath: string | null;
  assetId: string | null;
  status: ProjectSource['status'];
  isPrimary: boolean;
  playerUrl: string;
  processingUrl: string;
}

type LegacyPrimarySourceInput = {
  videoData: Uint8Array | null;
  videoFile: File | null;
  videoUrl: string;
  processingVideoUrl?: string;
  videoDuration: number;
  videoName?: string;
  storagePath?: string | null;
};

type ResolveProjectSourcesInput = {
  sources: ProjectSource[];
  runtimeBySourceId?: SourceRuntimeMediaMap;
  primaryFallback?: LegacyPrimarySourceInput;
};

function pickRuntimeSource(runtime?: SourceRuntimeMedia, fallback?: LegacyPrimarySourceInput): SourceMedia | null {
  return runtime?.file
    ?? runtime?.processingUrl
    ?? runtime?.objectUrl
    ?? runtime?.playerUrl
    ?? fallback?.videoData
    ?? fallback?.videoFile
    ?? fallback?.processingVideoUrl
    ?? fallback?.videoUrl
    ?? null;
}

function buildResolvedEntry(
  source: ProjectSource,
  runtime: SourceRuntimeMedia | undefined,
  fallback?: LegacyPrimarySourceInput,
): ResolvedProjectSourceMedia {
  const playerUrl = runtime?.playerUrl ?? fallback?.videoUrl ?? '';
  const processingUrl = runtime?.processingUrl ?? fallback?.processingVideoUrl ?? fallback?.videoUrl ?? '';
  const duration = source.duration > 0 ? source.duration : Math.max(0, fallback?.videoDuration ?? 0);

  return {
    sourceId: source.id,
    source: pickRuntimeSource(runtime, fallback),
    duration,
    fileName: source.fileName || fallback?.videoName || 'Source video',
    storagePath: source.storagePath,
    assetId: source.assetId,
    status: source.status,
    isPrimary: source.isPrimary,
    playerUrl,
    processingUrl,
  };
}

function buildFallbackPrimarySource(
  fallback: LegacyPrimarySourceInput,
  runtime?: SourceRuntimeMedia,
): ResolvedProjectSourceMedia | null {
  const source = pickRuntimeSource(runtime, fallback);
  const duration = Math.max(0, fallback.videoDuration);
  if (!source || duration <= 0) return null;

  return {
    sourceId: MAIN_SOURCE_ID,
    source,
    duration,
    fileName: fallback.videoName || fallback.videoFile?.name || 'Main video',
    storagePath: fallback.storagePath ?? null,
    assetId: null,
    status: fallback.storagePath ? 'pending' : 'ready',
    isPrimary: true,
    playerUrl: runtime?.playerUrl ?? fallback.videoUrl ?? '',
    processingUrl: runtime?.processingUrl ?? fallback.processingVideoUrl ?? fallback.videoUrl ?? '',
  };
}

export function resolveProjectSources(input: ResolveProjectSourcesInput): ResolvedProjectSourceMedia[] {
  const sources = input.sources.map((source) => {
    const fallback = source.id === MAIN_SOURCE_ID ? input.primaryFallback : undefined;
    return buildResolvedEntry(source, input.runtimeBySourceId?.[source.id], fallback);
  });

  if (sources.length > 0) {
    return sources.filter((entry) => entry.source && entry.duration > 0);
  }

  if (!input.primaryFallback) return [];
  const fallbackPrimary = buildFallbackPrimarySource(
    input.primaryFallback,
    input.runtimeBySourceId?.[MAIN_SOURCE_ID],
  );
  return fallbackPrimary ? [fallbackPrimary] : [];
}

export function resolveProjectSourceById(
  input: ResolveProjectSourcesInput,
  sourceId: string,
): ResolvedProjectSourceMedia | null {
  return resolveProjectSources(input).find((entry) => entry.sourceId === sourceId) ?? null;
}

export function resolvePrimaryProjectSource(
  input: ResolveProjectSourcesInput,
): ResolvedProjectSourceMedia | null {
  return resolveProjectSourceById(input, MAIN_SOURCE_ID)
    ?? resolveProjectSources(input).find((entry) => entry.isPrimary)
    ?? null;
}
