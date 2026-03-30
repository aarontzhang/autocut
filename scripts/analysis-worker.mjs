import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
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

const WORKER_ID = process.env.ANALYSIS_WORKER_ID?.trim() || `analysis-worker:${process.pid}`;
const POLL_INTERVAL_MS = normalizeInteger(process.env.ANALYSIS_WORKER_POLL_MS, 3000, 500, 60_000);
const WORKER_CONCURRENCY = normalizeInteger(process.env.ANALYSIS_WORKER_CONCURRENCY, DEFAULT_WORKER_CONCURRENCY, 1, 8);
const TRANSCRIPT_CHUNK_SECONDS = 45;
const TRANSCRIPT_OVERLAP_SECONDS = 0.75;
const STALE_RUNNING_JOB_MS = normalizeInteger(process.env.ANALYSIS_JOB_STALE_MS, 10 * 60_000, 60_000, 24 * 60 * 60_000);

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTimestampMs(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRunningJobStale(job) {
  const heartbeatMs = Math.max(
    parseTimestampMs(job?.updated_at) ?? 0,
    parseTimestampMs(job?.locked_at) ?? 0,
  );
  if (heartbeatMs <= 0) return false;
  return Date.now() - heartbeatMs >= STALE_RUNNING_JOB_MS;
}

function getRetryAfterDelayMs(error, attempt) {
  const retryAfterHeader = error?.headers?.['retry-after']
    ?? error?.headers?.get?.('retry-after')
    ?? null;
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  return 750 * (attempt + 1);
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

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
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


function buildTranscriptRangeKey(range) {
  return `${range.startTime.toFixed(3)}-${range.endTime.toFixed(3)}`;
}

function getJobResultValue(result, key) {
  return result && typeof result === 'object' && result[key] && typeof result[key] === 'object'
    ? result[key]
    : {};
}

function getTranscriptCheckpoint(result) {
  const transcript = getJobResultValue(result, 'transcript');
  const completedChunkKeys = Array.isArray(transcript.completedChunkKeys)
    ? transcript.completedChunkKeys.filter((value) => typeof value === 'string')
    : [];
  return {
    totalChunks: Math.max(1, normalizeInteger(transcript.totalChunks, completedChunkKeys.length || 1, 1, 10_000)),
    completedChunkKeys,
  };
}

function createPauseError() {
  const error = new Error('Analysis paused.');
  error.name = 'PauseRequestedError';
  return error;
}

const progressEtaState = new Map();
const jobResultMutationQueues = new Map();

function clearProgressState(jobId) {
  progressEtaState.delete(jobId);
  jobResultMutationQueues.delete(jobId);
}

function estimateStageEta(jobId, stage, completed, total, plannedUnitSeconds = null) {
  const jobState = progressEtaState.get(jobId) ?? new Map();
  const stageState = jobState.get(stage) ?? {
    startedAtMs: Date.now(),
    lastEtaSeconds: null,
  };
  jobState.set(stage, stageState);
  progressEtaState.set(jobId, jobState);

  const remaining = Math.max(total - completed, 0);
  if (remaining <= 0) {
    stageState.lastEtaSeconds = 0;
    return 0;
  }

  const plannedEta = plannedUnitSeconds && Number.isFinite(plannedUnitSeconds) && plannedUnitSeconds > 0
    ? remaining * plannedUnitSeconds
    : null;
  const observedEta = completed > 0
    ? (remaining / Math.max(completed / Math.max((Date.now() - stageState.startedAtMs) / 1000, 0.001), 0.001))
    : null;

  let nextEta = plannedEta ?? observedEta ?? null;
  if (plannedEta !== null && observedEta !== null) {
    const blend = clamp01(completed / Math.max(total * 0.45, 1));
    nextEta = plannedEta * (1 - blend) + observedEta * blend;
  }

  if (stageState.lastEtaSeconds !== null && nextEta !== null && nextEta > stageState.lastEtaSeconds) {
    nextEta = Math.min(nextEta, stageState.lastEtaSeconds + Math.max(12, stageState.lastEtaSeconds * 0.18));
  }

  stageState.lastEtaSeconds = nextEta === null ? null : Math.max(0, Math.round(nextEta));
  return stageState.lastEtaSeconds;
}

async function readPauseIntent(jobId) {
  const { data, error } = await supabase
    .from('analysis_jobs')
    .select('pause_requested')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  return data?.pause_requested === true;
}

async function checkpointPause(jobId) {
  const pauseRequested = await readPauseIntent(jobId);
  if (pauseRequested) {
    throw createPauseError();
  }
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

async function markRunningJobStale(job) {
  const message = `Recovered stale analysis lock held by ${job.locked_by || 'unknown worker'}.`;
  const { error } = await supabase
    .from('analysis_jobs')
    .update({
      status: 'failed',
      error: message,
      pause_requested: false,
      locked_at: null,
      locked_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('status', 'running');
  if (error) throw error;

  if (job.asset_id) {
    await setAssetStatus(job.asset_id, { status: 'indexing' });
  }

  console.warn(`[analysis-worker] marked stale running job ${job.id} as failed`);
}

async function updateProgress(jobId, stage, completed, total, label, options = {}) {
  const etaSeconds = options.etaSeconds ?? estimateStageEta(
    jobId,
    stage,
    completed,
    Math.max(1, total),
    options.plannedUnitSeconds ?? null,
  );
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

async function updateJobResult(jobId, updater) {
  const previous = jobResultMutationQueues.get(jobId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const { data, error } = await supabase
        .from('analysis_jobs')
        .select('result')
        .eq('id', jobId)
        .maybeSingle();
      if (error) throw error;

      const currentResult = data?.result && typeof data.result === 'object' ? data.result : {};
      const nextResult = updater(currentResult);
      await updateJob(jobId, { result: nextResult });
      return nextResult;
    });
  jobResultMutationQueues.set(jobId, next.then(() => undefined, () => undefined));
  return next;
}

async function claimNextJob(lockerId) {
  const { data: queuedJobs, error } = await supabase
    .from('analysis_jobs')
    .select('id, project_id, asset_id, payload, result, attempt_count')
    .eq('job_type', 'index_asset')
    .eq('status', 'queued')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(Math.max(1, WORKER_CONCURRENCY * 3));
  if (error) throw error;
  if (!queuedJobs?.length) return null;

  for (const job of queuedJobs) {
    if (job.asset_id) {
      const { data: activeSibling, error: activeSiblingError } = await supabase
        .from('analysis_jobs')
        .select('id, asset_id, locked_at, locked_by, updated_at')
        .eq('asset_id', job.asset_id)
        .eq('job_type', 'index_asset')
        .eq('status', 'running')
        .neq('id', job.id)
        .limit(1)
        .maybeSingle();
      if (activeSiblingError) throw activeSiblingError;
      if (activeSibling) {
        if (!isRunningJobStale(activeSibling)) {
          continue;
        }
        await markRunningJobStale(activeSibling);
      }
    }

    const { data: claimed, error: claimError } = await supabase
      .from('analysis_jobs')
      .update({
        status: 'running',
        attempt_count: Number(job.attempt_count ?? 0) + 1,
        locked_at: new Date().toISOString(),
        locked_by: lockerId,
        error: null,
        pause_requested: false,
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
      .select('id, project_id, asset_id, payload, result')
      .maybeSingle();

    if (claimError) throw claimError;
    if (claimed) return claimed;
  }

  return null;
}

async function getAssetForJob(job) {
  const { data: asset, error } = await supabase
    .from('media_assets')
    .select('id, project_id, storage_path, duration_seconds, fps, width, height, status, indexed_at')
    .eq('id', job.asset_id)
    .maybeSingle();
  if (error) throw error;
  if (!asset) throw new Error(`Asset ${job.asset_id} not found for analysis job ${job.id}.`);
  return asset;
}

async function downloadAssetToTemp(storagePath) {
  const { data: signedData, error: signedError } = await supabase.storage
    .from('videos')
    .createSignedUrl(storagePath, 3600);
  if (signedError || !signedData?.signedUrl) {
    throw signedError ?? new Error(`Failed to create download URL for ${storagePath}.`);
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-analysis-'));
  const inputPath = path.join(tempDir, path.basename(storagePath) || 'input.mp4');
  const response = await fetch(signedData.signedUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download video: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(inputPath));
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


async function processIndexAssetJob(job) {
  const asset = await getAssetForJob(job);
  if (asset.indexed_at) {
    await setAssetStatus(asset.id, { status: 'ready' });
    await updateJob(job.id, {
      status: 'completed',
      locked_at: null,
      locked_by: null,
      pause_requested: false,
      progress: {
        stage: 'transcribing_audio',
        completed: 1,
        total: 1,
        label: 'Completed',
        etaSeconds: 0,
      },
    });
    return;
  }
  const { tempDir, inputPath } = await downloadAssetToTemp(asset.storage_path);

  try {
    await setAssetStatus(asset.id, { status: 'indexing' });
    await updateProgress(job.id, 'preparing_media', 0, 1, 'Preparing media', { etaSeconds: null });

    const probe = await ffprobeVideo(inputPath);
    const duration = probe.duration > 0 ? probe.duration : Number(asset.duration_seconds ?? 0);
    await setAssetStatus(asset.id, {
      duration_seconds: duration || null,
      fps: probe.fps || null,
      width: probe.width || null,
      height: probe.height || null,
      status: 'indexing',
    });

    const transcriptRanges = buildOverlappingRanges(0, duration);
    const transcriptCheckpoint = getTranscriptCheckpoint(job.result ?? {});
    const completedTranscriptKeys = new Set(transcriptCheckpoint.completedChunkKeys);
    await updateJobResult(job.id, (currentResult) => {
      const transcript = getJobResultValue(currentResult, 'transcript');
      return {
        ...currentResult,
        transcript: {
          ...transcript,
          totalChunks: transcriptRanges.length,
          completedChunkKeys: Array.from(completedTranscriptKeys),
        },
      };
    });

    const jobControl = {
      cancelled: false,
      error: null,
    };
    const throwIfCancelled = () => {
      if (jobControl.cancelled && jobControl.error) {
        throw jobControl.error;
      }
    };
    const markCancelled = (error) => {
      if (!jobControl.cancelled) {
        jobControl.cancelled = true;
        jobControl.error = error;
      }
      return error;
    };

    const transcriptTask = (async () => {
      for (let index = 0; index < transcriptRanges.length; index += 1) {
        throwIfCancelled();
        const range = transcriptRanges[index];
        const rangeKey = buildTranscriptRangeKey(range);
        if (completedTranscriptKeys.has(rangeKey)) continue;

        await updateProgress(
          job.id,
          'transcribing_audio',
          completedTranscriptKeys.size,
          Math.max(1, transcriptRanges.length),
          `Transcribing audio ${completedTranscriptKeys.size}/${Math.max(1, transcriptRanges.length)}`,
          { plannedUnitSeconds: 12 },
        );

        const audioPath = path.join(tempDir, `audio-${index}.mp3`);
        await extractAudioChunk(inputPath, range, audioPath);
        throwIfCancelled();
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

        completedTranscriptKeys.add(rangeKey);
        await updateJobResult(job.id, (currentResult) => {
          const transcript = getJobResultValue(currentResult, 'transcript');
          return {
            ...currentResult,
            transcript: {
              ...transcript,
              totalChunks: transcriptRanges.length,
              completedChunkKeys: Array.from(completedTranscriptKeys),
            },
          };
        });
        await checkpointPause(job.id);
      }

      await updateProgress(
        job.id,
        'transcribing_audio',
        completedTranscriptKeys.size,
        Math.max(1, transcriptRanges.length),
        `Transcribing audio ${completedTranscriptKeys.size}/${Math.max(1, transcriptRanges.length)}`,
        { etaSeconds: 0, plannedUnitSeconds: 12 },
      );

      return {
        totalChunks: transcriptRanges.length,
        completedChunkKeys: Array.from(completedTranscriptKeys),
      };
    })().catch((error) => {
      throw markCancelled(error);
    });

    const transcriptResult = await transcriptTask;

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
      pause_requested: false,
      result: {
        transcript: {
          totalChunks: transcriptResult.totalChunks,
          completedChunkKeys: transcriptResult.completedChunkKeys,
        },
      },
      progress: {
        stage: 'transcribing_audio',
        completed: transcriptResult.totalChunks,
        total: Math.max(1, transcriptResult.totalChunks),
        label: 'Completed',
        etaSeconds: 0,
      },
    });
  } finally {
    clearProgressState(job.id);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function failJob(job, error) {
  if (error?.name === 'PauseRequestedError') {
    if (job?.id) {
      try {
        await updateJob(job.id, {
          status: 'paused',
          error: null,
          locked_at: null,
          locked_by: null,
        });
      } catch {}
    }
    console.log(`[analysis-worker] job ${job?.id ?? 'unknown'} paused`);
    return;
  }

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
        pause_requested: false,
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
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, (_, index) => runWorkerSlot(index)));
}

run().catch((error) => {
  console.error('[analysis-worker] fatal error', error);
  process.exitCode = 1;
});
