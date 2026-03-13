'use client';

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import {
  ChatMessage,
  EditAction,
  CaptionEntry,
  TransitionEntry,
  TextOverlayEntry,
  ColorFilter,
  VideoClip,
  MediaTrack,
  TrackClip,
  IndexedVideoFrame,
  AIEditingSettings,
  AppliedActionRecord,
  MarkerEntry,
  SourceIndexedFrame,
  SourceIndexState,
  VisualSearchSession,
} from './types';
import {
  applyActionToSnapshot,
  actionChangesTimelineStructure,
  deleteRangeFromClips,
  EditSnapshot,
  sanitizeTimelineClips,
  splitClipsAtTime,
} from './editActionUtils';
import { buildClipSchedule } from './playbackEngine';
import { buildTranscriptContext, formatTimePrecise, projectSourceFramesToTimeline } from './timelineUtils';
import { createImportedSourceId, MAIN_SOURCE_ID, normalizeSourceId } from './sourceUtils';

export type { EditSnapshot } from './editActionUtils';

export type TranscriptStatus = 'idle' | 'loading' | 'done' | 'error';
export type TranscriptProgress = {
  completed: number;
  total: number;
} | null;

export const SOURCE_INDEX_VERSION = 'source-index-v1';
export type SourceIndexStateMap = Record<string, SourceIndexState>;

export interface MediaLibraryItem {
  id: string;
  url: string;
  name: string;
  duration: number;
  sourceId?: string;
  sourcePath?: string;
}

export type FFmpegJob =
  | { status: 'idle' }
  | { status: 'running'; progress: number; stage: string; isCancelling?: boolean }
  | { status: 'done'; outputUrl: string }
  | { status: 'cancelled'; message: string }
  | { status: 'error'; message: string };

export type SelectedItem = {
  type: 'clip' | 'caption' | 'text' | 'transition' | 'marker';
  id: string;
} | null;

