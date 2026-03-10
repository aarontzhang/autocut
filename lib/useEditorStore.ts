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
} from './types';
import {
  actionChangesTimelineStructure,
  applyActionToSnapshot,
  EditSnapshot,
} from './editActionUtils';
import { buildClipSchedule } from './playbackEngine';
import { buildTranscriptContext } from './timelineUtils';

export type { EditSnapshot } from './editActionUtils';

export type TranscriptStatus = 'idle' | 'loading' | 'done' | 'error';

export interface MediaLibraryItem {
  id: string;
  url: string;
  name: string;
  duration: number;
  sourcePath?: string;
}

export type FFmpegJob =
  | { status: 'idle' }
  | { status: 'running'; progress: number; stage: string }
  | { status: 'done'; outputUrl: string }
  | { status: 'error'; message: string };

export type SelectedItem = {
  type: 'clip' | 'caption' | 'text' | 'transition';
  id: string;
} | null;

function makeClip(sourceStart: number, sourceDuration: number): VideoClip {
  return {
    id: uuidv4(),
    sourceStart,
    sourceDuration,
    speed: 1.0,
    volume: 1.0,
    filter: null,
    fadeIn: 0,
    fadeOut: 0,
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
    defaultFrameCount: 24,
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

interface EditorState {
  // Video
  videoFile: File | null;
  videoUrl: string;
  videoData: Uint8Array | null;
  videoDuration: number;
  currentTime: number;  // timeline time

  // Pending Claude action
  pendingAction: EditAction | null;

  // Clips — the core edit state
  clips: VideoClip[];

  // Effects (reference timeline time)
  captions: CaptionEntry[];
  transitions: TransitionEntry[];
  textOverlays: TextOverlayEntry[];
  previewSnapshot: EditSnapshot | null;
  previewOwnerId: string | null;

  // Extra tracks (video/audio overlays with positioned clips)
  extraTracks: MediaTrack[];

  // Selection
  selectedItem: SelectedItem;

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

  // Background transcription
  backgroundTranscript: string | null;
  transcriptStatus: TranscriptStatus;
  rawTranscriptCaptions: CaptionEntry[] | null;
  // Video frames cache
  videoFrames: IndexedVideoFrame[] | null;
  videoFramesFresh: boolean; // false when a structural edit invalidated the frame-to-timeline mapping

  // Actions
  setVideoFile: (file: File) => void;
  setVideoDuration: (duration: number) => void;
  setCurrentTime: (time: number) => void;
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
  clearMessages: () => void;
  setAISettings: (settings: Partial<AIEditingSettings>) => void;
  recordAppliedAction: (action: EditAction, summary: string) => void;

  // FFmpeg
  setFFmpegJob: (job: FFmpegJob) => void;

  setVideoCloud: (file: File, blobUrl: string, storagePath: string, projectId: string) => void;
  loadProject: (editState: { clips?: unknown[]; captions?: unknown[]; transitions?: unknown[]; textOverlays?: unknown[]; extraTracks?: unknown[]; messages?: unknown[]; appliedActions?: unknown[]; aiSettings?: unknown; backgroundTranscript?: unknown; transcriptStatus?: unknown; rawTranscriptCaptions?: unknown[] }, blobUrl: string, storagePath: string | null, projectId: string, duration?: number) => void;
  setUploadProgress: (pct: number | null) => void;
  setSaveStatus: (status: 'idle' | 'saving' | 'saved' | 'error') => void;
  setStoragePath: (path: string) => void;

  // Zoom
  setZoom: (zoom: number) => void;

  setBackgroundTranscript: (text: string | null, status: TranscriptStatus, rawCaptions?: CaptionEntry[]) => void;
  setVideoFrames: (frames: IndexedVideoFrame[]) => void;

  // Media library (multi-source V1)
  mediaLibrary: MediaLibraryItem[];
  addToMediaLibrary: (file: File) => Promise<string>;
  addMediaLibraryItem: (item: Omit<MediaLibraryItem, 'id'>) => string;
  appendVideoToTimeline: (sourceUrl: string, sourceName: string, duration: number, sourcePath?: string) => string;
  insertVideoIntoTimeline: (sourceUrl: string, sourceName: string, duration: number, insertAtTime: number, sourcePath?: string) => string;
  updateClipSourcePath: (clipId: string, sourcePath: string) => void;

  // Reset
  resetEditor: () => void;

  // Selection
  setSelectedItem: (item: SelectedItem) => void;
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
  pendingAction: null,
  clips: [],
  captions: [],
  transitions: [],
  textOverlays: [],
  previewSnapshot: null,
  previewOwnerId: null,
  extraTracks: [],
  selectedItem: null,
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
  backgroundTranscript: null,
  transcriptStatus: 'idle' as TranscriptStatus,
  rawTranscriptCaptions: null,
  videoFrames: null,
  videoFramesFresh: true,
  mediaLibrary: [],

  _snapshot: (): EditSnapshot => {
    const s = get();
    return {
      clips: s.clips,
      captions: s.captions,
      transitions: s.transitions,
      textOverlays: s.textOverlays,
    };
  },

  setVideoFile: (file) => {
    const url = URL.createObjectURL(file);
    set({
      videoFile: file, videoUrl: url, videoData: null, videoDuration: 0, currentTime: 0,
      pendingAction: null, clips: [],
      captions: [], transitions: [], textOverlays: [], extraTracks: [],
      previewSnapshot: null, previewOwnerId: null,
      messages: [], ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null,
      aiSettings: DEFAULT_AI_EDITING_SETTINGS,
      appliedActions: [],
      history: [], future: [],
      backgroundTranscript: null, transcriptStatus: 'idle' as TranscriptStatus, rawTranscriptCaptions: null, videoFrames: null, videoFramesFresh: true,
      mediaLibrary: [{ id: uuidv4(), url, name: file.name, duration: 0 }],
    });
  },

  setVideoDuration: (duration) => {
    const { clips, mediaLibrary } = get();
    const updatedLibrary = mediaLibrary.map((item, i) =>
      i === 0 && item.duration === 0 ? { ...item, duration } : item
    );
    // Initialize a single clip spanning full video on first load
    if (clips.length === 0 && duration > 0) {
      set({ videoDuration: duration, clips: [makeClip(0, duration)], mediaLibrary: updatedLibrary });
    } else {
      set({ videoDuration: duration, mediaLibrary: updatedLibrary });
    }
  },

  setCurrentTime: (time) => set({ currentTime: time }),
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
      previewSnapshot: null,
      previewOwnerId: null,
      videoFramesFresh: snapshot.clips === state.clips ? state.videoFramesFresh : false,
    }));
  },

  // ── Clip actions ────────────────────────────────────────────────────────────

  splitClipAtTime: (timelineTime) => {
    const { clips } = get();
    const schedule = buildClipSchedule(clips);

    // Find which clip contains this timeline time
    let targetEntry = null;
    for (const entry of schedule) {
      if (timelineTime > entry.timelineStart && timelineTime < entry.timelineEnd) {
        targetEntry = entry;
        break;
      }
    }
    if (!targetEntry) return;

    const snap = (get() as EditorStoreWithSnapshot)._snapshot();

    // Compute split point in source
    const offsetInTimeline = timelineTime - targetEntry.timelineStart;
    const splitSourceOffset = offsetInTimeline * targetEntry.speed;

    const clip = clips.find(c => c.id === targetEntry!.clipId);
    if (!clip) return;

    const firstDuration = splitSourceOffset;
    const secondStart = clip.sourceStart + splitSourceOffset;
    const secondDuration = clip.sourceDuration - splitSourceOffset;

    if (firstDuration < 0.05 || secondDuration < 0.05) return; // too small to split

    const firstClip: VideoClip = { ...clip, sourceDuration: firstDuration };
    const secondClip: VideoClip = { ...clip, id: uuidv4(), sourceStart: secondStart, sourceDuration: secondDuration };

    const idx = clips.findIndex(c => c.id === clip.id);
    const newClips = [...clips.slice(0, idx), firstClip, secondClip, ...clips.slice(idx + 1)];

    set({ history: [...get().history, snap], future: [], clips: newClips, videoFramesFresh: false });
  },

  deleteRangeAtTime: (startTime, endTime) => {
    const { clips } = get();
    const schedule = buildClipSchedule(clips);
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();

    const newClips: VideoClip[] = [];
    for (const entry of schedule) {
      const clip = clips.find(c => c.id === entry.clipId)!;
      const tStart = entry.timelineStart;
      const tEnd = entry.timelineEnd;
      const speed = entry.speed;

      if (tEnd <= startTime || tStart >= endTime) {
        // Entirely outside the delete range — keep as-is
        newClips.push(clip);
      } else if (tStart >= startTime && tEnd <= endTime) {
        // Entirely inside the delete range — remove
      } else if (tStart < startTime && tEnd > endTime) {
        // Straddles both boundaries — keep before and after portions
        const firstDuration = (startTime - tStart) * speed;
        const secondOffset = (endTime - tStart) * speed;
        const secondDuration = clip.sourceDuration - secondOffset;
        if (firstDuration >= 0.05) {
          newClips.push({ ...clip, sourceDuration: firstDuration });
        }
        if (secondDuration >= 0.05) {
          newClips.push({ ...clip, id: uuidv4(), sourceStart: clip.sourceStart + secondOffset, sourceDuration: secondDuration });
        }
      } else if (tStart < startTime) {
        // Starts before range, ends inside — trim end
        const newDuration = (startTime - tStart) * speed;
        if (newDuration >= 0.05) {
          newClips.push({ ...clip, sourceDuration: newDuration });
        }
      } else {
        // Starts inside range, ends after — trim start
        const trimOffset = (endTime - tStart) * speed;
        const newSourceStart = clip.sourceStart + trimOffset;
        const newDuration = clip.sourceDuration - trimOffset;
        if (newDuration >= 0.05) {
          newClips.push({ ...clip, id: uuidv4(), sourceStart: newSourceStart, sourceDuration: newDuration });
        }
      }
    }

    set({ history: [...get().history, snap], future: [], clips: newClips, videoFramesFresh: false });
  },

  deleteClip: (clipId) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      clips: s.clips.filter(c => c.id !== clipId),
      selectedItem: null,
      videoFramesFresh: false,
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
    set({ history: [...get().history, snap], future: [], clips: newClips, videoFramesFresh: false });
  },

  trimClip: (clipId, newSourceStart, newSourceDuration) => {
    set(s => ({
      clips: s.clips.map(c => c.id === clipId ? { ...c, sourceStart: newSourceStart, sourceDuration: newSourceDuration } : c),
      videoFramesFresh: false,
    }));
  },

  setClipSpeed: (clipId, speed) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      clips: s.clips.map(c => c.id === clipId ? { ...c, speed: Math.max(0.1, Math.min(10, speed)) } : c),
      videoFramesFresh: false,
    }));
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
      previewSnapshot: null,
      previewOwnerId: null,
      videoFramesFresh: actionChangesTimelineStructure(action) ? false : state.videoFramesFresh,
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
      previewSnapshot: null,
      previewOwnerId: null,
      videoFramesFresh: false,
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
      previewSnapshot: null,
      previewOwnerId: null,
      videoFramesFresh: false,
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

  clearMessages: () => set(s => ({
    messages: [],
    appliedActions: [],
    pendingAction: null,
    clips: s.videoDuration > 0 ? [makeClip(0, s.videoDuration)] : [],
    captions: [],
    transitions: [],
    textOverlays: [],
    previewSnapshot: null,
    previewOwnerId: null,
    extraTracks: [],
    selectedItem: null,
  })),

  setAISettings: (settings) => set(state => ({
    aiSettings: mergeAISettings(state.aiSettings, settings),
  })),

  recordAppliedAction: (action, summary) => set(state => ({
    appliedActions: [
      ...state.appliedActions.slice(-24),
      { id: uuidv4(), timestamp: Date.now(), action, summary },
    ],
  })),

  // ── FFmpeg ──────────────────────────────────────────────────────────────────

  setFFmpegJob: (job) => set({ ffmpegJob: job }),

  setVideoCloud: (file, blobUrl, storagePath, projectId) => {
    set({
      videoFile: file, videoUrl: blobUrl, videoData: null, videoDuration: 0, currentTime: 0,
      pendingAction: null, clips: [],
      captions: [], transitions: [], textOverlays: [], extraTracks: [],
      previewSnapshot: null, previewOwnerId: null,
      messages: [], ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null,
      aiSettings: DEFAULT_AI_EDITING_SETTINGS,
      appliedActions: [],
      history: [], future: [],
      backgroundTranscript: null, transcriptStatus: 'idle' as TranscriptStatus, rawTranscriptCaptions: null, videoFrames: null, videoFramesFresh: true,
      currentProjectId: projectId, storagePath, uploadProgress: null, saveStatus: 'idle',
      mediaLibrary: [],
    });
  },

  loadProject: (editState, blobUrl, storagePath, projectId, duration) => {
    const clips = (editState.clips as VideoClip[] | undefined) ?? [];
    const rawTranscriptCaptions = (editState.rawTranscriptCaptions as CaptionEntry[] | undefined) ?? null;
    const persistedTranscript = typeof editState.backgroundTranscript === 'string' ? editState.backgroundTranscript : null;
    const backgroundTranscript = rawTranscriptCaptions && rawTranscriptCaptions.length > 0
      ? buildTranscriptContext(clips, rawTranscriptCaptions)
      : persistedTranscript;
    const transcriptStatus = backgroundTranscript
      ? 'done'
      : editState.transcriptStatus === 'error'
        ? 'error'
        : 'idle';

    set({
      videoUrl: blobUrl, videoData: null, videoFile: null, videoDuration: duration ?? 0,
      currentTime: 0, pendingAction: null,
      clips,
      captions: (editState.captions as CaptionEntry[] | undefined) ?? [],
      transitions: (editState.transitions as TransitionEntry[] | undefined) ?? [],
      textOverlays: (editState.textOverlays as TextOverlayEntry[] | undefined) ?? [],
      previewSnapshot: null, previewOwnerId: null,
      extraTracks: (editState.extraTracks as MediaTrack[] | undefined) ?? [],
      messages: (editState.messages as ChatMessage[] | undefined) ?? [],
      appliedActions: (editState.appliedActions as AppliedActionRecord[] | undefined) ?? [],
      ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null,
      aiSettings: mergeAISettings(DEFAULT_AI_EDITING_SETTINGS, editState.aiSettings as Partial<AIEditingSettings> | undefined),
      history: [], future: [],
      backgroundTranscript, transcriptStatus: transcriptStatus as TranscriptStatus, rawTranscriptCaptions, videoFrames: null, videoFramesFresh: true,
      currentProjectId: projectId, storagePath, uploadProgress: null, saveStatus: 'idle',
      mediaLibrary: [],
    });
  },

  setUploadProgress: (pct) => set({ uploadProgress: pct }),
  setSaveStatus: (status) => set({ saveStatus: status }),
  setStoragePath: (path) => set({ storagePath: path }),

  // ── Zoom ────────────────────────────────────────────────────────────────────

  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(20, zoom)) }),

  // ── Reset ───────────────────────────────────────────────────────────────────

  resetEditor: () => {
    const { videoUrl } = get();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    set({
      videoFile: null, videoUrl: '', videoData: null, videoDuration: 0, currentTime: 0,
      pendingAction: null, clips: [],
      captions: [], transitions: [], textOverlays: [], extraTracks: [],
      previewSnapshot: null, previewOwnerId: null,
      messages: [], isChatLoading: false,
      aiSettings: DEFAULT_AI_EDITING_SETTINGS,
      appliedActions: [],
      ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null,
      history: [], future: [],
      backgroundTranscript: null, transcriptStatus: 'idle' as TranscriptStatus, rawTranscriptCaptions: null, videoFrames: null, videoFramesFresh: true,
      currentProjectId: null, storagePath: null, uploadProgress: null, saveStatus: 'idle' as const,
      mediaLibrary: [],
    });
  },

  // ── Selection ───────────────────────────────────────────────────────────────

  setSelectedItem: (item) => set({ selectedItem: item }),

  deleteSelectedItem: () => {
    const s = get();
    if (!s.selectedItem) return;
    const snap = (s as EditorStoreWithSnapshot)._snapshot();
    const { type, id } = s.selectedItem;
    const newHistory = [...s.history, snap];
    if (type === 'clip') {
      set({ history: newHistory, future: [], clips: s.clips.filter(c => c.id !== id), selectedItem: null, videoFramesFresh: false });
    } else if (type === 'caption') {
      set({ history: newHistory, future: [], captions: s.captions.filter(c => c.id !== id), selectedItem: null });
    } else if (type === 'text') {
      set({ history: newHistory, future: [], textOverlays: s.textOverlays.filter(c => c.id !== id), selectedItem: null });
    } else if (type === 'transition') {
      set({ history: newHistory, future: [], transitions: s.transitions.filter(c => c.id !== id), selectedItem: null });
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
    const item: MediaLibraryItem = { id: uuidv4(), url, name: file.name, duration };
    set(s => ({ mediaLibrary: [...s.mediaLibrary, item] }));
    return url;
  },

  addMediaLibraryItem: (item) => {
    const id = uuidv4();
    set(s => {
      const existing = s.mediaLibrary.find(entry =>
        (item.sourcePath && entry.sourcePath === item.sourcePath) || entry.url === item.url
      );
      if (existing) return s;
      return { mediaLibrary: [...s.mediaLibrary, { ...item, id }] };
    });
    return id;
  },

  appendVideoToTimeline: (sourceUrl, sourceName, duration, sourcePath) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const { clips, mediaLibrary } = get();
    const clipId = uuidv4();
    const newClip: VideoClip = {
      id: clipId,
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
      (sourcePath && item.sourcePath === sourcePath) || item.url === sourceUrl
    );
    const newLibrary = alreadyInLibrary ? mediaLibrary : [...mediaLibrary, { id: uuidv4(), url: sourceUrl, name: sourceName, duration, sourcePath }];
    set({ history: [...get().history, snap], future: [], clips: [...clips, newClip], mediaLibrary: newLibrary, videoFramesFresh: false });
    return clipId;
  },

  insertVideoIntoTimeline: (sourceUrl, sourceName, duration, insertAtTime, sourcePath) => {
    const snap = (get() as EditorStoreWithSnapshot)._snapshot();
    const { clips, mediaLibrary } = get();
    const clipId = uuidv4();
    const newClip: VideoClip = {
      id: clipId,
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
      (sourcePath && item.sourcePath === sourcePath) || item.url === sourceUrl
    );
    const newLibrary = alreadyInLibrary ? mediaLibrary : [...mediaLibrary, { id: uuidv4(), url: sourceUrl, name: sourceName, duration, sourcePath }];
    set({ history: [...get().history, snap], future: [], clips: newClips, mediaLibrary: newLibrary, videoFramesFresh: false });
    return clipId;
  },

  updateClipSourcePath: (clipId, sourcePath) => set(s => ({
    clips: s.clips.map(clip => clip.id === clipId ? { ...clip, sourcePath } : clip),
    mediaLibrary: s.mediaLibrary.map(item =>
      item.url === s.clips.find(clip => clip.id === clipId)?.sourceUrl && !item.sourcePath
        ? { ...item, sourcePath }
        : item
    ),
  })),

  setBackgroundTranscript: (text, status, rawCaptions) => set({
    backgroundTranscript: text,
    transcriptStatus: status,
    ...(rawCaptions !== undefined ? { rawTranscriptCaptions: rawCaptions } : {}),
  }),
  setVideoFrames: (frames) => set({ videoFrames: frames, videoFramesFresh: true }),
}));
