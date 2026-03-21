import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import jpeg from 'jpeg-js';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase environment variables for the analysis worker.');
}

if (!OPENAI_API_KEY) {
  throw new Error('Missing OPENAI_API_KEY for the analysis worker.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const HOST_PARALLELISM = typeof os.availableParallelism === 'function'
  ? os.availableParallelism()
  : Math.max(os.cpus().length, 1);
const DEFAULT_WORKER_CONCURRENCY = Math.min(8, Math.max(2, Math.floor(HOST_PARALLELISM / 2)));
const DEFAULT_INDEX_CONCURRENCY = Math.min(6, Math.max(2, Math.floor(HOST_PARALLELISM / 2)));
const DEFAULT_DESCRIPTION_CONCURRENCY = 2;

const WORKER_ID = process.env.ANALYSIS_WORKER_ID?.trim() || `analysis-worker:${process.pid}`;
const POLL_INTERVAL_MS = normalizeInteger(process.env.ANALYSIS_WORKER_POLL_MS, 3000, 500, 60_000);
const WORKER_CONCURRENCY = normalizeInteger(process.env.ANALYSIS_WORKER_CONCURRENCY, DEFAULT_WORKER_CONCURRENCY, 1, 8);
const INDEX_SELECTION_CONCURRENCY = normalizeInteger(process.env.ANALYSIS_INDEX_SEGMENT_CONCURRENCY, DEFAULT_INDEX_CONCURRENCY, 1, 8);
const DESCRIPTION_BATCH_CONCURRENCY = normalizeInteger(process.env.ANALYSIS_INDEX_DESCRIPTION_CONCURRENCY, DEFAULT_DESCRIPTION_CONCURRENCY, 1, 4);
const FRAME_DESCRIPTION_TIMEOUT_MS = 45_000;
const FRAME_DESCRIPTION_MAX_RETRIES = 2;
const FRAME_DESCRIPTION_UNAVAILABLE = 'Visual summary unavailable.';
const TRANSCRIPT_CHUNK_SECONDS = 45;
const TRANSCRIPT_OVERLAP_SECONDS = 0.75;
const FRAME_BATCH_SIZE = 8;
const DEFAULT_LONG_INTERVAL_SECONDS = 5;
const DEFAULT_MAX_COARSE_FRAMES = 720;

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSlotWorkerId(slotIndex) {
  return WORKER_CONCURRENCY === 1 ? WORKER_ID : `${WORKER_ID}:${slotIndex + 1}`;
}

async function runWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) return [];

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const results = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }));

  return results;
}

function getAdaptiveCoarseFrameBudget(duration, preferredLongIntervalSeconds, maxCoarseFrames) {
  if (duration <= 0 || maxCoarseFrames <= 0) return 0;
  const longVideoInterval = Math.max(0.5, preferredLongIntervalSeconds);
  const shortVideoInterval = Math.max(0.35, Math.min(longVideoInterval, longVideoInterval * 0.22));
  const taper = 1 - Math.exp(-Math.max(duration, 0) / 180);
  const averageSpacing = shortVideoInterval + (longVideoInterval - shortVideoInterval) * taper;
  return Math.max(1, Math.min(maxCoarseFrames, Math.floor(duration / averageSpacing) + 1));
}

function buildCoarseRepresentativeWindows(duration, preferredLongIntervalSeconds, maxCoarseFrames) {
  const budget = getAdaptiveCoarseFrameBudget(duration, preferredLongIntervalSeconds, maxCoarseFrames);
  if (budget <= 0) return [];
  const windowDuration = duration / budget;
  return Array.from({ length: budget }, (_, index) => {
    const startTime = index * windowDuration;
    const endTime = index === budget - 1 ? duration : Math.min(duration, (index + 1) * windowDuration);
    return {
      index,
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
    };
  }).filter((window) => window.duration > 0);
}

