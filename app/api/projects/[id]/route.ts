import { getSupabaseServer } from '@/lib/supabase/server';
import { ensureAssetIndexingJob, ensurePrimaryMediaAssetIfSupported } from '@/lib/analysisJobs';
import { readStoredVideoDurationSeconds } from '@/lib/server/videoDuration';
import { removeProjectStorageObjects } from '@/lib/server/storageQuota';
import { NextRequest, NextResponse } from 'next/server';
import { enforceRateLimit, enforceSameOrigin, getRateLimitIdentity } from '@/lib/server/requestSecurity';
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';
import { MAX_UPLOAD_VIDEO_DURATION_SECONDS, getVideoDurationLimitErrorMessage } from '@/lib/storageQuota';
import type { ProjectSource } from '@/lib/types';

function buildProjectSources(project: {
  edit_state?: Record<string, unknown> | null;
  video_path?: string | null;
  video_filename?: string | null;
}) {
  const persistedSources = Array.isArray(project.edit_state?.sources)
    ? project.edit_state!.sources as ProjectSource[]
    : [];
  if (persistedSources.length > 0) {
    const hasPrimary = persistedSources.some((source) => (
      source.id === MAIN_SOURCE_ID || source.isPrimary === true
    ));
    return persistedSources.map((source, index) => {
      const isPrimary = source.id === MAIN_SOURCE_ID || source.isPrimary === true || (!hasPrimary && index === 0);
      return {
        ...source,
        id: isPrimary ? MAIN_SOURCE_ID : (source.id || `source-${index + 1}`),
        fileName: source.fileName || `Source ${index + 1}`,
        storagePath: source.storagePath ?? null,
        assetId: source.assetId ?? null,
        duration: Number.isFinite(source.duration) ? Number(source.duration) : 0,
        status: source.status ?? 'pending',
        isPrimary,
      };
    });
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
  }] satisfies ProjectSource[];
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

  const signedUrl = project.video_path
    ? `/api/projects/${id}/media`
    : null;
  const processingUrl = project.video_path
    ? await supabase.storage
        .from('videos')
        .createSignedUrl(project.video_path, 3600)
        .then((result) => result.data?.signedUrl ?? null)
    : null;

  return NextResponse.json({
    ...project,
    signedUrl,
    processingUrl,
    sources: buildProjectSources(project),
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
  if (typeof body.video_path === 'string' && body.video_path.trim().length > 0) {
    const clientDurationSeconds = typeof body.durationSeconds === 'number' && Number.isFinite(body.durationSeconds)
      ? Math.max(0, body.durationSeconds)
      : null;
    try {
      const durationSeconds = await readStoredVideoDurationSeconds(supabase, body.video_path);
      const effectiveDurationSeconds = durationSeconds > 0 ? durationSeconds : (clientDurationSeconds ?? 0);
      if (effectiveDurationSeconds > MAX_UPLOAD_VIDEO_DURATION_SECONDS) {
        return NextResponse.json({ error: getVideoDurationLimitErrorMessage() }, { status: 413 });
      }
    } catch (durationError) {
      console.warn('[projects.patch] failed to validate uploaded video duration; continuing with client-side duration fallback', durationError);
      if ((clientDurationSeconds ?? 0) > MAX_UPLOAD_VIDEO_DURATION_SECONDS) {
        return NextResponse.json({ error: getVideoDurationLimitErrorMessage() }, { status: 413 });
      }
    }
  }

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
  if (typeof body.video_path === 'string' && body.video_path.trim().length > 0) {
    try {
      const asset = await ensurePrimaryMediaAssetIfSupported(supabase, id, body.video_path);
      assetId = asset?.id ?? null;
      if (asset?.id) {
        await ensureAssetIndexingJob(supabase, id, asset.id);
      }
    } catch (assetError) {
      console.error('[projects.patch] failed to initialize media asset record', assetError);
    }
  }
  return NextResponse.json({ ok: true, assetId });
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
