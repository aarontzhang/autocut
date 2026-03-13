import { v4 as uuidv4 } from 'uuid';
import type { CaptionEntry, SourceRangeRef, VideoClip } from './types';

export const MAIN_SOURCE_ID = 'main-source';

export function createImportedSourceId(): string {
  return `source-${uuidv4()}`;
}

export function normalizeSourceId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function getClipSourceId(clip: Pick<VideoClip, 'sourceId' | 'sourcePath'>): string {
  return normalizeSourceId(clip.sourceId)
    ?? normalizeSourceId(clip.sourcePath)
    ?? MAIN_SOURCE_ID;
}

export function getCaptionSourceId(caption: Pick<CaptionEntry, 'sourceId'>): string {
  return normalizeSourceId(caption.sourceId) ?? MAIN_SOURCE_ID;
}

export function getSourceRangeId(range: Pick<SourceRangeRef, 'sourceId' | 'assetId'>): string | null {
  return normalizeSourceId(range.sourceId) ?? normalizeSourceId(range.assetId);
}
