import { execFile } from 'node:child_process';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { STORAGE_BUCKET } from '@/lib/storageQuota';

const MAX_EXTRACT_DURATION_SECONDS = 60;
const SIGNED_URL_EXPIRY_SECONDS = 300;
const FFMPEG_TIMEOUT_MS = 45_000;

export async function extractAudioSegmentFromStorage(params: {
  storagePath: string;
  startTime: number;
  endTime: number;
}): Promise<Buffer> {
  const duration = Math.min(
    Math.max(0, params.endTime - params.startTime),
    MAX_EXTRACT_DURATION_SECONDS,
  );
  if (duration <= 0) {
    throw new Error('Invalid time range for audio extraction.');
  }

  const admin = getSupabaseAdmin();
  const { data: signedData, error: signedError } = await admin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(params.storagePath, SIGNED_URL_EXPIRY_SECONDS);

  if (signedError || !signedData?.signedUrl) {
    throw new Error('Failed to create signed URL for audio extraction.');
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderrOutput = '';

    const proc = execFile(
      'ffmpeg',
      [
        '-ss', String(params.startTime),
        '-t', String(duration),
        '-i', signedData.signedUrl,
        '-vn', '-sn', '-dn',
        '-ar', '16000',
        '-ac', '1',
        '-f', 'mp3',
        'pipe:1',
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS },
      (error) => {
        if (error) {
          const message = stderrOutput.slice(-500) || error.message;
          reject(new Error(`Audio extraction failed: ${message}`));
          return;
        }
        const result = Buffer.concat(chunks);
        if (result.length === 0) {
          reject(new Error('Audio extraction produced no output.'));
          return;
        }
        resolve(result);
      },
    );

    proc.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });
  });
}
