import { getSupabaseBrowser } from '@/lib/supabase/client';

function sanitizeName(name: string) {
  return name.replace(/[^\w.\-]+/g, '_');
}

export async function uploadProjectMedia(file: File, userId: string, projectId: string, folder = 'sources') {
  const supabase = getSupabaseBrowser();
  const fileName = `${Date.now()}_${sanitizeName(file.name)}`;
  const storagePath = `${userId}/${projectId}/${folder}/${fileName}`;
  const { error } = await supabase.storage.from('videos').upload(storagePath, file, { upsert: true });
  if (error) throw error;
  return storagePath;
}

export async function createSignedUrls(paths: string[]) {
  const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
  if (uniquePaths.length === 0) return new Map<string, string>();

  const supabase = getSupabaseBrowser();
  const { data, error } = await supabase.storage.from('videos').createSignedUrls(uniquePaths, 3600);
  if (error || !data) throw error ?? new Error('Failed to create signed URLs');

  const result = new Map<string, string>();
  for (const entry of data) {
    if (entry.path && entry.signedUrl) result.set(entry.path, entry.signedUrl);
  }
  return result;
}