function buildRepresentativeCandidateTimes(window, sceneChangeTimes = []) {
  const edgeInset = Math.min(0.35, Math.max(0.08, window.duration * 0.18));
  const baseCandidates = window.duration <= 2.5
    ? [window.startTime + window.duration / 2]
    : [
        window.startTime + edgeInset,
        window.startTime + window.duration / 2,
        window.endTime - edgeInset,
      ];
  const sceneCandidates = sceneChangeTimes
    .filter((time) => time >= window.startTime && time < window.endTime)
    .map((time) => Math.min(window.endTime - 0.05, Math.max(window.startTime + 0.05, time + 0.18)));
  const deduped = [];
  for (const candidate of [...baseCandidates, ...sceneCandidates]) {
    const clamped = Math.max(window.startTime + 0.01, Math.min(candidate, window.endTime - 0.01));
    if (!Number.isFinite(clamped)) continue;
    if (deduped.some((existing) => Math.abs(existing - clamped) < 0.12)) continue;
    deduped.push(clamped);
  }
  return deduped.sort((a, b) => a - b);
}

function buildOverlappingRanges(startTime, endTime, chunkDuration = TRANSCRIPT_CHUNK_SECONDS, overlapSeconds = TRANSCRIPT_OVERLAP_SECONDS) {
  const ranges = [];
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

function parseFrameDescriptions(text) {
  const normalized = String(text ?? '').trim();
  const candidates = [
    normalized,
    normalized.replace(/^```json\s*/i, '').replace(/\s*```$/, ''),
    normalized.replace(/^```\s*/i, '').replace(/\s*```$/, ''),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const frames = Array.isArray(parsed) ? parsed : parsed.frames;
      if (!Array.isArray(frames)) continue;
      return frames
        .filter((entry) => typeof entry?.index === 'number' && typeof entry?.description === 'string')
        .map((entry) => ({
          index: entry.index,
          description: entry.description.trim(),
        }));
    } catch {}
  }
  return null;
}

function parseScdetTimestamps(stderr) {
  const times = [];
  const regex = /scdet:([\d.]+)/g;
  let match;
  while ((match = regex.exec(stderr)) !== null) {
    const t = parseFloat(match[1]);
    if (Number.isFinite(t)) times.push(t);
  }
  return times.sort((a, b) => a - b);
}

function timestampsToSceneBoundaries(timestamps, sourceDuration, minSceneDurationSeconds = 1) {
  const starts = [0, ...timestamps].filter((time, index, arr) => {
    if (index === 0) return true;
    return time - arr[index - 1] >= minSceneDurationSeconds;
  });
  return starts.map((start, index) => ({
    id: `scene_${randomUUID().slice(0, 8)}`,
    sourceStart: start,
    sourceEnd: starts[index + 1] ?? sourceDuration,
  }));
}

function nearestDistanceToSceneBoundary(sourceTime, sceneChangeTimes) {
  if (sceneChangeTimes.length === 0) return Infinity;
  let nearest = Infinity;
  for (const sceneTime of sceneChangeTimes) {
    nearest = Math.min(nearest, Math.abs(sceneTime - sourceTime));
  }
  return nearest;
}

function findSceneForTime(sourceTime, scenes) {
  return scenes.find((scene) => sourceTime >= scene.sourceStart && sourceTime < scene.sourceEnd) ?? null;
}

function scoreFrameMetrics(metrics, sceneBoundaryDistanceSeconds) {
  const exposureScore = 1 - Math.min(1, Math.abs(metrics.brightness - 0.52) / 0.52);
  const washedOutPenalty = metrics.contrast < 0.16 ? (0.16 - metrics.contrast) / 0.16 : 0;
  const transitionPenalty = sceneBoundaryDistanceSeconds < 0.18
    ? 1 - sceneBoundaryDistanceSeconds / 0.18
    : 0;
  const score = (
    metrics.sharpness * 0.36 +
    metrics.edgeDensity * 0.22 +
    metrics.textUiScore * 0.16 +
    exposureScore * 0.18 +
    metrics.contrast * 0.08 -
    metrics.darknessScore * 0.18 -
    washedOutPenalty * 0.12 -
    transitionPenalty * 0.45
  );
  return Number(score.toFixed(4));
}

