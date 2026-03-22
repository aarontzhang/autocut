import { NextResponse } from 'next/server';
import { ensureAssetIndexingJob, ensurePrimaryMediaAssetIfSupported, getLatestAnalysisJobForAsset } from '@/lib/analysisJobs';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';
import type {
  CaptionEntry,
  ProjectSource,
  SourceIndexAnalysisState,
  SourceIndexAnalysisStateMap,
  SourceIndexState,
} from '@/lib/types';

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

type AssetLookupRow = {
  id: string;
  storage_path: string;
  status: ProjectSource['status'];
  indexed_at: string | null;
};

function clampFraction(value: number) {
  return Math.max(0, Math.min(1, value));
}

function getProgressFraction(analysis: SourceIndexAnalysisState | null): number {
  const completed = analysis?.progress?.completed ?? 0;
  const total = analysis?.progress?.total ?? 0;
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0;
  return clampFraction(completed / total);
}

function buildCompletedAnalysis(): SourceIndexAnalysisState {
  return {
    jobId: null,
    status: 'completed',
    error: null,
    progress: {
      stage: 'describing_representative_frames',
      completed: 1,
      total: 1,
      label: 'Completed',
      etaSeconds: 0,
    },
  };
}

function getAudioFraction(analysis: SourceIndexAnalysisState | null, hasTranscript: boolean): number {
  if (hasTranscript) return 1;
  const stage = analysis?.progress?.stage;
  if (!analysis || analysis.status === 'failed') return 0;
  if (analysis.status === 'completed') return 1;
  if (stage === 'transcribing_audio') return getProgressFraction(analysis);
  if (stage === 'detecting_scenes' || stage === 'choosing_representative_frames' || stage === 'describing_representative_frames') {
    return 1;
  }
  return 0;
}

function getVisualFraction(analysis: SourceIndexAnalysisState | null, hasOverview: boolean): number {
  if (hasOverview) return 1;
  if (!analysis || analysis.status === 'failed') return 0;
  if (analysis.status === 'completed') return 1;

  const stage = analysis?.progress?.stage;
  const progressFraction = getProgressFraction(analysis);
  switch (stage) {
    case 'preparing_media':
      return 0.05;
    case 'transcribing_audio':
      return 0.1;
    case 'detecting_scenes':
      return 0.2;
    case 'choosing_representative_frames':
      return 0.2 + 0.45 * progressFraction;
    case 'describing_representative_frames':
      return 0.65 + 0.35 * progressFraction;
    default:
      return analysis.status === 'queued' ? 0 : progressFraction;
  }
}

type AggregateEntry = {
  sourceId: string;
  fileName: string;
  analysis: SourceIndexAnalysisState | null;
  hasTranscript: boolean;
  hasOverview: boolean;
};

