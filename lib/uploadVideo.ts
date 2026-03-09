import { getSupabaseBrowser } from '@/lib/supabase/client';

export interface UploadResult {
  projectId: string;
  storagePath: string;
}

export async function uploadVideoToSupabase(
  file: File,
  userId: string,
  onProgress?: (pct: number) => void
): Promise<UploadResult> {
  // 1. Create project row
  const createRes = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name.replace(/\.[^.]+$/, ''),
      video_filename: file.name,
      video_size: file.size,
    }),
  });
  if (!createRes.ok) throw new Error('Failed to create project');
  const { id: projectId } = await createRes.json();

  const storagePath = `${userId}/${projectId}/${file.name}`;
  const supabase = getSupabaseBrowser();

  onProgress?.(5);

  // 2. Get a signed upload URL for real progress tracking
  const { data: signedData, error: signErr } = await supabase.storage
    .from('videos')
    .createSignedUploadUrl(storagePath, { upsert: true });

  if (signErr || !signedData) {
    console.error('[uploadVideo] Failed to get signed URL:', signErr);
    throw new Error(`Failed to get upload URL: ${signErr?.message ?? 'unknown error'}. Check that your Supabase Storage "videos" bucket has INSERT/SELECT policies for authenticated users.`);
  }

  // 3. Complete the signed upload using the token returned by Supabase.
  // Raw PUTs against the signed URL do not match the storage client contract here.
  onProgress?.(15);
  const { error: uploadErr } = await supabase.storage
    .from('videos')
    .uploadToSignedUrl(storagePath, signedData.token, file, {
      upsert: true,
      contentType: file.type || 'video/mp4',
    });

  if (uploadErr) {
    console.error('[uploadVideo] Signed upload failed:', uploadErr);
    if ('status' in uploadErr && uploadErr.status === 413) {
      throw new Error('File too large — increase the max file size in Supabase Dashboard -> Storage -> Settings');
    }
    throw new Error(`Upload failed: ${uploadErr.message}. Check that the "videos" bucket exists and allows authenticated uploads.`);
  }
  onProgress?.(100);

  // 4. Update project with video_path
  const patchRes = await fetch(`/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_path: storagePath }),
  });
  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => 'unknown');
    console.error('[uploadVideo] Failed to save video_path:', patchRes.status, errText);
    throw new Error(`Video uploaded but failed to link to your account (HTTP ${patchRes.status}). Please try again.`);
  }

  return { projectId, storagePath };
}
