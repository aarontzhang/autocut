export type CoarseRepresentativeWindow = {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
};

export function getAdaptiveCoarseFrameBudget(
  duration: number,
  preferredLongIntervalSeconds: number,
  maxCoarseFrames: number,
): number {
  if (duration <= 0 || maxCoarseFrames <= 0) return 0;
  const longVideoInterval = Math.max(0.5, preferredLongIntervalSeconds);
  const shortVideoInterval = Math.max(0.35, Math.min(longVideoInterval, longVideoInterval * 0.22));
  const taper = 1 - Math.exp(-Math.max(duration, 0) / 180);
  const averageSpacing = shortVideoInterval + (longVideoInterval - shortVideoInterval) * taper;
  return Math.max(1, Math.min(maxCoarseFrames, Math.floor(duration / averageSpacing) + 1));
}

export function buildCoarseRepresentativeWindows(
  duration: number,
  preferredLongIntervalSeconds: number,
  maxCoarseFrames: number,
): CoarseRepresentativeWindow[] {
  const budget = getAdaptiveCoarseFrameBudget(duration, preferredLongIntervalSeconds, maxCoarseFrames);
  if (budget <= 0) return [];

  const windowDuration = duration / budget;
  return Array.from({ length: budget }, (_, index) => {
    const startTime = index * windowDuration;
    const endTime = index === budget - 1 ? duration : Math.min(duration, (index + 1) * windowDuration);
    return {
      index,
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
    };
  }).filter((window) => window.duration > 0);
}

export function buildRepresentativeCandidateTimes(
  window: CoarseRepresentativeWindow,
  sceneChangeTimes: number[] = [],
): number[] {
  const edgeInset = Math.min(0.35, Math.max(0.08, window.duration * 0.18));
  const baseCandidates = [
    window.startTime + edgeInset,
    window.startTime + window.duration / 2,
    window.endTime - edgeInset,
  ];

  const sceneCandidates = sceneChangeTimes
    .filter((time) => time >= window.startTime && time < window.endTime)
    .map((time) => Math.min(window.endTime - 0.05, Math.max(window.startTime + 0.05, time + 0.18)));

  const deduped: number[] = [];
  for (const candidate of [...baseCandidates, ...sceneCandidates]) {
    const clamped = Math.max(window.startTime + 0.01, Math.min(candidate, window.endTime - 0.01));
    if (!Number.isFinite(clamped)) continue;
    if (deduped.some((existing) => Math.abs(existing - clamped) < 0.12)) continue;
    deduped.push(clamped);
  }

  return deduped.sort((a, b) => a - b);
}

export function buildDenseTimelineTimestamps(
  startTime: number,
  endTime: number,
  requestedCount?: number,
  maxSpacingSeconds = 1,
): number[] {
  const safeStart = Math.max(0, startTime);
  const safeEnd = Math.max(safeStart, endTime);
  const duration = safeEnd - safeStart;
  if (duration <= 0) return [];

  const targetCount = Math.max(
    2,
    Math.min(
      Math.max(2, Math.ceil(duration / Math.max(0.2, maxSpacingSeconds)) + 1),
      Number.isFinite(requestedCount) ? Math.max(2, Math.floor(requestedCount!)) : 24,
    ),
  );

  return Array.from({ length: targetCount }, (_, index) => {
    if (targetCount === 1) return safeStart;
    return safeStart + (duration * index) / (targetCount - 1);
  });
}