function buildAggregateAnalysis(entries: AggregateEntry[]): SourceIndexAnalysisState | null {
  if (entries.length === 0) return null;

  const analyses = entries
    .map((entry) => entry.analysis)
    .filter((analysis): analysis is SourceIndexAnalysisState => !!analysis);

  const runningEntry = entries.find((entry) => entry.analysis?.status === 'running');
  const queuedEntry = entries.find((entry) => entry.analysis?.status === 'queued');
  const failedEntry = entries.find((entry) => entry.analysis?.status === 'failed');
  const allCompleted = entries.every((entry) => (
    entry.hasTranscript && entry.hasOverview
  ));

  if (allCompleted) {
    return buildCompletedAnalysis();
  }

  const status = runningEntry
    ? 'running'
    : queuedEntry
      ? 'queued'
      : failedEntry
        ? 'failed'
        : analyses.some((analysis) => analysis.status === 'completed')
          ? 'running'
          : null;

  if (!status) return null;

  const combinedFraction = entries.reduce((total, entry) => {
    const audioFraction = getAudioFraction(entry.analysis, entry.hasTranscript);
    const visualFraction = getVisualFraction(entry.analysis, entry.hasOverview);
    return total + (audioFraction + visualFraction) / 2;
  }, 0) / Math.max(entries.length, 1);

  const activeEntry = runningEntry ?? queuedEntry ?? failedEntry ?? entries[0];
  const etaCandidates = entries
    .map((entry) => entry.analysis?.progress?.etaSeconds)
    .filter((eta): eta is number => typeof eta === 'number' && Number.isFinite(eta) && eta > 0);

  return {
    jobId: activeEntry.analysis?.jobId ?? null,
    status,
    error: failedEntry?.analysis?.error ?? null,
    progress: {
      stage: activeEntry.analysis?.progress?.stage ?? 'queued',
      completed: Math.round(clampFraction(combinedFraction) * 1000),
      total: 1000,
      label: `${entries.filter((entry) => entry.hasTranscript && entry.hasOverview).length}/${entries.length} clips ready`,
      etaSeconds: etaCandidates.length > 0 ? Math.max(...etaCandidates) : null,
    },
  };
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
    ((assetRows ?? []) as AssetLookupRow[]).map((asset) => [asset.storage_path, asset]),
  );

  const sourceIndexFreshBySourceId: Record<string, SourceIndexState> = {};
  const assetIdToSourceId = new Map<string, string>();
  const normalizedSources: Array<ProjectSource & { indexedAt: string | null }> = [];
  const analysisBySourceId: SourceIndexAnalysisStateMap = {};

  for (const source of sources) {
    let asset = source.storagePath ? assetByStoragePath.get(source.storagePath) ?? null : null;
    if (!asset && source.storagePath) {
      try {
        const ensuredAsset = await ensurePrimaryMediaAssetIfSupported(supabase, id, source.storagePath);
        if (ensuredAsset) {
          asset = {
            id: ensuredAsset.id,
            storage_path: ensuredAsset.storagePath,
            status: ensuredAsset.status,
            indexed_at: ensuredAsset.indexedAt,
          };
          assetByStoragePath.set(source.storagePath, asset);
        }
      } catch (error) {
        console.warn('[source-index] failed to ensure media asset for source', {
          projectId: id,
          sourceId: source.id,
          storagePath: source.storagePath,
          error,
        });
      }
    }

    if (asset?.id) {
      assetIdToSourceId.set(asset.id, source.id);
    }

    if (asset?.id) {
      const analysis = await getLatestAnalysisJobForAsset(supabase, id, asset.id)
        ?? ((asset.status !== 'ready' || !asset.indexed_at)
          ? await ensureAssetIndexingJob(supabase, id, asset.id)
          : null);
      analysisBySourceId[source.id] = analysis ?? (asset.status === 'ready' && asset.indexed_at ? buildCompletedAnalysis() : {
        jobId: null,
        status: asset.status === 'indexing' ? 'queued' : null,
        error: null,
        progress: asset.status === 'indexing'
          ? {
              stage: 'queued',
              completed: 0,
              total: 1,
              label: 'Queued',
              etaSeconds: null,
            }
          : null,
      });
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
      analysis: null,
      analysisBySourceId,
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

  const aggregateEntries: AggregateEntry[] = normalizedSources
    .filter((source) => !!source.assetId)
    .map((source) => ({
      sourceId: source.id,
      fileName: source.fileName,
      analysis: analysisBySourceId[source.id] ?? null,
      hasTranscript: sourceIndexFreshBySourceId[source.id]?.transcript === true,
      hasOverview: sourceIndexFreshBySourceId[source.id]?.overview === true,
    }));
  const activeAnalysis = buildAggregateAnalysis(aggregateEntries);

  return NextResponse.json({
    sourceTranscriptCaptions,
    sourceOverviewFrames,
    sourceIndexFreshBySourceId,
    analysis: activeAnalysis,
    analysisBySourceId,
    sources: normalizedSources,
  });
}