function makeClip(sourceStart: number, sourceDuration: number, sourceId = MAIN_SOURCE_ID): VideoClip {
  return {
    id: uuidv4(),
    sourceId,
    sourceStart,
    sourceDuration,
    speed: 1.0,
    volume: 1.0,
    filter: null,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function normalizeClipSourceId(
  clip: Partial<Pick<VideoClip, 'sourceId' | 'sourcePath'>>,
  fallback = MAIN_SOURCE_ID,
): string {
  return normalizeSourceId(clip.sourceId) ?? normalizeSourceId(clip.sourcePath) ?? fallback;
}

function normalizeLoadedClip(clip: VideoClip, mainSourcePath?: string | null): VideoClip {
  const normalizedSourceId = normalizeClipSourceId(clip);
  const resolvedSourceId = (
    mainSourcePath
    && (
      normalizeSourceId(clip.sourcePath) === mainSourcePath
      || normalizedSourceId === mainSourcePath
    )
  )
    ? MAIN_SOURCE_ID
    : normalizedSourceId;

  return {
    ...clip,
    sourceId: resolvedSourceId,
    speed: Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1,
    volume: Number.isFinite(clip.volume) ? clip.volume : 1,
    filter: clip.filter ?? null,
    fadeIn: Number.isFinite(clip.fadeIn) ? clip.fadeIn : 0,
    fadeOut: Number.isFinite(clip.fadeOut) ? clip.fadeOut : 0,
  };
}

function normalizeCaptionSourceId(caption: CaptionEntry): CaptionEntry {
  return {
    ...caption,
    sourceId: normalizeSourceId(caption.sourceId) ?? MAIN_SOURCE_ID,
  };
}

function collectSourceIds(items: Array<{ sourceId?: string | null }>): Set<string> {
  return new Set(items.map((item) => normalizeSourceId(item.sourceId) ?? MAIN_SOURCE_ID));
}

function sourceCoverageIncludesAll(sourceIds: Set<string>, expectedIds: Set<string>): boolean {
  if (expectedIds.size === 0) return true;
  if (sourceIds.size === 0) return false;
  return [...expectedIds].every((sourceId) => sourceIds.has(sourceId));
}

function mergeSourceOverviewFrames(
  current: SourceIndexedFrame[] | null,
  sourceId: string,
  nextFrames: SourceIndexedFrame[] | null,
): SourceIndexedFrame[] | null {
  const preserved = (current ?? []).filter((frame) => frame.sourceId !== sourceId);
  if (!nextFrames || nextFrames.length === 0) {
    return preserved.length > 0 ? preserved : null;
  }
  return [
    ...preserved,
    ...nextFrames.map((frame) => ({
      ...frame,
      sourceId,
    })),
  ].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.sourceTime - b.sourceTime);
}

function patchSourceIndexState(
  current: SourceIndexStateMap,
  sourceId: string,
  patch: Partial<SourceIndexState>,
): SourceIndexStateMap {
  const existing = current[sourceId] ?? {
    overview: false,
    transcript: false,
    version: SOURCE_INDEX_VERSION,
  };
  return {
    ...current,
    [sourceId]: {
      ...existing,
      ...patch,
      version: patch.version ?? existing.version ?? SOURCE_INDEX_VERSION,
    },
  };
}

function buildInitialSourceIndexState(
  sourceIds: Iterable<string>,
  overrides?: SourceIndexStateMap,
): SourceIndexStateMap {
  const next: SourceIndexStateMap = {};
  for (const sourceId of sourceIds) {
    next[sourceId] = overrides?.[sourceId] ?? {
      overview: false,
      transcript: false,
      version: SOURCE_INDEX_VERSION,
    };
  }
  return next;
}

function buildDerivedIndexState(
  clips: VideoClip[],
  aiSettings: AIEditingSettings,
  sourceTranscriptCaptions: CaptionEntry[] | null,
  sourceOverviewFrames: SourceIndexedFrame[] | null,
) {
  const backgroundTranscript = sourceTranscriptCaptions && sourceTranscriptCaptions.length > 0
    ? buildTranscriptContext(clips, sourceTranscriptCaptions)
    : null;
  const projectedOverviewFrames = sourceOverviewFrames && sourceOverviewFrames.length > 0
    ? projectSourceFramesToTimeline(clips, sourceOverviewFrames, aiSettings.frameInspection)
    : [];
  return {
    backgroundTranscript,
    projectedOverviewFrames: projectedOverviewFrames.length > 0 ? projectedOverviewFrames : null,
    timelineProjectionFresh: true,
  };
}

export const DEFAULT_AI_EDITING_SETTINGS: AIEditingSettings = {
  silenceRemoval: {
    paddingSeconds: 0.12,
    minDurationSeconds: 0.08,
    preserveShortPauses: false,
    requireSpeakerAbsence: true,
  },
  frameInspection: {
    defaultFrameCount: 30,
    overviewIntervalSeconds: 1,
    maxOverviewFrames: 1800,
  },
  captions: {
    wordsPerCaption: 4,
  },
  transitions: {
    defaultDuration: 1,
    defaultType: 'crossfade',
  },
  textOverlays: {
    defaultPosition: 'bottom',
    defaultFontSize: 16,
  },
};

function mergeAISettings(
  current: AIEditingSettings,
  patch?: Partial<AIEditingSettings>,
): AIEditingSettings {
  if (!patch) return current;
  return {
    silenceRemoval: { ...current.silenceRemoval, ...patch.silenceRemoval },
    frameInspection: { ...current.frameInspection, ...patch.frameInspection },
    captions: { ...current.captions, ...patch.captions },
    transitions: { ...current.transitions, ...patch.transitions },
    textOverlays: { ...current.textOverlays, ...patch.textOverlays },
  };
}

function filterTaggedMarkerIds(taggedMarkerIds: string[], markers: MarkerEntry[]): string[] {
  const markerIds = new Set(markers.map((marker) => marker.id));
  return taggedMarkerIds.filter((id) => markerIds.has(id));
}

function normalizeSelectedItem(selectedItem: SelectedItem, markers: MarkerEntry[]): SelectedItem {
  if (!selectedItem || selectedItem.type !== 'marker') return selectedItem;
  return markers.some((marker) => marker.id === selectedItem.id) ? selectedItem : null;
}

interface EditorState {
  // Video
  videoFile: File | null;
  videoUrl: string;
  videoData: Uint8Array | null;
  videoDuration: number;
  currentTime: number;  // timeline time
  requestedSeekTime: number | null;

  // Pending Claude action
  pendingAction: EditAction | null;

  // Clips — the core edit state
  clips: VideoClip[];

  // Effects (reference timeline time)
  captions: CaptionEntry[];
  transitions: TransitionEntry[];
  markers: MarkerEntry[];
  textOverlays: TextOverlayEntry[];
  previewSnapshot: EditSnapshot | null;
  previewOwnerId: string | null;

  // Extra tracks (video/audio overlays with positioned clips)
  extraTracks: MediaTrack[];

  // Selection
  selectedItem: SelectedItem;
  taggedMarkerIds: string[];

  // Undo/redo
  history: EditSnapshot[];
  future: EditSnapshot[];

  // Chat
  messages: ChatMessage[];
  isChatLoading: boolean;
  aiSettings: AIEditingSettings;
  appliedActions: AppliedActionRecord[];

  // FFmpeg
  ffmpegJob: FFmpegJob;

  // Cloud / project persistence
  currentProjectId: string | null;
  storagePath: string | null;
  uploadProgress: number | null;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';

  // Timeline
  zoom: number;
  playbackActive: boolean;

  // Background transcription
  backgroundTranscript: string | null;
  transcriptStatus: TranscriptStatus;
  transcriptProgress: TranscriptProgress;
  sourceTranscriptCaptions: CaptionEntry[] | null;
  sourceOverviewFrames: SourceIndexedFrame[] | null;
  projectedOverviewFrames: IndexedVideoFrame[] | null;
  sourceIndexFreshBySourceId: SourceIndexStateMap;
  timelineProjectionFresh: boolean;
  visualSearchSession: VisualSearchSession | null;

  // Actions
  setVideoFile: (file: File) => void;
  setVideoDuration: (duration: number) => void;
  setCurrentTime: (time: number) => void;
  requestSeek: (time: number) => void;
  clearRequestedSeek: () => void;
  setPendingAction: (action: EditAction | null) => void;
  setPreviewSnapshot: (ownerId: string, snapshot: EditSnapshot) => void;
  clearPreviewSnapshot: (ownerId?: string) => void;
  commitPreviewSnapshot: (snapshot: EditSnapshot) => void;

  // Clip actions
  splitClipAtTime: (timelineTime: number) => void;
  deleteRangeAtTime: (startTime: number, endTime: number) => void;
  deleteClip: (clipId: string) => void;
  reorderClip: (clipId: string, newIndex: number) => void;
  trimClip: (clipId: string, newSourceStart: number, newSourceDuration: number) => void;
  trimClipWithHistory: (clipId: string, newSourceStart: number, newSourceDuration: number) => void;
  setClipSpeed: (clipId: string, speed: number) => void;
  setClipVolume: (clipId: string, volume: number, fadeIn?: number, fadeOut?: number) => void;
  setClipFilter: (clipId: string, filter: ColorFilter | null) => void;
  setClipFade: (clipId: string, fadeIn: number, fadeOut: number) => void;

  // Apply AI actions
  applyAction: (action: EditAction) => void;

  // Undo/redo
  undo: () => void;
  redo: () => void;
  pushHistory: (snap: EditSnapshot) => void;

  // Chat
  addMessage: (msg: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  updateMessage: (id: string, patch: Partial<Omit<ChatMessage, 'id' | 'timestamp'>>) => void;
  setIsChatLoading: (v: boolean) => void;
  clearChatHistory: () => void;
  clearMessages: () => void;
  setAISettings: (settings: Partial<AIEditingSettings>) => void;
  recordAppliedAction: (
    action: EditAction,
    summary: string,
    metadata?: { sourceRanges?: AppliedActionRecord['sourceRanges'] },
  ) => void;

  // FFmpeg
  setFFmpegJob: (job: FFmpegJob) => void;

  setVideoCloud: (file: File, blobUrl: string, storagePath: string, projectId: string) => void;
  setProjectVideoFile: (file: File, projectId: string, storagePath?: string | null) => void;
  loadProject: (
    editState: {
      clips?: unknown[];
      captions?: unknown[];
      transitions?: unknown[];
      markers?: unknown[];
      textOverlays?: unknown[];
      extraTracks?: unknown[];
      messages?: unknown[];
      appliedActions?: unknown[];
      aiSettings?: unknown;
      backgroundTranscript?: unknown;
      transcriptStatus?: unknown;
      sourceTranscriptCaptions?: unknown[];
      sourceOverviewFrames?: unknown[];
      sourceIndexFreshBySourceId?: unknown;
      rawTranscriptCaptions?: unknown[];
      videoFrames?: unknown[];
      mediaLibrary?: unknown[];
    },
    project: {
      projectId: string;
      videoUrl: string;
      storagePath: string | null;
      videoFilename?: string | null;
      duration?: number;
      signedUrls?: Record<string, string>;
    }
  ) => void;
  setUploadProgress: (pct: number | null) => void;
  setSaveStatus: (status: 'idle' | 'saving' | 'saved' | 'error') => void;
  setStoragePath: (path: string) => void;

  // Zoom
  setZoom: (zoom: number) => void;
  setPlaybackActive: (active: boolean) => void;

  setBackgroundTranscript: (text: string | null, status: TranscriptStatus, rawCaptions?: CaptionEntry[]) => void;
  setTranscriptProgress: (progress: TranscriptProgress) => void;
  setSourceOverviewFrames: (
    sourceId: string,
    frames: SourceIndexedFrame[] | null,
    options?: { fresh?: boolean; assetId?: string | null; indexedAt?: string | null },
  ) => void;
  hydrateSourceIndex: (payload: {
    sourceTranscriptCaptions?: CaptionEntry[] | null;
    sourceOverviewFrames?: SourceIndexedFrame[] | null;
    sourceIndexFreshBySourceId?: SourceIndexStateMap;
  }) => void;
  setVisualSearchSession: (session: VisualSearchSession | null) => void;
  addMarker: (marker: Omit<MarkerEntry, 'id' | 'number'> & { id?: string; number?: number }) => string;
  updateMarker: (id: string, patch: Partial<Omit<MarkerEntry, 'id'>>) => void;
  removeMarker: (id: string) => void;
  createMarkerAtTime: (timelineTime: number, options?: { label?: string; createdBy?: 'ai' | 'human'; linkedMessageId?: string | null }) => string;

  // Media library (multi-source V1)
  mediaLibrary: MediaLibraryItem[];
  addToMediaLibrary: (file: File) => Promise<string>;
  addMediaLibraryItem: (item: Omit<MediaLibraryItem, 'id'>) => string;
  appendVideoToTimeline: (sourceUrl: string, sourceName: string, duration: number, sourcePath?: string, sourceId?: string) => string;
  insertVideoIntoTimeline: (sourceUrl: string, sourceName: string, duration: number, insertAtTime: number, sourcePath?: string, sourceId?: string) => string;
  updateClipSourcePath: (clipId: string, sourcePath: string) => void;

  // Reset
  resetEditor: () => void;

  // Selection
  setSelectedItem: (item: SelectedItem) => void;
  setTaggedMarkerIds: (ids: string[]) => void;
  toggleTaggedMarker: (id: string) => void;
  clearTaggedMarkers: () => void;
  deleteSelectedItem: () => void;

  // Effect drag helpers
  updateCaption: (id: string, patch: { startTime?: number; endTime?: number }) => void;
  updateTextOverlay: (id: string, patch: { startTime?: number; endTime?: number }) => void;
  updateTransition: (id: string, patch: { atTime?: number }) => void;

  // Extra track actions
  addTrack: (type: 'video' | 'audio') => string;
  removeTrack: (trackId: string) => void;
  addClipToTrack: (trackId: string, clip: Omit<TrackClip, 'id'> & { id?: string }) => void;
  updateTrackClipSourcePath: (trackId: string, clipId: string, sourcePath: string) => void;
  moveTrackClip: (trackId: string, clipId: string, newTimelineStart: number) => void;
  trimTrackClip: (trackId: string, clipId: string, newSourceStart: number, newSourceDuration: number) => void;
  removeTrackClip: (trackId: string, clipId: string) => void;
}

type EditorStoreWithSnapshot = EditorState & {
  _snapshot: () => EditSnapshot;
};

export const useEditorStore = create<EditorState>((set, get) => ({
  videoFile: null,
  videoUrl: '',
  videoData: null,
  videoDuration: 0,
  currentTime: 0,
  requestedSeekTime: null,
  pendingAction: null,
  clips: [],
  captions: [],
  transitions: [],
  markers: [],
  textOverlays: [],
  previewSnapshot: null,
  previewOwnerId: null,
  extraTracks: [],
  selectedItem: null,
  taggedMarkerIds: [],
  history: [],
  future: [],
  messages: [],
  isChatLoading: false,
  aiSettings: DEFAULT_AI_EDITING_SETTINGS,
  appliedActions: [],
  ffmpegJob: { status: 'idle' },
  currentProjectId: null,
  storagePath: null,
  uploadProgress: null,
  saveStatus: 'idle' as const,
  zoom: 1,
  playbackActive: false,
  backgroundTranscript: null,
  transcriptStatus: 'idle' as TranscriptStatus,
  transcriptProgress: null,
  sourceTranscriptCaptions: null,
  sourceOverviewFrames: null,
  projectedOverviewFrames: null,
  sourceIndexFreshBySourceId: {},
  timelineProjectionFresh: true,
  visualSearchSession: null,
  mediaLibrary: [],

  _snapshot: (): EditSnapshot => {
    const s = get();
    return {
      clips: s.clips,
      captions: s.captions,
      transitions: s.transitions,
      markers: s.markers,
      textOverlays: s.textOverlays,
    };
  },

  setVideoFile: (file) => {
    const url = URL.createObjectURL(file);
    set((state) => ({
      videoFile: file, videoUrl: url, videoData: null, videoDuration: 0, currentTime: 0, requestedSeekTime: null,
      pendingAction: null, clips: [],
      captions: [], transitions: [], markers: [], textOverlays: [], extraTracks: [],
      previewSnapshot: null, previewOwnerId: null,
      messages: state.messages, isChatLoading: false, ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null, taggedMarkerIds: [],
      playbackActive: false,
      aiSettings: DEFAULT_AI_EDITING_SETTINGS,
      appliedActions: [],
      history: [], future: [],
      backgroundTranscript: null,
      transcriptStatus: 'idle' as TranscriptStatus,
      transcriptProgress: null,
      sourceTranscriptCaptions: null,
      sourceOverviewFrames: null,
      projectedOverviewFrames: null,
      sourceIndexFreshBySourceId: buildInitialSourceIndexState([MAIN_SOURCE_ID]),
      timelineProjectionFresh: true,
      visualSearchSession: null,
      currentProjectId: null, storagePath: null, uploadProgress: null, saveStatus: 'idle' as const,
      mediaLibrary: [{ id: uuidv4(), url, name: file.name, duration: 0, sourceId: MAIN_SOURCE_ID }],
    }));
  },

  setVideoDuration: (duration) => {
    const { clips, mediaLibrary, aiSettings, sourceTranscriptCaptions, sourceOverviewFrames } = get();
    const updatedLibrary = mediaLibrary.map((item, i) =>
      i === 0 && item.duration === 0 ? { ...item, duration } : item
    );
    // Initialize a single clip spanning full video on first load
    if (clips.length === 0 && duration > 0) {
      const nextClips = [makeClip(0, duration, MAIN_SOURCE_ID)];
      set({
        videoDuration: duration,
        clips: nextClips,
        mediaLibrary: updatedLibrary,
        ...buildDerivedIndexState(nextClips, aiSettings, sourceTranscriptCaptions, sourceOverviewFrames),
      });
    } else {
      set({ videoDuration: duration, mediaLibrary: updatedLibrary });
    }
  },

  setCurrentTime: (time) => set({ currentTime: time }),
  requestSeek: (time) => set({ requestedSeekTime: Math.max(0, time) }),
  clearRequestedSeek: () => set({ requestedSeekTime: null }),
  setPendingAction: (action) => set({ pendingAction: action }),
  setPreviewSnapshot: (ownerId, snapshot) => set({ previewSnapshot: snapshot, previewOwnerId: ownerId }),
  clearPreviewSnapshot: (ownerId) => set(state => {
    if (ownerId && state.previewOwnerId && state.previewOwnerId !== ownerId) return state;
    return { previewSnapshot: null, previewOwnerId: null };
  }),
  commitPreviewSnapshot: (snapshot) => {
    const current = (get() as unknown as EditorStoreWithSnapshot)._snapshot();
    set(state => ({
      ...snapshot,
      history: [...state.history, current],
      future: [],
      pendingAction: null,
      selectedItem: normalizeSelectedItem(state.selectedItem, snapshot.markers),
      taggedMarkerIds: filterTaggedMarkerIds(state.taggedMarkerIds, snapshot.markers),
      previewSnapshot: null,
      previewOwnerId: null,
      ...buildDerivedIndexState(
        snapshot.clips,
        state.aiSettings,
        state.sourceTranscriptCaptions,
        state.sourceOverviewFrames,
      ),
    }));
  },

  // ── Clip actions ────────────────────────────────────────────────────────────

  splitClipAtTime: (timelineTime) => {
    const { clips } = get();
    const newClips = splitClipsAtTime(clips, timelineTime);
    if (newClips === clips) return;

    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const action: EditAction = {
      type: 'split_clip',
      splitTime: timelineTime,
      message: `Split clip at ${formatTimePrecise(timelineTime)}`,
    };

    set(state => ({
      history: [...state.history, snap],
      future: [],
      clips: newClips,
      markers: [],
      taggedMarkerIds: [],
      selectedItem: state.selectedItem?.type === 'marker' ? null : state.selectedItem,
      ...buildDerivedIndexState(
        newClips,
        state.aiSettings,
        state.sourceTranscriptCaptions,
        state.sourceOverviewFrames,
      ),
      appliedActions: [
        ...state.appliedActions.slice(-24),
        { id: uuidv4(), timestamp: Date.now(), action, summary: action.message },
      ],
    }));
  },

  deleteRangeAtTime: (startTime, endTime) => {
    const { clips } = get();
    const newClips = deleteRangeFromClips(clips, startTime, endTime);
    if (newClips === clips) return;
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();

    set(state => ({
      history: [...state.history, snap],
      future: [],
      clips: newClips,
      markers: [],
      taggedMarkerIds: [],
      selectedItem: state.selectedItem?.type === 'marker' ? null : state.selectedItem,
      ...buildDerivedIndexState(
        newClips,
        state.aiSettings,
        state.sourceTranscriptCaptions,
        state.sourceOverviewFrames,
      ),
    }));
  },

  deleteClip: (clipId) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      clips: s.clips.filter(c => c.id !== clipId),
      markers: [],
      taggedMarkerIds: [],
      selectedItem: null,
      ...buildDerivedIndexState(
        s.clips.filter(c => c.id !== clipId),
        s.aiSettings,
        s.sourceTranscriptCaptions,
        s.sourceOverviewFrames,
      ),
    }));
  },

  reorderClip: (clipId, newIndex) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const { clips } = get();
    const idx = clips.findIndex(c => c.id === clipId);
    if (idx === -1) return;
    const newClips = [...clips];
    const [removed] = newClips.splice(idx, 1);
    newClips.splice(Math.max(0, Math.min(newClips.length, newIndex)), 0, removed);
    set(state => ({
      history: [...state.history, snap],
      future: [],
      clips: newClips,
      markers: [],
      taggedMarkerIds: [],
      selectedItem: state.selectedItem?.type === 'marker' ? null : state.selectedItem,
      ...buildDerivedIndexState(
        newClips,
        state.aiSettings,
        state.sourceTranscriptCaptions,
        state.sourceOverviewFrames,
      ),
    }));
  },

  trimClip: (clipId, newSourceStart, newSourceDuration) => {
    set(s => {
      const nextClips = s.clips.map(c => c.id === clipId ? { ...c, sourceStart: newSourceStart, sourceDuration: newSourceDuration } : c);
      return {
        clips: nextClips,
        markers: [],
        taggedMarkerIds: [],
        selectedItem: s.selectedItem?.type === 'marker' ? null : s.selectedItem,
        ...buildDerivedIndexState(
          nextClips,
          s.aiSettings,
          s.sourceTranscriptCaptions,
          s.sourceOverviewFrames,
        ),
      };
    });
  },

  trimClipWithHistory: (clipId, newSourceStart, newSourceDuration) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set(s => {
      const nextClips = s.clips.map(c => c.id === clipId ? { ...c, sourceStart: newSourceStart, sourceDuration: newSourceDuration } : c);
      return {
        history: [...s.history, snap],
        future: [],
        clips: nextClips,
        markers: [],
        taggedMarkerIds: [],
        selectedItem: s.selectedItem?.type === 'marker' ? null : s.selectedItem,
        ...buildDerivedIndexState(
          nextClips,
          s.aiSettings,
          s.sourceTranscriptCaptions,
          s.sourceOverviewFrames,
        ),
      };
    });
  },

  setClipSpeed: (clipId, speed) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set(s => {
      const nextClips = s.clips.map(c => c.id === clipId ? { ...c, speed: Math.max(0.1, Math.min(10, speed)) } : c);
      return {
        history: [...s.history, snap],
        future: [],
        clips: nextClips,
        markers: [],
        taggedMarkerIds: [],
        selectedItem: s.selectedItem?.type === 'marker' ? null : s.selectedItem,
        ...buildDerivedIndexState(
          nextClips,
          s.aiSettings,
          s.sourceTranscriptCaptions,
          s.sourceOverviewFrames,
        ),
      };
    });
  },

  setClipVolume: (clipId, volume, fadeIn, fadeOut) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      clips: s.clips.map(c => c.id === clipId ? {
        ...c,
        volume,
        ...(fadeIn !== undefined ? { fadeIn } : {}),
        ...(fadeOut !== undefined ? { fadeOut } : {}),
      } : c),
    }));
  },

  setClipFilter: (clipId, filter) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      clips: s.clips.map(c => c.id === clipId ? { ...c, filter } : c),
    }));
  },

  setClipFade: (clipId, fadeIn, fadeOut) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      clips: s.clips.map(c => c.id === clipId ? { ...c, fadeIn, fadeOut } : c),
    }));
  },

  // ── Apply AI actions ────────────────────────────────────────────────────────

  applyAction: (action) => {
    if (action.type === 'none') return;
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    if (action.type === 'update_ai_settings') {
      set(state => ({
        aiSettings: mergeAISettings(state.aiSettings, action.settings),
        pendingAction: null,
        previewSnapshot: null,
        previewOwnerId: null,
        ...buildDerivedIndexState(
          state.clips,
          mergeAISettings(state.aiSettings, action.settings),
          state.sourceTranscriptCaptions,
          state.sourceOverviewFrames,
        ),
      }));
      return;
    }
    const next = applyActionToSnapshot(snap, action);
    if (next === snap) return;
    set(state => ({
      ...next,
      history: [...state.history, snap],
      future: [],
      pendingAction: null,
      selectedItem: normalizeSelectedItem(
        actionChangesTimelineStructure(action) ? null : state.selectedItem,
        next.markers,
      ),
      taggedMarkerIds: filterTaggedMarkerIds(state.taggedMarkerIds, next.markers),
      previewSnapshot: null,
      previewOwnerId: null,
      ...(actionChangesTimelineStructure(action)
        ? buildDerivedIndexState(
            next.clips,
            state.aiSettings,
            state.sourceTranscriptCaptions,
            state.sourceOverviewFrames,
          )
        : {}),
    }));
  },

  // ── Undo/redo ───────────────────────────────────────────────────────────────

  undo: () => {
    const { history, future } = get();
    if (history.length === 0) return;
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const prev = history[history.length - 1];
    set({
      ...prev,
      history: history.slice(0, -1),
      future: [snap, ...future],
      pendingAction: null,
      selectedItem: null,
      taggedMarkerIds: [],
      previewSnapshot: null,
      previewOwnerId: null,
      ...buildDerivedIndexState(
        prev.clips,
        get().aiSettings,
        get().sourceTranscriptCaptions,
        get().sourceOverviewFrames,
      ),
    });
  },

  redo: () => {
    const { history, future } = get();
    if (future.length === 0) return;
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const next = future[0];
    set({
      ...next,
      history: [...history, snap],
      future: future.slice(1),
      pendingAction: null,
      selectedItem: null,
      taggedMarkerIds: [],
      previewSnapshot: null,
      previewOwnerId: null,
      ...buildDerivedIndexState(
        next.clips,
        get().aiSettings,
        get().sourceTranscriptCaptions,
        get().sourceOverviewFrames,
      ),
    });
  },

  pushHistory: (snap) => set(s => ({ history: [...s.history, snap], future: [] })),

  // ── Chat ────────────────────────────────────────────────────────────────────

  addMessage: (msg) => set(s => ({
    messages: [...s.messages, { ...msg, id: uuidv4(), timestamp: Date.now() }],
  })),

  updateMessage: (id, patch) => set(s => ({
    messages: s.messages.map(message => (
      message.id === id ? { ...message, ...patch } : message
    )),
  })),

  setIsChatLoading: (v) => set({ isChatLoading: v }),

  clearChatHistory: () => set(() => ({
    messages: [],
    appliedActions: [],
    visualSearchSession: null,
    pendingAction: null,
    taggedMarkerIds: [],
  })),

  clearMessages: () => set(s => {
    const nextClips = s.videoDuration > 0 ? [makeClip(0, s.videoDuration, MAIN_SOURCE_ID)] : [];
    return {
      messages: [],
      appliedActions: [],
      visualSearchSession: null,
      pendingAction: null,
      clips: nextClips,
      captions: [],
      transitions: [],
      markers: [],
      textOverlays: [],
      previewSnapshot: null,
      previewOwnerId: null,
      extraTracks: [],
      selectedItem: null,
      taggedMarkerIds: [],
      ...buildDerivedIndexState(
        nextClips,
        s.aiSettings,
        s.sourceTranscriptCaptions,
        s.sourceOverviewFrames,
      ),
    };
  }),

  setAISettings: (settings) => set(state => {
    const aiSettings = mergeAISettings(state.aiSettings, settings);
    return {
      aiSettings,
      ...buildDerivedIndexState(
        state.clips,
        aiSettings,
        state.sourceTranscriptCaptions,
        state.sourceOverviewFrames,
      ),
    };
  }),

  recordAppliedAction: (action, summary, metadata) => set(state => ({
    appliedActions: [
      ...state.appliedActions.slice(-24),
      { id: uuidv4(), timestamp: Date.now(), action, summary, sourceRanges: metadata?.sourceRanges },
    ],
  })),

  // ── FFmpeg ──────────────────────────────────────────────────────────────────

  setFFmpegJob: (job) => set({ ffmpegJob: job }),

  setVideoCloud: (file, blobUrl, storagePath, projectId) => {
    set((state) => ({
      videoFile: file, videoUrl: blobUrl, videoData: null, videoDuration: 0, currentTime: 0, requestedSeekTime: null,
      pendingAction: null, clips: [],
      captions: [], transitions: [], markers: [], textOverlays: [], extraTracks: [],
      previewSnapshot: null, previewOwnerId: null,
      messages: state.messages, isChatLoading: false, ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null, taggedMarkerIds: [],
      playbackActive: false,
      aiSettings: DEFAULT_AI_EDITING_SETTINGS,
      appliedActions: [],
      history: [], future: [],
      backgroundTranscript: null,
      transcriptStatus: 'idle' as TranscriptStatus,
      transcriptProgress: null,
      sourceTranscriptCaptions: null,
      sourceOverviewFrames: null,
      projectedOverviewFrames: null,
      sourceIndexFreshBySourceId: buildInitialSourceIndexState([MAIN_SOURCE_ID]),
      timelineProjectionFresh: true,
      visualSearchSession: null,
      currentProjectId: projectId, storagePath, uploadProgress: null, saveStatus: 'idle',
      mediaLibrary: [{ id: uuidv4(), url: blobUrl, name: file.name, duration: 0, sourceId: MAIN_SOURCE_ID, sourcePath: storagePath }],
    }));
  },

  setProjectVideoFile: (file, projectId, storagePath = null) => {
    const url = URL.createObjectURL(file);
    set((state) => ({
      videoFile: file, videoUrl: url, videoData: null, videoDuration: 0, currentTime: 0, requestedSeekTime: null,
      pendingAction: null, clips: [],
      captions: [], transitions: [], markers: [], textOverlays: [], extraTracks: [],
      previewSnapshot: null, previewOwnerId: null,
      messages: state.messages, isChatLoading: false, ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null, taggedMarkerIds: [],
      playbackActive: false,
      aiSettings: DEFAULT_AI_EDITING_SETTINGS,
      appliedActions: [],
      history: [], future: [],
      backgroundTranscript: null,
      transcriptStatus: 'idle' as TranscriptStatus,
      transcriptProgress: null,
      sourceTranscriptCaptions: null,
      sourceOverviewFrames: null,
      projectedOverviewFrames: null,
      sourceIndexFreshBySourceId: buildInitialSourceIndexState([MAIN_SOURCE_ID]),
      timelineProjectionFresh: true,
      visualSearchSession: null,
      currentProjectId: projectId, storagePath, uploadProgress: null, saveStatus: 'idle',
      mediaLibrary: [{ id: uuidv4(), url, name: file.name, duration: 0, sourceId: MAIN_SOURCE_ID, ...(storagePath ? { sourcePath: storagePath } : {}) }],
    }));
  },

  loadProject: (editState, project) => {
    const { videoUrl, storagePath, projectId, videoFilename, duration, signedUrls = {} } = project;
    const clips = ((editState.clips as VideoClip[] | undefined) ?? []).map((clip) => normalizeLoadedClip(clip, storagePath));
    const sourceTranscriptCaptions = ((
      (editState.sourceTranscriptCaptions as CaptionEntry[] | undefined)
      ?? (editState.rawTranscriptCaptions as CaptionEntry[] | undefined)
      ?? null
    ))
      ?.map(normalizeCaptionSourceId) ?? null;
    const persistedMediaLibrary = Array.isArray(editState.mediaLibrary)
      ? (editState.mediaLibrary as Array<Partial<MediaLibraryItem>>)
          .filter((item) => (
            typeof item?.name === 'string'
            && typeof item.duration === 'number'
          ))
          .map((item) => ({
            id: uuidv4(),
            url: typeof item.sourcePath === 'string' ? (signedUrls[item.sourcePath] ?? '') : '',
            name: item.name as string,
            duration: item.duration as number,
            sourceId: normalizeSourceId(item.sourceId) ?? normalizeSourceId(item.sourcePath) ?? createImportedSourceId(),
            sourcePath: typeof item.sourcePath === 'string' ? item.sourcePath : undefined,
          }))
      : [];
    const persistedSourceOverviewFrames = Array.isArray(editState.sourceOverviewFrames)
      ? (editState.sourceOverviewFrames as Array<Partial<SourceIndexedFrame>>)
          .filter((frame) => (
            typeof frame?.sourceTime === 'number'
            && typeof frame.sourceId === 'string'
          ))
          .map((frame) => ({
            sourceTime: frame.sourceTime as number,
            sourceId: normalizeSourceId(frame.sourceId) ?? MAIN_SOURCE_ID,
            description: typeof frame.description === 'string' ? frame.description : undefined,
            image: typeof frame.image === 'string' ? frame.image : undefined,
            assetId: normalizeSourceId(frame.assetId) ?? null,
            indexedAt: typeof frame.indexedAt === 'string' ? frame.indexedAt : null,
          }))
      : Array.isArray(editState.videoFrames)
        ? (editState.videoFrames as Array<Partial<IndexedVideoFrame>>)
          .filter((frame) => (
            frame?.kind === 'overview'
            && typeof frame.sourceTime === 'number'
            && typeof frame.description === 'string'
          ))
          .map((frame) => ({
            sourceTime: frame.sourceTime as number,
            sourceId: normalizeSourceId(frame.sourceId) ?? MAIN_SOURCE_ID,
            description: frame.description as string,
            image: typeof frame.image === 'string' ? frame.image : undefined,
            assetId: null,
            indexedAt: null,
          }))
        : null;
    const persistedTranscript = typeof editState.backgroundTranscript === 'string' ? editState.backgroundTranscript : null;
    const persistedFreshness = editState.sourceIndexFreshBySourceId && typeof editState.sourceIndexFreshBySourceId === 'object'
      ? Object.entries(editState.sourceIndexFreshBySourceId as Record<string, Partial<SourceIndexState>>).reduce<SourceIndexStateMap>((acc, [sourceId, value]) => {
          const normalizedSourceId = normalizeSourceId(sourceId);
          if (!normalizedSourceId) return acc;
          acc[normalizedSourceId] = {
            overview: value?.overview === true,
            transcript: value?.transcript === true,
            version: typeof value?.version === 'string' ? value.version : SOURCE_INDEX_VERSION,
            assetId: normalizeSourceId(value?.assetId) ?? null,
            indexedAt: typeof value?.indexedAt === 'string' ? value.indexedAt : null,
          };
          return acc;
        }, {})
      : {};
    const clipSourceIds = collectSourceIds(clips);
    const transcriptSourceIds = collectSourceIds(sourceTranscriptCaptions ?? []);
    const frameSourceIds = collectSourceIds(persistedSourceOverviewFrames ?? []);
    const transcriptCoverageComplete = sourceTranscriptCaptions && sourceTranscriptCaptions.length > 0
      ? sourceCoverageIncludesAll(transcriptSourceIds, clipSourceIds)
      : clipSourceIds.size <= 1 && !!persistedTranscript;
    const frameCoverageComplete = sourceCoverageIncludesAll(frameSourceIds, clipSourceIds);
    const usableSourceTranscriptCaptions = transcriptCoverageComplete ? sourceTranscriptCaptions : null;
    const usableSourceOverviewFrames = frameCoverageComplete ? persistedSourceOverviewFrames : null;
    const backgroundTranscript = usableSourceTranscriptCaptions && usableSourceTranscriptCaptions.length > 0
      ? buildTranscriptContext(clips, usableSourceTranscriptCaptions)
      : transcriptCoverageComplete
        ? persistedTranscript
        : null;
    const transcriptStatus = backgroundTranscript
      ? 'done'
      : editState.transcriptStatus === 'error'
        ? 'error'
        : 'idle';
    const mediaLibraryByPath = new Map(
      persistedMediaLibrary
        .filter((item) => item.sourcePath)
        .map((item) => [item.sourcePath as string, item]),
    );
    const mediaLibraryBySourceId = new Map(
      persistedMediaLibrary
        .filter((item) => item.sourceId)
        .map((item) => [item.sourceId as string, item]),
    );
    const hydratedClips = sanitizeTimelineClips(clips.map((clip) => {
      const sourceItem = (clip.sourcePath ? mediaLibraryByPath.get(clip.sourcePath) : null)
        ?? mediaLibraryBySourceId.get(clip.sourceId);
      const sourceUrl = sourceItem?.url || (!clip.sourcePath && clip.sourceId === MAIN_SOURCE_ID ? videoUrl : clip.sourceUrl);
      return sourceUrl ? { ...clip, sourceUrl } : clip;
    }));
    const mainLibraryItem = videoUrl
      ? [{
          id: uuidv4(),
          url: storagePath ? (signedUrls[storagePath] ?? videoUrl) : videoUrl,
          name: videoFilename?.trim() || 'Main video',
          duration: duration ?? 0,
          sourceId: MAIN_SOURCE_ID,
          ...(storagePath ? { sourcePath: storagePath } : {}),
        }]
      : [];
    const mediaLibrary = [
      ...mainLibraryItem,
      ...persistedMediaLibrary.filter((item) => item.sourcePath !== storagePath),
    ];
    let sourceIndexFreshBySourceId = buildInitialSourceIndexState(clipSourceIds, persistedFreshness);
    for (const sourceId of clipSourceIds) {
      const existing = sourceIndexFreshBySourceId[sourceId];
      sourceIndexFreshBySourceId = patchSourceIndexState(sourceIndexFreshBySourceId, sourceId, {
        overview: existing?.overview || frameSourceIds.has(sourceId),
        transcript: existing?.transcript || transcriptSourceIds.has(sourceId),
      });
    }
    const derivedIndexState = buildDerivedIndexState(
      hydratedClips,
      mergeAISettings(DEFAULT_AI_EDITING_SETTINGS, editState.aiSettings as Partial<AIEditingSettings> | undefined),
      usableSourceTranscriptCaptions,
      usableSourceOverviewFrames,
    );

    set({
      videoUrl, videoData: null, videoFile: null, videoDuration: duration ?? 0,
      currentTime: 0, requestedSeekTime: null, pendingAction: null,
      clips: hydratedClips,
      captions: (editState.captions as CaptionEntry[] | undefined) ?? [],
      transitions: (editState.transitions as TransitionEntry[] | undefined) ?? [],
      markers: (editState.markers as MarkerEntry[] | undefined) ?? [],
      textOverlays: (editState.textOverlays as TextOverlayEntry[] | undefined) ?? [],
      previewSnapshot: null, previewOwnerId: null,
      extraTracks: [],
      messages: (editState.messages as ChatMessage[] | undefined) ?? [],
      appliedActions: ((editState.appliedActions as AppliedActionRecord[] | undefined) ?? []).map((entry) => ({
        ...entry,
        sourceRanges: entry.sourceRanges?.map((range) => ({
          ...range,
          sourceId: normalizeSourceId(range.sourceId)
            ?? normalizeSourceId(range.assetId)
            ?? MAIN_SOURCE_ID,
        })),
      })),
      ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null, taggedMarkerIds: [],
      playbackActive: false,
      aiSettings: mergeAISettings(DEFAULT_AI_EDITING_SETTINGS, editState.aiSettings as Partial<AIEditingSettings> | undefined),
      history: [], future: [],
      backgroundTranscript: derivedIndexState.backgroundTranscript ?? backgroundTranscript,
      transcriptStatus: transcriptStatus as TranscriptStatus,
      transcriptProgress: null,
      sourceTranscriptCaptions: usableSourceTranscriptCaptions,
      sourceOverviewFrames: usableSourceOverviewFrames && usableSourceOverviewFrames.length > 0 ? usableSourceOverviewFrames : null,
      projectedOverviewFrames: derivedIndexState.projectedOverviewFrames,
      sourceIndexFreshBySourceId,
      timelineProjectionFresh: derivedIndexState.timelineProjectionFresh,
      visualSearchSession: null,
      currentProjectId: projectId, storagePath, uploadProgress: null, saveStatus: 'idle',
      mediaLibrary,
    });
  },

  setUploadProgress: (pct) => set({ uploadProgress: pct }),
  setSaveStatus: (status) => set({ saveStatus: status }),
  setStoragePath: (path) => set({ storagePath: path }),

  // ── Zoom ────────────────────────────────────────────────────────────────────

  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(20, zoom)) }),
  setPlaybackActive: (active) => set({ playbackActive: active }),

  // ── Reset ───────────────────────────────────────────────────────────────────

  resetEditor: () => {
    const { videoUrl } = get();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    set({
      videoFile: null, videoUrl: '', videoData: null, videoDuration: 0, currentTime: 0, requestedSeekTime: null,
      pendingAction: null, clips: [],
      captions: [], transitions: [], markers: [], textOverlays: [], extraTracks: [],
      previewSnapshot: null, previewOwnerId: null,
      messages: [], isChatLoading: false,
      aiSettings: DEFAULT_AI_EDITING_SETTINGS,
      appliedActions: [],
      ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null, taggedMarkerIds: [],
      history: [], future: [],
      playbackActive: false,
      backgroundTranscript: null,
      transcriptStatus: 'idle' as TranscriptStatus,
      transcriptProgress: null,
      sourceTranscriptCaptions: null,
      sourceOverviewFrames: null,
      projectedOverviewFrames: null,
      sourceIndexFreshBySourceId: {},
      timelineProjectionFresh: true,
      visualSearchSession: null,
      currentProjectId: null, storagePath: null, uploadProgress: null, saveStatus: 'idle' as const,
      mediaLibrary: [],
    });
  },

  // ── Selection ───────────────────────────────────────────────────────────────

  setSelectedItem: (item) => set({ selectedItem: item }),
  setTaggedMarkerIds: (ids) => set(() => ({ taggedMarkerIds: [...new Set(ids)] })),
  toggleTaggedMarker: (id) => set((state) => ({
    taggedMarkerIds: state.taggedMarkerIds.includes(id)
      ? state.taggedMarkerIds.filter((markerId) => markerId !== id)
      : [...state.taggedMarkerIds, id],
  })),
  clearTaggedMarkers: () => set({ taggedMarkerIds: [] }),

  deleteSelectedItem: () => {
    const s = get();
    if (!s.selectedItem) return;
    const snap = (s as EditorStoreWithSnapshot)._snapshot();
    const { type, id } = s.selectedItem;
    const newHistory = [...s.history, snap];
    if (type === 'clip') {
      const nextClips = s.clips.filter(c => c.id !== id);
      set({
        history: newHistory,
        future: [],
        clips: nextClips,
        markers: [],
        taggedMarkerIds: [],
        selectedItem: null,
        ...buildDerivedIndexState(
          nextClips,
          s.aiSettings,
          s.sourceTranscriptCaptions,
          s.sourceOverviewFrames,
        ),
      });
    } else if (type === 'caption') {
      set({ history: newHistory, future: [], captions: s.captions.filter(c => c.id !== id), selectedItem: null });
    } else if (type === 'text') {
      set({ history: newHistory, future: [], textOverlays: s.textOverlays.filter(c => c.id !== id), selectedItem: null });
    } else if (type === 'transition') {
      set({ history: newHistory, future: [], transitions: s.transitions.filter(c => c.id !== id), selectedItem: null });
    } else if (type === 'marker') {
      set({
        history: newHistory,
        future: [],
        markers: s.markers.filter(marker => marker.id !== id),
        selectedItem: null,
        taggedMarkerIds: s.taggedMarkerIds.filter((markerId) => markerId !== id),
      });
    }
  },

  // ── Effect drag helpers ─────────────────────────────────────────────────────

  updateCaption: (id, patch) => set(s => ({
    captions: s.captions.map(c => c.id === id ? { ...c, ...patch } : c),
  })),

  updateTextOverlay: (id, patch) => set(s => ({
    textOverlays: s.textOverlays.map(t => t.id === id ? { ...t, ...patch } : t),
  })),

  updateTransition: (id, patch) => set(s => ({
    transitions: s.transitions.map(t => t.id === id ? { ...t, ...patch } : t),
  })),

  addMarker: (marker) => {
    const id = marker.id ?? uuidv4();
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const nextNumber = marker.number ?? (
      get().markers.length === 0
        ? 1
        : Math.max(...get().markers.map((entry) => entry.number)) + 1
    );
    set(s => ({
      history: [...s.history, snap],
      future: [],
      markers: [
        ...s.markers,
        {
          id,
          number: nextNumber,
          timelineTime: marker.timelineTime,
          label: marker.label,
          createdBy: marker.createdBy,
          status: marker.status,
          linkedRange: marker.linkedRange,
          linkedMessageId: marker.linkedMessageId ?? undefined,
          confidence: marker.confidence ?? null,
          note: marker.note,
        },
      ],
      selectedItem: { type: 'marker', id },
    }));
    return id;
  },

  updateMarker: (id, patch) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      markers: s.markers.map((marker) => (
        marker.id === id
          ? { ...marker, ...patch, number: patch.number ?? marker.number, timelineTime: patch.timelineTime ?? marker.timelineTime }
          : marker
      )),
    }));
  },

  removeMarker: (id) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      markers: s.markers.filter((marker) => marker.id !== id),
      taggedMarkerIds: s.taggedMarkerIds.filter((markerId) => markerId !== id),
      selectedItem: s.selectedItem?.type === 'marker' && s.selectedItem.id === id ? null : s.selectedItem,
    }));
  },

  createMarkerAtTime: (timelineTime, options) => get().addMarker({
    timelineTime,
    label: options?.label,
    createdBy: options?.createdBy ?? 'human',
    status: 'open',
    linkedMessageId: options?.linkedMessageId ?? undefined,
    confidence: null,
  }),

  // ── Extra track actions ─────────────────────────────────────────────────────

  addTrack: (type) => {
    const { extraTracks } = get();
    const typeCount = extraTracks.filter(t => t.type === type).length + 2; // +1 for main, +1 for new
    const id = uuidv4();
    set({
      extraTracks: [...extraTracks, {
        id,
        type,
        label: type === 'video' ? `V${typeCount}` : `A${typeCount}`,
        clips: [],
      }],
    });
    return id;
  },

  removeTrack: (trackId) => set(s => ({
    extraTracks: s.extraTracks.filter(t => t.id !== trackId),
  })),

  addClipToTrack: (trackId, clip) => set(s => ({
    extraTracks: s.extraTracks.map(t =>
      t.id === trackId
        ? { ...t, clips: [...t.clips, { ...clip, id: clip.id ?? uuidv4() }] }
        : t
    ),
  })),

  updateTrackClipSourcePath: (trackId, clipId, sourcePath) => set(s => ({
    extraTracks: s.extraTracks.map(t =>
      t.id === trackId
        ? { ...t, clips: t.clips.map(c => c.id === clipId ? { ...c, sourcePath } : c) }
        : t
    ),
  })),

  moveTrackClip: (trackId, clipId, newTimelineStart) => set(s => ({
    extraTracks: s.extraTracks.map(t =>
      t.id === trackId
        ? { ...t, clips: t.clips.map(c => c.id === clipId ? { ...c, timelineStart: Math.max(0, newTimelineStart) } : c) }
        : t
    ),
  })),

  trimTrackClip: (trackId, clipId, newSourceStart, newSourceDuration) => set(s => ({
    extraTracks: s.extraTracks.map(t =>
      t.id === trackId
        ? { ...t, clips: t.clips.map(c => c.id === clipId ? { ...c, sourceStart: newSourceStart, sourceDuration: newSourceDuration } : c) }
        : t
    ),
  })),

  removeTrackClip: (trackId, clipId) => set(s => ({
    extraTracks: s.extraTracks.map(t =>
      t.id === trackId
        ? { ...t, clips: t.clips.filter(c => c.id !== clipId) }
        : t
    ),
  })),

  addToMediaLibrary: async (file) => {
    const url = URL.createObjectURL(file);
    const duration = await new Promise<number>((resolve) => {
      const tmp = document.createElement('video');
      tmp.preload = 'metadata';
      tmp.onloadedmetadata = () => { resolve(tmp.duration); tmp.src = ''; };
      tmp.onerror = () => resolve(0);
      tmp.src = url;
    });
    const item: MediaLibraryItem = { id: uuidv4(), url, name: file.name, duration, sourceId: createImportedSourceId() };
    set(s => ({ mediaLibrary: [...s.mediaLibrary, item] }));
    return url;
  },

  addMediaLibraryItem: (item) => {
    const id = uuidv4();
    set(s => {
      const existing = s.mediaLibrary.find(entry =>
        (item.sourceId && entry.sourceId === item.sourceId)
        || (item.sourcePath && entry.sourcePath === item.sourcePath)
        || entry.url === item.url
      );
      if (existing) {
        return {
          mediaLibrary: s.mediaLibrary.map((entry) => (
            entry.id !== existing.id
              ? entry
              : {
                  ...entry,
                  sourceId: normalizeSourceId(entry.sourceId) ?? normalizeSourceId(item.sourceId) ?? normalizeSourceId(item.sourcePath) ?? createImportedSourceId(),
                  sourcePath: entry.sourcePath ?? item.sourcePath,
                }
          )),
        };
      }
      return {
        mediaLibrary: [
          ...s.mediaLibrary,
          {
            ...item,
            id,
            sourceId: normalizeSourceId(item.sourceId) ?? normalizeSourceId(item.sourcePath) ?? createImportedSourceId(),
          },
        ],
      };
    });
    return id;
  },

  appendVideoToTimeline: (sourceUrl, sourceName, duration, sourcePath, sourceId) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const { clips, mediaLibrary } = get();
    const clipId = uuidv4();
    const resolvedSourceId = normalizeSourceId(sourceId) ?? createImportedSourceId();
    const newClip: VideoClip = {
      id: clipId,
      sourceId: resolvedSourceId,
      sourceStart: 0,
      sourceDuration: duration,
      speed: 1.0,
      volume: 1.0,
      filter: null,
      fadeIn: 0,
      fadeOut: 0,
      sourceUrl,
      sourcePath,
      sourceName,
    };
    // Register in media library if not already present
    const alreadyInLibrary = mediaLibrary.some(item =>
      item.sourceId === resolvedSourceId
      || (sourcePath && item.sourcePath === sourcePath)
      || item.url === sourceUrl
    );
    const newLibrary = alreadyInLibrary ? mediaLibrary : [...mediaLibrary, {
      id: uuidv4(),
      url: sourceUrl,
      name: sourceName,
      duration,
      sourceId: resolvedSourceId,
      sourcePath,
    }];
    const nextClips = [...clips, newClip];
    set({
      history: [...get().history, snap],
      future: [],
      clips: nextClips,
      mediaLibrary: newLibrary,
      transcriptStatus: 'idle',
      transcriptProgress: null,
      sourceIndexFreshBySourceId: patchSourceIndexState(
        get().sourceIndexFreshBySourceId,
        resolvedSourceId,
        { overview: false, transcript: false },
      ),
      ...buildDerivedIndexState(
        nextClips,
        get().aiSettings,
        get().sourceTranscriptCaptions,
        get().sourceOverviewFrames,
      ),
    });
    return clipId;
  },

  insertVideoIntoTimeline: (sourceUrl, sourceName, duration, insertAtTime, sourcePath, sourceId) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const { clips, mediaLibrary } = get();
    const clipId = uuidv4();
    const resolvedSourceId = normalizeSourceId(sourceId) ?? createImportedSourceId();
    const newClip: VideoClip = {
      id: clipId,
      sourceId: resolvedSourceId,
      sourceStart: 0,
      sourceDuration: duration,
      speed: 1.0,
      volume: 1.0,
      filter: null,
      fadeIn: 0,
      fadeOut: 0,
      sourceUrl,
      sourcePath,
      sourceName,
    };

    const schedule = buildClipSchedule(clips);
    const newClips = [...clips];
    if (schedule.length === 0 || insertAtTime >= schedule[schedule.length - 1].timelineEnd - 0.001) {
      newClips.push(newClip);
    } else {
      const targetEntry = schedule.find(entry => insertAtTime < entry.timelineEnd);
      if (!targetEntry) {
        newClips.push(newClip);
      } else {
        const clipIndex = newClips.findIndex(c => c.id === targetEntry.clipId);
        if (clipIndex === -1) {
          newClips.push(newClip);
        } else if (insertAtTime <= targetEntry.timelineStart + 0.001) {
          newClips.splice(clipIndex, 0, newClip);
        } else {
          const clip = newClips[clipIndex];
          const splitOffset = (insertAtTime - targetEntry.timelineStart) * targetEntry.speed;
          const beforeDuration = splitOffset;
          const afterDuration = clip.sourceDuration - splitOffset;
          if (beforeDuration <= 0.05 || afterDuration <= 0.05) {
            newClips.splice(clipIndex + (beforeDuration > afterDuration ? 1 : 0), 0, newClip);
          } else {
            const beforeClip: VideoClip = { ...clip, sourceDuration: beforeDuration };
            const afterClip: VideoClip = {
              ...clip,
              id: uuidv4(),
              sourceStart: clip.sourceStart + splitOffset,
              sourceDuration: afterDuration,
            };
            newClips.splice(clipIndex, 1, beforeClip, newClip, afterClip);
          }
        }
      }
    }

    const alreadyInLibrary = mediaLibrary.some(item =>
      item.sourceId === resolvedSourceId
      || (sourcePath && item.sourcePath === sourcePath)
      || item.url === sourceUrl
    );
    const newLibrary = alreadyInLibrary ? mediaLibrary : [...mediaLibrary, {
      id: uuidv4(),
      url: sourceUrl,
      name: sourceName,
      duration,
      sourceId: resolvedSourceId,
      sourcePath,
    }];
    set({
      history: [...get().history, snap],
      future: [],
      clips: newClips,
      mediaLibrary: newLibrary,
      transcriptStatus: 'idle',
      transcriptProgress: null,
      sourceIndexFreshBySourceId: patchSourceIndexState(
        get().sourceIndexFreshBySourceId,
        resolvedSourceId,
        { overview: false, transcript: false },
      ),
      ...buildDerivedIndexState(
        newClips,
        get().aiSettings,
        get().sourceTranscriptCaptions,
        get().sourceOverviewFrames,
      ),
    });
    return clipId;
  },

  updateClipSourcePath: (clipId, sourcePath) => set(s => ({
    clips: s.clips.map(clip => clip.id === clipId ? { ...clip, sourcePath } : clip),
    mediaLibrary: s.mediaLibrary.map(item =>
      item.sourceId === s.clips.find(clip => clip.id === clipId)?.sourceId && !item.sourcePath
        ? { ...item, sourcePath }
        : item
    ),
  })),

  setBackgroundTranscript: (text, status, rawCaptions) => set((state) => ({
    backgroundTranscript: rawCaptions !== undefined
      ? buildTranscriptContext(state.clips, rawCaptions)
      : text,
    transcriptStatus: status,
    transcriptProgress: status === 'loading' ? state.transcriptProgress : null,
    ...(rawCaptions !== undefined ? { sourceTranscriptCaptions: rawCaptions } : {}),
    ...(rawCaptions !== undefined ? {
      sourceIndexFreshBySourceId: Object.keys(
        buildInitialSourceIndexState(collectSourceIds(rawCaptions), state.sourceIndexFreshBySourceId),
      ).reduce<SourceIndexStateMap>((acc, sourceId) => (
        patchSourceIndexState(acc, sourceId, { transcript: true })
      ), state.sourceIndexFreshBySourceId),
    } : {}),
  })),
  setTranscriptProgress: (progress) => set({ transcriptProgress: progress }),
  setSourceOverviewFrames: (sourceId, frames, options) => set((state) => {
    const sourceOverviewFrames = mergeSourceOverviewFrames(state.sourceOverviewFrames, sourceId, frames);
    const sourceIndexFreshBySourceId = patchSourceIndexState(state.sourceIndexFreshBySourceId, sourceId, {
      overview: options?.fresh ?? false,
      assetId: options?.assetId,
      indexedAt: options?.indexedAt,
    });
    return {
      sourceOverviewFrames,
      sourceIndexFreshBySourceId,
      ...buildDerivedIndexState(
        state.clips,
        state.aiSettings,
        state.sourceTranscriptCaptions,
        sourceOverviewFrames,
      ),
    };
  }),
  hydrateSourceIndex: (payload) => set((state) => {
    const sourceTranscriptCaptions = payload.sourceTranscriptCaptions ?? state.sourceTranscriptCaptions;
    const sourceOverviewFrames = payload.sourceOverviewFrames ?? state.sourceOverviewFrames;
    const sourceIndexFreshBySourceId = payload.sourceIndexFreshBySourceId
      ? { ...state.sourceIndexFreshBySourceId, ...payload.sourceIndexFreshBySourceId }
      : state.sourceIndexFreshBySourceId;
    return {
      sourceTranscriptCaptions,
      sourceOverviewFrames,
      sourceIndexFreshBySourceId,
      ...buildDerivedIndexState(
        state.clips,
        state.aiSettings,
        sourceTranscriptCaptions,
        sourceOverviewFrames,
      ),
      transcriptStatus: sourceTranscriptCaptions && sourceTranscriptCaptions.length > 0 ? 'done' : state.transcriptStatus,
    };
  }),
  setVisualSearchSession: (session) => set({ visualSearchSession: session }),
}));
