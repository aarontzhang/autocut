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
} from './types';
import { buildClipSchedule } from './playbackEngine';

export type TranscriptStatus = 'idle' | 'loading' | 'done' | 'error';

export type FFmpegJob =
  | { status: 'idle' }
  | { status: 'running'; progress: number; stage: string }
  | { status: 'done'; outputUrl: string }
  | { status: 'error'; message: string };

export interface EditSnapshot {
  clips: VideoClip[];
  captions: CaptionEntry[];
  transitions: TransitionEntry[];
  textOverlays: TextOverlayEntry[];
}

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

  // FFmpeg
  ffmpegJob: FFmpegJob;

  // Timeline
  zoom: number;

  // Background transcription
  backgroundTranscript: string | null;
  transcriptStatus: TranscriptStatus;
  rawTranscriptCaptions: CaptionEntry[] | null;
  // Video frames cache
  videoFrames: string[] | null;
  videoFramesFresh: boolean; // false when a structural edit invalidated the frame-to-timeline mapping

  // Actions
  setVideoFile: (file: File) => void;
  setVideoDuration: (duration: number) => void;
  setCurrentTime: (time: number) => void;
  setPendingAction: (action: EditAction | null) => void;

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
  setIsChatLoading: (v: boolean) => void;
  clearMessages: () => void;

  // FFmpeg
  setFFmpegJob: (job: FFmpegJob) => void;

  // Zoom
  setZoom: (zoom: number) => void;

  setBackgroundTranscript: (text: string | null, status: TranscriptStatus, rawCaptions?: CaptionEntry[]) => void;
  setVideoFrames: (frames: string[]) => void;

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
  addTrack: (type: 'video' | 'audio') => void;
  removeTrack: (trackId: string) => void;
  addClipToTrack: (trackId: string, clip: Omit<TrackClip, 'id'>) => void;
  moveTrackClip: (trackId: string, clipId: string, newTimelineStart: number) => void;
  trimTrackClip: (trackId: string, clipId: string, newSourceStart: number, newSourceDuration: number) => void;
  removeTrackClip: (trackId: string, clipId: string) => void;
}

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
  extraTracks: [],
  selectedItem: null,
  history: [],
  future: [],
  messages: [],
  isChatLoading: false,
  ffmpegJob: { status: 'idle' },
  zoom: 1,
  backgroundTranscript: null,
  transcriptStatus: 'idle' as TranscriptStatus,
  rawTranscriptCaptions: null,
  videoFrames: null,
  videoFramesFresh: true,

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
      messages: [], ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null,
      history: [], future: [],
      backgroundTranscript: null, transcriptStatus: 'idle' as TranscriptStatus, rawTranscriptCaptions: null, videoFrames: null, videoFramesFresh: true,
    });
  },

  setVideoDuration: (duration) => {
    const { clips } = get();
    // Initialize a single clip spanning full video on first load
    if (clips.length === 0 && duration > 0) {
      set({ videoDuration: duration, clips: [makeClip(0, duration)] });
    } else {
      set({ videoDuration: duration });
    }
  },

  setCurrentTime: (time) => set({ currentTime: time }),
  setPendingAction: (action) => set({ pendingAction: action }),

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

    const snap = (get() as any)._snapshot();

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

    set({ history: [...get().history, snap], future: [], clips: newClips });
  },

  deleteRangeAtTime: (startTime, endTime) => {
    const { clips } = get();
    const schedule = buildClipSchedule(clips);
    const snap = (get() as any)._snapshot();

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

    set({ history: [...get().history, snap], future: [], clips: newClips });
  },

  deleteClip: (clipId) => {
    const snap = (get() as any)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      clips: s.clips.filter(c => c.id !== clipId),
      selectedItem: null,
    }));
  },

  reorderClip: (clipId, newIndex) => {
    const snap = (get() as any)._snapshot();
    const { clips } = get();
    const idx = clips.findIndex(c => c.id === clipId);
    if (idx === -1) return;
    const newClips = [...clips];
    const [removed] = newClips.splice(idx, 1);
    newClips.splice(Math.max(0, Math.min(newClips.length, newIndex)), 0, removed);
    set({ history: [...get().history, snap], future: [], clips: newClips });
  },

  trimClip: (clipId, newSourceStart, newSourceDuration) => {
    set(s => ({
      clips: s.clips.map(c => c.id === clipId ? { ...c, sourceStart: newSourceStart, sourceDuration: newSourceDuration } : c),
    }));
  },

  setClipSpeed: (clipId, speed) => {
    const snap = (get() as any)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      clips: s.clips.map(c => c.id === clipId ? { ...c, speed: Math.max(0.1, Math.min(10, speed)) } : c),
    }));
  },

  setClipVolume: (clipId, volume, fadeIn, fadeOut) => {
    const snap = (get() as any)._snapshot();
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
    const snap = (get() as any)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      clips: s.clips.map(c => c.id === clipId ? { ...c, filter } : c),
    }));
  },

  setClipFade: (clipId, fadeIn, fadeOut) => {
    const snap = (get() as any)._snapshot();
    set(s => ({
      history: [...s.history, snap],
      future: [],
      clips: s.clips.map(c => c.id === clipId ? { ...c, fadeIn, fadeOut } : c),
    }));
  },

  // ── Apply AI actions ────────────────────────────────────────────────────────

  applyAction: (action) => {
    if (action.type === 'none') return;
    const { clips, captions, transitions, textOverlays } = get();
    const snap = (get() as any)._snapshot();
    set({ history: [...get().history, snap], future: [] });

    const clipStructureChanged = ['split_clip', 'delete_range', 'delete_ranges', 'delete_clip', 'reorder_clip'].includes(action.type);

    if (action.type === 'split_clip') {
      if (action.splitTime !== undefined) {
        get().splitClipAtTime(action.splitTime);
      }
    } else if (action.type === 'delete_range') {
      if (action.deleteStartTime !== undefined && action.deleteEndTime !== undefined) {
        get().deleteRangeAtTime(action.deleteStartTime, action.deleteEndTime);
      }
    } else if (action.type === 'delete_ranges') {
      // Sort end-to-start so each deletion doesn't shift the positions of earlier ranges
      const sorted = [...(action.ranges ?? [])].sort((a, b) => b.start - a.start);
      for (const r of sorted) {
        if (r.end > r.start) get().deleteRangeAtTime(r.start, r.end);
      }
    } else if (action.type === 'reorder_clip') {
      const idx = action.clipIndex ?? 0;
      const clip = clips[idx];
      if (clip && action.newIndex !== undefined) get().reorderClip(clip.id, action.newIndex);
    } else if (action.type === 'delete_clip') {
      const idx = action.clipIndex ?? 0;
      const clip = clips[idx];
      if (clip) get().deleteClip(clip.id);
    } else if (action.type === 'set_clip_speed') {
      const idx = action.clipIndex ?? 0;
      const clip = clips[idx];
      if (clip && action.speed !== undefined) get().setClipSpeed(clip.id, action.speed);
    } else if (action.type === 'set_clip_volume') {
      const idx = action.clipIndex ?? 0;
      const clip = clips[idx];
      if (clip && action.volume !== undefined) {
        get().setClipVolume(clip.id, action.volume, action.fadeIn, action.fadeOut);
      }
    } else if (action.type === 'set_clip_filter') {
      const idx = action.clipIndex ?? 0;
      const clip = clips[idx];
      if (clip) get().setClipFilter(clip.id, action.filter ?? null);
    } else if (action.type === 'add_captions') {
      const newCaptions = (action.captions ?? []).map(c => ({ ...c, id: uuidv4() }));
      set({ captions: [...captions, ...newCaptions], pendingAction: null });
    } else if (action.type === 'add_transition') {
      const newTransitions = (action.transitions ?? []).map(t => ({ ...t, id: uuidv4() }));
      set({ transitions: [...transitions, ...newTransitions], pendingAction: null });
    } else if (action.type === 'add_text_overlay') {
      const newOverlays = (action.textOverlays ?? []).map(t => ({ ...t, id: uuidv4() }));
      set({ textOverlays: [...textOverlays, ...newOverlays], pendingAction: null });
    } else if (action.type === 'replace_text_overlay') {
      const idx = action.overlayIndex ?? 0;
      const replacement = (action.textOverlays ?? [])[0];
      if (replacement && idx < textOverlays.length) {
        const newOverlays = [...textOverlays];
        newOverlays[idx] = { ...replacement, id: uuidv4() };
        set({ textOverlays: newOverlays, pendingAction: null });
      }
    }

    // Mark frames as stale after structural edits — re-extraction happens in the
    // background so the UI isn't blocked. Old frames remain available for context.
    if (clipStructureChanged) {
      set({ videoFramesFresh: false });
    }

    set({ pendingAction: null });
  },

  // ── Undo/redo ───────────────────────────────────────────────────────────────

  undo: () => {
    const { history, future } = get();
    if (history.length === 0) return;
    const snap = (get() as any)._snapshot();
    const prev = history[history.length - 1];
    set({ ...prev, history: history.slice(0, -1), future: [snap, ...future], pendingAction: null, selectedItem: null });
  },

  redo: () => {
    const { history, future } = get();
    if (future.length === 0) return;
    const snap = (get() as any)._snapshot();
    const next = future[0];
    set({ ...next, history: [...history, snap], future: future.slice(1), pendingAction: null, selectedItem: null });
  },

  pushHistory: (snap) => set(s => ({ history: [...s.history, snap], future: [] })),

  // ── Chat ────────────────────────────────────────────────────────────────────

  addMessage: (msg) => set(s => ({
    messages: [...s.messages, { ...msg, id: uuidv4(), timestamp: Date.now() }],
  })),

  setIsChatLoading: (v) => set({ isChatLoading: v }),

  clearMessages: () => set(s => ({
    messages: [],
    pendingAction: null,
    clips: s.videoDuration > 0 ? [makeClip(0, s.videoDuration)] : [],
    captions: [],
    transitions: [],
    textOverlays: [],
    extraTracks: [],
    selectedItem: null,
  })),

  // ── FFmpeg ──────────────────────────────────────────────────────────────────

  setFFmpegJob: (job) => set({ ffmpegJob: job }),

  // ── Zoom ────────────────────────────────────────────────────────────────────

  setZoom: (zoom) => set({ zoom: Math.max(1, Math.min(20, zoom)) }),

  // ── Reset ───────────────────────────────────────────────────────────────────

  resetEditor: () => {
    const { videoUrl } = get();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    set({
      videoFile: null, videoUrl: '', videoData: null, videoDuration: 0, currentTime: 0,
      pendingAction: null, clips: [],
      captions: [], transitions: [], textOverlays: [], extraTracks: [],
      messages: [], isChatLoading: false,
      ffmpegJob: { status: 'idle' }, zoom: 1, selectedItem: null,
      history: [], future: [],
      backgroundTranscript: null, transcriptStatus: 'idle' as TranscriptStatus, rawTranscriptCaptions: null, videoFrames: null, videoFramesFresh: true,
    });
  },

  // ── Selection ───────────────────────────────────────────────────────────────

  setSelectedItem: (item) => set({ selectedItem: item }),

  deleteSelectedItem: () => {
    const s = get();
    if (!s.selectedItem) return;
    const snap = (s as any)._snapshot();
    const { type, id } = s.selectedItem;
    const newHistory = [...s.history, snap];
    if (type === 'clip') {
      set({ history: newHistory, future: [], clips: s.clips.filter(c => c.id !== id), selectedItem: null });
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
    set({
      extraTracks: [...extraTracks, {
        id: uuidv4(),
        type,
        label: type === 'video' ? `V${typeCount}` : `A${typeCount}`,
        clips: [],
      }],
    });
  },

  removeTrack: (trackId) => set(s => ({
    extraTracks: s.extraTracks.filter(t => t.id !== trackId),
  })),

  addClipToTrack: (trackId, clip) => set(s => ({
    extraTracks: s.extraTracks.map(t =>
      t.id === trackId
        ? { ...t, clips: [...t.clips, { ...clip, id: uuidv4() }] }
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

  setBackgroundTranscript: (text, status, rawCaptions) => set({
    backgroundTranscript: text,
    transcriptStatus: status,
    ...(rawCaptions !== undefined ? { rawTranscriptCaptions: rawCaptions } : {}),
  }),
  setVideoFrames: (frames) => set({ videoFrames: frames, videoFramesFresh: true }),
}));
