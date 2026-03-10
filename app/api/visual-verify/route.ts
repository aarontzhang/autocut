import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { enqueueAnalysisJob, getPrimaryMediaAsset } from '@/lib/analysisJobs';

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
  const assetId = typeof body?.assetId === 'string' ? body.assetId : '';
  const query = typeof body?.query === 'string' ? body.query : '';
  const candidateIds = Array.isArray(body?.candidateIds)
    ? body.candidateIds.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  const candidateWindows = Array.isArray(body?.candidateWindows) ? body.candidateWindows : [];

  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const resolvedAsset = assetId
    ? { id: assetId }
    : await getPrimaryMediaAsset(supabase, projectId);

  if (!resolvedAsset) return NextResponse.json({ error: 'No indexed asset found for this project' }, { status: 404 });

  const job = await enqueueAnalysisJob(supabase, {
    projectId,
    assetId: resolvedAsset.id,
    jobType: 'verify_visual_candidates',
    payload: {
      candidateIds,
      candidateWindows,
      query,
    },
  });

  return NextResponse.json({ jobId: job.id, status: job.status });
}
