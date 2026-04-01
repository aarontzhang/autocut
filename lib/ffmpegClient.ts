'use client';

import { FFmpeg } from '@ffmpeg/ffmpeg';

import { buildCaptionRenderWindows, invertSegments } from './timelineUtils';
import { normalizeTransitionEntries, resolveTransitions } from './playbackEngine';
import { CaptionEntry, TextOverlayEntry, Track, TransitionEntry, TransitionType, VideoClip } from './types';
import { MAIN_SOURCE_ID } from './sourceUtils';
import { getTextOverlayExportY, getTextOverlayFontSize, normalizeTextOverlayEntry } from './textOverlays';

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<void> | null = null;
let progressHandler: ((progress: number) => void) | null = null;
let activeJobCancel: (() => void) | null = null;
const remoteMediaInputCache = new Map<string, Promise<Uint8Array>>();
const fileDataCache = new WeakMap<File, Promise<Uint8Array>>();
const audioTrackCache = new Map<string, Promise<Uint8Array>>();
let lastWrittenInputKey: string | null = null;
let captionFontDataPromise: Promise<Uint8Array> | null = null;
let recentFFmpegLogs: string[] = [];
const FFMPEG_ASSET_VERSION = '20260319-esm-core';
const CAPTION_FONT_PATH = '/fonts/NotoSans-Regular.ttf';
const CAPTION_FONT_FILE_NAME = 'caption_font.ttf';

function normalizeUnknownError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.trim()) return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(fallback);
  }
}

function getSourceKey(fileOrUrl: Uint8Array | File | string): string | null {
  if (typeof fileOrUrl === 'string') return `url:${fileOrUrl}`;
  if (fileOrUrl instanceof File) return `file:${fileOrUrl.name}:${fileOrUrl.size}:${fileOrUrl.lastModified}`;
  return null;
}

function createAbortError() {
  return new DOMException('Export canceled.', 'AbortError');
}

function cloneWritableBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function isSameOriginUrl(value: string): boolean {
  try {
    return new URL(value, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function resetFFmpeg() {
  ffmpegInstance = null;
  loadPromise = null;
  progressHandler = null;
  lastWrittenInputKey = null;
  recentFFmpegLogs = [];
  audioTrackCache.clear();
}

async function getFFmpeg(onProgress?: (progress: number) => void): Promise<FFmpeg> {
  progressHandler = onProgress ?? null;

  if (ffmpegInstance && loadPromise) {
    await loadPromise;
    return ffmpegInstance;
  }

  ffmpegInstance = new FFmpeg();

  ffmpegInstance.on('progress', ({ progress }) => {
    progressHandler?.(Math.min(100, Math.max(0, Math.round(progress * 100))));
  });
  ffmpegInstance.on('log', ({ message }) => {
    const nextMessage = message.trim();
    if (!nextMessage) return;
    recentFFmpegLogs = [...recentFFmpegLogs.slice(-11), nextMessage];
  });

  loadPromise = (async () => {
    const base = window.location.origin + '/ffmpeg';
    const assetSuffix = `?v=${FFMPEG_ASSET_VERSION}`;
    // classWorkerURL bypasses Turbopack's static-analysis restriction.
    // All files served from same origin — no CORS/COEP issues, no toBlobURL needed.
    try {
      await ffmpegInstance!.load({
        classWorkerURL: `${base}/worker.js${assetSuffix}`,
        coreURL: `${base}/ffmpeg-core.js${assetSuffix}`,
        wasmURL: `${base}/ffmpeg-core.wasm${assetSuffix}`,
      });
    } catch (error) {
      resetFFmpeg();
      throw normalizeUnknownError(error, 'Failed to load FFmpeg.');
    }
  })();

  await loadPromise;
  return ffmpegInstance;
}

async function readMediaInput(fileOrUrl: Uint8Array | File | string): Promise<Uint8Array> {
  if (fileOrUrl instanceof Uint8Array) {
    return fileOrUrl;
  }
  if (fileOrUrl instanceof File) {
    let pending = fileDataCache.get(fileOrUrl);
    if (!pending) {
      pending = fileOrUrl.arrayBuffer().then(
        (buf) => new Uint8Array(buf as ArrayBuffer),
        (error) => {
          // Remove cached rejection so future attempts can retry (e.g. after re-adding the file).
          fileDataCache.delete(fileOrUrl);
          const isNotReadable = error instanceof DOMException && error.name === 'NotReadableError';
          throw new Error(
            isNotReadable
              ? `Could not read "${fileOrUrl.name}". The file may have been moved or the browser lost access. Try refreshing the page.`
              : `Failed to read "${fileOrUrl.name}": ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
      fileDataCache.set(fileOrUrl, pending);
    }
    return pending;
  }
  const cached = remoteMediaInputCache.get(fileOrUrl);
  if (cached) {
    return cached;
  }

  const pendingBytes = (async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 300_000);
    try {
      const response = await fetch(fileOrUrl, {
        signal: controller.signal,
        cache: isSameOriginUrl(fileOrUrl) ? 'force-cache' : 'default',
      });
      if (!response.ok) {
        throw new Error(`Failed to load media source (${response.status}).`);
      }
      return new Uint8Array(await response.arrayBuffer() as ArrayBuffer);
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  remoteMediaInputCache.set(fileOrUrl, pendingBytes);

  try {
    return await pendingBytes;
  } catch (error) {
    remoteMediaInputCache.delete(fileOrUrl);
    throw error;
  }
}

async function probeMediaInput(fileOrUrl: Uint8Array | File | string): Promise<{
  width: number;
  height: number;
}> {
  let objectUrl: string | null = null;
  const src = (() => {
    if (typeof fileOrUrl === 'string') return fileOrUrl;
    if (fileOrUrl instanceof File) {
      objectUrl = URL.createObjectURL(fileOrUrl);
      return objectUrl;
    }
    const buffer = new ArrayBuffer(fileOrUrl.byteLength);
    new Uint8Array(buffer).set(fileOrUrl);
    objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
    return objectUrl;
  })();

  try {
    return await new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const cleanup = () => {
        video.removeAttribute('src');
        video.load();
      };
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => {
        const width = video.videoWidth || 0;
        const height = video.videoHeight || 0;
        cleanup();
        if (width > 0 && height > 0) {
          resolve({ width, height });
        } else {
          reject(new Error('Video dimensions unavailable'));
        }
      };
      video.onerror = () => {
        cleanup();
        reject(new Error('Failed to probe media dimensions'));
      };
      video.src = src;
      video.load();
    });
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

function toEvenDimension(value: number, fallback: number): number {
  const safe = Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
  return safe % 2 === 0 ? safe : safe + 1;
}

async function execOrThrow(ffmpeg: FFmpeg, args: string[]) {
  const WATCHDOG_MS = 15 * 60 * 1000;
  let watchdogId: ReturnType<typeof setTimeout> | null = null;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogId = setTimeout(() => {
      try { ffmpeg.terminate(); } catch { /* ignore */ }
      resetFFmpeg();
      reject(new Error('FFmpeg timed out after 15 minutes.'));
    }, WATCHDOG_MS);
  });
  try {
    const exitCode = await Promise.race([ffmpeg.exec(args), watchdog]);
    if (exitCode !== 0) {
      const logSuffix = recentFFmpegLogs.length > 0
        ? `\n${recentFFmpegLogs.slice(-4).join('\n')}`
        : '';
      throw new Error(`FFmpeg exited with code ${exitCode}.${logSuffix}`);
    }
  } finally {
    if (watchdogId !== null) clearTimeout(watchdogId);
  }
}

// ─── Audio Loudness Analysis ────────────────────────────────────────────────

export interface ClipLoudnessResult {
  maxVolumeDb: number;
  meanVolumeDb: number;
}

export async function analyzeClipLoudness(
  fileOrUrl: Uint8Array | File | string,
  sourceStart: number,
  sourceDuration: number,
): Promise<ClipLoudnessResult> {
  const ffmpeg = await getFFmpeg();
  const inputData = await readMediaInput(fileOrUrl);
  const inputName = '_voldetect_input.mp4';
  const outputName = '_voldetect_out.wav';

  await ffmpeg.writeFile(inputName, cloneWritableBytes(inputData));

  // Clear logs before analysis
  const logsBefore = recentFFmpegLogs.length;
  recentFFmpegLogs = [];

  await execOrThrow(ffmpeg, [
    '-ss', sourceStart.toFixed(6),
    '-t', sourceDuration.toFixed(6),
    '-i', inputName,
    '-vn',
    '-af', 'volumedetect',
    '-f', 'wav',
    outputName,
  ]);

  // Parse volumedetect output from logs
  let maxVolumeDb = 0;
  let meanVolumeDb = -Infinity;
  for (const line of recentFFmpegLogs) {
    const maxMatch = line.match(/max_volume:\s*([-\d.]+)\s*dB/);
    if (maxMatch) maxVolumeDb = parseFloat(maxMatch[1]);
    const meanMatch = line.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    if (meanMatch) meanVolumeDb = parseFloat(meanMatch[1]);
  }

  // Cleanup
  try { await ffmpeg.deleteFile(inputName); } catch {}
  try { await ffmpeg.deleteFile(outputName); } catch {}

  return { maxVolumeDb, meanVolumeDb };
}

export function dBToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

async function getCaptionFontData() {
  if (!captionFontDataPromise) {
    captionFontDataPromise = (async () => {
      const response = await fetch(`${CAPTION_FONT_PATH}?v=${FFMPEG_ASSET_VERSION}`);
      if (!response.ok) {
        throw new Error(`Failed to load caption font (${response.status}).`);
      }
      return new Uint8Array(await response.arrayBuffer() as ArrayBuffer);
    })();
  }
  return captionFontDataPromise;
}

async function ensureCaptionFontFile(ffmpeg: FFmpeg) {
  const fontData = await getCaptionFontData();
  try {
    await ffmpeg.deleteFile(CAPTION_FONT_FILE_NAME);
  } catch {
    // Ignore missing file errors before rewriting the font asset.
  }
  await ffmpeg.writeFile(CAPTION_FONT_FILE_NAME, cloneWritableBytes(fontData));
  return CAPTION_FONT_FILE_NAME;
}

function isPlainCutClip(clip: VideoClip): boolean {
  const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
  const volume = Number.isFinite(clip.volume) ? clip.volume : 1;
  const fadeIn = Number.isFinite(clip.fadeIn) ? clip.fadeIn : 0;
  const fadeOut = Number.isFinite(clip.fadeOut) ? clip.fadeOut : 0;
  const filterType = clip.filter?.type ?? 'none';

  return (
    speed === 1
    && volume === 1
    && fadeIn === 0
    && fadeOut === 0
    && filterType === 'none'
  );
}

function mergeAdjacentCopyClips(clips: VideoClip[]): VideoClip[] {
  const merged: VideoClip[] = [];

  for (const clip of clips) {
    const last = merged[merged.length - 1];

    if (
      last
      && isPlainCutClip(last)
      && isPlainCutClip(clip)
      && last.sourceId === clip.sourceId
      && Math.abs((last.sourceStart + last.sourceDuration) - clip.sourceStart) < 0.001
    ) {
      last.sourceDuration += clip.sourceDuration;
      continue;
    }

    merged.push({ ...clip });
  }

  return merged;
}

function createOverallProgressReporter(onProgress?: (progress: number) => void) {
  let lastReported = 0;

  return (nextProgress: number) => {
    if (!onProgress) return;
    lastReported = Math.max(lastReported, Math.round(nextProgress));
    onProgress(Math.max(0, Math.min(100, lastReported)));
  };
}

async function createExportObjectUrl(
  ffmpeg: FFmpeg,
  outputFileName: string,
  reportOverallProgress: (progress: number) => void,
  onStage?: (stage: string) => void,
) {
  onStage?.('Preparing download…');
  reportOverallProgress(97);
  const data = await ffmpeg.readFile(outputFileName);
  reportOverallProgress(99);
  const blob = new Blob([data as unknown as ArrayBuffer], { type: 'video/mp4' });
  const outputUrl = URL.createObjectURL(blob);
  reportOverallProgress(100);
  return outputUrl;
}

async function mixAudioTracks(
  ffmpeg: FFmpeg,
  videoFileName: string,
  clips: VideoClip[],
  tracks: Track[],
  sourcesById: Record<string, Uint8Array | File | string | null | undefined>,
  onStage?: (stage: string) => void,
): Promise<string> {
  const audioTracks = tracks.filter((t) => t.type === 'audio' && !t.muted);
  const audioTrackClips = audioTracks.flatMap((track) =>
    clips.filter((c) => c.trackId === track.id).map((c) => ({ clip: c, track })),
  );
  if (audioTrackClips.length === 0) return videoFileName;

  onStage?.('Mixing audio tracks…');

  // Write each audio source and build a concat file per track
  for (let ti = 0; ti < audioTracks.length; ti++) {
    const track = audioTracks[ti];
    const trackClips = clips.filter((c) => c.trackId === track.id);
    if (trackClips.length === 0) continue;

    // Render each clip's audio segment
    const segmentNames: string[] = [];
    let cursor = 0;
    for (let ci = 0; ci < trackClips.length; ci++) {
      const clip = trackClips[ci];
      const source = sourcesById[clip.sourceId];
      if (!source) continue;

      const inputName = `audio_track_${ti}_src_${ci}.mp4`;
      const inputData = await readMediaInput(source as Uint8Array | File | string);
      await ffmpeg.writeFile(inputName, cloneWritableBytes(inputData));

      const speed = clip.speed > 0 ? clip.speed : 1;
      const duration = clip.sourceDuration / speed;
      const segName = `audio_track_${ti}_seg_${ci}.mp3`;

      // Build audio filter chain
      const filters: string[] = ['asetpts=PTS-STARTPTS'];
      if (speed !== 1) {
        let remaining = speed;
        while (remaining > 2.0) { filters.push('atempo=2.0'); remaining /= 2.0; }
        while (remaining < 0.5) { filters.push('atempo=0.5'); remaining /= 0.5; }
        filters.push(`atempo=${remaining.toFixed(6)}`);
      }
      const effectiveVolume = Math.max(0, Math.min(2, clip.volume * track.volume));
      if (effectiveVolume !== 1) filters.push(`volume=${effectiveVolume.toFixed(4)}`);

      await execOrThrow(ffmpeg, [
        '-ss', clip.sourceStart.toFixed(6),
        '-t', clip.sourceDuration.toFixed(6),
        '-i', inputName,
        '-vn',
        '-af', filters.join(','),
        '-t', duration.toFixed(6),
        '-ar', '48000', '-ac', '2',
        segName,
      ]);

      // If there's a gap before this clip, insert silence
      if (cursor < ci) {
        // Simplified: we don't handle gaps for now — clips are sequential within a track
      }
      segmentNames.push(segName);
      cursor++;

      try { await ffmpeg.deleteFile(inputName); } catch {}
    }

    if (segmentNames.length === 0) continue;

    // Concat all segments for this track
    const concatList = segmentNames.map((name) => `file '${name}'`).join('\n');
    await ffmpeg.writeFile(`audio_track_${ti}_list.txt`, concatList);
    await execOrThrow(ffmpeg, [
      '-f', 'concat', '-safe', '0',
      '-i', `audio_track_${ti}_list.txt`,
      '-c', 'copy',
      `audio_track_${ti}.mp3`,
    ]);

    for (const name of segmentNames) {
      try { await ffmpeg.deleteFile(name); } catch {}
    }
    try { await ffmpeg.deleteFile(`audio_track_${ti}_list.txt`); } catch {}
  }

  // Mix all audio tracks with the video
  const inputs = ['-i', videoFileName];
  const audioInputs: string[] = [];
  for (let ti = 0; ti < audioTracks.length; ti++) {
    const trackClips = clips.filter((c) => c.trackId === audioTracks[ti].id);
    if (trackClips.length === 0) continue;
    inputs.push('-i', `audio_track_${ti}.mp3`);
    audioInputs.push(`audio_track_${ti}.mp3`);
  }

  if (audioInputs.length === 0) return videoFileName;

  const mixedOutput = 'export_mixed.mp4';
  const totalAudioInputs = 1 + audioInputs.length; // video audio + audio tracks
  const filterComplex = `amix=inputs=${totalAudioInputs}:duration=longest:dropout_transition=0`;

  await execOrThrow(ffmpeg, [
    ...inputs,
    '-filter_complex', filterComplex,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    mixedOutput,
  ]);

  for (const name of audioInputs) {
    try { await ffmpeg.deleteFile(name); } catch {}
  }

  return mixedOutput;
}

// ─── Transition Export Helpers ───────────────────────────────────────────────

/** Returns true if the transition type uses the xfade filter (composites two clips) */
function isXfadeTransition(type: TransitionType): boolean {
  return type === 'crossfade' || type === 'wipe_left' || type === 'wipe_right'
    || type === 'slide_left' || type === 'slide_right'
    || type === 'zoom_in' || type === 'zoom_out';
}

/** Returns true if the transition uses per-clip fade approach (no compositing) */
function isFadeTransition(type: TransitionType): boolean {
  return type === 'fade_black' || type === 'dip_to_white';
}

/** Maps our transition type to the FFmpeg xfade transition name */
function getXfadeTransitionName(type: TransitionType): string {
  switch (type) {
    case 'crossfade': return 'fade';
    case 'wipe_left': return 'wipeleft';
    case 'wipe_right': return 'wiperight';
    case 'slide_left': return 'slideleft';
    case 'slide_right': return 'slideright';
    case 'zoom_in': return 'zoomin';
    case 'zoom_out': return 'fadeblack'; // FFmpeg doesn't have a native zoom_out, use fadeblack as fallback
    default: return 'fade';
  }
}

function getClipExportState(clip: VideoClip) {
  return {
    speed: Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1,
    volume: Number.isFinite(clip.volume) ? clip.volume : 1,
    fadeIn: Number.isFinite(clip.fadeIn) ? clip.fadeIn : 0,
    fadeOut: Number.isFinite(clip.fadeOut) ? clip.fadeOut : 0,
    filter: clip.filter ?? null,
  };
}

function buildClipVideoFilterChain(
  clip: VideoClip,
  targetWidth: number,
  targetHeight: number,
  options?: {
    durationSeconds?: number;
    extraFadeIn?: number;
    extraFadeOut?: number;
    fadeInColor?: string;
    fadeOutColor?: string;
  },
): string[] {
  const clipState = getClipExportState(clip);
  const vFilters: string[] = [];
  const durationSeconds = Number.isFinite(options?.durationSeconds) ? Math.max(0, Number(options?.durationSeconds)) : 0;
  const fadeInSeconds = Math.max(0, clipState.fadeIn, options?.extraFadeIn ?? 0);
  const fadeOutSeconds = Math.max(0, clipState.fadeOut, options?.extraFadeOut ?? 0);

  if (clipState.speed !== 1.0) {
    vFilters.push(`setpts=(PTS-STARTPTS)/${clipState.speed}`);
  } else {
    vFilters.push('setpts=PTS-STARTPTS');
  }

  if (clipState.filter && clipState.filter.type !== 'none') {
    const filterMap: Record<string, string> = {
      cinematic: 'eq=contrast=1.2:saturation=0.8:brightness=-0.05',
      vintage: 'eq=contrast=1.1:saturation=0.7:brightness=0.05,hue=s=0.7',
      warm: 'eq=saturation=1.2:brightness=0.05,colorchannelmixer=rr=1.1:bb=0.9',
      cool: 'eq=saturation=1.1,colorchannelmixer=rr=0.9:bb=1.1',
      bw: 'hue=s=0',
    };
    const filterValue = filterMap[clipState.filter.type];
    if (filterValue) {
      vFilters.push(filterValue);
    }
  }

  if (fadeInSeconds > 0) {
    const colorSuffix = options?.fadeInColor ? `:color=${options.fadeInColor}` : '';
    vFilters.push(`fade=t=in:st=0:d=${fadeInSeconds.toFixed(3)}${colorSuffix}`);
  }
  if (fadeOutSeconds > 0 && durationSeconds > 0) {
    const fadeOutStart = Math.max(0, durationSeconds - fadeOutSeconds);
    const colorSuffix = options?.fadeOutColor ? `:color=${options.fadeOutColor}` : '';
    vFilters.push(`fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutSeconds.toFixed(3)}${colorSuffix}`);
  }

  vFilters.push(
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease`,
    `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    'fps=30',
    'format=yuv420p',
  );

  return vFilters;
}

function buildClipAudioFilterChain(
  clip: VideoClip,
  options?: {
    durationSeconds?: number;
    extraFadeIn?: number;
    extraFadeOut?: number;
  },
): string[] {
  const clipState = getClipExportState(clip);
  const aFilters: string[] = ['asetpts=PTS-STARTPTS'];
  const durationSeconds = Number.isFinite(options?.durationSeconds) ? Math.max(0, Number(options?.durationSeconds)) : 0;
  const fadeInSeconds = Math.max(0, clipState.fadeIn, options?.extraFadeIn ?? 0);
  const fadeOutSeconds = Math.max(0, clipState.fadeOut, options?.extraFadeOut ?? 0);

  if (clipState.speed !== 1.0) {
    let remainingSpeed = clipState.speed;
    while (remainingSpeed > 2.0) {
      aFilters.push('atempo=2.0');
      remainingSpeed /= 2.0;
    }
    while (remainingSpeed < 0.5) {
      aFilters.push('atempo=0.5');
      remainingSpeed /= 0.5;
    }
    aFilters.push(`atempo=${remainingSpeed.toFixed(4)}`);
  }

  if (clipState.volume !== 1.0) {
    aFilters.push(`volume=${clipState.volume.toFixed(3)}`);
  }

  if (fadeInSeconds > 0) {
    aFilters.push(`afade=t=in:st=0:d=${fadeInSeconds.toFixed(3)}`);
  }
  if (fadeOutSeconds > 0 && durationSeconds > 0) {
    const fadeOutStart = Math.max(0, durationSeconds - fadeOutSeconds);
    aFilters.push(`afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutSeconds.toFixed(3)}`);
  }

  return aFilters;
}

type ExportCaptionWindow = {
  startTime: number;
  endTime: number;
  lines: string[];
  positionX?: number;
  positionY?: number;
};

type ExportTextOverlay = {
  startTime: number;
  endTime: number;
  text: string;
  position: TextOverlayEntry['position'];
  fontSize: number;
  positionX?: number;
  positionY?: number;
};

function buildExportCaptionWindows(params: {
  clips: VideoClip[];
  transitions: TransitionEntry[];
  captions: CaptionEntry[];
}): ExportCaptionWindow[] {
  void params.clips;
  void params.transitions;
  return buildCaptionRenderWindows(params.captions)
    .map((window) => ({
      startTime: window.startTime,
      endTime: window.endTime,
      lines: window.lines,
      positionX: window.positionX,
      positionY: window.positionY,
    }))
    .filter((window) => window.endTime > window.startTime && window.lines.length > 0)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

function buildExportTextOverlays(textOverlays: TextOverlayEntry[]): ExportTextOverlay[] {
  return textOverlays
    .map((overlay) => normalizeTextOverlayEntry(overlay))
    .filter((overlay): overlay is TextOverlayEntry => !!overlay)
    .map((overlay) => ({
      startTime: overlay.startTime,
      endTime: overlay.endTime,
      text: overlay.text,
      position: overlay.position,
      fontSize: getTextOverlayFontSize(overlay),
      positionX: overlay.positionX,
      positionY: overlay.positionY,
    }))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

async function writeCaptionTextFiles(
  ffmpeg: FFmpeg,
  captionWindows: ExportCaptionWindow[],
) {
  const encoder = new TextEncoder();
  const drawTextFilters: string[] = [];
  const fontFileName = await ensureCaptionFontFile(ffmpeg);

  for (let windowIndex = 0; windowIndex < captionWindows.length; windowIndex += 1) {
    const window = captionWindows[windowIndex];
    const fileName = `caption_${windowIndex}.txt`;
    await ffmpeg.writeFile(fileName, encoder.encode(window.lines.join('\n')));
    const hasCustomPos = window.positionX != null && window.positionY != null;
    const xExpr = hasCustomPos
      ? `w*${(window.positionX! / 100).toFixed(4)}-text_w/2`
      : '(w-text_w)/2';
    const yExpr = hasCustomPos
      ? `h*${(window.positionY! / 100).toFixed(4)}-text_h/2`
      : 'h-(h*0.14)-text_h';
    drawTextFilters.push(
      `drawtext=textfile=${fileName}:fontfile=${fontFileName}:reload=0:fontcolor=white:fontsize=h*0.036:line_spacing=10:` +
      `borderw=3:bordercolor=black:shadowcolor=black@0.45:shadowx=0:shadowy=3:` +
      `x=${xExpr}:y=${yExpr}:` +
      `enable='gte(t,${window.startTime.toFixed(3)})*lt(t,${window.endTime.toFixed(3)})'`,
    );
  }

  return drawTextFilters;
}

async function writeTextOverlayTextFiles(
  ffmpeg: FFmpeg,
  textOverlays: ExportTextOverlay[],
  frameHeight: number,
) {
  const encoder = new TextEncoder();
  const drawTextFilters: string[] = [];
  const fontFileName = await ensureCaptionFontFile(ffmpeg);

  for (let overlayIndex = 0; overlayIndex < textOverlays.length; overlayIndex += 1) {
    const overlay = textOverlays[overlayIndex];
    const fileName = `text_overlay_${overlayIndex}.txt`;
    await ffmpeg.writeFile(fileName, encoder.encode(overlay.text));
    const hasCustomPos = overlay.positionX != null && overlay.positionY != null;
    const xExpr = hasCustomPos
      ? `w*${(overlay.positionX! / 100).toFixed(4)}-text_w/2`
      : '(w-text_w)/2';
    const yExpr = hasCustomPos
      ? `h*${(overlay.positionY! / 100).toFixed(4)}-text_h/2`
      : getTextOverlayExportY(overlay.position, frameHeight, overlay.positionY);
    drawTextFilters.push(
      `drawtext=textfile=${fileName}:fontfile=${fontFileName}:reload=0:fontcolor=white:fontsize=h*0.036:line_spacing=10:` +
      `borderw=3:bordercolor=black:shadowcolor=black@0.45:shadowx=0:shadowy=3:` +
      `x=${xExpr}:y=${yExpr}:` +
      `enable='gte(t,${overlay.startTime.toFixed(3)})*lt(t,${overlay.endTime.toFixed(3)})'`,
    );
  }

  return drawTextFilters;
}

function createFFmpegJobHandle(signal?: AbortSignal) {
  let cancelled = false;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      ffmpegInstance?.terminate();
    } finally {
      resetFFmpeg();
    }
  };

  activeJobCancel = cancel;

  const handleAbort = () => {
    cancel();
  };

  signal?.addEventListener('abort', handleAbort, { once: true });

  return {
    throwIfCancelled() {
      if (cancelled || signal?.aborted) {
        cancel();
        throw createAbortError();
      }
    },
    cleanup() {
      signal?.removeEventListener('abort', handleAbort);
      if (activeJobCancel === cancel) {
        activeJobCancel = null;
      }
    },
  };
}

export function cancelActiveFFmpegJob() {
  if (!activeJobCancel) return false;
  activeJobCancel();
  return true;
}

export function isFFmpegAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error) {
    return error.message.includes('FFmpeg.terminate()') || error.message === 'Export canceled.';
  }
  return typeof error === 'string' && error.includes('FFmpeg.terminate()');
}

/**
 * Extract and cache the full audio track from a video source.
 *
 * For a 2-hour video the audio-only MP3 is typically ~100-140 MB —
 * far smaller than the multi-GB video.  Caching the audio track
 * avoids keeping the full video in FFmpeg's WASM memory for the
 * duration of the transcription run.
 */
async function getOrExtractAudioTrack(
  fileOrUrl: Uint8Array | File | string,
): Promise<Uint8Array> {
  const sourceKey = getSourceKey(fileOrUrl);
  const cacheKey = sourceKey ? `audio:${sourceKey}` : null;

  if (cacheKey) {
    const cached = audioTrackCache.get(cacheKey);
    if (cached) return cached;
  }

  const pending = (async () => {
    const ffmpeg = await getFFmpeg();
    const inputBytes = await readMediaInput(fileOrUrl);

    // Write the full video source to a temporary VFS file.
    try { await ffmpeg.deleteFile('_aud_src'); } catch { /* ok */ }
    await ffmpeg.writeFile('_aud_src', cloneWritableBytes(inputBytes));

    // Extract mono 16 kHz MP3 audio track (no video/subtitle/data streams).
    try { await ffmpeg.deleteFile('_aud_full.mp3'); } catch { /* ok */ }
    await execOrThrow(ffmpeg, [
      '-i', '_aud_src',
      '-vn', '-sn', '-dn',
      '-ar', '16000',
      '-ac', '1',
      '-q:a', '5',
      '-f', 'mp3',
      '_aud_full.mp3',
    ]);

    const audioData = new Uint8Array(
      (await ffmpeg.readFile('_aud_full.mp3')) as unknown as ArrayBuffer,
    );

    // Clean up the large video file from the WASM filesystem.
    try { await ffmpeg.deleteFile('_aud_src'); } catch { /* ok */ }
    try { await ffmpeg.deleteFile('_aud_full.mp3'); } catch { /* ok */ }

    // Free the original video bytes from the URL download cache so they
    // can be garbage-collected while the much smaller audio stays cached.
    if (typeof fileOrUrl === 'string') {
      remoteMediaInputCache.delete(fileOrUrl);
    }

    return audioData;
  })();

  if (cacheKey) {
    audioTrackCache.set(cacheKey, pending);
  }

  try {
    return await pending;
  } catch (error) {
    if (cacheKey) audioTrackCache.delete(cacheKey);
    throw error;
  }
}

export async function extractAudioSegment(
  fileOrUrl: Uint8Array | File | string,
  startTime: number,
  endTime: number,
): Promise<Blob> {
  // Use the cached audio-only track instead of the full video.
  // This keeps WASM memory usage at ~100 MB instead of multiple GB.
  const audioTrack = await getOrExtractAudioTrack(fileOrUrl);

  const ffmpeg = await getFFmpeg();
  const sourceKey = getSourceKey(fileOrUrl);
  const audioInputKey = sourceKey ? `audio:${sourceKey}` : null;

  if (audioInputKey === null || audioInputKey !== lastWrittenInputKey) {
    try { await ffmpeg.deleteFile('input_audio'); } catch { /* doesn't exist, fine */ }
    await ffmpeg.writeFile('input_audio', cloneWritableBytes(audioTrack));
    lastWrittenInputKey = audioInputKey;
  }
  try { await ffmpeg.deleteFile('audio_out.mp3'); } catch { /* doesn't exist, fine */ }

  try {
    await ffmpeg.exec([
      '-ss', String(startTime),
      '-to', String(endTime),
      '-i', 'input_audio',
      '-map', '0:a:0',
      '-vn',          // strip video
      '-sn',          // ignore subtitle streams
      '-dn',          // ignore data streams from iPhone MOV containers
      '-ar', '16000', // 16kHz — Whisper's preferred rate
      '-ac', '1',     // mono
      '-f', 'mp3',
      'audio_out.mp3',
    ], 300_000);

    const outputData = await ffmpeg.readFile('audio_out.mp3');
    return new Blob([outputData as unknown as ArrayBuffer], { type: 'audio/mpeg' });
  } catch (err) {
    resetFFmpeg();
    throw normalizeUnknownError(err, 'Failed to extract audio for transcription.');
  }
}

export interface CutSegmentsOptions {
  fileUrl: Uint8Array | File | string;
  /** Segments to REMOVE */
  cutSegments: Array<{ startTime: number; endTime: number }>;
  duration: number;
  onStage?: (stage: string) => void;
  onProgress?: (progress: number) => void;
}

export async function cutSegments({
  fileUrl,
  cutSegments: cuts,
  duration,
  onStage,
  onProgress,
}: CutSegmentsOptions): Promise<string> {
  onStage?.('Loading FFmpeg…');
  const ffmpeg = await getFFmpeg(onProgress);

  // Write input file
  onStage?.('Reading file…');
  const inputName = 'input.mp4';
  const inputData = await readMediaInput(fileUrl);
  await ffmpeg.writeFile(inputName, cloneWritableBytes(inputData));

  // Compute keep segments by inverting cuts
  const keepSegments = cuts.length > 0
    ? invertSegments(cuts, duration)
    : [{ startTime: 0, endTime: duration }];

  if (keepSegments.length === 0) {
    throw new Error('All segments are cut — nothing to export');
  }

  onStage?.('Cutting segments…');

  // Extract each keep segment
  const segFiles: string[] = [];
  for (let i = 0; i < keepSegments.length; i++) {
    const { startTime, endTime } = keepSegments[i];
    const outName = `seg${i}.mp4`;
    await ffmpeg.exec([
      '-ss', String(startTime),
      '-to', String(endTime),
      '-i', inputName,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      outName,
    ]);
    segFiles.push(outName);
  }

  onStage?.('Concatenating…');

  if (segFiles.length === 1) {
    // Single segment — just use it directly
    const data = await ffmpeg.readFile(segFiles[0]);
    const blob = new Blob([data as unknown as ArrayBuffer], { type: 'video/mp4' });
    return URL.createObjectURL(blob);
  }

  // Write concat list
  const concatContent = segFiles.map(f => `file '${f}'`).join('\n');
  const encoder = new TextEncoder();
  await ffmpeg.writeFile('concat.txt', encoder.encode(concatContent));

  await ffmpeg.exec([
    '-f', 'concat',
    '-safe', '0',
    '-i', 'concat.txt',
    '-c', 'copy',
    'output.mp4',
  ]);

  onStage?.('Preparing download…');
  const data = await ffmpeg.readFile('output.mp4');
  const blob = new Blob([data as unknown as ArrayBuffer], { type: 'video/mp4' });
  return URL.createObjectURL(blob);
}

export interface ExportClipsOptions {
  sourcesById: Record<string, Uint8Array | File | string | null | undefined>;
  clips: VideoClip[];
  captions?: CaptionEntry[];
  textOverlays?: TextOverlayEntry[];
  transitions?: TransitionEntry[];
  tracks?: Track[];
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onProgress?: (progress: number) => void;
}

export async function exportClips(options: ExportClipsOptions): Promise<string> {
  const {
    sourcesById,
    captions = [],
    textOverlays = [],
    transitions = [],
    tracks = [],
    signal,
    onStage,
    onProgress,
  } = options;
  // Keep all clips for audio mixing, use only video track clips for the main pipeline
  const allClips = options.clips;
  const clips = allClips.filter((c) => c.trackId === 'default' || !tracks.some((t) => t.id === c.trackId && t.type === 'audio'));
  if (clips.length === 0) throw new Error('No clips to export');

  const hasAudioTracks = tracks.some((t) => t.type === 'audio' && !t.muted)
    && allClips.some((c) => tracks.some((t) => t.id === c.trackId && t.type === 'audio'));

  const job = createFFmpegJobHandle(signal);
  const reportOverallProgress = createOverallProgressReporter(onProgress);
  let phaseStart = 0;
  let phaseSpan = 5;

  const finalizeExport = async (ffmpeg: FFmpeg, videoFileName: string) => {
    if (hasAudioTracks) {
      const mixedFile = await mixAudioTracks(ffmpeg, videoFileName, allClips, tracks, sourcesById, onStage);
      return createExportObjectUrl(ffmpeg, mixedFile, reportOverallProgress, onStage);
    }
    return createExportObjectUrl(ffmpeg, videoFileName, reportOverallProgress, onStage);
  };
  const normalizedTransitions = normalizeTransitionEntries(clips, transitions);
  const captionWindows = buildExportCaptionWindows({
    clips,
    transitions: normalizedTransitions,
    captions,
  });
  const normalizedTextOverlays = buildExportTextOverlays(textOverlays);
  const resolvedTransitions = resolveTransitions(clips, normalizedTransitions);
  const uniqueSourceCount = new Set(clips.map((clip) => clip.sourceId)).size;
  const requiresFullRender = normalizedTransitions.length > 0
    || captionWindows.length > 0
    || normalizedTextOverlays.length > 0
    || uniqueSourceCount > 1;

  const getSourceInput = (sourceId: string) => {
    const source = sourcesById[sourceId];
    if (!source) {
      throw new Error(`Missing media for source ${sourceId}. Reload or re-upload this source before exporting.`);
    }
    return source;
  };

  try {
    onStage?.('Loading FFmpeg…');
    const ffmpeg = await getFFmpeg((progress) => {
      reportOverallProgress(phaseStart + (phaseSpan * progress) / 100);
    });
    job.throwIfCancelled();
    reportOverallProgress(5);

    if (!requiresFullRender && clips.every(isPlainCutClip)) {
      const mergedClips = mergeAdjacentCopyClips(clips);
      const inputNameBySourceId = new Map<string, string>();
      const uniqueSourceIds = Array.from(new Set(mergedClips.map((clip) => clip.sourceId)));

      onStage?.('Reading source media…');
      for (let index = 0; index < uniqueSourceIds.length; index += 1) {
        const sourceId = uniqueSourceIds[index];
        const inputName = `input_export_fast_${index}.mp4`;
        const inputData = await readMediaInput(getSourceInput(sourceId));
        job.throwIfCancelled();
        await ffmpeg.writeFile(inputName, cloneWritableBytes(inputData));
        inputNameBySourceId.set(sourceId, inputName);
      }
      reportOverallProgress(15);

      const segFiles: string[] = [];
      const segmentSpan = mergedClips.length > 0 ? 75 / mergedClips.length : 75;

      for (let index = 0; index < mergedClips.length; index += 1) {
        job.throwIfCancelled();
        const clip = mergedClips[index];
        const segName = `export_fast_seg${index}.mp4`;
        phaseStart = 15 + (segmentSpan * index);
        phaseSpan = segmentSpan;
        onStage?.(`Fast exporting clip ${index + 1} of ${mergedClips.length}…`);
        const inputName = inputNameBySourceId.get(clip.sourceId);
        if (!inputName) {
          throw new Error(`Missing input for source ${clip.sourceId}.`);
        }
        await execOrThrow(ffmpeg, [
          '-ss', String(clip.sourceStart),
          '-t', String(clip.sourceDuration),
          '-i', inputName,
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          segName,
        ]);
        segFiles.push(segName);
        reportOverallProgress(phaseStart + phaseSpan);
      }

      if (segFiles.length === 1) {
        return finalizeExport(ffmpeg, segFiles[0]);
      }

      phaseStart = 90;
      phaseSpan = 8;
      onStage?.('Concatenating clips…');
      const concatContent = segFiles.map((file) => `file '${file}'`).join('\n');
      const encoder = new TextEncoder();
      await ffmpeg.writeFile('export_fast_concat.txt', encoder.encode(concatContent));
      await execOrThrow(ffmpeg, [
        '-f', 'concat',
        '-safe', '0',
        '-i', 'export_fast_concat.txt',
        '-c', 'copy',
        '-movflags', '+faststart',
        'export_output.mp4',
      ]);

      return finalizeExport(ffmpeg, 'export_output.mp4');
    }

    onStage?.('Reading source media…');
    const uniqueSourceIds = Array.from(new Set(clips.map((clip) => clip.sourceId)));
    const inputNameBySourceId = new Map<string, string>();
    for (let index = 0; index < uniqueSourceIds.length; index += 1) {
      const sourceId = uniqueSourceIds[index];
      const inputName = `input_export_${index}.mp4`;
      const inputData = await readMediaInput(getSourceInput(sourceId));
      job.throwIfCancelled();
      await ffmpeg.writeFile(inputName, cloneWritableBytes(inputData));
      inputNameBySourceId.set(sourceId, inputName);
    }
    reportOverallProgress(15);

    const dimensionProbeSourceId = (sourcesById[MAIN_SOURCE_ID] ? MAIN_SOURCE_ID : null)
      ?? clips.find((clip) => !!sourcesById[clip.sourceId])?.sourceId
      ?? null;
    const dimensions = dimensionProbeSourceId
      ? await probeMediaInput(getSourceInput(dimensionProbeSourceId)).catch(() => ({ width: 0, height: 0 }))
      : { width: 0, height: 0 };
    const targetWidth = toEvenDimension(dimensions.width || 1280, 1280);
    const targetHeight = toEvenDimension(dimensions.height || 720, 720);

    onStage?.(
      normalizedTransitions.length > 0
        ? 'Rendering boundary fades…'
        : (captionWindows.length > 0 || normalizedTextOverlays.length > 0)
          ? 'Rendering clips for overlays…'
          : requiresFullRender
            ? 'Rendering final video…'
            : 'Processing clips…',
    );

    const segFiles: string[] = [];
    const processingSpan = clips.length > 0 ? 65 / clips.length : 65;
    const transitionInByClipId = new Map(resolvedTransitions.map((transition) => [transition.toClipId, transition]));
    const transitionOutByClipId = new Map(resolvedTransitions.map((transition) => [transition.fromClipId, transition]));

    for (let i = 0; i < clips.length; i++) {
      job.throwIfCancelled();
      const clip = clips[i];
      const segName = `export_seg${i}.mp4`;
      const inputName = inputNameBySourceId.get(clip.sourceId);
      if (!inputName) {
        throw new Error(`Missing input for source ${clip.sourceId}.`);
      }

      const clipDurationSeconds = clip.sourceDuration / clip.speed;
      const transitionIn = transitionInByClipId.get(clip.id);
      const transitionOut = transitionOutByClipId.get(clip.id);

      // Only apply per-clip fade for fade_black/dip_to_white transitions
      // xfade transitions are composited later
      const fadeInTransition = transitionIn && isFadeTransition(transitionIn.type) ? transitionIn : null;
      const fadeOutTransition = transitionOut && isFadeTransition(transitionOut.type) ? transitionOut : null;
      const transitionInHalf = (fadeInTransition?.duration ?? 0) / 2;
      const transitionOutHalf = (fadeOutTransition?.duration ?? 0) / 2;
      const fadeInColor = fadeInTransition?.type === 'dip_to_white' ? 'white' : undefined;
      const fadeOutColor = fadeOutTransition?.type === 'dip_to_white' ? 'white' : undefined;

      const args: string[] = [
        '-ss', String(clip.sourceStart),
        '-t', String(clip.sourceDuration),
        '-i', inputName,
        '-vf', buildClipVideoFilterChain(clip, targetWidth, targetHeight, {
          durationSeconds: clipDurationSeconds,
          extraFadeIn: transitionInHalf,
          extraFadeOut: transitionOutHalf,
          fadeInColor,
          fadeOutColor,
        }).join(','),
        '-af', buildClipAudioFilterChain(clip, {
          durationSeconds: clipDurationSeconds,
          extraFadeIn: transitionInHalf,
          extraFadeOut: transitionOutHalf,
        }).join(','),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        '-avoid_negative_ts', 'make_zero',
        segName,
      ];

      phaseStart = 15 + (processingSpan * i);
      phaseSpan = processingSpan;
      onStage?.(`Processing clip ${i + 1} of ${clips.length}…`);
      await execOrThrow(ffmpeg, args);
      segFiles.push(segName);
      reportOverallProgress(phaseStart + phaseSpan);
    }

    // Apply xfade transitions between consecutive clips that need compositing
    const hasXfadeTransitions = resolvedTransitions.some((t) => isXfadeTransition(t.type));
    let composedSegFiles = segFiles;

    if (hasXfadeTransitions && segFiles.length >= 2) {
      onStage?.('Compositing transitions…');
      phaseStart = 80;
      phaseSpan = 8;

      // Build clip durations array (after speed adjustment)
      const clipDurations = clips.map((clip) => clip.sourceDuration / (clip.speed > 0 ? clip.speed : 1));

      // Apply xfade transitions progressively: chain [seg0, seg1] → [x0, seg2] → [x1, seg3] etc.
      let currentFile = segFiles[0];
      let currentDuration = clipDurations[0];

      for (let i = 0; i < clips.length - 1; i++) {
        const transition = transitionOutByClipId.get(clips[i].id);
        const nextFile = segFiles[i + 1];
        const nextDuration = clipDurations[i + 1];

        if (transition && isXfadeTransition(transition.type)) {
          const xfadeName = getXfadeTransitionName(transition.type);
          const xfadeDuration = Math.min(transition.duration, currentDuration - 0.01, nextDuration - 0.01);
          const xfadeOffset = Math.max(0, currentDuration - xfadeDuration);
          const outputName = `export_xfade_${i}.mp4`;

          await execOrThrow(ffmpeg, [
            '-i', currentFile,
            '-i', nextFile,
            '-filter_complex',
            `[0:v][1:v]xfade=transition=${xfadeName}:duration=${xfadeDuration.toFixed(3)}:offset=${xfadeOffset.toFixed(3)}[v];` +
            `[0:a][1:a]acrossfade=d=${xfadeDuration.toFixed(3)}[a]`,
            '-map', '[v]',
            '-map', '[a]',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-pix_fmt', 'yuv420p',
            '-r', '30',
            '-c:a', 'aac',
            '-ar', '48000',
            '-ac', '2',
            outputName,
          ]);

          // Clean up previous intermediate file
          if (currentFile.startsWith('export_xfade_')) {
            try { await ffmpeg.deleteFile(currentFile); } catch {}
          }
          currentFile = outputName;
          currentDuration = currentDuration + nextDuration - xfadeDuration;
        } else {
          // No xfade transition — these will be concat'd normally
          // We need to concat currentFile with nextFile first
          const concatName = `export_concat_${i}.mp4`;
          const concatList = `file '${currentFile}'\nfile '${nextFile}'`;
          await ffmpeg.writeFile(`concat_${i}.txt`, new TextEncoder().encode(concatList));
          await execOrThrow(ffmpeg, [
            '-f', 'concat',
            '-safe', '0',
            '-i', `concat_${i}.txt`,
            '-c', 'copy',
            concatName,
          ]);
          if (currentFile.startsWith('export_xfade_') || currentFile.startsWith('export_concat_')) {
            try { await ffmpeg.deleteFile(currentFile); } catch {}
          }
          try { await ffmpeg.deleteFile(`concat_${i}.txt`); } catch {}
          currentFile = concatName;
          currentDuration = currentDuration + nextDuration;
        }
      }

      composedSegFiles = [currentFile];
    }

    let stitchedOutputName = composedSegFiles[0];
    if (composedSegFiles.length > 1) {
      phaseStart = 88;
      phaseSpan = (captionWindows.length > 0 || normalizedTextOverlays.length > 0) ? 3 : 8;
      onStage?.('Concatenating clips…');
      const concatContent = composedSegFiles.map((file) => `file '${file}'`).join('\n');
      const encoder = new TextEncoder();
      stitchedOutputName = (captionWindows.length > 0 || normalizedTextOverlays.length > 0) ? 'export_stitched.mp4' : 'export_output.mp4';
      await ffmpeg.writeFile('export_concat.txt', encoder.encode(concatContent));
      await execOrThrow(ffmpeg, [
        '-f', 'concat',
        '-safe', '0',
        '-i', 'export_concat.txt',
        '-c', 'copy',
        ...((captionWindows.length > 0 || normalizedTextOverlays.length > 0) ? [] : ['-movflags', '+faststart']),
        stitchedOutputName,
      ]);
    }

    if (captionWindows.length > 0 || normalizedTextOverlays.length > 0) {
      phaseStart = segFiles.length > 1 ? 93 : 90;
      phaseSpan = 6;
      onStage?.('Rendering timeline overlays…');
      const captionFilters = captionWindows.length > 0
        ? await writeCaptionTextFiles(ffmpeg, captionWindows)
        : [];
      const textOverlayFilters = normalizedTextOverlays.length > 0
        ? await writeTextOverlayTextFiles(ffmpeg, normalizedTextOverlays, targetHeight)
        : [];
      await execOrThrow(ffmpeg, [
        '-i', stitchedOutputName,
        '-vf', [...captionFilters, ...textOverlayFilters].join(','),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        'export_output.mp4',
      ]);
      return finalizeExport(ffmpeg, 'export_output.mp4');
    }

    if (stitchedOutputName === 'export_output.mp4') {
      return finalizeExport(ffmpeg, 'export_output.mp4');
    }

    return finalizeExport(ffmpeg, stitchedOutputName);
  } catch (error) {
    if (isFFmpegAbortError(error)) {
      throw createAbortError();
    }
    throw error;
  } finally {
    job.cleanup();
    progressHandler = null;
  }
}

export async function extractVideoFrames(
  fileOrUrl: Uint8Array | File | string,
  timestamps: number[],
  options: {
    concurrency?: number;
    onProgress?: (progress: { completed: number; total: number }) => void;
  } = {},
): Promise<string[]> {
  if (timestamps.length === 0) return [];

  // Use browser-native video + Canvas — avoids loading the file into WASM memory entirely.
  let objectUrl: string | null = null;
  let fallbackObjectUrl: string | null = null;
  let srcUrl: string;

  if (fileOrUrl instanceof Uint8Array) {
    const buffer = new ArrayBuffer(fileOrUrl.byteLength);
    new Uint8Array(buffer).set(fileOrUrl);
    const blob = new Blob([buffer], { type: 'video/mp4' });
    objectUrl = URL.createObjectURL(blob);
    srcUrl = objectUrl;
  } else if (fileOrUrl instanceof File) {
    objectUrl = URL.createObjectURL(fileOrUrl);
    srcUrl = objectUrl;
  } else {
    srcUrl = fileOrUrl;
  }

  const loadMetadata = async (video: HTMLVideoElement, url: string) => {
    await new Promise<void>((resolve, reject) => {
      const handleLoadedMetadata = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error('Failed to load video for frame extraction'));
      };
      const cleanup = () => {
        clearTimeout(timeoutId);
        video.removeEventListener('loadedmetadata', handleLoadedMetadata);
        video.removeEventListener('error', handleError);
      };
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error('Video metadata load timed out'));
      }, 20_000);

      video.addEventListener('loadedmetadata', handleLoadedMetadata);
      video.addEventListener('error', handleError);
      video.src = url;
      video.load();
    });
  };

  const createWorker = async (url: string) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas context unavailable for frame extraction');
    }

    await loadMetadata(video, url);
    const maxSeekTime = Math.max(video.duration - 0.05, 0);

    return {
      maxSeekTime,
      async extractFrame(time: number) {
        await new Promise<void>((resolve, reject) => {
          const handleSeeked = () => {
            cleanup();
            resolve();
          };
          const handleError = () => {
            cleanup();
            reject(new Error(`Seek failed at ${time}s`));
          };
          const cleanup = () => {
            clearTimeout(timeoutId);
            video.removeEventListener('seeked', handleSeeked);
            video.removeEventListener('error', handleError);
          };
          const timeoutId = window.setTimeout(() => {
            cleanup();
            reject(new Error(`Seek timeout at ${time}s`));
          }, 30000);

          video.addEventListener('seeked', handleSeeked, { once: true });
          video.addEventListener('error', handleError, { once: true });
          video.currentTime = Math.max(0, Math.min(time, maxSeekTime));
        });

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
      },
      dispose() {
        video.src = '';
        video.load();
      },
    };
  };

  let workers: Array<{
    extractFrame: (time: number) => Promise<string>;
    dispose: () => void;
  }> = [];

  try {
    const probeVideo = document.createElement('video');
    probeVideo.muted = true;
    probeVideo.preload = 'metadata';
    probeVideo.playsInline = true;
    probeVideo.crossOrigin = 'anonymous';

    try {
      await loadMetadata(probeVideo, srcUrl);
    } catch (error) {
      if (typeof fileOrUrl !== 'string') throw error;
      const response = await fetch(fileOrUrl);
      if (!response.ok) throw error;
      const blob = await response.blob();
      fallbackObjectUrl = URL.createObjectURL(blob);
      srcUrl = fallbackObjectUrl;
      await loadMetadata(probeVideo, srcUrl);
    } finally {
      probeVideo.src = '';
      probeVideo.load();
    }

    // After the probe succeeds, download remote URLs to a local blob
    // so seeks are instant (in-memory) rather than making hundreds of
    // range requests to Supabase storage.
    // Use readMediaInput so the download is shared with any concurrent
    // FFmpeg audio extraction, avoiding two parallel full-video fetches.
    if (typeof fileOrUrl === 'string' && /^https?:\/\//.test(srcUrl)) {
      try {
        const bytes = await readMediaInput(fileOrUrl);
        const blob = new Blob([bytes.buffer as ArrayBuffer]);
        fallbackObjectUrl = URL.createObjectURL(blob);
        srcUrl = fallbackObjectUrl;
      } catch {
        // Keep srcUrl as the remote URL; seeks will fall back to range requests.
      }
    }

    const hardwareConcurrency = typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 4;
    const defaultConcurrency = Math.max(1, Math.min(4, Math.floor(hardwareConcurrency / 4) || 2));
    const workerCount = Math.min(
      timestamps.length,
      Math.max(1, Math.floor(options.concurrency ?? defaultConcurrency)),
    );

    workers = await Promise.all(Array.from({ length: workerCount }, () => createWorker(srcUrl)));
    const frames = new Array<string>(timestamps.length);
    let nextIndex = 0;
    let completed = 0;

    await Promise.all(workers.map(async (worker) => {
      for (;;) {
        const currentIndex = nextIndex;
        if (currentIndex >= timestamps.length) return;
        nextIndex += 1;
        frames[currentIndex] = await worker.extractFrame(timestamps[currentIndex]);
        completed += 1;
        options.onProgress?.({ completed, total: timestamps.length });
        // Yield to the event loop so the browser can process other tasks
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }));
    return frames;
  } finally {
    workers.forEach((worker) => worker.dispose());
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (fallbackObjectUrl) URL.revokeObjectURL(fallbackObjectUrl);
  }
}
