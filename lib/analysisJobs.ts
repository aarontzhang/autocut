import { SupabaseClient } from '@supabase/supabase-js';
import { MediaAsset, SourceIndexAnalysisState } from './types';

function isMissingRelationError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const message = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message?: unknown }).message) : '';
  return code === '42P01' || /relation .* does not exist/i.test(message);
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

function mapAnalysis(row: Record<string, unknown>): SourceIndexAnalysisState {
  const progress = row.progress && typeof row.progress === 'object'
    ? row.progress as Record<string, unknown>
    : null;
  return {
    jobId: typeof row.id === 'string' ? row.id : null,
    status: row.status === 'queued' || row.status === 'running' || row.status === 'completed' || row.status === 'failed'
      ? row.status
      : null,
    error: typeof row.error === 'string' ? row.error : null,
    progress: progress && typeof progress.stage === 'string' && Number.isFinite(progress.completed) && Number.isFinite(progress.total)
      ? {
          stage: progress.stage as NonNullable<SourceIndexAnalysisState['progress']>['stage'],
          completed: Number(progress.completed),
          total: Math.max(1, Number(progress.total)),
          label: typeof progress.label === 'string' ? progress.label : null,
          etaSeconds: Number.isFinite(progress.etaSeconds) ? Number(progress.etaSeconds) : null,
        }
      : null,
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

export async function getLatestAnalysisJobForAsset(
  supabase: SupabaseClient,
  projectId: string,
  assetId: string,
): Promise<SourceIndexAnalysisState | null> {
  try {
    const { data, error } = await supabase
      .from('analysis_jobs')
      .select('id, status, error, progress, updated_at')
      .eq('project_id', projectId)
      .eq('asset_id', assetId)
      .eq('job_type', 'index_asset')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data ? mapAnalysis(data) : null;
  } catch (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
}

export async function ensureAssetIndexingJob(
  supabase: SupabaseClient,
  projectId: string,
  assetId: string,
): Promise<SourceIndexAnalysisState | null> {
  try {
    const { data: existing, error: existingError } = await supabase
      .from('analysis_jobs')
      .select('id, status, error, progress')
      .eq('project_id', projectId)
      .eq('asset_id', assetId)
      .eq('job_type', 'index_asset')
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingError) throw existingError;
    if (existing) return mapAnalysis(existing);

    const { data: inserted, error: insertError } = await supabase
      .from('analysis_jobs')
      .insert({
        project_id: projectId,
        asset_id: assetId,
        job_type: 'index_asset',
        status: 'queued',
        progress: {
          stage: 'queued',
          completed: 0,
          total: 1,
          label: 'Queued',
          etaSeconds: null,
        },
      })
      .select('id, status, error, progress')
      .single();

    if (insertError) throw insertError;

    await supabase
      .from('media_assets')
      .update({ status: 'indexing' })
      .eq('id', assetId);

    return inserted ? mapAnalysis(inserted) : null;
  } catch (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
}