function analyzeJpegMetrics(jpegBuffer) {
  const decoded = jpeg.decode(jpegBuffer, { useTArray: true });
  const { width, height, data } = decoded;
  const pixelCount = Math.max(1, width * height);
  const gray = new Float32Array(pixelCount);
  let brightnessSum = 0;
  let brightnessSqSum = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
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
      const magnitude = gx + gy;
      edgeSum += laplacian;
      if (magnitude > 0.18) strongEdges += 1;
      if (gx > 0.12 && gy < 0.08) horizontalLineEvidence += 1;
    }
  }

  const edgeDensity = Math.min(1, strongEdges / pixelCount * 8);
  const sharpness = Math.min(1, edgeSum / pixelCount * 3.5);
  const darknessScore = brightness < 0.16 ? (0.16 - brightness) / 0.16 : 0;
  const textUiScore = Math.min(1, horizontalLineEvidence / pixelCount * 18 + edgeDensity * 0.35);

  return {
    brightness: Number(brightness.toFixed(4)),
    contrast: Number(contrast.toFixed(4)),
    edgeDensity: Number(edgeDensity.toFixed(4)),
    sharpness: Number(sharpness.toFixed(4)),
    darknessScore: Number(darknessScore.toFixed(4)),
    textUiScore: Number(textUiScore.toFixed(4)),
  };
}

async function updateJob(jobId, patch) {
  const { error } = await supabase
    .from('analysis_jobs')
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
  if (error) throw error;
}

async function updateProgress(jobId, stage, completed, total, label, etaSeconds = null) {
  await updateJob(jobId, {
    progress: {
      stage,
      completed,
      total: Math.max(1, total),
      label,
      etaSeconds,
    },
  });
}

async function setAssetStatus(assetId, patch) {
  const { error } = await supabase
    .from('media_assets')
    .update(patch)
    .eq('id', assetId);
  if (error) throw error;
}

async function claimNextJob(lockerId) {
  const { data: queuedJobs, error } = await supabase
    .from('analysis_jobs')
    .select('id, project_id, asset_id, payload, attempt_count')
    .eq('job_type', 'index_asset')
    .eq('status', 'queued')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(Math.max(1, WORKER_CONCURRENCY * 3));
  if (error) throw error;
  if (!queuedJobs?.length) return null;

  for (const job of queuedJobs) {
    const { data: claimed, error: claimError } = await supabase
      .from('analysis_jobs')
      .update({
        status: 'running',
        attempt_count: Number(job.attempt_count ?? 0) + 1,
        locked_at: new Date().toISOString(),
        locked_by: lockerId,
        error: null,
        progress: {
          stage: 'preparing_media',
          completed: 0,
          total: 1,
          label: 'Preparing media',
          etaSeconds: null,
        },
      })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id, project_id, asset_id, payload')
      .maybeSingle();

    if (claimError) throw claimError;
    if (claimed) return claimed;
  }

  return null;
}

async function getAssetForJob(job) {
  const { data: asset, error } = await supabase
    .from('media_assets')
    .select('id, project_id, storage_path, duration_seconds, fps, width, height')
    .eq('id', job.asset_id)
    .maybeSingle();
  if (error) throw error;
  if (!asset) throw new Error(`Asset ${job.asset_id} not found for analysis job ${job.id}.`);
  return asset;
}

async function downloadAssetToTemp(storagePath) {
  const { data, error } = await supabase.storage.from('videos').download(storagePath);
  if (error || !data) {
    throw error ?? new Error(`Failed to download ${storagePath}.`);
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-analysis-'));
  const inputPath = path.join(tempDir, path.basename(storagePath) || 'input.mp4');
  const arrayBuffer = await data.arrayBuffer();
  await fs.writeFile(inputPath, Buffer.from(arrayBuffer));
  return { tempDir, inputPath };
}

async function ffprobeVideo(inputPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate',
    inputPath,
  ]);
  const parsed = JSON.parse(stdout);
  const videoStream = (parsed.streams ?? []).find((stream) => stream.codec_type === 'video') ?? {};
  const duration = Number(parsed.format?.duration ?? 0);
  const fps = (() => {
    const rate = String(videoStream.r_frame_rate ?? '0/1');
    const [num, den] = rate.split('/').map(Number);
    return den > 0 ? num / den : 0;
  })();
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: Number(videoStream.width ?? 0) || 0,
    height: Number(videoStream.height ?? 0) || 0,
    fps: Number.isFinite(fps) ? fps : 0,
  };
}

