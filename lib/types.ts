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
  // Multi-source support
  sourceUrl?: string;    // blob URL for this clip's source (undefined = main videoUrl from store)
  sourcePath?: string;   // Supabase Storage path for persisted secondary sources
  sourceName?: string;   // display name for the clip
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
  startTime: number;
  endTime: number;
  text: string;
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
  atTime: number;
  type: 'crossfade' | 'fade_black' | 'dissolve' | 'wipe';
  duration: number;
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
  visualSearch?: VisualSearchSession | null;
  autoApplied?: boolean;
  actionStatus?: 'pending' | 'completed' | 'rejected';
  actionResult?: string;
}

export interface AppliedActionRecord {
  id: string;
  timestamp: number;
  action: EditAction;
  summary: string;
  sourceRanges?: SourceRangeRef[];
}

export type MediaAssetStatus = 'pending' | 'indexing' | 'ready' | 'error';

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

export interface AssetScene {
  id: string;
  assetId: string;
  sceneIndex: number;
  sourceStart: number;
  sourceEnd: number;
  representativeThumbnailPath: string | null;
  metadata?: Record<string, unknown> | null;
}

export type AssetVisualSampleKind = 'scene_rep' | 'window_250ms';

export interface AssetVisualSample {
  id: string;
  assetId: string;
  sourceTime: number;
  windowDuration: number;
  sampleKind: AssetVisualSampleKind;
  thumbnailPath: string | null;
  ocrText: string | null;
  embedding: number[] | null;
  brightness: number | null;
  contrast: number | null;
  edgeDensity: number | null;
  motionScore: number | null;
  fogScore: number | null;
  darknessScore: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface AssetTranscriptWord {
  id: string;
  assetId: string;
  startTime: number;
  endTime: number;
  text: string;
  confidence?: number | null;
}

export type AnalysisJobType =
  | 'index_asset'
  | 'verify_visual_candidates'
  | 'repeat_detect_from_seed';

export type AnalysisJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

export interface AnalysisJobProgress {
  completed: number;
  total: number;
  stage?: string;
}

export interface AnalysisJob {
  id: string;
  projectId: string;
  assetId: string | null;
  jobType: AnalysisJobType;
  status: AnalysisJobStatus;
  priority: number;
  attemptCount: number;
  payload?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  lockedAt?: string | null;
  lockedBy?: string | null;
  progress?: AnalysisJobProgress | null;
  createdAt: string;
  updatedAt: string;
}

export interface IndexedVideoFrame {
  image?: string;
  timelineTime: number;
  sourceTime: number;
  sourceId?: string;
  kind: 'overview' | 'dense';
  rangeStart?: number;
  rangeEnd?: number;
  description?: string;
  projectedTimelineTime?: number | null;
  visibleOnTimeline?: boolean;
}

export type VisualConfidenceBand = 'low' | 'medium' | 'high';

export interface VisualQueryIntent {
  rawQuery: string;
  normalizedQuery: string;
  actionType: 'delete' | 'locate' | 'inspect';
  targetType: 'visual_motif' | 'text_on_screen' | 'scene' | 'unknown';
  transcriptRelevance: 'low' | 'medium' | 'high';
  visualEvidencePriority: 'low' | 'medium' | 'high';
  expectedDurationSeconds: number;
  confidenceThreshold: number;
  allowRepeatDetection: boolean;
}

export interface VisualCandidateWindow {
  id: string;
  assetId: string;
  sourceStart: number;
  sourceEnd: number;
  retrievalScore: number;
  retrievalReasons: string[];
  thumbnailPath?: string | null;
  ocrText?: string | null;
  verificationStatus?: 'not_requested' | 'queued' | 'verified' | 'rejected';
  confidenceBand?: VisualConfidenceBand;
}

export interface VerifiedSourceRange {
  assetId: string;
  sourceStart: number;
  sourceEnd: number;
  frameStart: number;
  frameEnd: number;
  verificationConfidence: number;
  boundaryConfidence: number;
  evidence: string[];
  candidateId?: string;
}

export interface VisualEditProposal {
  assetId: string;
  intent: VisualQueryIntent;
  confidenceBand: VisualConfidenceBand;
  sourceRanges: VerifiedSourceRange[];
  timelineRanges: Array<{ timelineStart: number; timelineEnd: number }>;
  followUpPrompt?: string;
}

export interface VisualSearchSession {
  projectId: string;
  assetId: string | null;
  query: string;
  confidenceBand: VisualConfidenceBand;
  intent: VisualQueryIntent | null;
  candidates: VisualCandidateWindow[];
  proposal: VisualEditProposal | null;
  followUpPrompt?: string;
  verificationJobId?: string | null;
  updatedAt: number;
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
    overviewIntervalSeconds: number;
    maxOverviewFrames: number;
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
