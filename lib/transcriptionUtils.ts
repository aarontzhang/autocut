'use client';

import { extractAudioSegment } from './ffmpegClient';
import { CaptionEntry } from './types';

type TimeRange = { startTime: number; endTime: number };

export function buildOverlappingRanges(
  startTime: number,
  endTime: number,
  chunkDuration = 45,
  overlapSeconds = 0.75,
): TimeRange[] {
  const ranges: TimeRange[] = [];
  const safeStart = Math.max(0, startTime);
  const safeEnd = Math.max(safeStart, endTime);
  if (safeEnd <= safeStart) return ranges;

  const step = Math.max(1, chunkDuration - overlapSeconds);
  for (let cursor = safeStart; cursor < safeEnd; cursor += step) {
    const rangeEnd = Math.min(safeEnd, cursor + chunkDuration);
    ranges.push({ startTime: cursor, endTime: rangeEnd });
    if (rangeEnd >= safeEnd) break;
  }
  return ranges;
}

export function dedupeCaptionEntries(entries: CaptionEntry[], toleranceSeconds = 0.08): CaptionEntry[] {
  const sorted = [...entries].sort((a, b) => (
    a.startTime - b.startTime ||
    a.endTime - b.endTime ||
    a.text.localeCompare(b.text)
  ));

  const deduped: CaptionEntry[] = [];
  for (const entry of sorted) {
    const text = entry.text.trim();
    if (!text) continue;
    const normalized: CaptionEntry = {
      ...entry,
      text,
      startTime: Math.max(0, entry.startTime),
      endTime: Math.max(entry.startTime, entry.endTime),
    };
    const last = deduped[deduped.length - 1];
    if (
      last &&
      last.text === normalized.text &&
      Math.abs(last.startTime - normalized.startTime) <= toleranceSeconds &&
      Math.abs(last.endTime - normalized.endTime) <= toleranceSeconds
    ) {
      last.startTime = Math.min(last.startTime, normalized.startTime);
      last.endTime = Math.max(last.endTime, normalized.endTime);
      continue;
    }
    deduped.push(normalized);
  }

  return deduped;
}

export async function transcribeSourceRanges(
  source: Uint8Array | File | string,
  ranges: TimeRange[],
  wordsPerCaption: number,
): Promise<CaptionEntry[]> {
  const rawEntries: CaptionEntry[] = [];

  for (const range of ranges) {
    const audioBlob = await extractAudioSegment(source, range.startTime, range.endTime);
    const form = new FormData();
    form.append('audio', audioBlob, 'audio.mp3');
    form.append('startTime', String(range.startTime));
    form.append('wordsPerCaption', String(wordsPerCaption));

    const res = await fetch('/api/transcribe', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Transcription failed');
    rawEntries.push(...((data.words as CaptionEntry[]) ?? (data.captions as CaptionEntry[]) ?? []));
  }

  return dedupeCaptionEntries(rawEntries);
}
