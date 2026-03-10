export interface VideoClip {
  id: string;
  sourceStart: number;   // seconds into original video
  sourceDuration: number; // duration in source
  // Per-clip effects
  speed: number;         // default 1.0
  volume: number;        // 0.0–2.0, default 1.0
  filter: ColorFilter | null;
  fadeIn: number;        // seconds
  fadeOut: number;       // seconds
  // Multi-source support
  sourceUrl?: string;    // blob URL for this clip's source (undefined = main videoUrl from store)
  sourcePath?: string;   // Supabase Storage path for persisted secondary sources
  sourceName?: string;   // display name for the clip
}

export interface ClipScheduleEntry {
  clipId: string;
  timelineStart: number;  // position in output timeline
  timelineEnd: number;
  sourceStart: number;
  sourceDuration: number;
  speed: number;
}

export interface CaptionEntry {
  id?: string;
  startTime: number;
  endTime: number;
  text: string;
}

export interface TransitionEntry {
  id?: string;
  atTime: number;
  type: 'crossfade' | 'fade_black' | 'dissolve' | 'wipe';
  duration: number;
}

export interface TextOverlayEntry {
  id?: string;
  startTime: number;
  endTime: number;
  text: string;
  position: 'top' | 'center' | 'bottom';
  fontSize?: number;
}

export interface ColorFilter {
  type: 'cinematic' | 'vintage' | 'warm' | 'cool' | 'bw' | 'none';
  intensity: number; // 0.0 to 1.0
}

/** A clip positioned at an explicit timeline time on an extra track */
export interface TrackClip {
  id: string;
  sourceUrl: string;
  sourcePath?: string; // Supabase Storage path — set after background upload, used to re-hydrate on load
  sourceName: string;
  sourceStart: number;
  sourceDuration: number;
  timelineStart: number; // seconds in the output timeline
  speed: number;
  volume: number;
  linkedClipId?: string; // ID of the paired clip on another track (video↔audio pair)
}

/** An extra video or audio track (beyond the main track 0) */
export interface MediaTrack {
  id: string;
  type: 'video' | 'audio';
  label: string;
  clips: TrackClip[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  action?: EditAction;
  autoApplied?: boolean;
}

export interface IndexedVideoFrame {
  image: string;
  timelineTime: number;
  sourceTime: number;
  kind: 'overview' | 'dense';
  rangeStart?: number;
  rangeEnd?: number;
}

export interface AIEditingSettings {
  silenceRemoval: {
    paddingSeconds: number;
    minDurationSeconds: number;
    preserveShortPauses: boolean;
    requireSpeakerAbsence: boolean;
  };
  frameInspection: {
    defaultFrameCount: number;
  };
  captions: {
    wordsPerCaption: number;
  };
  transitions: {
    defaultDuration: number;
    defaultType: 'crossfade' | 'fade_black' | 'dissolve' | 'wipe';
  };
  textOverlays: {
    defaultPosition: 'top' | 'center' | 'bottom';
    defaultFontSize: number;
  };
}

export interface EditAction {
  type:
    | 'split_clip'
    | 'delete_clip'
    | 'delete_range'
    | 'delete_ranges'
    | 'reorder_clip'
    | 'set_clip_speed'
    | 'set_clip_volume'
    | 'set_clip_filter'
    | 'add_captions'
    | 'transcribe_request'
    | 'request_frames'
    | 'add_transition'
    | 'add_text_overlay'
    | 'replace_text_overlay'
    | 'update_ai_settings'
    | 'none';
  // split_clip
  splitTime?: number;
  // delete_range
  deleteStartTime?: number;
  deleteEndTime?: number;
  // delete_ranges (batch — applied end-to-start to avoid offset issues)
  ranges?: Array<{ start: number; end: number }>;
  // delete_clip / set_clip_* / reorder_clip (target by index or id)
  clipIndex?: number;
  clipId?: string;
  // reorder_clip
  newIndex?: number;
  // set_clip_speed
  speed?: number;
  // set_clip_volume
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  // set_clip_filter
  filter?: ColorFilter;
  // captions / transcription
  captions?: CaptionEntry[];
  segments?: Array<{ startTime: number; endTime: number; reason?: string }>;
  // request_frames
  frameRequest?: { startTime: number; endTime: number; count?: number };
  // transitions
  transitions?: TransitionEntry[];
  // text overlays
  textOverlays?: TextOverlayEntry[];
  // replace_text_overlay
  overlayIndex?: number;
  // update_ai_settings
  settings?: Partial<AIEditingSettings>;
  message: string;
}
