import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { STORAGE_FILE_LIMIT_BYTES, getFileSizeErrorMessage } from '@/lib/storageQuota';
import { enforceRateLimit, enforceSameOrigin, getRateLimitIdentity } from '@/lib/server/requestSecurity';

export async function POST(request: NextRequest) {
  const csrfError = enforceSameOrigin(request);
  if (csrfError) return csrfError;

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rateLimitError = enforceRateLimit({
    key: `uploads-file:${getRateLimitIdentity(request.headers, user.id)}`,
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('file');
  const storagePath = formData.get('storagePath');

  if (!(file instanceof Blob) || typeof storagePath !== 'string' || !storagePath) {
    return NextResponse.json({ error: 'Missing file or storagePath' }, { status: 400 });
  }

  const fileSize = file.size;
  if (fileSize > STORAGE_FILE_LIMIT_BYTES) {
    return NextResponse.json({ error: getFileSizeErrorMessage() }, { status: 413 });
  }

  if (!storagePath.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: 'Invalid storage path' }, { status: 403 });
  }

  const contentType = file.type || 'video/mp4';
  const admin = getSupabaseAdmin();
  const { error } = await admin.storage.from('videos').upload(storagePath, file, {
    upsert: false,
    contentType,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
