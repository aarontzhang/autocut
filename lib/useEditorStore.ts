'use client';

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import {
  AppliedActionRecord,
  AIEditingSettings,
  CaptionEntry,
  ChatMessage,
  ColorFilter,
  EditAction,
  IndexedVideoFrame,
  MarkerEntry,
  SourceIndex,
  SourceIndexState,
  SourceIndexedFrame,
  TextOverlayEntry,
  TransitionEntry,
  VideoClip,
  VisualSearchSession,
} from './types';
import {
  actionChangesTimelineStructure,
  applyActionToSnapshot,
  deleteRangeFromClips,
  EditSnapshot,
  sanitizeTimelineClips,
  splitClipsAtTime,
} from './editActionUtils';
import { buildTranscriptContext, formatTimePrecise, projectSourceFramesToTimeline } from './timelineUtils';
import { MAIN_SOURCE_ID, normalizeSourceId } from './sourceUtils';

export type { EditSnapshot } from './editActionUtils';

export type TranscriptStatus = 'idle' | 'loading' | 'done' | 'error';
export type TranscriptProgress = {
  completed: number;
  total: number;
} | null;

export const SOURCE_INDEX_VERSION = 'source-index-v1';
export type SourceIndexStateMap = Record<string, SourceIndexState>;

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

export type PendingDeleteRanges = { ownerId: string; ranges: Array<{ start: number; end: number }> };

function makeClip(sourceStart: number, sourceDuration: number): VideoClip {
  return {
    id: uuidv4(),
    sourceId: MAIN_SOURCE_ID,
    sourceStart,
    sourceDuration,
    speed: 1,
    volume: 1,
    filter: null,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function normalizeLoadedClip(
  clip: Partial<VideoClip> & { sourcePath?: unknown },
  mainSourcePath?: string | null,
): VideoClip | null {
  const clipSourceId = normalizeSourceId(clip.sourceId);
  const clipSourcePath = typeof clip.sourcePath === 'string' ? clip.sourcePath.trim() : null;
  const isLegacySecondarySource = (
    (clipSourceId && clipSourceId !== MAIN_SOURCE_ID)
    || (clipSourcePath && mainSourcePath && clipSourcePath !== mainSourcePath)
  );
  if (isLegacySecondarySource) return null;
  if (typeof clip.id !== 'string') return null;
  if (!Number.isFinite(clip.sourceStart) || !Number.isFinite(clip.sourceDuration)) return null;

  return {
    id: clip.id,
    sourceId: MAIN_SOURCE_ID,
    sourceStart: clip.sourceStart!,
    sourceDuration: clip.sourceDuration!,
    speed: Number.isFinite(clip.speed) && clip.speed! > 0 ? clip.speed! : 1,
    volume: Number.isFinite(clip.volume) ? clip.volume! : 1,
    filter: clip.filter ?? null,
    fadeIn: Number.isFinite(clip.fadeIn) ? clip.fadeIn! : 0,
    fadeOut: Number.isFinite(clip.fadeOut) ? clip.fadeOut! : 0,
  };
}

function normalizeCaptionEntry(entry: Partial<CaptionEntry>): CaptionEntry | null {
  const sourceId = normalizeSourceId(entry.sourceId);
  if (sourceId && sourceId !== MAIN_SOURCE_ID) return null;
  if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.endTime) || typeof entry.text !== 'string') {
    return null;
  }
  return {
    id: typeof entry.id === 'string' ? entry.id : undefined,
    sourceId: MAIN_SOURCE_ID,
    startTime: entry.startTime!,
    endTime: entry.endTime!,
    text: entry.text!,
  };
}

function normalizeOverviewFrame(entry: Partial<SourceIndexedFrame>): SourceIndexedFrame | null {
  const sourceId = normalizeSourceId(entry.sourceId);
  if (sourceId && sourceId !== MAIN_SOURCE_ID) return null;
  if (!Number.isFinite(entry.sourceTime)) return null;
  return {
    sourceId: MAIN_SOURCE_ID,
    sourceTime: entry.sourceTime!,
    description: typeof entry.description === 'string' ? entry.description : undefined,
    image: typeof entry.image === 'string' ? entry.image : undefined,
    assetId: normalizeSourceId(entry.assetId) ?? null,
    indexedAt: typeof entry.indexedAt === 'string' ? entry.indexedAt : null,
  };
}

function buildInitialSourceIndexState(
  overrides?: SourceIndexStateMap,
): SourceIndexStateMap {
  return {
    [MAIN_SOURCE_ID]: overrides?.[MAIN_SOURCE_ID] ?? {
      overview: false,
      transcript: false,
      version: SOURCE_INDEX_VERSION,
    },
  };
}

