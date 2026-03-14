import { MAIN_SOURCE_ID } from './sourceUtils';

export type SourceMedia = Uint8Array | File | string;

export type ResolvedMainSource = {
  sourceId: string;
  source: SourceMedia | null;
  duration: number;
};

type ResolveMainSourceInput = {
  videoData: Uint8Array | null;
  videoFile: File | null;
  videoUrl: string;
  videoDuration: number;
};

export function resolveMainTrackSources(input: ResolveMainSourceInput): ResolvedMainSource[] {
  const source = input.videoData ?? input.videoFile ?? input.videoUrl ?? null;
  if (!source || input.videoDuration <= 0) return [];
  return [{
    sourceId: MAIN_SOURCE_ID,
    source,
    duration: input.videoDuration,
  }];
}

export function resolveMainTrackSource(input: ResolveMainSourceInput): ResolvedMainSource | null {
  return resolveMainTrackSources(input)[0] ?? null;
}
