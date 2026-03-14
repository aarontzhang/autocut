import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';
import type { CaptionEntry, SourceIndexState, SourceIndexedFrame } from '@/lib/types';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, user_id, video_path')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
  if (!project || !project.video_path) {
    return NextResponse.json({
      sourceTranscriptCaptions: [],
      sourceOverviewFrames: [],
      sourceIndexFreshBySourceId: {},
      sources: [],
    });
  }

  const { data: asset, error: assetError } = await supabase
    .from('media_assets')
    .select('id, status, indexed_at')
    .eq('project_id', id)
    .eq('storage_path', project.video_path)
    .maybeSingle();

  if (assetError) return NextResponse.json({ error: assetError.message }, { status: 500 });
  if (!asset) {
    return NextResponse.json({
      sourceTranscriptCaptions: [],
      sourceOverviewFrames: [],
      sourceIndexFreshBySourceId: {
        [MAIN_SOURCE_ID]: {
          overview: false,
          transcript: false,
          version: 'source-index-v1',
          assetId: null,
          indexedAt: null,
        } satisfies SourceIndexState,
      },
      sources: [{
        sourceId: MAIN_SOURCE_ID,
        assetId: null,
        status: 'pending',
        indexedAt: null,
      }],
    });
  }

  const [visualRowsResult, transcriptRowsResult] = await Promise.all([
    supabase
      .from('asset_visual_index')
      .select('asset_id, source_time, sample_kind, metadata')
      .eq('asset_id', asset.id)
      .order('source_time', { ascending: true }),
    supabase
      .from('asset_transcript_words')
      .select('asset_id, start_time, end_time, text')
      .eq('asset_id', asset.id)
      .order('start_time', { ascending: true }),
  ]);

  if (visualRowsResult.error) {
    return NextResponse.json({ error: visualRowsResult.error.message }, { status: 500 });
  }
  if (transcriptRowsResult.error) {
    return NextResponse.json({ error: transcriptRowsResult.error.message }, { status: 500 });
  }

  const sourceIndexFreshBySourceId: Record<string, SourceIndexState> = {
    [MAIN_SOURCE_ID]: {
      overview: false,
      transcript: false,
      version: 'source-index-v1',
      assetId: asset.id,
      indexedAt: asset.indexed_at ?? null,
    },
  };

  const sourceOverviewFrames: SourceIndexedFrame[] = ((visualRowsResult.data ?? []) as Array<{
    asset_id: string;
    source_time: number;
    sample_kind: string;
    metadata?: { description?: string } | null;
  }>)
    .flatMap((row) => {
      const description = typeof row.metadata?.description === 'string' ? row.metadata.description.trim() : '';
      if (!description && row.sample_kind !== 'scene_rep') return [];
      sourceIndexFreshBySourceId[MAIN_SOURCE_ID] = {
        ...sourceIndexFreshBySourceId[MAIN_SOURCE_ID],
        overview: true,
      };
      return [{
        sourceId: MAIN_SOURCE_ID,
        sourceTime: Number(row.source_time ?? 0),
        description,
        assetId: row.asset_id,
        indexedAt: sourceIndexFreshBySourceId[MAIN_SOURCE_ID]?.indexedAt ?? null,
      }];
    });

  const sourceTranscriptCaptions: CaptionEntry[] = ((transcriptRowsResult.data ?? []) as Array<{
    asset_id: string;
    start_time: number;
    end_time: number;
    text: string;
  }>)
    .map((row) => {
      sourceIndexFreshBySourceId[MAIN_SOURCE_ID] = {
        ...sourceIndexFreshBySourceId[MAIN_SOURCE_ID],
        transcript: true,
      };
      return {
        sourceId: MAIN_SOURCE_ID,
        startTime: Number(row.start_time ?? 0),
        endTime: Number(row.end_time ?? row.start_time ?? 0),
        text: String(row.text ?? ''),
      };
    });

  return NextResponse.json({
    sourceTranscriptCaptions,
    sourceOverviewFrames,
    sourceIndexFreshBySourceId,
    sources: [{
      sourceId: MAIN_SOURCE_ID,
      assetId: asset.id,
      status: asset.status,
      indexedAt: asset.indexed_at ?? null,
    }],
  });
}