function patchSourceIndexState(
  current: SourceIndexStateMap,
  patch: Partial<SourceIndexState>,
): SourceIndexStateMap {
  const existing = current[MAIN_SOURCE_ID] ?? {
    overview: false,
    transcript: false,
    version: SOURCE_INDEX_VERSION,
  };
  return {
    ...current,
    [MAIN_SOURCE_ID]: {
      ...existing,
      ...patch,
      version: patch.version ?? existing.version ?? SOURCE_INDEX_VERSION,
    },
  };
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
    overviewIntervalSeconds: 2,
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

function buildBaseEditorState(input?: {
  videoFile?: File | null;
  videoUrl?: string;
  videoName?: string;
  currentProjectId?: string | null;
  storagePath?: string | null;
}): Pick<
  EditorState,
  | 'videoFile'
  | 'videoUrl'
  | 'videoName'
  | 'videoData'
  | 'videoDuration'
  | 'currentTime'
  | 'requestedSeekTime'
  | 'pendingAction'
  | 'clips'
  | 'captions'
  | 'transitions'
  | 'markers'
  | 'textOverlays'
  | 'previewSnapshot'
  | 'previewOwnerId'
  | 'selectedItem'
  | 'taggedMarkerIds'
  | 'history'
  | 'future'
  | 'isChatLoading'
  | 'aiSettings'
  | 'appliedActions'
  | 'ffmpegJob'
  | 'currentProjectId'
  | 'storagePath'
  | 'uploadProgress'
  | 'saveStatus'
  | 'zoom'
  | 'playbackActive'
  | 'backgroundTranscript'
  | 'transcriptStatus'
  | 'transcriptProgress'
  | 'sourceTranscriptCaptions'
  | 'sourceOverviewFrames'
  | 'projectedOverviewFrames'
  | 'sourceIndexFreshBySourceId'
  | 'timelineProjectionFresh'
  | 'visualSearchSession'
  | 'sourceIndex'
  | 'pendingDeleteRanges'
> {
  return {
    videoFile: input?.videoFile ?? null,
    videoUrl: input?.videoUrl ?? '',
    videoName: input?.videoName ?? '',
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
    selectedItem: null,
    taggedMarkerIds: [],
    history: [],
    future: [],
    isChatLoading: false,
    aiSettings: DEFAULT_AI_EDITING_SETTINGS,
    appliedActions: [],
    ffmpegJob: { status: 'idle' },
    currentProjectId: input?.currentProjectId ?? null,
    storagePath: input?.storagePath ?? null,
    uploadProgress: null,
    saveStatus: 'idle',
    zoom: 1,
    playbackActive: false,
    backgroundTranscript: null,
    transcriptStatus: 'idle',
    transcriptProgress: null,
    sourceTranscriptCaptions: null,
    sourceOverviewFrames: null,
    projectedOverviewFrames: null,
    sourceIndexFreshBySourceId: buildInitialSourceIndexState(),
    timelineProjectionFresh: true,
    visualSearchSession: null,
    sourceIndex: null,
    pendingDeleteRanges: null,
  };
}

interface EditorState {
  videoFile: File | null;
  videoUrl: string;
  videoName: string;
  videoData: Uint8Array | null;
  videoDuration: number;
  currentTime: number;
  requestedSeekTime: number | null;
  pendingAction: EditAction | null;
  clips: VideoClip[];
  captions: CaptionEntry[];
  transitions: TransitionEntry[];
  markers: MarkerEntry[];
  textOverlays: TextOverlayEntry[];
  previewSnapshot: EditSnapshot | null;
  previewOwnerId: string | null;
  selectedItem: SelectedItem;
  taggedMarkerIds: string[];
  history: EditSnapshot[];
  future: EditSnapshot[];
  messages: ChatMessage[];
  isChatLoading: boolean;
  aiSettings: AIEditingSettings;
  appliedActions: AppliedActionRecord[];
  ffmpegJob: FFmpegJob;
  currentProjectId: string | null;
  storagePath: string | null;
  uploadProgress: number | null;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  zoom: number;
  playbackActive: boolean;
  backgroundTranscript: string | null;
  transcriptStatus: TranscriptStatus;
  transcriptProgress: TranscriptProgress;
  sourceTranscriptCaptions: CaptionEntry[] | null;
  sourceOverviewFrames: SourceIndexedFrame[] | null;
  projectedOverviewFrames: IndexedVideoFrame[] | null;
  sourceIndexFreshBySourceId: SourceIndexStateMap;
  timelineProjectionFresh: boolean;
  visualSearchSession: VisualSearchSession | null;
  sourceIndex: SourceIndex | null;
  pendingDeleteRanges: PendingDeleteRanges | null;
  setVideoFile: (file: File) => void;
  setVideoDuration: (duration: number) => void;
  setCurrentTime: (time: number) => void;
  requestSeek: (time: number) => void;
  clearRequestedSeek: () => void;
  setPendingAction: (action: EditAction | null) => void;
  setPreviewSnapshot: (ownerId: string, snapshot: EditSnapshot) => void;
  clearPreviewSnapshot: (ownerId?: string) => void;
  commitPreviewSnapshot: (snapshot: EditSnapshot) => void;
  setPendingDeleteRanges: (ownerId: string, ranges: Array<{ start: number; end: number }>) => void;
  clearPendingDeleteRanges: (ownerId?: string) => void;
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
  applyAction: (action: EditAction) => void;
  undo: () => void;
  redo: () => void;
  pushHistory: (snap: EditSnapshot) => void;
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
      videoDuration?: number;
      sourceIndex?: unknown;
    },
    project: {
      projectId: string;
      videoUrl: string;
      storagePath: string | null;
      videoFilename?: string | null;
      duration?: number;
    }
  ) => void;
  setUploadProgress: (pct: number | null) => void;
  setSaveStatus: (status: 'idle' | 'saving' | 'saved' | 'error') => void;
  setStoragePath: (path: string) => void;
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
  setSourceIndex: (index: SourceIndex | null) => void;
  addMarker: (marker: Omit<MarkerEntry, 'id' | 'number'> & { id?: string; number?: number }) => string;
  updateMarker: (id: string, patch: Partial<Omit<MarkerEntry, 'id'>>) => void;
  removeMarker: (id: string) => void;
  createMarkerAtTime: (timelineTime: number, options?: { label?: string; createdBy?: 'ai' | 'human'; linkedMessageId?: string | null }) => string;
  resetEditor: () => void;
  setSelectedItem: (item: SelectedItem) => void;
  setTaggedMarkerIds: (ids: string[]) => void;
  toggleTaggedMarker: (id: string) => void;
  clearTaggedMarkers: () => void;
  deleteSelectedItem: () => void;
  updateCaption: (id: string, patch: { startTime?: number; endTime?: number }) => void;
  updateTextOverlay: (id: string, patch: { startTime?: number; endTime?: number }) => void;
  updateTransition: (id: string, patch: { atTime?: number }) => void;
}