async function extractAudioChunk(inputPath, range, outputPath) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', range.startTime.toFixed(3),
    '-to', range.endTime.toFixed(3),
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'mp3',
    outputPath,
  ]);
}

async function transcribeAudioChunk(audioPath, rangeStartTime) {
  const transcription = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
  });
  return (transcription.words ?? [])
    .map((word) => {
      const text = String(word.word ?? '').trim();
      if (!text) return null;
      return {
        start_time: rangeStartTime + Number(word.start ?? 0),
        end_time: rangeStartTime + Number(word.end ?? 0),
        text,
        confidence: null,
      };
    })
    .filter(Boolean);
}

async function detectScenes(inputPath, sourceDuration) {
  const stderrChunks = [];
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-i', inputPath,
      '-vf', 'scdet=threshold=0.3:sc_pass=0',
      '-an',
      '-f', 'null',
      '-',
    ]);
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(String(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || code === 1) resolve();
      else reject(new Error(`ffmpeg scene detect exited with code ${code}`));
    });
  });
  const timestamps = parseScdetTimestamps(stderrChunks.join(''));
  return timestampsToSceneBoundaries(timestamps, sourceDuration, 1);
}

async function extractFrameBuffer(inputPath, sourceTime, outputPath) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', sourceTime.toFixed(3),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-q:v', '4',
    outputPath,
  ]);
  return fs.readFile(outputPath);
}

async function evaluateCandidateFrame(inputPath, sourceTime, sceneChangeTimes, scratchDir) {
  const outputPath = path.join(
    scratchDir,
    `frame-${sourceTime.toFixed(3).replace(/\./g, '_')}-${randomUUID().slice(0, 8)}.jpg`,
  );
  const jpegBuffer = await extractFrameBuffer(inputPath, sourceTime, outputPath);
  const metrics = analyzeJpegMetrics(jpegBuffer);
  const score = scoreFrameMetrics(metrics, nearestDistanceToSceneBoundary(sourceTime, sceneChangeTimes));
  await fs.rm(outputPath, { force: true });
  return {
    sourceTime,
    imageBase64: jpegBuffer.toString('base64'),
    score,
    metrics,
  };
}

async function describeRepresentativeFrameBatch(batch) {
  const input = [{
    role: 'user',
    content: [
      {
        type: 'input_text',
        text:
          'Describe each representative video frame in one short sentence for retrieval. ' +
          'Focus on visible subjects, actions, text on screen, and the dominant visual event. ' +
          'Return strict JSON as {"frames":[{"index":0,"description":"..."}]}.',
      },
      ...batch.flatMap((frame, index) => ([
        {
          type: 'input_text',
          text: `Frame ${index}: source ${frame.sourceTime.toFixed(2)}s.`,
        },
        {
          type: 'input_image',
          image_url: `data:image/jpeg;base64,${frame.imageBase64}`,
          detail: 'auto',
        },
      ])),
    ],
  }];

  let lastError = null;
  for (let attempt = 0; attempt < FRAME_DESCRIPTION_MAX_RETRIES; attempt += 1) {
    try {
      const response = await openai.responses.create({
        model: process.env.OPENAI_FRAME_DESCRIPTION_MODEL?.trim() || 'gpt-4o-mini',
        input,
        max_output_tokens: 1600,
      }, {
        maxRetries: 1,
        timeout: FRAME_DESCRIPTION_TIMEOUT_MS,
      });
      const parsed = parseFrameDescriptions(response.output_text ?? '');
      if (!parsed || parsed.length === 0) {
        throw new Error('Could not parse representative-frame descriptions.');
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= FRAME_DESCRIPTION_MAX_RETRIES) break;
      await sleep(750 * (attempt + 1));
    }
  }

  throw lastError ?? new Error('Could not describe representative frames.');
}

