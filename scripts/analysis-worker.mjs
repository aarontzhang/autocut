import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function leaseNextJob() {
  const { data: jobs, error } = await supabase
    .from('analysis_jobs')
    .select('*')
    .eq('status', 'queued')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) throw error;
  const nextJob = jobs?.[0];
  if (!nextJob) return null;

  const { data: leased, error: leaseError } = await supabase
    .from('analysis_jobs')
    .update({
      status: 'running',
      locked_at: new Date().toISOString(),
      locked_by: WORKER_ID,
      attempt_count: Number(nextJob.attempt_count ?? 0) + 1,
      progress: { completed: 0, total: 1, stage: 'starting' },
    })
    .eq('id', nextJob.id)
    .eq('status', 'queued')
    .select('*')
    .maybeSingle();

  if (leaseError) throw leaseError;
  return leased;
}

async function updateJob(jobId, patch) {
  const { error } = await supabase.from('analysis_jobs').update(patch).eq('id', jobId);
  if (error) throw error;
}

async function markAsset(assetId, patch) {
  const { error } = await supabase.from('media_assets').update(patch).eq('id', assetId);
  if (error) throw error;
}

async function runIndexAsset(job) {
  const assetId = job.asset_id;
  if (!assetId) throw new Error('index_asset job missing asset_id');

  await markAsset(assetId, { status: 'indexing' });
  await updateJob(job.id, { progress: { completed: 1, total: 4, stage: 'metadata' } });

  const payload = job.payload ?? {};
  const duration = Number(payload.sourceDuration ?? 0);
  const fps = Number(payload.fps ?? 30);

  await markAsset(assetId, {
    duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    width: Number(payload.width ?? 1920),
    height: Number(payload.height ?? 1080),
  });

  await updateJob(job.id, { progress: { completed: 2, total: 4, stage: 'scenes' } });
  await updateJob(job.id, { progress: { completed: 3, total: 4, stage: 'samples' } });

  await markAsset(assetId, {
    status: 'ready',
    indexed_at: new Date().toISOString(),
  });

  await updateJob(job.id, {
    status: 'completed',
    result: {
      summary: 'Asset indexing job completed. Worker skeleton populated metadata and marked asset ready.',
    },
    progress: { completed: 4, total: 4, stage: 'done' },
    locked_at: null,
    locked_by: null,
  });
}

async function runVerifyCandidates(job) {
  const windows = Array.isArray(job.payload?.candidateWindows) ? job.payload.candidateWindows : [];
  const verifiedRanges = windows.slice(0, 3).map((window, index) => {
    const sourceStart = Number(window.sourceStart ?? 0);
    const sourceEnd = Number(window.sourceEnd ?? sourceStart + 0.75);
    return {
      candidateId: window.id ?? `window-${index}`,
      assetId: job.asset_id,
      sourceStart,
      sourceEnd,
      frameStart: Math.round(sourceStart * 30),
      frameEnd: Math.round(sourceEnd * 30),
      verificationConfidence: 0.72,
      boundaryConfidence: 0.7,
      evidence: ['Worker verification placeholder'],
    };
  });

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

async function main() {
  for (;;) {
    const job = await leaseNextJob();
    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    try {
      await handleJob(job);
    } catch (error) {
      await updateJob(job.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown worker error',
        locked_at: null,
        locked_by: null,
      });
      if (job.asset_id) {
        await markAsset(job.asset_id, { status: 'error' });
      }
    }
  }
}

main().catch((error) => {
  console.error('[analysis-worker] fatal error', error);
  process.exit(1);
});
