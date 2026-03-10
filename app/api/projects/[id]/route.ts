import { getSupabaseServer } from '@/lib/supabase/server';
import { enqueueAnalysisJob, ensurePrimaryMediaAsset } from '@/lib/analysisJobs';
import { NextResponse } from 'next/server';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: project, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (error || !project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let signedUrl: string | null = null;
  if (project.video_path) {
    const { data: signed } = await supabase.storage
      .from('videos')
      .createSignedUrl(project.video_path, 3600);
    signedUrl = signed?.signedUrl ?? null;
  }

  return NextResponse.json({ ...project, signedUrl });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (body.edit_state !== undefined) patch.edit_state = body.edit_state;
  if (body.name !== undefined) patch.name = body.name;
  if (body.video_path !== undefined) patch.video_path = body.video_path;
  if (body.video_filename !== undefined) patch.video_filename = body.video_filename;
  if (body.video_size !== undefined) patch.video_size = body.video_size;

  const { data: updated, error } = await supabase.from('projects').update(patch).eq('id', id).eq('user_id', user.id).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 });

  let assetId: string | null = null;
  let indexingJobId: string | null = null;
  if (typeof body.video_path === 'string' && body.video_path.trim().length > 0) {
    try {
      const asset = await ensurePrimaryMediaAsset(supabase, id, body.video_path);
      assetId = asset.id;
      if (asset.status === 'pending' || asset.status === 'error') {
        const job = await enqueueAnalysisJob(supabase, {
          projectId: id,
          assetId: asset.id,
          jobType: 'index_asset',
          payload: {
            storagePath: body.video_path,
            videoFilename: body.video_filename ?? null,
          },
        });
        indexingJobId = job.id;
      }
    } catch (assetError) {
      return NextResponse.json({
        ok: false,
        error: assetError instanceof Error ? assetError.message : 'Failed to create source media asset',
      }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, assetId, indexingJobId });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: project } = await supabase.from('projects').select('video_path').eq('id', id).eq('user_id', user.id).single();
  if (project?.video_path) {
    await supabase.storage.from('videos').remove([project.video_path]);
  }

  const { error } = await supabase.from('projects').delete().eq('id', id).eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