type EditorStoreWithSnapshot = EditorState & {
  _snapshot: () => EditSnapshot;
};

export const useEditorStore = create<EditorState>((set, get) => ({
  ...buildBaseEditorState(),
  messages: [],

  _snapshot: (): EditSnapshot => {
    const s = get();
    return {
      clips: s.clips,
      captions: s.captions,
      transitions: s.transitions,
      markers: s.markers,
      textOverlays: s.textOverlays,
      appliedActions: s.appliedActions,
    };
  },

  setVideoFile: (file) => {
    const url = URL.createObjectURL(file);
    set((state) => ({
      ...buildBaseEditorState({
        videoFile: file,
        videoUrl: url,
        videoName: file.name,
      }),
      messages: state.messages,
    }));
  },

  setVideoDuration: (duration) => {
    const { clips, aiSettings, sourceTranscriptCaptions, sourceOverviewFrames } = get();
    if (clips.length === 0 && duration > 0) {
      const nextClips = [makeClip(0, duration)];
      set({
        videoDuration: duration,
        clips: nextClips,
        ...buildDerivedIndexState(nextClips, aiSettings, sourceTranscriptCaptions, sourceOverviewFrames),
      });
      return;
    }
    set({ videoDuration: duration });
  },

  setCurrentTime: (time) => set({ currentTime: time }),
  requestSeek: (time) => set({ requestedSeekTime: Math.max(0, time) }),
  clearRequestedSeek: () => set({ requestedSeekTime: null }),
  setPendingAction: (action) => set({ pendingAction: action }),
  setPreviewSnapshot: (ownerId, snapshot) => set({ previewSnapshot: snapshot, previewOwnerId: ownerId }),
  clearPreviewSnapshot: (ownerId) => set((state) => {
    if (ownerId && state.previewOwnerId && state.previewOwnerId !== ownerId) return state;
    return { previewSnapshot: null, previewOwnerId: null };
  }),

  setPendingDeleteRanges: (ownerId, ranges) => set({ pendingDeleteRanges: { ownerId, ranges } }),
  clearPendingDeleteRanges: (ownerId) => set((state) => {
    if (ownerId && state.pendingDeleteRanges && state.pendingDeleteRanges.ownerId !== ownerId) return state;
    return { pendingDeleteRanges: null };
  }),
  commitPreviewSnapshot: (snapshot) => {
    const current = (get() as unknown as EditorStoreWithSnapshot)._snapshot();
    set((state) => ({
      ...snapshot,
      history: [...state.history, current],
      future: [],
      pendingAction: null,
      selectedItem: normalizeSelectedItem(state.selectedItem, snapshot.markers),
      taggedMarkerIds: filterTaggedMarkerIds(state.taggedMarkerIds, snapshot.markers),
      previewSnapshot: null,
      previewOwnerId: null,
      pendingDeleteRanges: null,
      ...buildDerivedIndexState(
        snapshot.clips,
        state.aiSettings,
        state.sourceTranscriptCaptions,
        state.sourceOverviewFrames,
      ),
    }));
  },

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

    set((state) => ({
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
    set((state) => ({
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
    set((state) => {
      const nextClips = state.clips.filter((clip) => clip.id !== clipId);
      return {
        history: [...state.history, snap],
        future: [],
        clips: nextClips,
        markers: [],
        taggedMarkerIds: [],
        selectedItem: null,
        ...buildDerivedIndexState(
          nextClips,
          state.aiSettings,
          state.sourceTranscriptCaptions,
          state.sourceOverviewFrames,
        ),
      };
    });
  },

  reorderClip: (clipId, newIndex) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const { clips } = get();
    const idx = clips.findIndex((clip) => clip.id === clipId);
    if (idx === -1) return;
    const nextClips = [...clips];
    const [removed] = nextClips.splice(idx, 1);
    nextClips.splice(Math.max(0, Math.min(nextClips.length, newIndex)), 0, removed);
    set((state) => ({
      history: [...state.history, snap],
      future: [],
      clips: nextClips,
      markers: [],
      taggedMarkerIds: [],
      selectedItem: state.selectedItem?.type === 'marker' ? null : state.selectedItem,
      ...buildDerivedIndexState(
        nextClips,
        state.aiSettings,
        state.sourceTranscriptCaptions,
        state.sourceOverviewFrames,
      ),
    }));
  },

  trimClip: (clipId, newSourceStart, newSourceDuration) => {
    set((state) => {
      const nextClips = state.clips.map((clip) => (
        clip.id === clipId
          ? { ...clip, sourceStart: newSourceStart, sourceDuration: newSourceDuration }
          : clip
      ));
      return {
        clips: nextClips,
        markers: [],
        taggedMarkerIds: [],
        selectedItem: state.selectedItem?.type === 'marker' ? null : state.selectedItem,
        ...buildDerivedIndexState(
          nextClips,
          state.aiSettings,
          state.sourceTranscriptCaptions,
          state.sourceOverviewFrames,
        ),
      };
    });
  },

  trimClipWithHistory: (clipId, newSourceStart, newSourceDuration) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set((state) => {
      const nextClips = state.clips.map((clip) => (
        clip.id === clipId
          ? { ...clip, sourceStart: newSourceStart, sourceDuration: newSourceDuration }
          : clip
      ));
      return {
        history: [...state.history, snap],
        future: [],
        clips: nextClips,
        markers: [],
        taggedMarkerIds: [],
        selectedItem: state.selectedItem?.type === 'marker' ? null : state.selectedItem,
        ...buildDerivedIndexState(
          nextClips,
          state.aiSettings,
          state.sourceTranscriptCaptions,
          state.sourceOverviewFrames,
        ),
      };
    });
  },

  setClipSpeed: (clipId, speed) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set((state) => {
      const nextClips = state.clips.map((clip) => (
        clip.id === clipId
          ? { ...clip, speed: Math.max(0.1, Math.min(10, speed)) }
          : clip
      ));
      return {
        history: [...state.history, snap],
        future: [],
        clips: nextClips,
        markers: [],
        taggedMarkerIds: [],
        selectedItem: state.selectedItem?.type === 'marker' ? null : state.selectedItem,
        ...buildDerivedIndexState(
          nextClips,
          state.aiSettings,
          state.sourceTranscriptCaptions,
          state.sourceOverviewFrames,
        ),
      };
    });
  },

  setClipVolume: (clipId, volume, fadeIn, fadeOut) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set((state) => ({
      history: [...state.history, snap],
      future: [],
      clips: state.clips.map((clip) => (
        clip.id === clipId
          ? {
              ...clip,
              volume,
              ...(fadeIn !== undefined ? { fadeIn } : {}),
              ...(fadeOut !== undefined ? { fadeOut } : {}),
            }
          : clip
      )),
    }));
  },

  setClipFilter: (clipId, filter) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set((state) => ({
      history: [...state.history, snap],
      future: [],
      clips: state.clips.map((clip) => (
        clip.id === clipId ? { ...clip, filter } : clip
      )),
    }));
  },

  setClipFade: (clipId, fadeIn, fadeOut) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set((state) => ({
      history: [...state.history, snap],
      future: [],
      clips: state.clips.map((clip) => (
        clip.id === clipId ? { ...clip, fadeIn, fadeOut } : clip
      )),
    }));
  },

  applyAction: (action) => {
    if (action.type === 'none') return;
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    if (action.type === 'update_ai_settings') {
      set((state) => {
        const aiSettings = mergeAISettings(state.aiSettings, action.settings);
        return {
          aiSettings,
          pendingAction: null,
          previewSnapshot: null,
          previewOwnerId: null,
          ...buildDerivedIndexState(
            state.clips,
            aiSettings,
            state.sourceTranscriptCaptions,
            state.sourceOverviewFrames,
          ),
        };
      });
      return;
    }
    const next = applyActionToSnapshot(snap, action);
    if (next === snap) return;
    set((state) => ({
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
      pendingDeleteRanges: null,
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

  undo: () => {
    const { history, future } = get();
    if (history.length === 0) return;
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const prev = history[history.length - 1];
    set({
      ...prev,
      history: history.slice(0, -1),
      future: [snap, ...future],
      appliedActions: prev.appliedActions ?? get().appliedActions,
      pendingAction: null,
      selectedItem: null,
      taggedMarkerIds: [],
      previewSnapshot: null,
      previewOwnerId: null,
      pendingDeleteRanges: null,
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
      appliedActions: next.appliedActions ?? get().appliedActions,
      pendingAction: null,
      selectedItem: null,
      taggedMarkerIds: [],
      previewSnapshot: null,
      previewOwnerId: null,
      pendingDeleteRanges: null,
      ...buildDerivedIndexState(
        next.clips,
        get().aiSettings,
        get().sourceTranscriptCaptions,
        get().sourceOverviewFrames,
      ),
    });
  },

  pushHistory: (snap) => set((state) => ({ history: [...state.history, snap], future: [] })),

  addMessage: (msg) => set((state) => ({
    messages: [...state.messages, { ...msg, id: uuidv4(), timestamp: Date.now() }],
  })),

  updateMessage: (id, patch) => set((state) => ({
    messages: state.messages.map((message) => (
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

  clearMessages: () => set((state) => {
    const nextClips = state.videoDuration > 0 ? [makeClip(0, state.videoDuration)] : [];
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
      pendingDeleteRanges: null,
      selectedItem: null,
      taggedMarkerIds: [],
      ...buildDerivedIndexState(
        nextClips,
        state.aiSettings,
        state.sourceTranscriptCaptions,
        state.sourceOverviewFrames,
      ),
    };
  }),

  setAISettings: (settings) => set((state) => {
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

  recordAppliedAction: (action, summary, metadata) => set((state) => ({
    appliedActions: [
      ...state.appliedActions.slice(-24),
      { id: uuidv4(), timestamp: Date.now(), action, summary, sourceRanges: metadata?.sourceRanges },
    ],
  })),

  setFFmpegJob: (job) => set({ ffmpegJob: job }),

  setVideoCloud: (file, blobUrl, storagePath, projectId) => {
    set((state) => ({
      ...buildBaseEditorState({
        videoFile: file,
        videoUrl: blobUrl,
        videoName: file.name,
        currentProjectId: projectId,
        storagePath,
      }),
      messages: state.messages,
    }));
  },

  setProjectVideoFile: (file, projectId, storagePath = null) => {
    const url = URL.createObjectURL(file);
    set((state) => ({
      ...buildBaseEditorState({
        videoFile: file,
        videoUrl: url,
        videoName: file.name,
        currentProjectId: projectId,
        storagePath,
      }),
      messages: state.messages,
    }));
  },

  loadProject: (editState, project) => {
    const { videoUrl, storagePath, projectId, videoFilename, duration } = project;
    const existingState = get();
    const canReuseLocalVideo = (
      existingState.currentProjectId === projectId
      && existingState.videoFile !== null
      && (
        !storagePath
        || !existingState.storagePath
        || existingState.storagePath === storagePath
      )
    );
    const resolvedVideoFile = canReuseLocalVideo ? existingState.videoFile : null;
    const resolvedVideoUrl = canReuseLocalVideo && existingState.videoUrl
      ? existingState.videoUrl
      : videoUrl;
    const resolvedVideoName = canReuseLocalVideo && existingState.videoFile
      ? existingState.videoFile.name
      : videoFilename?.trim() || 'Main video';
    const rawClips = Array.isArray(editState.clips) ? editState.clips : [];
    const clips = sanitizeTimelineClips(rawClips
      .map((clip) => normalizeLoadedClip(clip as Partial<VideoClip> & { sourcePath?: unknown }, storagePath))
      .filter((clip): clip is VideoClip => !!clip));
    const persistedDuration = typeof editState.videoDuration === 'number' && editState.videoDuration > 0 ? editState.videoDuration : 0;
    const effectiveDuration = (typeof duration === 'number' && duration > 0) ? duration : persistedDuration;
    const hydratedClips = clips.length > 0
      ? clips
      : (effectiveDuration > 0 ? [makeClip(0, effectiveDuration)] : []);

    const rawTranscriptCaptions = Array.isArray(editState.sourceTranscriptCaptions)
      ? editState.sourceTranscriptCaptions
      : Array.isArray(editState.rawTranscriptCaptions)
        ? editState.rawTranscriptCaptions
        : null;
    const sourceTranscriptCaptions = rawTranscriptCaptions
      ?.map((entry) => normalizeCaptionEntry(entry as Partial<CaptionEntry>))
      .filter((entry): entry is CaptionEntry => !!entry) ?? null;

    const rawOverviewFrames = Array.isArray(editState.sourceOverviewFrames)
      ? editState.sourceOverviewFrames
      : Array.isArray(editState.videoFrames)
        ? (editState.videoFrames as Array<Partial<IndexedVideoFrame>>)
            .filter((frame) => frame?.kind === 'overview')
            .map((frame) => ({
              sourceId: normalizeSourceId(frame.sourceId) ?? MAIN_SOURCE_ID,
              sourceTime: frame.sourceTime,
              description: frame.description,
              image: frame.image,
              assetId: null,
              indexedAt: null,
            }))
        : null;
    const sourceOverviewFrames = rawOverviewFrames
      ?.map((entry) => normalizeOverviewFrame(entry as Partial<SourceIndexedFrame>))
      .filter((entry): entry is SourceIndexedFrame => !!entry) ?? null;

    const persistedFreshness = (
      editState.sourceIndexFreshBySourceId
      && typeof editState.sourceIndexFreshBySourceId === 'object'
      && (editState.sourceIndexFreshBySourceId as Record<string, Partial<SourceIndexState>>)[MAIN_SOURCE_ID]
    )
      ? {
          [MAIN_SOURCE_ID]: {
            overview: (editState.sourceIndexFreshBySourceId as Record<string, Partial<SourceIndexState>>)[MAIN_SOURCE_ID]?.overview === true,
            transcript: (editState.sourceIndexFreshBySourceId as Record<string, Partial<SourceIndexState>>)[MAIN_SOURCE_ID]?.transcript === true,
            version: typeof (editState.sourceIndexFreshBySourceId as Record<string, Partial<SourceIndexState>>)[MAIN_SOURCE_ID]?.version === 'string'
              ? (editState.sourceIndexFreshBySourceId as Record<string, Partial<SourceIndexState>>)[MAIN_SOURCE_ID]!.version!
              : SOURCE_INDEX_VERSION,
            assetId: normalizeSourceId((editState.sourceIndexFreshBySourceId as Record<string, Partial<SourceIndexState>>)[MAIN_SOURCE_ID]?.assetId) ?? null,
            indexedAt: typeof (editState.sourceIndexFreshBySourceId as Record<string, Partial<SourceIndexState>>)[MAIN_SOURCE_ID]?.indexedAt === 'string'
              ? (editState.sourceIndexFreshBySourceId as Record<string, Partial<SourceIndexState>>)[MAIN_SOURCE_ID]!.indexedAt!
              : null,
          },
        }
      : buildInitialSourceIndexState();

    const aiSettings = mergeAISettings(DEFAULT_AI_EDITING_SETTINGS, editState.aiSettings as Partial<AIEditingSettings> | undefined);
    const derivedIndexState = buildDerivedIndexState(
      hydratedClips,
      aiSettings,
      sourceTranscriptCaptions,
      sourceOverviewFrames,
    );

    set({
      ...buildBaseEditorState({
        videoFile: resolvedVideoFile,
        videoUrl: resolvedVideoUrl,
        videoName: resolvedVideoName,
        currentProjectId: projectId,
        storagePath,
      }),
      videoDuration: duration ?? (typeof editState.videoDuration === 'number' && editState.videoDuration > 0 ? editState.videoDuration : 0),
      clips: hydratedClips,
      captions: (editState.captions as CaptionEntry[] | undefined) ?? [],
      transitions: (editState.transitions as TransitionEntry[] | undefined) ?? [],
      markers: (editState.markers as MarkerEntry[] | undefined) ?? [],
      textOverlays: (editState.textOverlays as TextOverlayEntry[] | undefined) ?? [],
      messages: (editState.messages as ChatMessage[] | undefined) ?? [],
      appliedActions: ((editState.appliedActions as AppliedActionRecord[] | undefined) ?? []).map((entry) => ({
        ...entry,
        sourceRanges: entry.sourceRanges?.map((range) => ({
          ...range,
          sourceId: normalizeSourceId(range.sourceId) ?? MAIN_SOURCE_ID,
        })),
      })),
      aiSettings,
      backgroundTranscript: derivedIndexState.backgroundTranscript ?? (
        typeof editState.backgroundTranscript === 'string' ? editState.backgroundTranscript : null
      ),
      transcriptStatus: sourceTranscriptCaptions && sourceTranscriptCaptions.length > 0
        ? 'done'
        : (editState.transcriptStatus === 'error' ? 'error' : 'idle'),
      sourceTranscriptCaptions,
      sourceOverviewFrames: sourceOverviewFrames && sourceOverviewFrames.length > 0 ? sourceOverviewFrames : null,
      projectedOverviewFrames: derivedIndexState.projectedOverviewFrames,
      sourceIndexFreshBySourceId: patchSourceIndexState(persistedFreshness, {
        overview: persistedFreshness[MAIN_SOURCE_ID]?.overview || !!(sourceOverviewFrames && sourceOverviewFrames.length > 0),
        transcript: persistedFreshness[MAIN_SOURCE_ID]?.transcript || !!(sourceTranscriptCaptions && sourceTranscriptCaptions.length > 0),
      }),
      timelineProjectionFresh: derivedIndexState.timelineProjectionFresh,
      sourceIndex: (editState.sourceIndex as SourceIndex | null | undefined) ?? null,
    });
  },

  setUploadProgress: (pct) => set({ uploadProgress: pct }),
  setSaveStatus: (status) => set({ saveStatus: status }),
  setStoragePath: (path) => set({ storagePath: path }),
  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(20, zoom)) }),
  setPlaybackActive: (active) => set({ playbackActive: active }),

  resetEditor: () => {
    const { videoUrl } = get();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    set({
      ...buildBaseEditorState(),
      messages: [],
    });
  },

  setSelectedItem: (item) => set({ selectedItem: item }),
  setTaggedMarkerIds: (ids) => set(() => ({ taggedMarkerIds: [...new Set(ids)] })),
  toggleTaggedMarker: (id) => set((state) => ({
    taggedMarkerIds: state.taggedMarkerIds.includes(id)
      ? state.taggedMarkerIds.filter((markerId) => markerId !== id)
      : [...state.taggedMarkerIds, id],
  })),
  clearTaggedMarkers: () => set({ taggedMarkerIds: [] }),

  deleteSelectedItem: () => {
    const state = get();
    if (!state.selectedItem) return;
    const snap = (state as EditorStoreWithSnapshot)._snapshot();
    const { type, id } = state.selectedItem;
    const newHistory = [...state.history, snap];
    if (type === 'clip') {
      const nextClips = state.clips.filter((clip) => clip.id !== id);
      set({
        history: newHistory,
        future: [],
        clips: nextClips,
        markers: [],
        taggedMarkerIds: [],
        selectedItem: null,
        ...buildDerivedIndexState(
          nextClips,
          state.aiSettings,
          state.sourceTranscriptCaptions,
          state.sourceOverviewFrames,
        ),
      });
      return;
    }
    if (type === 'caption') {
      set({ history: newHistory, future: [], captions: state.captions.filter((entry) => entry.id !== id), selectedItem: null });
      return;
    }
    if (type === 'text') {
      set({ history: newHistory, future: [], textOverlays: state.textOverlays.filter((entry) => entry.id !== id), selectedItem: null });
      return;
    }
    if (type === 'transition') {
      set({ history: newHistory, future: [], transitions: state.transitions.filter((entry) => entry.id !== id), selectedItem: null });
      return;
    }
    set({
      history: newHistory,
      future: [],
      markers: state.markers.filter((marker) => marker.id !== id),
      selectedItem: null,
      taggedMarkerIds: state.taggedMarkerIds.filter((markerId) => markerId !== id),
    });
  },

  updateCaption: (id, patch) => set((state) => ({
    captions: state.captions.map((caption) => (
      caption.id === id ? { ...caption, ...patch } : caption
    )),
  })),

  updateTextOverlay: (id, patch) => set((state) => ({
    textOverlays: state.textOverlays.map((overlay) => (
      overlay.id === id ? { ...overlay, ...patch } : overlay
    )),
  })),

  updateTransition: (id, patch) => set((state) => ({
    transitions: state.transitions.map((transition) => (
      transition.id === id ? { ...transition, ...patch } : transition
    )),
  })),

  addMarker: (marker) => {
    const id = marker.id ?? uuidv4();
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const nextNumber = marker.number ?? (
      get().markers.length === 0
        ? 1
        : Math.max(...get().markers.map((entry) => entry.number)) + 1
    );
    set((state) => ({
      history: [...state.history, snap],
      future: [],
      markers: [
        ...state.markers,
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
    set((state) => ({
      history: [...state.history, snap],
      future: [],
      markers: state.markers.map((marker) => (
        marker.id === id
          ? { ...marker, ...patch, number: patch.number ?? marker.number, timelineTime: patch.timelineTime ?? marker.timelineTime }
          : marker
      )),
    }));
  },

  removeMarker: (id) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set((state) => ({
      history: [...state.history, snap],
      future: [],
      markers: state.markers.filter((marker) => marker.id !== id),
      taggedMarkerIds: state.taggedMarkerIds.filter((markerId) => markerId !== id),
      selectedItem: state.selectedItem?.type === 'marker' && state.selectedItem.id === id ? null : state.selectedItem,
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

  setBackgroundTranscript: (text, status, rawCaptions) => set((state) => {
    const normalizedCaptions = rawCaptions
      ?.map((entry) => normalizeCaptionEntry(entry))
      .filter((entry): entry is CaptionEntry => !!entry) ?? undefined;
    return {
      backgroundTranscript: normalizedCaptions !== undefined
        ? buildTranscriptContext(state.clips, normalizedCaptions)
        : text,
      transcriptStatus: status,
      transcriptProgress: status === 'loading' ? state.transcriptProgress : null,
      ...(normalizedCaptions !== undefined ? { sourceTranscriptCaptions: normalizedCaptions } : {}),
      ...(normalizedCaptions !== undefined ? {
        sourceIndexFreshBySourceId: patchSourceIndexState(state.sourceIndexFreshBySourceId, { transcript: true }),
      } : {}),
    };
  }),

  setTranscriptProgress: (progress) => set({ transcriptProgress: progress }),

  setSourceOverviewFrames: (_sourceId, frames, options) => set((state) => {
    const normalizedFrames = frames
      ?.map((entry) => normalizeOverviewFrame(entry))
      .filter((entry): entry is SourceIndexedFrame => !!entry) ?? null;
    return {
      sourceOverviewFrames: normalizedFrames,
      sourceIndexFreshBySourceId: patchSourceIndexState(state.sourceIndexFreshBySourceId, {
        overview: options?.fresh ?? false,
        assetId: options?.assetId,
        indexedAt: options?.indexedAt,
      }),
      ...buildDerivedIndexState(
        state.clips,
        state.aiSettings,
        state.sourceTranscriptCaptions,
        normalizedFrames,
      ),
    };
  }),

  hydrateSourceIndex: (payload) => set((state) => {
    const sourceTranscriptCaptions = payload.sourceTranscriptCaptions
      ?.map((entry) => normalizeCaptionEntry(entry))
      .filter((entry): entry is CaptionEntry => !!entry) ?? state.sourceTranscriptCaptions;
    const sourceOverviewFrames = payload.sourceOverviewFrames
      ?.map((entry) => normalizeOverviewFrame(entry))
      .filter((entry): entry is SourceIndexedFrame => !!entry) ?? state.sourceOverviewFrames;
    const sourceIndexFreshBySourceId = payload.sourceIndexFreshBySourceId?.[MAIN_SOURCE_ID]
      ? patchSourceIndexState(state.sourceIndexFreshBySourceId, payload.sourceIndexFreshBySourceId[MAIN_SOURCE_ID]!)
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

  setSourceIndex: (index) => set({ sourceIndex: index }),
}));
