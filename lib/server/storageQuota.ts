import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  STORAGE_BUCKET,
  STORAGE_QUOTA_BYTES,
  buildStorageQuotaSnapshot,
  projectStorageQuotaSnapshot,
} from '@/lib/storageQuota';

type StorageObjectRow = {
  name: string;
  metadata: unknown;
};

const STORAGE_QUERY_PAGE_SIZE = 1000;
const STORAGE_REMOVE_CHUNK_SIZE = 100;

function getStorageObjectsTable() {
  return getSupabaseAdmin().schema('storage').from('objects');
}

function readObjectSize(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object') return 0;
  const size = (metadata as { size?: unknown }).size;
  if (typeof size === 'number' && Number.isFinite(size)) return size;
  if (typeof size === 'string') {
    const parsed = Number(size);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function listObjectsByPrefix(prefix: string) {
  const rows: StorageObjectRow[] = [];
  let from = 0;

  while (true) {
    const to = from + STORAGE_QUERY_PAGE_SIZE - 1;
    const { data, error } = await getStorageObjectsTable()
      .select('name, metadata')
      .eq('bucket_id', STORAGE_BUCKET)
      .like('name', `${prefix}%`)
      .range(from, to);

    if (error) throw error;

    const page = (data ?? []) as StorageObjectRow[];
    rows.push(...page);

    if (page.length < STORAGE_QUERY_PAGE_SIZE) break;
    from += STORAGE_QUERY_PAGE_SIZE;
  }

  return rows;
}

export async function getStorageObjectSize(storagePath: string) {
  const { data, error } = await getStorageObjectsTable()
    .select('name, metadata')
    .eq('bucket_id', STORAGE_BUCKET)
    .eq('name', storagePath)
    .maybeSingle();

  if (error) throw error;
  return readObjectSize((data as StorageObjectRow | null)?.metadata);
}

export async function getUserStorageUsageBytes(userId: string) {
  const rows = await listObjectsByPrefix(`${userId}/`);
  return rows.reduce((total, row) => total + readObjectSize(row.metadata), 0);
}

export async function getUserStorageQuotaSnapshot(userId: string) {
  const usedBytes = await getUserStorageUsageBytes(userId);
  return buildStorageQuotaSnapshot(usedBytes, STORAGE_QUOTA_BYTES);
}

export async function getProjectedQuotaSnapshot(userId: string, additionalBytes: number) {
  const current = await getUserStorageQuotaSnapshot(userId);
  return {
    current,
    projected: projectStorageQuotaSnapshot(current, additionalBytes),
  };
}

export async function removeStorageObjects(paths: string[]) {
  const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
  if (uniquePaths.length === 0) return;

  const admin = getSupabaseAdmin();
  for (let index = 0; index < uniquePaths.length; index += STORAGE_REMOVE_CHUNK_SIZE) {
    const chunk = uniquePaths.slice(index, index + STORAGE_REMOVE_CHUNK_SIZE);
    const { error } = await admin.storage.from(STORAGE_BUCKET).remove(chunk);
    if (error) throw error;
  }
}

export async function removeProjectStorageObjects(userId: string, projectId: string) {
  const rows = await listObjectsByPrefix(`${userId}/${projectId}/`);
  await removeStorageObjects(rows.map((row) => row.name));
}