async function describeRepresentativeFramesWithFallback(batch) {
  try {
    return await describeRepresentativeFrameBatch(batch);
  } catch (error) {
    if (batch.length === 1) {
      console.warn('[analysis-worker] representative-frame description failed for a single frame', {
        sourceTime: batch[0]?.sourceTime ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      return [{ index: 0, description: FRAME_DESCRIPTION_UNAVAILABLE }];
    }

    console.warn('[analysis-worker] representative-frame batch failed; retrying frames individually', {
      batchSize: batch.length,
      error: error instanceof Error ? error.message : String(error),
    });

    return runWithConcurrency(
      batch.map((frame, index) => ({ frame, index })),
      Math.min(DESCRIPTION_BATCH_CONCURRENCY, batch.length),
      async ({ frame, index }) => {
        const single = await describeRepresentativeFramesWithFallback([frame]);
        return {
          index,
          description: single[0]?.description?.trim() || FRAME_DESCRIPTION_UNAVAILABLE,
        };
      },
    );
  }
}

async function chooseBestCandidateForWindow(inputPath, candidateTimes, sceneChangeTimes, scratchDir) {
  let best = null;
  for (const candidateTime of candidateTimes) {
    const evaluated = await evaluateCandidateFrame(inputPath, candidateTime, sceneChangeTimes, scratchDir);
    if (!best || evaluated.score > best.score) {
      best = evaluated;
    }
  }
  return best;
}

async function chooseRepresentativeFrames(inputPath, duration, scenes, scratchDir, jobId) {
  const sceneChangeTimes = scenes.slice(1).map((scene) => scene.sourceStart);
  const windows = buildCoarseRepresentativeWindows(duration, DEFAULT_LONG_INTERVAL_SECONDS, DEFAULT_MAX_COARSE_FRAMES);
  const totalWork = windows.length + scenes.length;
  let completed = 0;
  const tasks = [
    ...windows.map((window, index) => ({
      kind: 'window',
      index,
      window,
    })),
    ...scenes.map((scene, sceneIndex) => ({
      kind: 'scene',
      index: sceneIndex,
      scene,
      window: {
        index: sceneIndex,
        startTime: scene.sourceStart,
        endTime: scene.sourceEnd,
        duration: Math.max(0, scene.sourceEnd - scene.sourceStart),
      },
    })),
  ];

  const resolved = await runWithConcurrency(tasks, INDEX_SELECTION_CONCURRENCY, async (task) => {
    const candidates = task.kind === 'window'
      ? buildRepresentativeCandidateTimes(task.window, sceneChangeTimes)
      : buildRepresentativeCandidateTimes(task.window, [task.scene.sourceStart]);
    const best = await chooseBestCandidateForWindow(inputPath, candidates, sceneChangeTimes, scratchDir);

    completed += 1;
    await updateProgress(
      jobId,
      'choosing_representative_frames',
      completed,
      Math.max(1, totalWork),
      `Choosing representative frames ${completed}/${Math.max(1, totalWork)}`,
    );

    if (!best) return null;
    if (task.kind === 'window') {
      const scene = findSceneForTime(best.sourceTime, scenes);
      return {
        kind: 'window',
        index: task.index,
        selection: {
          sampleKind: 'coarse_window_rep',
          sourceTime: best.sourceTime,
          windowStart: task.window.startTime,
          windowEnd: task.window.endTime,
          windowDuration: task.window.duration,
          sceneId: scene?.id ?? null,
          imageBase64: best.imageBase64,
          score: best.score,
          metrics: best.metrics,
        },
      };
    }

    return {
      kind: 'scene',
      index: task.index,
      selection: {
        sampleKind: 'scene_rep',
        sourceTime: best.sourceTime,
        windowStart: task.scene.sourceStart,
        windowEnd: task.scene.sourceEnd,
        windowDuration: Math.max(0, task.scene.sourceEnd - task.scene.sourceStart),
        sceneId: task.scene.id,
        imageBase64: best.imageBase64,
        score: best.score,
        metrics: best.metrics,
        sceneIndex: task.index,
      },
    };
  });

  const windowSelections = new Array(windows.length).fill(null);
  const sceneSelections = new Array(scenes.length).fill(null);
  for (const entry of resolved) {
    if (!entry) continue;
    if (entry.kind === 'window') windowSelections[entry.index] = entry.selection;
    if (entry.kind === 'scene') sceneSelections[entry.index] = entry.selection;
  }

  return {
    windowSelections: windowSelections.filter(Boolean),
    sceneSelections: sceneSelections.filter(Boolean),
  };
}

async function insertRepresentativeFrames(assetId, selections) {
  const inserted = [];
  for (const selection of selections) {
    const { data, error } = await supabase
      .from('asset_visual_index')
      .insert({
        asset_id: assetId,
        source_time: selection.sourceTime,
        window_duration: Math.max(selection.windowDuration, 0.25),
        sample_kind: selection.sampleKind,
        thumbnail_path: null,
        brightness: selection.metrics.brightness,
        contrast: selection.metrics.contrast,
        edge_density: selection.metrics.edgeDensity,
        darkness_score: selection.metrics.darknessScore,
        metadata: {
          score: selection.score,
          sceneId: selection.sceneId,
          windowStart: selection.windowStart,
          windowEnd: selection.windowEnd,
          sampleKind: selection.sampleKind,
        },
      })
      .select('id, metadata')
      .single();
    if (error) throw error;
    inserted.push({
      ...selection,
      rowId: data.id,
      metadata: data.metadata ?? {},
    });
  }
  return inserted;
}

async function insertScenes(assetId, scenes, sceneSelections) {
  for (const [sceneIndex, scene] of scenes.entries()) {
    const rep = sceneSelections.find((candidate) => candidate.sceneId === scene.id);
    const { error } = await supabase
      .from('asset_scenes')
      .insert({
        asset_id: assetId,
        scene_index: sceneIndex,
        source_start: scene.sourceStart,
        source_end: scene.sourceEnd,
        representative_thumbnail_path: null,
        metadata: {
          sceneId: scene.id,
          representativeSourceTime: rep?.sourceTime ?? null,
          score: rep?.score ?? null,
        },
      });
    if (error) throw error;
  }
}

async function writeRepresentativeDescriptions(insertedSelections, jobId) {
  let completed = 0;
  const total = insertedSelections.length;
  await updateProgress(jobId, 'describing_representative_frames', 0, Math.max(1, total), 'Describing representative frames 0/' + Math.max(1, total));
  const batches = [];
  for (let start = 0; start < insertedSelections.length; start += FRAME_BATCH_SIZE) {
    batches.push(insertedSelections.slice(start, start + FRAME_BATCH_SIZE));
  }

  await runWithConcurrency(batches, DESCRIPTION_BATCH_CONCURRENCY, async (batch) => {
    const descriptions = await describeRepresentativeFramesWithFallback(batch);
    for (const item of descriptions) {
      const target = batch[item.index];
      if (!target) continue;
      const nextMetadata = {
        ...(target.metadata ?? {}),
        description: item.description.trim() || FRAME_DESCRIPTION_UNAVAILABLE,
        score: target.score,
        sceneId: target.sceneId,
        sampleKind: target.sampleKind,
      };
      const { error } = await supabase
        .from('asset_visual_index')
        .update({ metadata: nextMetadata })
        .eq('id', target.rowId);
      if (error) throw error;
      completed += 1;
      await updateProgress(
        jobId,
        'describing_representative_frames',
        completed,
        Math.max(1, total),
        `Describing representative frames ${completed}/${Math.max(1, total)}`,
      );
    }
  });
}

async function processIndexAssetJob(job) {
  const asset = await getAssetForJob(job);
  const { tempDir, inputPath } = await downloadAssetToTemp(asset.storage_path);
  const scratchDir = await fs.mkdtemp(path.join(tempDir, 'frames-'));

  try {
    await setAssetStatus(asset.id, { status: 'indexing' });
    await updateProgress(job.id, 'preparing_media', 0, 1, 'Preparing media');

    const probe = await ffprobeVideo(inputPath);
    const duration = probe.duration > 0 ? probe.duration : Number(asset.duration_seconds ?? 0);
    await setAssetStatus(asset.id, {
      duration_seconds: duration || null,
      fps: probe.fps || null,
      width: probe.width || null,
      height: probe.height || null,
      status: 'indexing',
    });

    await supabase.from('asset_transcript_words').delete().eq('asset_id', asset.id);
    await supabase.from('asset_scenes').delete().eq('asset_id', asset.id);
    await supabase.from('asset_visual_index').delete().eq('asset_id', asset.id).in('sample_kind', ['coarse_window_rep', 'scene_rep']);

    const transcriptRanges = buildOverlappingRanges(0, duration);
    for (let index = 0; index < transcriptRanges.length; index += 1) {
      const range = transcriptRanges[index];
      await updateProgress(
        job.id,
        'transcribing_audio',
        index,
        Math.max(1, transcriptRanges.length),
        `Transcribing audio ${index}/${Math.max(1, transcriptRanges.length)}`,
      );
      const audioPath = path.join(tempDir, `audio-${index}.mp3`);
      await extractAudioChunk(inputPath, range, audioPath);
      const words = await transcribeAudioChunk(audioPath, range.startTime);
      await fs.rm(audioPath, { force: true });
      if (words.length > 0) {
        const rows = words.map((word) => ({
          asset_id: asset.id,
          start_time: word.start_time,
          end_time: word.end_time,
          text: word.text,
          confidence: word.confidence,
        }));
        const { error } = await supabase.from('asset_transcript_words').insert(rows);
        if (error) throw error;
      }
    }
    await updateProgress(
      job.id,
      'transcribing_audio',
      transcriptRanges.length,
      Math.max(1, transcriptRanges.length),
      `Transcribing audio ${transcriptRanges.length}/${Math.max(1, transcriptRanges.length)}`,
      0,
    );

    await updateProgress(job.id, 'detecting_scenes', 0, 1, 'Detecting scenes');
    const scenes = await detectScenes(inputPath, duration);
    await updateProgress(job.id, 'detecting_scenes', 1, 1, 'Detecting scenes', 0);

    const { windowSelections, sceneSelections } = await chooseRepresentativeFrames(inputPath, duration, scenes, scratchDir, job.id);
    const insertedWindowSelections = await insertRepresentativeFrames(asset.id, windowSelections);
    const insertedSceneSelections = await insertRepresentativeFrames(asset.id, sceneSelections);
    await insertScenes(asset.id, scenes, sceneSelections);

    await writeRepresentativeDescriptions([...insertedWindowSelections, ...insertedSceneSelections], job.id);

    await setAssetStatus(asset.id, {
      status: 'ready',
      indexed_at: new Date().toISOString(),
      duration_seconds: duration || null,
      fps: probe.fps || null,
      width: probe.width || null,
      height: probe.height || null,
    });

    await updateJob(job.id, {
      status: 'completed',
      locked_at: null,
      locked_by: null,
      result: {
        transcriptChunks: transcriptRanges.length,
        sceneCount: scenes.length,
        coarseRepresentativeCount: insertedWindowSelections.length,
        sceneRepresentativeCount: insertedSceneSelections.length,
      },
      progress: {
        stage: 'describing_representative_frames',
        completed: insertedWindowSelections.length + insertedSceneSelections.length,
        total: Math.max(1, insertedWindowSelections.length + insertedSceneSelections.length),
        label: 'Completed',
        etaSeconds: 0,
      },
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function failJob(job, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (job?.asset_id) {
    try {
      await setAssetStatus(job.asset_id, { status: 'error' });
    } catch {}
  }
  if (job?.id) {
    try {
      await updateJob(job.id, {
        status: 'failed',
        error: message,
        locked_at: null,
        locked_by: null,
      });
    } catch {}
  }
  console.error(`[analysis-worker] job ${job?.id ?? 'unknown'} failed`, error);
}

async function runWorkerSlot(slotIndex) {
  const lockerId = getSlotWorkerId(slotIndex);
  while (true) {
    let job = null;
    try {
      job = await claimNextJob(lockerId);
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      console.log(`[analysis-worker] ${lockerId} claimed job ${job.id} for asset ${job.asset_id}`);
      await processIndexAssetJob(job);
      console.log(`[analysis-worker] ${lockerId} completed job ${job.id}`);
    } catch (error) {
      await failJob(job, error);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function run() {
  console.log('[analysis-worker] started', {
    workerId: WORKER_ID,
    workerConcurrency: WORKER_CONCURRENCY,
    indexSelectionConcurrency: INDEX_SELECTION_CONCURRENCY,
    descriptionBatchConcurrency: DESCRIPTION_BATCH_CONCURRENCY,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, (_, index) => runWorkerSlot(index)));
}

run().catch((error) => {
  console.error('[analysis-worker] fatal error', error);
  process.exitCode = 1;
});
