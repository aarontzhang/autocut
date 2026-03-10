import { SupabaseClient } from '@supabase/supabase-js';
import { AnalysisJob, AnalysisJobStatus, AnalysisJobType, MediaAsset } from './types';

type JsonMap = Record<string, unknown>;

function isMissingRelationError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const message = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message?: unknown }).message) : '';
  return code === '42P01' || /relation .* does not exist/i.test(message);
}

function mapJob(row: Record<string, unknown>): AnalysisJob {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    assetId: row.asset_id ? String(row.asset_id) : null,
    jobType: row.job_type as AnalysisJobType,
    status: row.status as AnalysisJobStatus,
    priority: Number(row.priority ?? 100),
    attemptCount: Number(row.attempt_count ?? 0),
    payload: (row.payload as JsonMap | null) ?? null,
    result: (row.result as JsonMap | null) ?? null,
    error: row.error ? String(row.error) : null,
    lockedAt: row.locked_at ? String(row.locked_at) : null,
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    progress: (row.progress as AnalysisJob['progress']) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAsset(row: Record<string, unknown>): MediaAsset {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    storagePath: String(row.storage_path),
    sourceDuration: row.duration_seconds == null ? null : Number(row.duration_seconds),
    fps: row.fps == null ? null : Number(row.fps),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    status: row.status as MediaAsset['status'],
    createdAt: String(row.created_at),
    indexedAt: row.indexed_at ? String(row.indexed_at) : null,
  };
}

export async function ensurePrimaryMediaAsset(
  supabase: SupabaseClient,
  projectId: string,
  storagePath: string,
): Promise<MediaAsset> {
  const { data: existing, error: fetchError } = await supabase
    .from('media_assets')
    .select('*')
    .eq('project_id', projectId)
    .eq('storage_path', storagePath)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (existing) return mapAsset(existing);

  const { data: inserted, error: insertError } = await supabase
    .from('media_assets')
    .insert({
      project_id: projectId,
      storage_path: storagePath,
      status: 'pending',
    })
    .select('*')
    .single();

  if (insertError || !inserted) {
    throw insertError ?? new Error('Failed to create media asset');
  }

  return mapAsset(inserted);
}

export async function getPrimaryMediaAsset(
  supabase: SupabaseClient,
  projectId: string,
): Promise<MediaAsset | null> {
  const { data, error } = await supabase
    .from('media_assets')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
  return data ? mapAsset(data) : null;
}

export async function enqueueAnalysisJob(
  supabase: SupabaseClient,
  input: {
    projectId: string;
    assetId?: string | null;
    jobType: AnalysisJobType;
    priority?: number;
    payload?: JsonMap;
  },
): Promise<AnalysisJob> {
  const { data, error } = await supabase
    .from('analysis_jobs')
    .insert({
      project_id: input.projectId,
      asset_id: input.assetId ?? null,
      job_type: input.jobType,
      status: 'queued',
      priority: input.priority ?? 100,
      attempt_count: 0,
      payload: input.payload ?? {},
      progress: { completed: 0, total: 1, stage: 'queued' },
    })
    .select('*')
    .single();

  if (error || !data) throw error ?? new Error('Failed to enqueue analysis job');
  return mapJob(data);
}

export async function getAnalysisJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<AnalysisJob | null> {
  const { data, error } = await supabase
    .from('analysis_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
  return data ? mapJob(data) : null;
}

export async function ensurePrimaryMediaAssetIfSupported(
  supabase: SupabaseClient,
  projectId: string,
  storagePath: string,
): Promise<MediaAsset | null> {
  try {
    return await ensurePrimaryMediaAsset(supabase, projectId, storagePath);
  } catch (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
}

export async function enqueueAnalysisJobIfSupported(
  supabase: SupabaseClient,
  input: {
    projectId: string;
    assetId?: string | null;
    jobType: AnalysisJobType;
    priority?: number;
    payload?: JsonMap;
  },
): Promise<AnalysisJob | null> {
  try {
    return await enqueueAnalysisJob(supabase, input);
  } catch (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
}
