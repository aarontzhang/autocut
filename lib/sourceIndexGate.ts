import type { ProjectSource, SourceIndexAnalysisStateMap } from './types';

function requiresInitialIndexing(source: Pick<ProjectSource, 'storagePath' | 'assetId'>) {
  return Boolean(source.storagePath || source.assetId);
}

export function getInitialIndexingTrackedSourceIds(
  sources: Array<Pick<ProjectSource, 'id' | 'storagePath' | 'assetId'>>,
  analysisBySourceId?: SourceIndexAnalysisStateMap,
): string[] {
  return sources
    .filter((source) => requiresInitialIndexing(source) || Boolean(analysisBySourceId?.[source.id]))
    .map((source) => source.id);
}

export function getInitialIndexingReady(
  sources: Array<Pick<ProjectSource, 'id' | 'storagePath' | 'assetId'>>,
  analysisBySourceId: SourceIndexAnalysisStateMap,
): boolean {
  const trackedSourceIds = getInitialIndexingTrackedSourceIds(sources, analysisBySourceId);
  if (trackedSourceIds.length === 0) return true;

  return trackedSourceIds.every((sourceId) => {
    const analysis = analysisBySourceId[sourceId];
    return analysis?.audio?.status === 'completed' && analysis.visual?.status === 'completed';
  });
}
