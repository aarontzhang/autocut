import { getSupabaseServer } from '@/lib/supabase/server';
import { enqueueAnalysisJobIfSupported, ensurePrimaryMediaAssetIfSupported } from '@/lib/analysisJobs';
import { removeProjectStorageObjects } from '@/lib/server/storageQuota';
import { NextRequest, NextResponse } from 'next/server';
import { enforceRateLimit, enforceSameOrigin, getRateLimitIdentity } from '@/lib/server/requestSecurity';

function extractSignedMediaPaths(editState: unknown, mainVideoPath: string | null): string[] {
  const paths = new Set<string>();
  if (mainVideoPath) paths.add(mainVideoPath);

  if (!editState || typeof editState !== 'object') {
    return [...paths];
  }

  const candidateCollections = [
    (editState as { mediaLibrary?: unknown }).mediaLibrary,
    (editState as { clips?: unknown }).clips,
  ];

  for (const collection of candidateCollections) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      const sourcePath = typeof (entry as { sourcePath?: unknown })?.sourcePath === 'string'
        ? (entry as { sourcePath: string }).sourcePath
        : '';
      if (sourcePath) paths.add(sourcePath);
    }
  }

  return [...paths];
}

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

  const signedUrls: Record<string, string> = {};
  const signedMediaPaths = extractSignedMediaPaths(project.edit_state, project.video_path);
  if (signedMediaPaths.length > 0) {
    const { data: signed } = await supabase.storage
      .from('videos')
      .createSignedUrls(signedMediaPaths, 3600);
    if (signed) {
      for (const entry of signed) {
        if (entry.path && entry.signedUrl) {
          signedUrls[entry.path] = entry.signedUrl;
        }
      }
    }
  }

  return NextResponse.json({
    ...project,
    signedUrl: project.video_path ? (signedUrls[project.video_path] ?? null) : null,
    signedUrls,
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrfError = enforceSameOrigin(request);
  if (csrfError) return csrfError;

  const { id } = await params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rateLimitError = enforceRateLimit({
    key: `projects-update:${getRateLimitIdentity(request.headers, user.id)}`,
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

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
      const asset = await ensurePrimaryMediaAssetIfSupported(supabase, id, body.video_path);
      assetId = asset?.id ?? null;
      if (asset && (asset.status === 'pending' || asset.status === 'error')) {
        const job = await enqueueAnalysisJobIfSupported(supabase, {
          projectId: id,
          assetId: asset.id,
          jobType: 'index_asset',
          payload: {
            storagePath: body.video_path,
            videoFilename: body.video_filename ?? null,
          },
        });
        indexingJobId = job?.id ?? null;
      }
    } catch (assetError) {
      console.error('[projects.patch] failed to initialize source asset indexing', assetError);
    }
  }
  return NextResponse.json({ ok: true, assetId, indexingJobId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrfError = enforceSameOrigin(req);
  if (csrfError) return csrfError;

  const { id } = await params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rateLimitError = enforceRateLimit({
    key: `projects-delete:${getRateLimitIdentity(req.headers, user.id)}`,
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const { data: project } = await supabase.from('projects').select('id').eq('id', id).eq('user_id', user.id).single();
  if (!project) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 });
  }

  const { error } = await supabase.from('projects').delete().eq('id', id).eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    await removeProjectStorageObjects(user.id, id);
  } catch (storageError) {
    console.error('[projects.delete] deleted project row but failed to delete project storage objects', storageError);
    return NextResponse.json({ ok: true, cleanupWarning: 'Project media cleanup failed after deleting the project row' });
  }

  return NextResponse.json({ ok: true });
}
