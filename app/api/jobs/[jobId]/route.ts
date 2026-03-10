import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getAnalysisJob } from '@/lib/analysisJobs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const job = await getAnalysisJob(supabase, jobId);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id')
    .eq('id', job.projectId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  return NextResponse.json({
    id: job.id,
    status: job.status,
    progress: job.progress ?? null,
    result: job.result ?? null,
    error: job.error ?? null,
  });
}
