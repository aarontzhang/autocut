import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MAIN_SOURCE_ID } from '@/lib/sourceUtils';
import type { ProjectSource } from '@/lib/types';

const FORWARDED_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-encoding',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const;

async function proxyProjectMedia(request: NextRequest, params: Promise<{ id: string }>) {
  const { id } = await params;
  const requestedSourceId = request.nextUrl.searchParams.get('sourceId') || MAIN_SOURCE_ID;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: project, error } = await supabase
    .from('projects')
    .select('video_path, edit_state')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const persistedSources = Array.isArray(project?.edit_state?.sources)
    ? project.edit_state.sources as ProjectSource[]
    : [];
  const requestedSource = persistedSources.find((source) => source.id === requestedSourceId) ?? null;
  const storagePath = requestedSource?.storagePath ?? project?.video_path ?? null;

  if (!storagePath) {
    return NextResponse.json({ error: 'Project media not found' }, { status: 404 });
  }

  const admin = getSupabaseAdmin();
  const { data: signedData, error: signedError } = await admin.storage
    .from('videos')
    .createSignedUrl(storagePath, 60);

  if (signedError || !signedData?.signedUrl) {
    return NextResponse.json(
      { error: signedError?.message ?? 'Failed to create media URL' },
      { status: 500 },
    );
  }

  const upstreamHeaders = new Headers();
  const range = request.headers.get('range');
  if (range) {
    upstreamHeaders.set('range', range);
  }

  const upstream = await fetch(signedData.signedUrl, {
    method: request.method,
    headers: upstreamHeaders,
    redirect: 'follow',
  });

  const responseHeaders = new Headers();
  for (const headerName of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(headerName);
    if (value) {
      responseHeaders.set(headerName, value);
    }
  }

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return proxyProjectMedia(request, context.params);
}

export async function HEAD(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return proxyProjectMedia(request, context.params);
}
