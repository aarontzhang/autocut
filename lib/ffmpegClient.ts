'use client';

import { FFmpeg } from '@ffmpeg/ffmpeg';

import { invertSegments } from './timelineUtils';
import { VideoClip } from './types';

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<void> | null = null;
let progressHandler: ((progress: number) => void) | null = null;
let activeJobCancel: (() => void) | null = null;
const remoteMediaInputCache = new Map<string, Promise<Uint8Array>>();
const fileDataCache = new WeakMap<File, Promise<Uint8Array>>();
let lastWrittenInputKey: string | null = null;

function getSourceKey(fileOrUrl: Uint8Array | File | string): string | null {
  if (typeof fileOrUrl === 'string') return `url:${fileOrUrl}`;
  if (fileOrUrl instanceof File) return `file:${fileOrUrl.name}:${fileOrUrl.size}:${fileOrUrl.lastModified}`;
  return null;
}

function createAbortError() {
  return new DOMException('Export canceled.', 'AbortError');
}

export function resetFFmpeg() {
  ffmpegInstance = null;
  loadPromise = null;
  progressHandler = null;
  lastWrittenInputKey = null;
}

async function getFFmpeg(onProgress?: (progress: number) => void): Promise<FFmpeg> {
  progressHandler = onProgress ?? null;

  if (ffmpegInstance && loadPromise) {
    await loadPromise;
    return ffmpegInstance;
  }

  ffmpegInstance = new FFmpeg();

  ffmpegInstance.on('progress', ({ progress }) => {
    progressHandler?.(Math.round(progress * 100));
  });

  loadPromise = (async () => {
    const base = window.location.origin + '/ffmpeg';
    // classWorkerURL bypasses Turbopack's static-analysis restriction.
    // All files served from same origin — no CORS/COEP issues, no toBlobURL needed.
    await ffmpegInstance!.load({
      classWorkerURL: `${base}/worker.js`,
      coreURL: `${base}/ffmpeg-core.js`,
      wasmURL: `${base}/ffmpeg-core.wasm`,
    });
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
      pending = fileOrUrl.arrayBuffer().then((buf) => new Uint8Array(buf as ArrayBuffer));
      fileDataCache.set(fileOrUrl, pending);
    }
    return pending;
  }
  const cached = remoteMediaInputCache.get(fileOrUrl);
  if (cached) {
    return cached;
  }

  const pendingBytes = (async () => {
    const response = await fetch(fileOrUrl);
    if (!response.ok) {
      throw new Error(`Failed to load media source (${response.status}).`);
    }
    return new Uint8Array(await response.arrayBuffer() as ArrayBuffer);
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
  const exitCode = await ffmpeg.exec(args);
  if (exitCode !== 0) {
    throw new Error(`FFmpeg exited with code ${exitCode}.`);
  }
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

function getClipExportState(clip: VideoClip) {
  return {
    speed: Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1,
    volume: Number.isFinite(clip.volume) ? clip.volume : 1,
    fadeIn: Number.isFinite(clip.fadeIn) ? clip.fadeIn : 0,
    fadeOut: Number.isFinite(clip.fadeOut) ? clip.fadeOut : 0,
    filter: clip.filter ?? null,
  };
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

export async function extractAudioSegment(
  fileOrUrl: Uint8Array | File | string,
  startTime: number,
  endTime: number,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const inputKey = getSourceKey(fileOrUrl);
  if (inputKey === null || inputKey !== lastWrittenInputKey) {
    const inputBytes = await readMediaInput(fileOrUrl);
    try { await ffmpeg.deleteFile('input_audio'); } catch { /* doesn't exist, fine */ }
    await ffmpeg.writeFile('input_audio', inputBytes);
    lastWrittenInputKey = inputKey;
  }
  try { await ffmpeg.deleteFile('audio_out.mp3'); } catch { /* doesn't exist, fine */ }

  try {
    await ffmpeg.exec([
      '-ss', String(startTime),
      '-to', String(endTime),
      '-i', 'input_audio',
      '-vn',          // strip video
      '-ar', '16000', // 16kHz — Whisper's preferred rate
      '-ac', '1',     // mono
      '-f', 'mp3',
      'audio_out.mp3',
    ]);

    const outputData = await ffmpeg.readFile('audio_out.mp3');
    return new Blob([outputData as unknown as ArrayBuffer], { type: 'audio/mpeg' });
  } catch (err) {
    resetFFmpeg();
    throw err;
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
  await ffmpeg.writeFile(inputName, inputData);

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
  source: Uint8Array | File | string;
  clips: VideoClip[];
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onProgress?: (progress: number) => void;
}

export async function exportClips({
  source,
  clips,
  signal,
  onStage,
  onProgress,
}: ExportClipsOptions): Promise<string> {
  if (clips.length === 0) throw new Error('No clips to export');

  const job = createFFmpegJobHandle(signal);
  const reportOverallProgress = createOverallProgressReporter(onProgress);
  let phaseStart = 0;
  let phaseSpan = 5;

  try {
    onStage?.('Loading FFmpeg…');
    const ffmpeg = await getFFmpeg((progress) => {
      reportOverallProgress(phaseStart + (phaseSpan * progress) / 100);
    });
    job.throwIfCancelled();
    reportOverallProgress(5);

    if (clips.every(isPlainCutClip)) {
      const mergedClips = mergeAdjacentCopyClips(clips);
      const inputName = 'input_export_fast.mp4';

      onStage?.('Reading source media…');
      const inputData = await readMediaInput(source);
      job.throwIfCancelled();
      await ffmpeg.writeFile(inputName, inputData);
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
        onStage?.('Preparing download…');
        reportOverallProgress(98);
        const data = await ffmpeg.readFile(segFiles[0]);
        reportOverallProgress(100);
        const blob = new Blob([data as unknown as ArrayBuffer], { type: 'video/mp4' });
        return URL.createObjectURL(blob);
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

      onStage?.('Preparing download…');
      reportOverallProgress(98);
      const data = await ffmpeg.readFile('export_output.mp4');
      reportOverallProgress(100);
      const blob = new Blob([data as unknown as ArrayBuffer], { type: 'video/mp4' });
      return URL.createObjectURL(blob);
    }

    onStage?.('Reading source media…');
    const inputName = 'input_export.mp4';
    const [inputData, dimensions] = await Promise.all([
      readMediaInput(source),
      probeMediaInput(source).catch(() => ({ width: 0, height: 0 })),
    ]);
    job.throwIfCancelled();
    await ffmpeg.writeFile(inputName, inputData);
    reportOverallProgress(15);

    const targetWidth = toEvenDimension(dimensions.width || 1280, 1280);
    const targetHeight = toEvenDimension(dimensions.height || 720, 720);

    onStage?.('Processing clips…');
    const segFiles: string[] = [];
    const processingSpan = clips.length > 0 ? 75 / clips.length : 75;

    for (let i = 0; i < clips.length; i++) {
      job.throwIfCancelled();
      const clip = clips[i];
      const clipState = getClipExportState(clip);
      const segName = `export_seg${i}.mp4`;

      const vFilters: string[] = [];
      const aFilters: string[] = [];

      if (clipState.speed !== 1.0) {
        vFilters.push(`setpts=(PTS-STARTPTS)/${clipState.speed}`);
        let remainingSpeed = clipState.speed;
        const atempoChain: string[] = [];
        while (remainingSpeed > 2.0) {
          atempoChain.push('atempo=2.0');
          remainingSpeed /= 2.0;
        }
        while (remainingSpeed < 0.5) {
          atempoChain.push('atempo=0.5');
          remainingSpeed /= 0.5;
        }
        atempoChain.push(`atempo=${remainingSpeed.toFixed(4)}`);
        aFilters.push(...atempoChain);
      } else {
        vFilters.push('setpts=PTS-STARTPTS');
      }

      if (clipState.volume !== 1.0) {
        aFilters.push(`volume=${clipState.volume.toFixed(3)}`);
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

      vFilters.push(
        `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease`,
        `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`,
        'setsar=1',
        'fps=30',
        'format=yuv420p',
      );

      if (aFilters.length > 0) {
        aFilters.unshift('asetpts=PTS-STARTPTS');
      }

      const args: string[] = [
        '-ss', String(clip.sourceStart),
        '-t', String(clip.sourceDuration),
        '-i', inputName,
      ];

      if (vFilters.length > 0) {
        args.push('-vf', vFilters.join(','));
      }
      if (aFilters.length > 0) {
        args.push('-af', aFilters.join(','));
      }

      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        '-avoid_negative_ts', 'make_zero',
        segName,
      );

      phaseStart = 15 + (processingSpan * i);
      phaseSpan = processingSpan;
      onStage?.(`Processing clip ${i + 1} of ${clips.length}…`);
      await execOrThrow(ffmpeg, args);
      segFiles.push(segName);
      reportOverallProgress(phaseStart + phaseSpan);
    }

    if (segFiles.length === 1) {
      onStage?.('Preparing download…');
      reportOverallProgress(98);
      const data = await ffmpeg.readFile(segFiles[0]);
      reportOverallProgress(100);
      const blob = new Blob([data as unknown as ArrayBuffer], { type: 'video/mp4' });
      return URL.createObjectURL(blob);
    }

    phaseStart = 90;
    phaseSpan = 8;
    onStage?.('Concatenating clips…');
    const concatContent = segFiles.map((file) => `file '${file}'`).join('\n');
    const encoder = new TextEncoder();
    await ffmpeg.writeFile('export_concat.txt', encoder.encode(concatContent));
    await execOrThrow(ffmpeg, [
      '-f', 'concat',
      '-safe', '0',
      '-i', 'export_concat.txt',
      '-c', 'copy',
      '-movflags', '+faststart',
      'export_output.mp4',
    ]);

    onStage?.('Preparing download…');
    reportOverallProgress(98);
    const data = await ffmpeg.readFile('export_output.mp4');
    reportOverallProgress(100);
    const blob = new Blob([data as unknown as ArrayBuffer], { type: 'video/mp4' });
    return URL.createObjectURL(blob);
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
        video.removeEventListener('loadedmetadata', handleLoadedMetadata);
        video.removeEventListener('error', handleError);
      };

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
    if (typeof fileOrUrl === 'string' && /^https?:\/\//.test(srcUrl)) {
      const response = await fetch(srcUrl);
      if (response.ok) {
        const blob = await response.blob();
        fallbackObjectUrl = URL.createObjectURL(blob);
        srcUrl = fallbackObjectUrl;
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
