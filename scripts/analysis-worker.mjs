import dotenv from 'dotenv';
import os from 'node:os';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { indexAssetFromStorage, verifyCandidatesAgainstQuery } from '../lib/server/visionIndexing.mjs';

dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const WORKER_ID = process.env.ANALYSIS_WORKER_ID ?? `worker-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.ANALYSIS_WORKER_POLL_MS ?? 3000);
const HOST_PARALLELISM = typeof os.availableParallelism === 'function' ? os.availableParallelism() : Math.max(os.cpus().length, 1);
const DEFAULT_WORKER_CONCURRENCY = Math.min(8, Math.max(2, Math.floor(HOST_PARALLELISM / 2)));
const WORKER_CONCURRENCY = normalizeWorkerConcurrency(process.env.ANALYSIS_WORKER_CONCURRENCY);

function normalizeWorkerConcurrency(value) {
  if (!value) return DEFAULT_WORKER_CONCURRENCY;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_WORKER_CONCURRENCY;
  return Math.min(8, Math.max(1, Math.floor(parsed)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSlotWorkerId(slotIndex) {
  return WORKER_CONCURRENCY === 1 ? WORKER_ID : `${WORKER_ID}:${slotIndex + 1}`;
}

async function leaseNextJob(lockerId) {
  const { data: jobs, error } = await supabase
    .from('analysis_jobs')
    .select('*')
    .eq('status', 'queued')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(Math.max(1, WORKER_CONCURRENCY * 3));

  if (error) throw error;
  if (!jobs?.length) return null;

  for (const nextJob of jobs) {
    const { data: leased, error: leaseError } = await supabase
      .from('analysis_jobs')
      .update({
        status: 'running',
        locked_at: new Date().toISOString(),
        locked_by: lockerId,
        attempt_count: Number(nextJob.attempt_count ?? 0) + 1,
        progress: { completed: 0, total: 1, stage: 'starting' },
      })
      .eq('id', nextJob.id)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle();

    if (leaseError) throw leaseError;
    if (leased) return leased;
  }

  return null;
}

async function updateJob(jobId, patch) {
  const { error } = await supabase.from('analysis_jobs').update(patch).eq('id', jobId);
  if (error) throw error;
}

async function markAsset(assetId, patch) {
  const { error } = await supabase.from('media_assets').update(patch).eq('id', assetId);
  if (error) throw error;
}

async function getAsset(assetId) {
  const { data, error } = await supabase.from('media_assets').select('*').eq('id', assetId).single();
  if (error || !data) throw error ?? new Error(`Asset ${assetId} not found`);
  return {
    id: String(data.id),
    projectId: String(data.project_id),
    storagePath: String(data.storage_path),
    sourceDuration: data.duration_seconds == null ? null : Number(data.duration_seconds),
    fps: data.fps == null ? null : Number(data.fps),
    width: data.width == null ? null : Number(data.width),
    height: data.height == null ? null : Number(data.height),
    status: String(data.status),
    createdAt: String(data.created_at),
    indexedAt: data.indexed_at ? String(data.indexed_at) : null,
  };
}

async function runIndexAsset(job) {
  const assetId = job.asset_id;
  if (!assetId) throw new Error('index_asset job missing asset_id');

  await markAsset(assetId, { status: 'indexing' });
  await updateJob(job.id, { progress: { completed: 1, total: 4, stage: 'metadata' } });
  const asset = await getAsset(assetId);
  await updateJob(job.id, { progress: { completed: 2, total: 4, stage: 'extracting_samples' } });
  const result = await indexAssetFromStorage(supabase, asset);
  await updateJob(job.id, { progress: { completed: 3, total: 4, stage: 'persisted_index' } });

  await updateJob(job.id, {
    status: 'completed',
    result: {
      summary: 'Asset indexing job completed.',
      ...result,
    },
    progress: { completed: 4, total: 4, stage: 'done' },
    locked_at: null,
    locked_by: null,
  });
}

async function runVerifyCandidates(job) {
  const assetId = job.asset_id;
  if (!assetId) throw new Error('verify_visual_candidates job missing asset_id');
  const asset = await getAsset(assetId);
  const windows = Array.isArray(job.payload?.candidateWindows) ? job.payload.candidateWindows : [];
  const query = typeof job.payload?.query === 'string' ? job.payload.query : '';
  const verifiedRanges = await verifyCandidatesAgainstQuery(supabase, asset, query, windows);

  await updateJob(job.id, {
    status: 'completed',
    result: { verifiedRanges },
    progress: { completed: 1, total: 1, stage: 'done' },
    locked_at: null,
    locked_by: null,
  });
}

async function runRepeatDetect(job) {
  await updateJob(job.id, {
    status: 'completed',
    result: { matches: [] },
    progress: { completed: 1, total: 1, stage: 'done' },
    locked_at: null,
    locked_by: null,
  });
}

async function handleJob(job) {
  switch (job.job_type) {
    case 'index_asset':
      await runIndexAsset(job);
      break;
    case 'verify_visual_candidates':
      await runVerifyCandidates(job);
      break;
    case 'repeat_detect_from_seed':
      await runRepeatDetect(job);
      break;
    default:
      throw new Error(`Unsupported job type: ${job.job_type}`);
  }
}

async function handleLeasedJob(job) {
  try {
    await handleJob(job);
  } catch (error) {
    try {
      await updateJob(job.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown worker error',
        locked_at: null,
        locked_by: null,
      });
      if (job.asset_id) {
        await markAsset(job.asset_id, { status: 'error' });
      }
    } catch (updateError) {
      console.error('[analysis-worker] failed to persist job failure', {
        jobId: job.id,
        error: updateError instanceof Error ? updateError.message : updateError,
      });
    }
  }
}

async function runWorkerSlot(slotIndex) {
  const lockerId = getSlotWorkerId(slotIndex);
  for (;;) {
    try {
      const job = await leaseNextJob(lockerId);
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      await handleLeasedJob(job);
    } catch (error) {
      console.error('[analysis-worker] slot error', {
        workerId: lockerId,
        error: error instanceof Error ? error.message : error,
      });
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function main() {
  console.info('[analysis-worker] starting', {
    workerId: WORKER_ID,
    concurrency: WORKER_CONCURRENCY,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, (_, index) => runWorkerSlot(index)));
}

main().catch((error) => {
  console.error('[analysis-worker] fatal error', error);
  process.exit(1);
});
