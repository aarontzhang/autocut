import { NextResponse } from 'next/server';
import { ensureAssetIndexingJob, getLatestAnalysisJobForAsset } from '@/lib/analysisJobs';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';
import type { CaptionEntry, ProjectSource, SourceIndexAnalysisState, SourceIndexState } from '@/lib/types';

type ProjectRow = {
  id: string;
  user_id: string;
  video_path: string | null;
  video_filename: string | null;
  edit_state?: Record<string, unknown> | null;
};

function buildProjectSources(project: ProjectRow): ProjectSource[] {
  const persistedSources = Array.isArray(project.edit_state?.sources)
    ? project.edit_state!.sources as ProjectSource[]
    : [];
  if (persistedSources.length > 0) {
    return persistedSources.map((source, index) => ({
      ...source,
      id: source.id || (index === 0 ? MAIN_SOURCE_ID : `source-${index + 1}`),
      fileName: source.fileName || `Source ${index + 1}`,
      storagePath: source.storagePath ?? null,
      assetId: source.assetId ?? null,
      duration: Number.isFinite(source.duration) ? Number(source.duration) : 0,
      status: source.status ?? 'pending',
      isPrimary: source.id === MAIN_SOURCE_ID || source.isPrimary === true || index === 0,
    }));
  }
  if (!project.video_path && !project.video_filename) {
    return [];
  }
  return [{
    id: MAIN_SOURCE_ID,
    fileName: project.video_filename?.trim() || 'Main video',
    storagePath: project.video_path ?? null,
    assetId: null,
    duration: 0,
    status: project.video_path ? 'pending' : 'ready',
    isPrimary: true,
  }];
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, user_id, video_path, video_filename, edit_state')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle<ProjectRow>();

  if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
  if (!project) {
    return NextResponse.json({
      sourceTranscriptCaptions: [],
      sourceOverviewFrames: [],
      sourceIndexFreshBySourceId: {},
      analysis: null,
      sources: [],
    });
  }

  const sources = buildProjectSources(project);
  if (sources.length === 0) {
    return NextResponse.json({
      sourceTranscriptCaptions: [],
      sourceOverviewFrames: [],
      sourceIndexFreshBySourceId: {},
      analysis: null,
      sources: [],
    });
  }

  const storagePaths = sources
    .map((source) => source.storagePath)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);

  const { data: assetRows, error: assetError } = await supabase
    .from('media_assets')
    .select('id, storage_path, status, indexed_at')
    .eq('project_id', id)
    .in('storage_path', storagePaths.length > 0 ? storagePaths : ['']);

  if (assetError) return NextResponse.json({ error: assetError.message }, { status: 500 });

  const assetByStoragePath = new Map(
    ((assetRows ?? []) as Array<{
      id: string;
      storage_path: string;
      status: ProjectSource['status'];
      indexed_at: string | null;
    }>).map((asset) => [asset.storage_path, asset]),
  );

  const sourceIndexFreshBySourceId: Record<string, SourceIndexState> = {};
  const assetIdToSourceId = new Map<string, string>();
  const normalizedSources: Array<ProjectSource & { indexedAt: string | null }> = [];
  let activeAnalysis: SourceIndexAnalysisState | null = null;

  for (const source of sources) {
    const asset = source.storagePath ? assetByStoragePath.get(source.storagePath) ?? null : null;
    if (asset?.id) {
      assetIdToSourceId.set(asset.id, source.id);
    }

    if (asset?.id) {
      const analysis = await getLatestAnalysisJobForAsset(supabase, id, asset.id)
        ?? ((asset.status !== 'ready' || !asset.indexed_at)
          ? await ensureAssetIndexingJob(supabase, id, asset.id)
          : null);
      if (!activeAnalysis || analysis?.status === 'running' || analysis?.status === 'queued') {
        activeAnalysis = analysis ?? activeAnalysis;
      }
    }

    sourceIndexFreshBySourceId[source.id] = {
      overview: false,
      transcript: false,
      version: 'source-index-v2',
      assetId: asset?.id ?? source.assetId ?? null,
      indexedAt: asset?.indexed_at ?? null,
    };

    normalizedSources.push({
      ...source,
      assetId: asset?.id ?? source.assetId ?? null,
      status: asset?.status ?? source.status ?? 'pending',
      indexedAt: asset?.indexed_at ?? null,
    });
  }

  const assetIds = Array.from(assetIdToSourceId.keys());
  if (assetIds.length === 0) {
    return NextResponse.json({
      sourceTranscriptCaptions: [],
      sourceOverviewFrames: [],
      sourceIndexFreshBySourceId,
      analysis: activeAnalysis,
      sources: normalizedSources,
    });
  }

  const { data: transcriptRows, error: transcriptError } = await supabase
    .from('asset_transcript_words')
    .select('asset_id, start_time, end_time, text')
    .in('asset_id', assetIds)
    .order('start_time', { ascending: true });

  if (transcriptError) {
    return NextResponse.json({ error: transcriptError.message }, { status: 500 });
  }

  const { data: visualRows, error: visualError } = await supabase
    .from('asset_visual_index')
    .select('asset_id, source_time, sample_kind, metadata')
    .in('asset_id', assetIds)
    .in('sample_kind', ['coarse_window_rep', 'scene_rep'])
    .order('source_time', { ascending: true });

  if (visualError) {
    return NextResponse.json({ error: visualError.message }, { status: 500 });
  }

  const sourceTranscriptCaptions: CaptionEntry[] = ((transcriptRows ?? []) as Array<{
    asset_id: string;
    start_time: number;
    end_time: number;
    text: string;
  }>)
    .flatMap((row) => {
      const sourceId = assetIdToSourceId.get(row.asset_id);
      if (!sourceId) return [];
      sourceIndexFreshBySourceId[sourceId] = {
        ...sourceIndexFreshBySourceId[sourceId],
        transcript: true,
      };
      return [{
        sourceId,
        startTime: Number(row.start_time ?? 0),
        endTime: Number(row.end_time ?? row.start_time ?? 0),
        text: String(row.text ?? ''),
      }];
    });

  const sourceOverviewFrames = ((visualRows ?? []) as Array<{
    asset_id: string;
    source_time: number;
    sample_kind: string;
    metadata?: Record<string, unknown> | null;
  }>)
    .flatMap((row) => {
      const sourceId = assetIdToSourceId.get(row.asset_id);
      if (!sourceId) return [];
      const freshness = sourceIndexFreshBySourceId[sourceId];
      sourceIndexFreshBySourceId[sourceId] = {
        ...freshness,
        overview: true,
      };
      const metadata = row.metadata && typeof row.metadata === 'object'
        ? row.metadata as Record<string, unknown>
        : {};
      return [{
        sourceId,
        sourceTime: Number(row.source_time ?? 0),
        description: typeof metadata.description === 'string' ? metadata.description : undefined,
        assetId: row.asset_id,
        indexedAt: freshness?.indexedAt ?? null,
        sampleKind: row.sample_kind === 'scene_rep' || row.sample_kind === 'coarse_window_rep'
          ? row.sample_kind
          : 'coarse_window_rep',
        score: Number.isFinite(metadata.score) ? Number(metadata.score) : null,
        sceneId: typeof metadata.sceneId === 'string' ? metadata.sceneId : null,
      }];
    });

  return NextResponse.json({
    sourceTranscriptCaptions,
    sourceOverviewFrames,
    sourceIndexFreshBySourceId,
    analysis: activeAnalysis,
    sources: normalizedSources,
  });
}
