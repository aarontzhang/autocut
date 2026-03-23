export const FRAME_DESCRIPTION_BATCH_SIZE = 8;
export const FRAME_DESCRIPTION_IMAGE_DETAIL = 'low' as const;
export const FRAME_DESCRIPTION_SERVER_SUB_BATCH_SIZE = 4;

export function getFrameDescriptionParallelRequestLimit(totalFrames: number): number {
  const safeTotal = Number.isFinite(totalFrames) ? Math.max(0, Math.floor(totalFrames)) : 0;
  if (safeTotal >= 120) return 1;
  return 2;
}
