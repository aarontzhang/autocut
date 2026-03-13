import { MAIN_SOURCE_ID, getClipSourceId } from './sourceUtils';
import type { VideoClip } from './types';
import type { MediaLibraryItem } from './useEditorStore';

export type SourceMedia = Uint8Array | File | string;

export type ResolvedMainSource = {
  sourceId: string;
  source: SourceMedia | null;
  duration: number;
};

type ResolveMainSourcesInput = {
  clips: VideoClip[];
  mediaLibrary: MediaLibraryItem[];
  videoData: Uint8Array | null;
  videoFile: File | null;
  videoUrl: string;
  videoDuration: number;
};

export function resolveMainTrackSources(input: ResolveMainSourcesInput): ResolvedMainSource[] {
  const grouped = new Map<string, { source: SourceMedia | null; duration: number }>();

  for (const clip of input.clips) {
    const sourceId = getClipSourceId(clip);
    const current = grouped.get(sourceId);
    const clipEnd = clip.sourceStart + clip.sourceDuration;
    const existingDuration = current?.duration ?? 0;

    let source = current?.source ?? null;
    if (!source) {
      if (sourceId === MAIN_SOURCE_ID) {
        source = input.videoData ?? input.videoFile ?? input.videoUrl ?? null;
      } else {
        const libraryMatch = input.mediaLibrary.find((item) => item.sourceId === sourceId);
        source = clip.sourceUrl ?? libraryMatch?.url ?? null;
      }
    }

    grouped.set(sourceId, {
      source,
      duration: Math.max(existingDuration, clipEnd, sourceId === MAIN_SOURCE_ID ? input.videoDuration : 0),
    });
  }

  if (grouped.size === 0 && (input.videoData || input.videoFile || input.videoUrl) && input.videoDuration > 0) {
    grouped.set(MAIN_SOURCE_ID, {
      source: input.videoData ?? input.videoFile ?? input.videoUrl,
      duration: input.videoDuration,
    });
  }

  return [...grouped.entries()].map(([sourceId, value]) => ({
    sourceId,
    source: value.source,
    duration: value.duration,
  }));
}

export function resolveMainTrackSource(
  input: ResolveMainSourcesInput,
  sourceId: string,
): ResolvedMainSource | null {
  return resolveMainTrackSources(input).find((entry) => entry.sourceId === sourceId) ?? null;
}
