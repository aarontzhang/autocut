import type {
  ImageOverlayEntry,
  OverlayCompositionEntry,
  OverlayTrack,
  OverlayTrackKind,
  TextOverlayEntry,
} from './types';

export const DEFAULT_TEXT_OVERLAY_TRACK_ID = 'overlay-track-text-primary';
export const DEFAULT_IMAGE_OVERLAY_TRACK_ID = 'overlay-track-image-primary';

const DEFAULT_TRACK_ORDER: Record<OverlayTrackKind, number> = {
  image: 100,
  text: 200,
};

function clampLayer(value: unknown): number {
  if (!Number.isInteger(value)) return 0;
  return Math.max(0, Number(value));
}

function getTrackId(kind: OverlayTrackKind, trackId?: string): string {
  if (typeof trackId === 'string' && trackId.trim()) {
    return trackId.trim();
  }
  return kind === 'image' ? DEFAULT_IMAGE_OVERLAY_TRACK_ID : DEFAULT_TEXT_OVERLAY_TRACK_ID;
}

export function normalizeTextOverlayEntry(entry: Partial<TextOverlayEntry>): TextOverlayEntry | null {
  if (
    !Number.isFinite(entry.startTime)
    || !Number.isFinite(entry.endTime)
    || entry.endTime! <= entry.startTime!
    || typeof entry.text !== 'string'
  ) {
    return null;
  }

  return {
    id: typeof entry.id === 'string' ? entry.id : undefined,
    trackId: getTrackId('text', entry.trackId),
    layer: clampLayer(entry.layer),
    startTime: entry.startTime!,
    endTime: entry.endTime!,
    text: entry.text,
    position: entry.position === 'top' || entry.position === 'center' || entry.position === 'bottom'
      ? entry.position
      : 'bottom',
    fontSize: Number.isFinite(entry.fontSize) ? Math.max(10, Number(entry.fontSize)) : undefined,
  };
}

function normalizeImageOverlayEntry(entry: Partial<ImageOverlayEntry>): ImageOverlayEntry | null {
  if (
    !Number.isFinite(entry.startTime)
    || !Number.isFinite(entry.endTime)
    || entry.endTime! <= entry.startTime!
  ) {
    return null;
  }

  return {
    id: typeof entry.id === 'string' ? entry.id : undefined,
    trackId: getTrackId('image', entry.trackId),
    layer: clampLayer(entry.layer),
    startTime: entry.startTime!,
    endTime: entry.endTime!,
    sourceId: typeof entry.sourceId === 'string' && entry.sourceId.trim()
      ? entry.sourceId.trim()
      : null,
  };
}

function ensureTrack(
  existing: Map<string, OverlayTrack>,
  kind: OverlayTrackKind,
  trackId: string,
) {
  if (existing.has(trackId)) return;
  existing.set(trackId, {
    id: trackId,
    kind,
    order: DEFAULT_TRACK_ORDER[kind],
  });
}

export function buildOverlayTracks(params: {
  tracks?: OverlayTrack[] | null;
  textOverlays?: TextOverlayEntry[] | null;
  imageOverlays?: ImageOverlayEntry[] | null;
}): OverlayTrack[] {
  const trackMap = new Map<string, OverlayTrack>();

  for (const track of params.tracks ?? []) {
    if (!track || typeof track.id !== 'string' || !track.id.trim()) continue;
    if (track.kind !== 'text' && track.kind !== 'image') continue;
    trackMap.set(track.id, {
      id: track.id,
      kind: track.kind,
      label: typeof track.label === 'string' && track.label.trim() ? track.label.trim() : undefined,
      order: Number.isFinite(track.order) ? Number(track.order) : DEFAULT_TRACK_ORDER[track.kind],
    });
  }

  for (const overlay of params.textOverlays ?? []) {
    ensureTrack(trackMap, 'text', getTrackId('text', overlay.trackId));
  }
  for (const overlay of params.imageOverlays ?? []) {
    ensureTrack(trackMap, 'image', getTrackId('image', overlay.trackId));
  }

  return [...trackMap.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function buildOverlayComposition(params: {
  tracks?: OverlayTrack[] | null;
  textOverlays?: TextOverlayEntry[] | null;
  imageOverlays?: ImageOverlayEntry[] | null;
  currentTime?: number | null;
}): OverlayCompositionEntry[] {
  const tracks = buildOverlayTracks(params);
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const currentTime = Number.isFinite(params.currentTime) ? Number(params.currentTime) : null;
  const entries: OverlayCompositionEntry[] = [];

  for (const rawOverlay of params.textOverlays ?? []) {
    const overlay = normalizeTextOverlayEntry(rawOverlay);
    if (!overlay) continue;
    if (currentTime !== null && (currentTime < overlay.startTime || currentTime >= overlay.endTime)) continue;
    const trackId = getTrackId('text', overlay.trackId);
    const track = trackById.get(trackId) ?? {
      id: trackId,
      kind: 'text' as const,
      order: DEFAULT_TRACK_ORDER.text,
    };
    entries.push({
      id: overlay.id ?? `text:${trackId}:${overlay.startTime}:${overlay.endTime}:${overlay.text}`,
      type: 'text',
      overlay,
      trackId,
      trackKind: 'text',
      trackOrder: track.order,
      layer: clampLayer(overlay.layer),
      startTime: overlay.startTime,
      endTime: overlay.endTime,
    });
  }

  for (const rawOverlay of params.imageOverlays ?? []) {
    const overlay = normalizeImageOverlayEntry(rawOverlay);
    if (!overlay) continue;
    if (currentTime !== null && (currentTime < overlay.startTime || currentTime >= overlay.endTime)) continue;
    const trackId = getTrackId('image', overlay.trackId);
    const track = trackById.get(trackId) ?? {
      id: trackId,
      kind: 'image' as const,
      order: DEFAULT_TRACK_ORDER.image,
    };
    entries.push({
      id: overlay.id ?? `image:${trackId}:${overlay.startTime}:${overlay.endTime}`,
      type: 'image',
      overlay,
      trackId,
      trackKind: 'image',
      trackOrder: track.order,
      layer: clampLayer(overlay.layer),
      startTime: overlay.startTime,
      endTime: overlay.endTime,
    });
  }

  return entries.sort((a, b) => (
    a.trackOrder - b.trackOrder
    || a.layer - b.layer
    || a.startTime - b.startTime
    || a.endTime - b.endTime
    || a.id.localeCompare(b.id)
  ));
}

export function getOverlayTrackLabel(track: OverlayTrack): string {
  if (track.label) return track.label;
  return track.kind === 'image' ? 'Image' : 'Text';
}
