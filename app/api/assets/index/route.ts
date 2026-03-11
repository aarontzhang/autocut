import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { enqueueAnalysisJob, ensurePrimaryMediaAsset, getPrimaryMediaAsset } from '@/lib/analysisJobs';
import { enforceRateLimit, enforceSameOrigin, getRateLimitIdentity } from '@/lib/server/requestSecurity';

export async function POST(req: NextRequest) {
  const csrfError = enforceSameOrigin(req);
  if (csrfError) return csrfError;

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rateLimitError = enforceRateLimit({
    key: `assets-index:${getRateLimitIdentity(req.headers, user.id)}`,
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const body = await req.json().catch(() => ({}));
  const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
  const storagePath = typeof body?.storagePath === 'string' ? body.storagePath : '';
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, user_id, video_path')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const resolvedPath = storagePath || project.video_path;
  if (!resolvedPath) return NextResponse.json({ error: 'No source video path is associated with this project' }, { status: 400 });

  const asset = storagePath
    ? await ensurePrimaryMediaAsset(supabase, projectId, resolvedPath)
    : await getPrimaryMediaAsset(supabase, projectId) ?? await ensurePrimaryMediaAsset(supabase, projectId, resolvedPath);

  const job = await enqueueAnalysisJob(supabase, {
    projectId,
    assetId: asset.id,
    jobType: 'index_asset',
    payload: { storagePath: resolvedPath },
  });

  return NextResponse.json({ assetId: asset.id, jobId: job.id, status: job.status });
}
