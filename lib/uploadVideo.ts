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

  const { error } = await supabase.storage
    .from('videos')
    .upload(storagePath, file, { upsert: true });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  onProgress?.(100);

  // 3. Update project with video_path
  await fetch(`/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_path: storagePath }),
  });

  return { projectId, storagePath };
}
