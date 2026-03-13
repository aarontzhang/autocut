'use client';

import { FFmpeg } from '@ffmpeg/ffmpeg';

import { invertSegments } from './timelineUtils';
import { VideoClip } from './types';

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<void> | null = null;

export function resetFFmpeg() {
  ffmpegInstance = null;
  loadPromise = null;
}

async function getFFmpeg(onProgress?: (progress: number) => void): Promise<FFmpeg> {
  if (ffmpegInstance && loadPromise) {
    await loadPromise;
    return ffmpegInstance;
  }

  ffmpegInstance = new FFmpeg();

  if (onProgress) {
    ffmpegInstance.on('progress', ({ progress }) => {
      onProgress(Math.round(progress * 100));
    });
  }

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

export async function extractAudioSegment(
  fileOrUrl: Uint8Array | File | string,
  startTime: number,
  endTime: number,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  let inputBytes: Uint8Array;
  if (fileOrUrl instanceof Uint8Array) {
    inputBytes = fileOrUrl;
  } else if (fileOrUrl instanceof File) {
    inputBytes = new Uint8Array(await fileOrUrl.arrayBuffer() as ArrayBuffer);
  } else {
    inputBytes = new Uint8Array(await fetch(fileOrUrl).then(r => r.arrayBuffer()) as ArrayBuffer);
  }
  try { await ffmpeg.deleteFile('input_audio'); } catch { /* doesn't exist, fine */ }
  try { await ffmpeg.deleteFile('audio_out.mp3'); } catch { /* doesn't exist, fine */ }
  await ffmpeg.writeFile('input_audio', inputBytes);

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
  let inputData: Uint8Array;
  if (fileUrl instanceof Uint8Array) {
    inputData = fileUrl;
  } else if (fileUrl instanceof File) {
    inputData = new Uint8Array(await fileUrl.arrayBuffer() as ArrayBuffer);
  } else {
    inputData = new Uint8Array(await fetch(fileUrl).then(r => r.arrayBuffer()) as ArrayBuffer);
  }
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
  fileUrl: Uint8Array | File | string;
  clips: VideoClip[];
  onStage?: (stage: string) => void;
  onProgress?: (progress: number) => void;
}

export async function exportClips({
  fileUrl,
  clips,
  onStage,
  onProgress,
}: ExportClipsOptions): Promise<string> {
  if (clips.length === 0) throw new Error('No clips to export');

  onStage?.('Loading FFmpeg…');
  const ffmpeg = await getFFmpeg(onProgress);

  onStage?.('Reading file…');
  const inputName = 'input_export.mp4';
  let inputData: Uint8Array;
  if (fileUrl instanceof Uint8Array) {
    inputData = fileUrl;
  } else if (fileUrl instanceof File) {
    inputData = new Uint8Array(await fileUrl.arrayBuffer() as ArrayBuffer);
  } else {
    inputData = new Uint8Array(await fetch(fileUrl).then(r => r.arrayBuffer()) as ArrayBuffer);
  }
  await ffmpeg.writeFile(inputName, inputData);

  onStage?.('Processing clips…');
  const segFiles: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const segName = `export_seg${i}.mp4`;

    // Build video filter chain
    const vFilters: string[] = [];
    const aFilters: string[] = [];

    if (clip.speed !== 1.0) {
      vFilters.push(`setpts=${1/clip.speed}*PTS`);
      // atempo must be in range 0.5–2.0; chain for values outside that range
      let remainingSpeed = clip.speed;
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
    }

    if (clip.volume !== 1.0) {
      aFilters.push(`volume=${clip.volume.toFixed(3)}`);
    }

    if (clip.filter && clip.filter.type !== 'none') {
      const filterMap: Record<string, string> = {
        cinematic: 'eq=contrast=1.2:saturation=0.8:brightness=-0.05',
        vintage: 'eq=contrast=1.1:saturation=0.7:brightness=0.05,hue=s=0.7',
        warm: 'eq=saturation=1.2:brightness=0.05,colorchannelmixer=rr=1.1:bb=0.9',
        cool: 'eq=saturation=1.1,colorchannelmixer=rr=0.9:bb=1.1',
        bw: 'hue=s=0',
      };
      const f = filterMap[clip.filter.type];
      if (f) vFilters.push(f);
    }

    const args: string[] = [
      '-ss', String(clip.sourceStart),
      '-t', String(clip.sourceDuration),
      '-i', inputName,
    ];

    if (vFilters.length > 0 || aFilters.length > 0) {
      // Need re-encode
      if (vFilters.length > 0) {
        args.push('-vf', vFilters.join(','));
      }
      if (aFilters.length > 0) {
        args.push('-af', aFilters.join(','));
      }
      args.push('-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast');
    } else {
      // Stream copy — fast
      args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
    }

    args.push(segName);
    await ffmpeg.exec(args);
    segFiles.push(segName);
  }

  onStage?.('Concatenating…');

  if (segFiles.length === 1) {
    const data = await ffmpeg.readFile(segFiles[0]);
    const blob = new Blob([data as unknown as ArrayBuffer], { type: 'video/mp4' });
    return URL.createObjectURL(blob);
  }

  const concatContent = segFiles.map(f => `file '${f}'`).join('\n');
  const encoder = new TextEncoder();
  await ffmpeg.writeFile('export_concat.txt', encoder.encode(concatContent));

  await ffmpeg.exec([
    '-f', 'concat',
    '-safe', '0',
    '-i', 'export_concat.txt',
    '-c', 'copy',
    'export_output.mp4',
  ]);

  onStage?.('Preparing download…');
  const data = await ffmpeg.readFile('export_output.mp4');
  const blob = new Blob([data as unknown as ArrayBuffer], { type: 'video/mp4' });
  return URL.createObjectURL(blob);
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
          }, 8000);

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

    const hardwareConcurrency = typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 4;
    const defaultConcurrency = Math.max(2, Math.min(8, Math.floor(hardwareConcurrency / 2) || 4));
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
      }
    }));
    return frames;
  } finally {
    workers.forEach((worker) => worker.dispose());
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (fallbackObjectUrl) URL.revokeObjectURL(fallbackObjectUrl);
  }
}
