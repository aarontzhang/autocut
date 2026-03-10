import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('media_assets')
    .select(`
      id,
      project_id,
      storage_path,
      duration_seconds,
      fps,
      width,
      height,
      status,
      created_at,
      indexed_at,
      projects!inner(user_id),
      analysis_jobs(id, status, progress, updated_at)
    `)
    .eq('id', assetId)
    .eq('projects.user_id', user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const jobs = Array.isArray(data.analysis_jobs) ? data.analysis_jobs : [];
  const latestJob = jobs.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] ?? null;

  return NextResponse.json({
    assetId: data.id,
    projectId: data.project_id,
    status: data.status,
    sourceDuration: data.duration_seconds,
    fps: data.fps,
    width: data.width,
    height: data.height,
    indexedAt: data.indexed_at,
    latestJob: latestJob
      ? {
          id: latestJob.id,
          status: latestJob.status,
          progress: latestJob.progress ?? null,
          updatedAt: latestJob.updated_at,
        }
      : null,
  });
}
