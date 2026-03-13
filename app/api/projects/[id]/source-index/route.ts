import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MAIN_SOURCE_ID, normalizeSourceId } from '@/lib/sourceUtils';
import type { CaptionEntry, SourceIndexState, SourceIndexedFrame } from '@/lib/types';

type SourceProjectEntry = {
  sourceId: string;
  sourcePath: string | null;
};

function extractProjectSources(project: { video_path?: string | null; edit_state?: unknown }): SourceProjectEntry[] {
  const sourceEntries = new Map<string, SourceProjectEntry>();
  if (project.video_path) {
    sourceEntries.set(MAIN_SOURCE_ID, { sourceId: MAIN_SOURCE_ID, sourcePath: project.video_path });
  }

  if (!project.edit_state || typeof project.edit_state !== 'object') {
    return [...sourceEntries.values()];
  }

  const editState = project.edit_state as {
    mediaLibrary?: Array<{ sourceId?: unknown; sourcePath?: unknown }>;
    clips?: Array<{ sourceId?: unknown; sourcePath?: unknown }>;
  };

  for (const collection of [editState.mediaLibrary, editState.clips]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      const sourceId = normalizeSourceId(entry?.sourceId) ?? normalizeSourceId(entry?.sourcePath);
      if (!sourceId || sourceEntries.has(sourceId)) continue;
      sourceEntries.set(sourceId, {
        sourceId,
        sourcePath: normalizeSourceId(entry?.sourcePath),
      });
    }
  }

  return [...sourceEntries.values()];
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, user_id, video_path, edit_state')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const sourceEntries = extractProjectSources(project);
  const sourcePaths = sourceEntries
    .map((entry) => entry.sourcePath)
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);

  if (sourcePaths.length === 0) {
    return NextResponse.json({
      sourceTranscriptCaptions: [],
      sourceOverviewFrames: [],
      sourceIndexFreshBySourceId: {},
      sources: [],
    });
  }

  const { data: assets, error: assetsError } = await supabase
    .from('media_assets')
    .select('id, storage_path, status, indexed_at')
    .eq('project_id', id)
    .in('storage_path', sourcePaths);

  if (assetsError) return NextResponse.json({ error: assetsError.message }, { status: 500 });

  const assetByPath = new Map(
    ((assets ?? []) as Array<{ id: string; storage_path: string; status: string; indexed_at: string | null }>)
      .map((asset) => [asset.storage_path, asset]),
  );
  const assetIds = [...new Set((assets ?? []).map((asset) => asset.id))];

  const [visualRowsResult, transcriptRowsResult] = assetIds.length > 0
    ? await Promise.all([
        supabase
          .from('asset_visual_index')
          .select('asset_id, source_time, sample_kind, metadata')
          .in('asset_id', assetIds)
          .order('source_time', { ascending: true }),
        supabase
          .from('asset_transcript_words')
          .select('asset_id, start_time, end_time, text')
          .in('asset_id', assetIds)
          .order('start_time', { ascending: true }),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];

  if (visualRowsResult.error) {
    return NextResponse.json({ error: visualRowsResult.error.message }, { status: 500 });
  }
  if (transcriptRowsResult.error) {
    return NextResponse.json({ error: transcriptRowsResult.error.message }, { status: 500 });
  }

  const sourceIdByAssetId = new Map<string, string>();
  const sourceIndexFreshBySourceId: Record<string, SourceIndexState> = {};
  const sources = sourceEntries.map((entry) => {
    const asset = entry.sourcePath ? assetByPath.get(entry.sourcePath) : null;
    if (asset) {
      sourceIdByAssetId.set(asset.id, entry.sourceId);
    }
    sourceIndexFreshBySourceId[entry.sourceId] = {
      overview: false,
      transcript: false,
      version: 'source-index-v1',
      assetId: asset?.id ?? null,
      indexedAt: asset?.indexed_at ?? null,
    };
    return {
      sourceId: entry.sourceId,
      assetId: asset?.id ?? null,
      status: asset?.status ?? 'pending',
      indexedAt: asset?.indexed_at ?? null,
    };
  });

  const sourceOverviewFrames: SourceIndexedFrame[] = ((visualRowsResult.data ?? []) as Array<{
    asset_id: string;
    source_time: number;
    sample_kind: string;
    metadata?: { description?: string } | null;
  }>)
    .flatMap((row) => {
      const sourceId = sourceIdByAssetId.get(row.asset_id);
      if (!sourceId) return [];
      const description = typeof row.metadata?.description === 'string' ? row.metadata.description.trim() : '';
      if (!description && row.sample_kind !== 'scene_rep') return [];
      sourceIndexFreshBySourceId[sourceId] = {
        ...sourceIndexFreshBySourceId[sourceId],
        overview: true,
      };
      return [{
        sourceId,
        sourceTime: Number(row.source_time ?? 0),
        description,
        assetId: row.asset_id,
        indexedAt: sourceIndexFreshBySourceId[sourceId]?.indexedAt ?? null,
      }];
    });

  const sourceTranscriptCaptions: CaptionEntry[] = ((transcriptRowsResult.data ?? []) as Array<{
    asset_id: string;
    start_time: number;
    end_time: number;
    text: string;
  }>)
    .flatMap((row) => {
      const sourceId = sourceIdByAssetId.get(row.asset_id);
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

  return NextResponse.json({
    sourceTranscriptCaptions,
    sourceOverviewFrames,
    sourceIndexFreshBySourceId,
    sources,
  });
}
