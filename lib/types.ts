export type CaptionRenderStyle = 'rolling_word' | 'static';

export interface CaptionWordTiming {
  startTime: number;
  endTime: number;
  text: string;
}

export interface VideoClip {
  id: string;
  sourceId: string;
  sourceStart: number;   // seconds into original video
  sourceDuration: number; // duration in source
  // Per-clip effects
  speed: number;         // default 1.0
  volume: number;        // 0.0–2.0, default 1.0
  filter: ColorFilter | null;
  fadeIn: number;        // seconds
  fadeOut: number;       // seconds
}

export interface ClipScheduleEntry {
  clipId: string;
  sourceId: string;
  timelineStart: number;  // position in output timeline
  timelineEnd: number;
  sourceStart: number;
  sourceDuration: number;
  speed: number;
}

export interface CaptionEntry {
  id?: string;
  sourceId?: string;
  // Source-backed transcript words keep a sourceId. User-added captions stay
  // in current-timeline coordinates and omit sourceId.
  startTime: number;
  endTime: number;
  text: string;
  words?: CaptionWordTiming[];
  renderStyle?: CaptionRenderStyle;
}

export interface SourceRangeRef {
  sourceId?: string | null;
  assetId?: string | null;
  sourceStart: number;
  sourceEnd: number;
}

export interface SilenceCandidate {
  gapStart: number;
  gapEnd: number;
  deleteStart: number;
  deleteEnd: number;
  duration: number;
}

export interface TransitionEntry {
  id?: string;
  afterClipId?: string;
  atTime: number;
  type: 'fade_black';
  duration: number;
}

export interface ResolvedTransitionBoundary {
  id?: string;
  afterClipId: string;
  atTime: number;
  type: TransitionEntry['type'];
  duration: number;
  fromClipId: string;
  toClipId: string;
}

export interface RenderTimelineEntry extends ClipScheduleEntry {
  transitionIn?: ResolvedTransitionBoundary | null;
  transitionOut?: ResolvedTransitionBoundary | null;
}

export interface CaptionCueWord {
  text: string;
  startTime: number;
  endTime: number;
}

export interface CaptionCue {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  lines: string[];
  words: CaptionCueWord[];
}

export interface MarkerEntry {
  id: string;
  number: number;
  timelineTime: number;
  label?: string;
  createdBy: 'ai' | 'human';
  status: 'open' | 'accepted' | 'rejected';
  linkedRange?: {
    startTime: number;
    endTime: number;
  };
  linkedMessageId?: string;
  confidence?: number | null;
  note?: string;
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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  requestChainId?: string;
  action?: EditAction;
  autoApplied?: boolean;
  actionStatus?: 'pending' | 'completed' | 'rejected';
  actionResult?: string;
  final?: boolean;
  isStreaming?: boolean;
}

export interface AppliedActionRecord {
  id: string;
  timestamp: number;
  requestChainId?: string;
  action: EditAction;
  summary: string;
  sourceRanges?: SourceRangeRef[];
}

export type MediaAssetStatus = 'pending' | 'indexing' | 'ready' | 'error' | 'missing';

export interface ProjectSource {
  id: string;
  fileName: string;
  storagePath: string | null;
  assetId: string | null;
  duration: number;
  status: MediaAssetStatus;
  isPrimary: boolean;
}

export interface MediaAsset {
  id: string;
  projectId: string;
  storagePath: string;
  sourceDuration: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  status: MediaAssetStatus;
  createdAt: string;
  indexedAt: string | null;
}

export interface AssetTranscriptWord {
  id: string;
  assetId: string;
  startTime: number;
  endTime: number;
  text: string;
  confidence?: number | null;
}

export interface SourceIndexState {
  transcript: boolean;
  version: string;
  assetId?: string | null;
  indexedAt?: string | null;
}

export type AnalysisJobStage =
  | 'queued'
  | 'preparing_media'
  | 'transcribing_audio'
  | 'transcribing';

export interface AnalysisProgress {
  stage: AnalysisJobStage;
  completed: number;
  total: number;
  label?: string | null;
  etaSeconds?: number | null;
}

export type AnalysisJobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export type SourceIndexTaskStatus =
  | AnalysisJobStatus
  | 'unavailable';

export interface SourceIndexTaskState {
  status: SourceIndexTaskStatus;
  completed: number;
  total: number;
  etaSeconds?: number | null;
  reason?: string | null;
}

export interface SourceIndexAnalysisState {
  jobId?: string | null;
  status: AnalysisJobStatus | null;
  error?: string | null;
  pauseRequested?: boolean | null;
  progress: AnalysisProgress | null;
  audio?: SourceIndexTaskState | null;
}

export type SourceIndexAnalysisStateMap = Record<string, SourceIndexAnalysisState>;

export interface AIEditingSettings {
  silenceRemoval: {
    paddingSeconds: number;
    minDurationSeconds: number;
    preserveShortPauses: boolean;
    requireSpeakerAbsence: boolean;
  };
  captions: {
    wordsPerCaption: number;
  };
  transitions: {
    defaultDuration: number;
    defaultType: 'fade_black';
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
    | 'add_marker'
    | 'add_markers'
    | 'update_marker'
    | 'remove_marker'
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
  transcriptRange?: { startTime: number; endTime: number };
  captionStyle?: CaptionRenderStyle;
  segments?: Array<{ startTime: number; endTime: number; reason?: string }>;
  // request_frames
  frameRequest?: { startTime: number; endTime: number; count?: number };
  // transitions
  transitions?: TransitionEntry[];
  // markers
  marker?: Partial<MarkerEntry>;
  markers?: Array<Partial<MarkerEntry>>;
  markerId?: string;
  // text overlays
  textOverlays?: TextOverlayEntry[];
  // replace_text_overlay
  overlayIndex?: number;
  // update_ai_settings
  settings?: Partial<AIEditingSettings>;
  message: string;
}

// ─── Source Index Layer ──────────────────────────────────────────────────────

/** A single word from Whisper word-level output, annotated with filler status */
export interface SourceWord {
  word: string;
  start: number;    // source video seconds
  end: number;      // source video seconds
  isFiller: boolean;
}

/** A semantic segment (sentence or phrase) indexed against source time */
export interface SourceSegment {
  id: string;
  text: string;
  sourceStart: number;
  sourceEnd: number;
  words: SourceWord[];
  fillerWords: string[];   // filler words found in this segment
  pauseAfterMs: number;    // gap in ms to the next segment (0 if last)
}

/** The complete source index for one video clip — stored alongside the project */
export interface SourceIndex {
  version: string;
  sourceId: string;
  sourceDuration: number;
  segments: SourceSegment[];
  indexedAt: string;
}
