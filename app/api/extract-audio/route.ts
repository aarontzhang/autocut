import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { enforceRateLimit, enforceSameOrigin, getRateLimitIdentity } from '@/lib/server/requestSecurity';
import { getSubscriptionStatus, subscriptionRequiredResponse } from '@/lib/server/subscription';
import { extractAudioSegmentFromStorage } from '@/lib/server/audioExtraction';

export const maxDuration = 60;

const EXTRACT_REQUESTS_PER_MINUTE = 30;

async function verifyStoragePathOwnership(
  userId: string,
  storagePath: string,
): Promise<boolean> {
  const admin = getSupabaseAdmin();

  // Check if the storage path belongs to a project owned by this user via video_path.
  const { data: projectByPath } = await admin
    .from('projects')
    .select('id')
    .eq('user_id', userId)
    .eq('video_path', storagePath)
    .limit(1)
    .maybeSingle();

  if (projectByPath) return true;

  // Check if the storage path is referenced in any project's edit_state sources.
  // The storage path should start with the user's ID as a prefix.
  if (!storagePath.startsWith(`${userId}/`)) return false;

  const { data: userProjects } = await admin
    .from('projects')
    .select('id')
    .eq('user_id', userId)
    .limit(1);

  return (userProjects?.length ?? 0) > 0;
}

export async function POST(req: NextRequest) {
  const csrfError = enforceSameOrigin(req);
  if (csrfError) return csrfError;

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sub = await getSubscriptionStatus(user.id);
  if (!sub.isActive) return subscriptionRequiredResponse();

  const rateLimitError = enforceRateLimit({
    key: `extract-audio:${getRateLimitIdentity(req.headers, user.id)}`,
    limit: EXTRACT_REQUESTS_PER_MINUTE,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const body = await req.json().catch(() => ({}));
  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';
  const startTime = typeof body.startTime === 'number' && Number.isFinite(body.startTime) ? Math.max(0, body.startTime) : NaN;
  const endTime = typeof body.endTime === 'number' && Number.isFinite(body.endTime) ? Math.max(0, body.endTime) : NaN;

  if (!storagePath || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    return NextResponse.json({ error: 'Invalid extraction parameters' }, { status: 400 });
  }

  const isOwner = await verifyStoragePathOwnership(user.id, storagePath);
  if (!isOwner) {
    return NextResponse.json({ error: 'Storage path not found' }, { status: 404 });
  }

  try {
    const audioBuffer = await extractAudioSegmentFromStorage({ storagePath, startTime, endTime });
    return new Response(new Uint8Array(audioBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audioBuffer.length),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('[extract-audio] extraction failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Audio extraction failed' },
      { status: 500 },
    );
  }
}
