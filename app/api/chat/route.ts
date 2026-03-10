import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getPrimaryMediaAsset } from '@/lib/analysisJobs';
import {
  AIEditingSettings,
  EditAction,
  IndexedVideoFrame,
  VerifiedSourceRange,
  VideoClip,
  VisualSearchSession,
} from '@/lib/types';
import {
  confidenceBandForCandidates,
  isLikelyVisualQuery,
  makeDeleteRangesAction,
  parseVisualQuery,
  projectVerifiedRangesToProposal,
  retrieveVisualCandidates,
} from '@/lib/visualRetrieval';
import { mergeSourceRanges, subtractSourceRanges } from '@/lib/timelineUtils';
import { verifyCandidatesAgainstQuery } from '@/lib/server/visionIndexing.mjs';

const client = new Anthropic();

const BASE_SYSTEM_PROMPT = `You are an AI video editor assistant inside a professional clip-based timeline editor (like CapCut). Help users edit their video using natural language commands.

The video is organized as a sequence of clips on the timeline. You can split, delete, and modify clips.

## Operations

### 1. Split Clip (split_clip)
- Split the clip at a specific timeline time into two clips
- Use when user says: "cut here", "split at 1:30", "cut the video at X", etc.

### 2. Delete Clip (delete_clip)
- Delete a clip by its index (0-based: first clip = 0, second = 1, etc.)
- Use when user says: "delete the first clip", "remove the intro", "cut out clip 2", etc.

### 2c. Reorder Clip (reorder_clip)
- Move a clip to a new position in the timeline
- clipIndex: the current 0-based index of the clip to move
- newIndex: the 0-based index of where to insert it (0 = front, clips.length-1 = end)
- If the user has a selected clip (provided in context), use that clipIndex
- Use when user says: "move clip 3 to the front", "put this at the end", "switch clip 1 and clip 2", "move the last clip to the beginning", etc.

### 2b. Delete Range (delete_range)
- Remove everything between two timeline times, automatically trimming or removing any clips in that region
- Use when user says: "delete between X and Y", "remove from 0:20 to 0:30", "cut out the section from X to Y", etc.
- After any structural edit, earlier chat messages may refer to pre-edit timeline times. Use the clip source ranges and applied-action history in context to translate those old references onto the current timeline instead of reusing stale timestamps.

### 2d. Delete Multiple Ranges (delete_ranges) — USE THIS for silence removal
- Remove ALL non-speaking / silent sections in one single action
- ranges: array of { start, end } in seconds — list every range to delete at once
- Applied end-to-start internally, so offsets stay correct — you do NOT need to account for shifting
- IMPORTANT: use the silence-removal settings provided in context. Treat them as the current default behavior unless the user explicitly overrides them in the latest request.
- IMPORTANT: delete_ranges is a complete, one-shot operation. After issuing it, immediately return type:none. Do NOT issue a second delete_ranges or any delete_range actions afterward — all silence is removed in the single batch.
- IMPORTANT: when removing silence, use the transcript's sub-second timing and cut as tightly as possible without clipping spoken words. Leaving a tiny bit of extra room is better than cutting into speech.
- Use when user says: "cut out silence", "remove the parts where I'm not speaking", "delete dead air", "auto-edit", etc.

Example — delete two silent sections (original silence was 22s–45s and 70s–90s):
<action>{"type":"delete_ranges","ranges":[{"start":23.5,"end":43.5},{"start":71.5,"end":88.5}],"message":"Removed 2 silent sections."}</action>

### 3. Set Clip Speed (set_clip_speed)
- Change playback speed for a specific clip
- speed: 0.1 to 10.0 (1.0 = normal, 2.0 = 2x fast, 0.5 = half speed)
- Use when user says: "slow down the second clip", "speed up clip 1 to 2x", etc.

### 4. Set Clip Volume (set_clip_volume)
- Adjust volume for a specific clip
- volume: 0.0 to 2.0 (1.0 = normal, 0.0 = muted, 0.5 = 50%)
- fadeIn: seconds to fade in at start of clip
- fadeOut: seconds to fade out at end of clip
- Use when user says: "mute the first clip", "lower volume on clip 2", "fade out the last clip", etc.

### 5. Set Clip Filter (set_clip_filter)
- Apply a color filter to a specific clip
- Types: "cinematic", "vintage", "warm", "cool", "bw", "none"
- intensity: 0.0 to 1.0
- Use when user says: "make clip 1 black and white", "add cinematic look to the intro", etc.

### 6. Request Dense Frames (request_frames)
- Request a higher-density set of actual video frames for a specific time range to pinpoint a precise visual moment
- Use when the user wants an edit "right before X happens", "when Y appears", etc. and you need better visual resolution
- startTime/endTime: the range to inspect (seconds); count: frames to extract (default comes from context settings, max 60)
- Prefer narrow requests around the likely boundary instead of one broad 10–20s span when the user needs an exact cut
- Never request dense frames across most or all of the video to search for a brief visual event. If you cannot narrow the candidate span first, ask the user for an approximate timestamp instead of guessing.
- Dense sampled frames are discrete evidence, not proof that an entire multi-second range matches. If you see a possible match, request a narrower follow-up window before issuing a delete_range.
- Use this when the text-only frame summaries are not specific enough. After extraction, the frames will be attached as images — use them to identify the exact timestamp, then make your edit

Example:
<action>{"type":"request_frames","frameRequest":{"startTime":10,"endTime":25,"count":15},"message":"Getting a closer look at that section to find the exact moment."}</action>

### 7. Transcribe Audio (transcribe_request)
- Request real audio transcription for a region of the video using Whisper — stores the result internally as a transcript for future queries, does NOT add visible captions
- Use when user asks about what is said/spoken in the video, or when you need the transcript to answer a question, or when user says "transcribe"
- After transcription, the transcript will be available in your context for follow-up queries
- Do NOT use this for adding visible captions/subtitles — that is a separate feature (add_captions)

### 8. Add Captions (add_captions)
- Add subtitle/caption entries that appear as text at the bottom of the video
- captions: array of { startTime, endTime, text } entries in seconds
- Use when user says: "add captions", "subtitle this", "caption what I'm saying", "add subtitles", etc.
- Do NOT use add_text_overlay for captions — use this tool instead
- Use the caption defaults from context unless the user asks for something different.

Example:
<action>{"type":"add_captions","captions":[{"startTime":0,"endTime":3,"text":"Hello world"},{"startTime":3,"endTime":6,"text":"This is a caption"}],"message":"Added captions."}</action>

### 9. Transitions (add_transition)
- Add a transition effect at a specific timeline time
- Types: "crossfade", "fade_black", "dissolve", "wipe"
- Use when user says: "add a fade between clips", "transition at 0:30", etc.
- Use the transition defaults from context unless the user asks for something different.

### 10. Text Overlays (add_text_overlay / replace_text_overlay)
- Add text/title overlays that appear on screen at specific timeline times
- Position: "top", "center", or "bottom"
- fontSize: optional number in pixels (default 16). Use smaller values (12–14) for single-line overlays
- Use add_text_overlay when user says: "add a title", "put text saying X", "add lower thirds", etc.
- Use replace_text_overlay when user says: "change the text overlay", "move it to top", "make the font smaller", "edit the title" — i.e. modifying an existing overlay. Include overlayIndex (0-based) to identify which overlay to replace.
- Use the text-overlay defaults from context unless the user asks for something different.

### 11. Update AI Defaults (update_ai_settings)
- Update the project's AI editing defaults for future requests
- settings: partial settings object containing only the values that should change
- Use when the user asks to change default editing behavior, such as silence padding, silence cutoff, default caption chunking, default transition duration/type, frame inspection density, or text overlay defaults
- If the user asks to change a default and also wants an edit right now, update the settings first

## Response format

Always respond with:
1. A brief, friendly explanation (1-2 sentences max)
2. A JSON action block embedded at the end (always required)

## Action block examples

Split clip at 10 seconds:
<action>{"type":"split_clip","splitTime":10,"message":"Splitting the clip at 0:10."}</action>

Delete the first clip (index 0):
<action>{"type":"delete_clip","clipIndex":0,"message":"Deleted the first clip."}</action>

Move clip 2 to the front:
<action>{"type":"reorder_clip","clipIndex":1,"newIndex":0,"message":"Moved clip 2 to the front."}</action>

Move the last clip to position 1 (assuming 4 clips, last = index 3):
<action>{"type":"reorder_clip","clipIndex":3,"newIndex":0,"message":"Moved the last clip to the front."}</action>

Delete from 20s to 30s:
<action>{"type":"delete_range","deleteStartTime":20,"deleteEndTime":30,"message":"Removed the section from 0:20 to 0:30."}</action>

Speed up the second clip to 2x:
<action>{"type":"set_clip_speed","clipIndex":1,"speed":2.0,"message":"Set clip 2 to 2x speed."}</action>

Mute the first clip:
<action>{"type":"set_clip_volume","clipIndex":0,"volume":0,"message":"Muted clip 1."}</action>

Fade out the last clip (assumes 1 clip, index 0):
<action>{"type":"set_clip_volume","clipIndex":0,"volume":1.0,"fadeOut":2.0,"message":"Added 2s fade out."}</action>

Black and white on the first clip:
<action>{"type":"set_clip_filter","clipIndex":0,"filter":{"type":"bw","intensity":1.0},"message":"Applied black and white filter."}</action>

Transcribe:
<action>{"type":"transcribe_request","segments":[{"startTime":0,"endTime":60}],"message":"Transcribing the audio."}</action>

Transition:
<action>{"type":"add_transition","transitions":[{"atTime":30,"type":"crossfade","duration":1.0}],"message":"Added crossfade at 0:30."}</action>

Text overlay:
<action>{"type":"add_text_overlay","textOverlays":[{"startTime":0,"endTime":5,"text":"Chapter One","position":"bottom","fontSize":16}],"message":"Added title overlay."}</action>

Replace/edit existing text overlay (index 0):
<action>{"type":"replace_text_overlay","overlayIndex":0,"textOverlays":[{"startTime":0,"endTime":60,"text":"Look what Claude Code can do","position":"top","fontSize":14}],"message":"Updated the text overlay."}</action>

Update AI settings:
<action>{"type":"update_ai_settings","settings":{"silenceRemoval":{"paddingSeconds":1,"minDurationSeconds":3}},"message":"Updated the silence-removal defaults."}</action>

No action:
<action>{"type":"none","message":"Just a note."}</action>

## Rules
- Times are floats in seconds
- Only use times within [0, videoDuration]
- clipIndex is 0-based (0 = first clip)
- Be concise in your explanation (1-2 sentences max)
- For time references: "1:20" = 80s, "2:00" = 120s
- ALWAYS express times in M:SS format in your messages (e.g., "4:03", "1:20") — never use plain seconds like "243 seconds" or "80s"
- Never use markdown formatting (no **bold**, no *italic*, no bullet points). Plain text only.
- If context says "Selected clip: Clip N (index I)", and the user says "this clip", "it", "the selected clip" — use clipIndex I for the operation.
- Treat current timeline time and original source time as different once edits have been made. If a prior message mentioned a moment before a cut, map that original/source moment onto the current timeline before making a new edit.
- You are a single-action editor per request. Complete ONE operation unless the user explicitly asked for multiple distinct edits in one message. After executing any edit, return type:none immediately unless more work is clearly required by the original request.

## Visual and audio context
You may be provided with sampled frames from the user's video as text summaries, dense sampled frames as images, and/or a full audio transcript.
- Overview frames are usually provided as text summaries for retrieval. Treat them as approximate visual metadata.
- Dense frames may be attached as images for a narrower time range. Use those images when you need precise visual confirmation.
- For visually triggered edits, prioritize the visual evidence over the transcript when they disagree. Spoken words can lead or lag what appears on screen.
- If the text summaries are not specific enough for the user's visual request, issue request_frames for the most relevant narrow range instead of guessing.
- If dense frames are attached: use them to answer visual questions about what is on screen. Do NOT say you cannot see or analyze the video.
- If a transcript is provided: use it to answer questions about what is spoken and when. Transcript timestamps may include milliseconds and are word-aligned; use that precision when choosing edit boundaries.
- If NEITHER frame summaries/dense frames nor transcript are available: use transcribe_request to get the audio content you need before answering. Do not say you "can't analyze the video" — instead proactively request transcription.
When the user asks about a timestamp or spoken content, cross-reference the frame sequence and transcript to give your best estimate. Never copy transcript text directly as captions — use transcribe_request only to store the transcript internally.`;

const DEFAULT_SETTINGS: AIEditingSettings = {
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

function mergeSettings(patch?: Partial<AIEditingSettings>): AIEditingSettings {
  return {
    silenceRemoval: { ...DEFAULT_SETTINGS.silenceRemoval, ...patch?.silenceRemoval },
    frameInspection: { ...DEFAULT_SETTINGS.frameInspection, ...patch?.frameInspection },
    captions: { ...DEFAULT_SETTINGS.captions, ...patch?.captions },
    transitions: { ...DEFAULT_SETTINGS.transitions, ...patch?.transitions },
    textOverlays: { ...DEFAULT_SETTINGS.textOverlays, ...patch?.textOverlays },
  };
}

type ClipSummary = { index: number; sourceStart: number; sourceDuration: number; speed?: number };
type ChatTurn = { role: string; content: string };

const MAX_TRANSCRIPT_LINES = 160;

function isVisualSearchSession(value: unknown): value is VisualSearchSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<VisualSearchSession>;
  return typeof session.projectId === 'string'
    && typeof session.query === 'string'
    && Array.isArray(session.candidates);
}

function isAffirmativeVisualFollowUp(message: string): boolean {
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ');

  if (!normalized) return false;

  const exactMatches = new Set([
    'yes',
    'yep',
    'yeah',
    'correct',
    'looks right',
    'looks good',
    'seems right',
    'seems correct',
    'thats right',
    'that is right',
    'thats correct',
    'that is correct',
    'apply it',
    'do it',
    'go ahead',
    'cut it',
    'remove it',
  ]);

  if (exactMatches.has(normalized)) return true;

  return [
    /\bapply\b/,
    /\bgo ahead\b/,
    /\blooks (right|good)\b/,
    /\bseems (right|correct)\b/,
    /\bthat's (right|correct)\b/,
    /\bthat is (right|correct)\b/,
    /\byes\b/,
    /\bcut (it|that)\b/,
    /\bremove (it|that)\b/,
  ].some((pattern) => pattern.test(normalized));
}

function tokenizeForRetrieval(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);
}

function selectRelevantTranscriptLines(
  transcript: string,
  messages: ChatTurn[],
  maxLines = MAX_TRANSCRIPT_LINES,
): { text: string; truncated: boolean } {
  const lines = transcript
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= maxLines) {
    return { text: lines.join('\n'), truncated: false };
  }

  const recentUserText = messages
    .filter((message) => message.role === 'user')
    .slice(-3)
    .map((message) => message.content)
    .join(' ');
  const queryTokens = new Set(tokenizeForRetrieval(recentUserText));

  if (queryTokens.size === 0) {
    const headCount = Math.floor(maxLines / 2);
    const tailCount = maxLines - headCount;
    return {
      text: [...lines.slice(0, headCount), ...lines.slice(-tailCount)].join('\n'),
      truncated: true,
    };
  }

  const scored = lines.map((line, index) => {
    const lineTokens = new Set(tokenizeForRetrieval(line));
    let score = 0;
    for (const token of queryTokens) {
      if (lineTokens.has(token)) score += 1;
    }
    return { index, score };
  });

  const selected = new Set<number>();
  const topMatches = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, Math.floor(maxLines / 4)));

  for (const match of topMatches) {
    for (let offset = -2; offset <= 2; offset += 1) {
      const candidate = match.index + offset;
      if (candidate >= 0 && candidate < lines.length) {
        selected.add(candidate);
      }
    }
  }

  if (selected.size < maxLines) {
    const stride = Math.max(1, Math.floor(lines.length / maxLines));
    for (let index = 0; index < lines.length && selected.size < maxLines; index += stride) {
      selected.add(index);
    }
  }

  return {
    text: [...selected]
      .sort((a, b) => a - b)
      .slice(0, maxLines)
      .map((index) => lines[index])
      .join('\n'),
    truncated: true,
  };
}

function selectRelevantOverviewFrames(
  frames: IndexedVideoFrame[],
  messages: ChatTurn[],
  maxFrames = 60,
): IndexedVideoFrame[] {
  if (frames.length <= maxFrames) return frames;

  const recentUserText = messages
    .filter((message) => message.role === 'user')
    .slice(-3)
    .map((message) => message.content)
    .join(' ');
  const queryTokens = new Set(tokenizeForRetrieval(recentUserText));

  if (queryTokens.size === 0) {
    const stride = Math.ceil(frames.length / maxFrames);
    return frames.filter((_, index) => index % stride === 0).slice(0, maxFrames);
  }

  const scored = frames.map((frame, index) => {
    const descriptionTokens = new Set(tokenizeForRetrieval(frame.description ?? ''));
    let score = 0;
    for (const token of queryTokens) {
      if (descriptionTokens.has(token)) score += 1;
    }
    return { frame, index, score };
  });

  const topMatches = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, Math.floor(maxFrames / 3)));

  if (topMatches.length === 0) {
    const stride = Math.ceil(frames.length / maxFrames);
    return frames.filter((_, index) => index % stride === 0).slice(0, maxFrames);
  }

  const selectedIndexes = new Set<number>();
  for (const match of topMatches) {
    for (let offset = -1; offset <= 1; offset += 1) {
      const candidate = match.index + offset;
      if (candidate >= 0 && candidate < frames.length) {
        selectedIndexes.add(candidate);
      }
    }
  }

  if (selectedIndexes.size < maxFrames) {
    const stride = Math.max(1, Math.floor(frames.length / maxFrames));
    for (let index = 0; index < frames.length && selectedIndexes.size < maxFrames; index += stride) {
      selectedIndexes.add(index);
    }
  }

  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .slice(0, maxFrames)
    .map((index) => frames[index]);
}

function sourceTimeToTimelineFromContext(clips: ClipSummary[], sourceTime: number): number | null {
  let cursor = 0;
  for (const clip of clips) {
    const clipDuration = clip.sourceDuration / (clip.speed ?? 1);
    if (sourceTime >= clip.sourceStart && sourceTime <= clip.sourceStart + clip.sourceDuration) {
      return cursor + (sourceTime - clip.sourceStart) / (clip.speed ?? 1);
    }
    cursor += clipDuration;
  }
  return null;
}

function extractMentionedTimes(messages: ChatTurn[], clips: ClipSummary[]) {
  const seen = new Set<number>();
  const mentioned: Array<{ raw: string; seconds: number; currentTimeline: number | null }> = [];
  const timePattern = /\b(?:(\d+):([0-5]\d)|(\d+(?:\.\d+)?)\s*seconds?)\b/gi;

  for (const message of messages) {
    if (message.role !== 'user') continue;
    let match: RegExpExecArray | null;
    while ((match = timePattern.exec(message.content)) !== null) {
      const seconds = match[1] !== undefined
        ? parseInt(match[1], 10) * 60 + parseInt(match[2] ?? '0', 10)
        : parseFloat(match[3] ?? '0');
      if (seen.has(seconds)) continue;
      seen.add(seconds);
      mentioned.push({
        raw: match[0],
        seconds,
        currentTimeline: sourceTimeToTimelineFromContext(clips, seconds),
      });
      if (mentioned.length >= 6) return mentioned;
    }
  }

  return mentioned;
}

function toProjectionClips(clips: ClipSummary[]): VideoClip[] {
  return clips.map((clip, index) => ({
    id: `clip-${clip.index ?? index}`,
    sourceStart: clip.sourceStart,
    sourceDuration: clip.sourceDuration,
    speed: clip.speed ?? 1,
    volume: 1,
    filter: null,
    fadeIn: 0,
    fadeOut: 0,
  }));
}

function formatVisualCandidateMessage(session: VisualSearchSession): string {
  if (session.proposal?.timelineRanges.length) {
    const matchCount = session.proposal.timelineRanges.length;
    if (session.confidenceBand === 'high') {
      return matchCount === 1
        ? 'I found one verified source-anchored visual match and mapped it onto the current timeline.'
        : `I found ${matchCount} verified source-anchored visual matches and mapped them onto the current timeline.`;
    }
    return matchCount === 1
      ? 'I found the strongest likely source match and mapped it onto the current timeline.'
      : `I found ${matchCount} likely source matches and mapped them onto the current timeline.`;
  }

  if (session.candidates.length === 0) {
    return session.followUpPrompt ?? 'I could not find a confident visual match in the indexed source media.';
  }

  const preview = session.candidates
    .slice(0, 3)
    .map((candidate, index) => `${index + 1}. source ${candidate.sourceStart.toFixed(2)}-${candidate.sourceEnd.toFixed(2)}s`)
    .join(' ');

  if (session.confidenceBand === 'medium') {
    return `I narrowed this to a few likely source windows but I am not confident enough to cut automatically. Candidates: ${preview}`;
  }

  return session.followUpPrompt ?? `I do not have a reliable visual match yet. Best candidates: ${preview}`;
}

function formatVisualSearchContext(session: VisualSearchSession, fmtSec: (seconds: number) => string): string[] {
  const lines = [
    `Latest source visual retrieval query: "${session.query}" (${session.confidenceBand} confidence)`,
  ];

  if (session.candidates.length > 0) {
    lines.push(
      `Latest retrieval candidates: ${session.candidates
        .slice(0, 3)
        .map((candidate, index) => `${index + 1}. source ${candidate.sourceStart.toFixed(2)}-${candidate.sourceEnd.toFixed(2)}s`)
        .join(' | ')}`
    );
  }

  if (session.proposal?.timelineRanges.length) {
    lines.push(
      `Latest mapped timeline ranges: ${session.proposal.timelineRanges
        .map((range) => `${fmtSec(range.timelineStart)}-${fmtSec(range.timelineEnd)}`)
        .join(' | ')}`
    );
  }

  if (session.followUpPrompt) {
    lines.push(`Latest source retrieval note: ${session.followUpPrompt}`);
  }

  return lines;
}

function extractRemovedSourceRanges(
  appliedActions: unknown,
  assetId?: string | null,
): Array<{ sourceStart: number; sourceEnd: number }> {
  if (!Array.isArray(appliedActions)) return [];
  const ranges = appliedActions.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const sourceRanges = (entry as { sourceRanges?: Array<{ sourceStart?: unknown; sourceEnd?: unknown; assetId?: unknown }> }).sourceRanges;
    if (!Array.isArray(sourceRanges)) return [];
    return sourceRanges.flatMap((range) => {
      const sourceStart = typeof range?.sourceStart === 'number' ? range.sourceStart : null;
      const sourceEnd = typeof range?.sourceEnd === 'number' ? range.sourceEnd : null;
      const rangeAssetId = typeof range?.assetId === 'string' ? range.assetId : assetId ?? null;
      if (sourceStart == null || sourceEnd == null || sourceEnd <= sourceStart) return [];
      if (assetId && rangeAssetId && rangeAssetId !== assetId) return [];
      return [{ sourceStart, sourceEnd }];
    });
  });
  return mergeSourceRanges(ranges);
}

function filterCandidatesAgainstRemovedSourceRanges(
  candidates: ReturnType<typeof retrieveVisualCandidates> extends Promise<infer T> ? T : never,
  removedSourceRanges: Array<{ sourceStart: number; sourceEnd: number }>,
) {
  return candidates.flatMap((candidate) => {
    const remaining = subtractSourceRanges(
      { sourceStart: candidate.sourceStart, sourceEnd: candidate.sourceEnd },
      removedSourceRanges,
    );
    if (remaining.length === 0) return [];
    const longest = remaining.reduce((best, range) => (
      (range.sourceEnd - range.sourceStart) > (best.sourceEnd - best.sourceStart) ? range : best
    ));
    return [{
      ...candidate,
      sourceStart: longest.sourceStart,
      sourceEnd: longest.sourceEnd,
    }];
  });
}

export async function POST(req: NextRequest) {
  try {
    const { messages, context } = await req.json();
    const latestUserMessage = [...(Array.isArray(messages) ? messages : [])]
      .reverse()
      .find((message: ChatTurn) => message.role === 'user')?.content ?? '';
    const settings = mergeSettings(context?.settings as Partial<AIEditingSettings> | undefined);
    const systemPrompt = `${BASE_SYSTEM_PROMPT}

## Current AI Editing Defaults
- Silence removal: trim ${settings.silenceRemoval.paddingSeconds}s from each silent gap edge; skip any silent gap shorter than ${settings.silenceRemoval.minDurationSeconds}s after trimming
- Preserve short pauses: ${settings.silenceRemoval.preserveShortPauses ? 'yes' : 'no'}
- Require speaker absence before removing silence: ${settings.silenceRemoval.requireSpeakerAbsence ? 'yes' : 'no'}
- Dense frame inspection default count: ${settings.frameInspection.defaultFrameCount}
- Overview frame sampling: every ${settings.frameInspection.overviewIntervalSeconds}s, capped at ${settings.frameInspection.maxOverviewFrames} frames
- Caption defaults: ${settings.captions.wordsPerCaption} words per caption
- Transition defaults: ${settings.transitions.defaultType}, ${settings.transitions.defaultDuration}s
- Text overlay defaults: position ${settings.textOverlays.defaultPosition}, font size ${settings.textOverlays.defaultFontSize}px

Honor these defaults unless the user explicitly asks for something different in the current message.`;

    const fmtSec = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2, '0')}`;
    };

    const contextLines = [
      `Video duration: ${(context?.videoDuration ?? 0).toFixed(2)} seconds`,
      `Number of clips: ${context?.clipCount ?? 1}`,
    ];

    const clipSummaries = (context?.clips && Array.isArray(context.clips) ? context.clips : []) as ClipSummary[];
    const projectionClips = toProjectionClips(clipSummaries);
    const priorVisualSearch = isVisualSearchSession(context?.visualSearchSession)
      ? context.visualSearchSession
      : null;

    if (
      priorVisualSearch
      && context?.projectId
      && priorVisualSearch.projectId === context.projectId
      && isAffirmativeVisualFollowUp(latestUserMessage)
      && priorVisualSearch.proposal?.intent.actionType === 'delete'
      && priorVisualSearch.proposal.timelineRanges.length > 0
    ) {
      const action = makeDeleteRangesAction(priorVisualSearch.proposal);
      const visualSearch: VisualSearchSession = {
        ...priorVisualSearch,
        confidenceBand: 'high',
        followUpPrompt: undefined,
        updatedAt: Date.now(),
      };

      return NextResponse.json({
        message: action?.message ?? 'Applied the confirmed visual cut.',
        action: action ?? { type: 'none', message: 'I could not apply the confirmed visual cut.' },
        visualSearch,
      });
    }

    if (context?.projectId && typeof context.projectId === 'string' && isLikelyVisualQuery(latestUserMessage)) {
      const supabase = await getSupabaseServer();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select('id')
        .eq('id', context.projectId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
      if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

      let asset = null;
      const intent = parseVisualQuery(latestUserMessage);
      try {
        asset = await getPrimaryMediaAsset(supabase, context.projectId);
      } catch (error) {
        console.error('[chat.visual] failed to load primary media asset, falling back to legacy flow', error);
        asset = null;
      }

      if (!asset) {
        // Fall back to the existing transcript/frame-summary workflow when
        // the new source-index tables are not available yet.
      } else {
        let candidates;
        const removedSourceRanges = extractRemovedSourceRanges(context?.appliedActions, asset?.id);
        try {
          candidates = await retrieveVisualCandidates(supabase, asset, intent, 5);
        } catch (error) {
          console.error('[chat.visual] failed to retrieve visual candidates, falling back to legacy flow', error);
          candidates = null;
        }
        if (!candidates) {
          // Fall back to the existing transcript/frame-summary workflow when
          // the visual sample table is not available yet.
        } else {
        candidates = filterCandidatesAgainstRemovedSourceRanges(candidates, removedSourceRanges);
        let confidenceBand = confidenceBandForCandidates(candidates);
        let proposal = null;
        let action: EditAction | null = { type: 'none', message: 'No timeline edit was applied.' };
        let followUpPrompt: string | undefined;
        let verifiedRanges: VerifiedSourceRange[] = [];

        if (candidates.length > 0) {
          try {
            verifiedRanges = await verifyCandidatesAgainstQuery(supabase, asset, latestUserMessage, candidates);
          } catch (error) {
            console.error('[chat.visual] candidate verification failed', error);
          }
        }

        if (verifiedRanges.length > 0) {
          proposal = projectVerifiedRangesToProposal(projectionClips, asset.id, intent, verifiedRanges, {
            excludedSourceRanges: removedSourceRanges,
          });
          confidenceBand = proposal.confidenceBand;
        }

        if (!proposal && candidates[0]) {
          const seed = candidates[0];
          verifiedRanges = [{
            assetId: asset.id,
            sourceStart: seed.sourceStart,
            sourceEnd: seed.sourceEnd,
            frameStart: Math.round(seed.sourceStart * (asset.fps ?? 30)),
            frameEnd: Math.round(seed.sourceEnd * (asset.fps ?? 30)),
            verificationConfidence: Math.max(seed.retrievalScore, 0.55),
            boundaryConfidence: Math.max(seed.confidenceBand === 'high' ? 0.82 : 0.68, seed.retrievalScore),
            evidence: seed.retrievalReasons,
            candidateId: seed.id,
          }];
          proposal = projectVerifiedRangesToProposal(projectionClips, asset.id, intent, verifiedRanges, {
            excludedSourceRanges: removedSourceRanges,
          });
          confidenceBand = proposal.confidenceBand;
        }

        if (proposal && proposal.timelineRanges.length > 0 && intent.actionType === 'delete') {
          const deleteAction = intent.actionType === 'delete' ? makeDeleteRangesAction(proposal) : null;
          if (deleteAction) {
            action = {
              ...deleteAction,
              message: deleteAction.message,
            };
          } else {
            action = { type: 'none', message: 'I found a strong source-anchored visual match.' };
          }
          if (proposal.confidenceBand !== 'high') {
            followUpPrompt = 'I used the strongest source match and you can review or undo it if needed.';
          }
        } else {
          followUpPrompt = confidenceBand === 'medium'
            ? 'I found a few plausible source windows. Choose one, or give me an approximate timestamp for tighter verification.'
            : 'I am not confident enough to cut automatically. Please give me a more specific visual description or an approximate timestamp.';
        }

        const visualSearch: VisualSearchSession = {
          projectId: context.projectId,
          assetId: asset.id,
          query: latestUserMessage,
          confidenceBand,
          intent,
          candidates,
          proposal,
          followUpPrompt,
          updatedAt: Date.now(),
        };

        return NextResponse.json({
          message: formatVisualCandidateMessage(visualSearch),
          action,
          visualSearch,
        });
        }
      }
    }

    if (clipSummaries.length > 0) {
      let cursor = 0;
      const summaries = clipSummaries.map(c => {
        const dur = c.sourceDuration / (c.speed ?? 1);
        const start = cursor;
        cursor += dur;
        return `clip ${c.index} timeline [${fmtSec(start)}–${fmtSec(cursor)}] from source [${fmtSec(c.sourceStart)}–${fmtSec(c.sourceStart + c.sourceDuration)}] at ${(c.speed ?? 1).toFixed(2)}x`;
      });
      contextLines.push(`Timeline: ${summaries.join(' | ')}`);
    }

    if (priorVisualSearch && (!context?.projectId || priorVisualSearch.projectId === context.projectId)) {
      contextLines.push(...formatVisualSearchContext(priorVisualSearch, fmtSec));
    }

    const mentionedTimes = extractMentionedTimes(messages, clipSummaries);
    if (mentionedTimes.length > 0) {
      contextLines.push(
        'Previously mentioned timestamps remapped onto the current timeline: ' +
        mentionedTimes.map((entry) => (
          entry.currentTimeline === null
            ? `${entry.raw} was cut out`
            : `${entry.raw} source is now around ${fmtSec(entry.currentTimeline)}`
        )).join(' | ')
      );
    }

    if (context?.selectedClip != null) {
      const sc = context.selectedClip;
      contextLines.push(`Selected clip: Clip ${sc.index + 1} (index ${sc.index}), duration ${sc.duration.toFixed(2)}s`);
    }
    if (context?.transcript) {
      const transcriptExcerpt = selectRelevantTranscriptLines(context.transcript, messages);
      contextLines.push(
        `\nVideo transcript (spoken content only — do NOT copy as captions, use transcribe_request for that)` +
        `${transcriptExcerpt.truncated ? ' [excerpted for relevance]' : ''}:\n` +
        `<transcript>\n${transcriptExcerpt.text}\n</transcript>`
      );
    }
    contextLines.push(
      `\nCurrent AI defaults:\n` +
      `- Silence padding: ${settings.silenceRemoval.paddingSeconds}s\n` +
      `- Minimum silence duration after padding: ${settings.silenceRemoval.minDurationSeconds}s\n` +
      `- Preserve short pauses: ${settings.silenceRemoval.preserveShortPauses ? 'yes' : 'no'}\n` +
      `- Require speaker absence for silence removal: ${settings.silenceRemoval.requireSpeakerAbsence ? 'yes' : 'no'}\n` +
      `- Default dense-frame count: ${settings.frameInspection.defaultFrameCount}\n` +
      `- Overview frame interval: ${settings.frameInspection.overviewIntervalSeconds}s\n` +
      `- Max overview frames: ${settings.frameInspection.maxOverviewFrames}\n` +
      `- Caption defaults: ${settings.captions.wordsPerCaption} words per caption\n` +
      `- Transition defaults: ${settings.transitions.defaultType}, ${settings.transitions.defaultDuration}s\n` +
      `- Text overlay defaults: ${settings.textOverlays.defaultPosition}, ${settings.textOverlays.defaultFontSize}px`
    );
    if (context?.appliedActions && Array.isArray(context.appliedActions) && context.appliedActions.length > 0) {
      const recentActions = (context.appliedActions as Array<{ summary?: string; timestamp?: number; action?: { type?: string } }>).slice(-8);
      contextLines.push(
        `\nRecently applied edits (most recent last):\n` +
        recentActions.map((entry, index) => `${index + 1}. ${entry.summary ?? entry.action?.type ?? 'edit'}`).join('\n')
      );
    }
    contextLines.push(
      `\nTime-mapping rule:\n` +
      `Use source ranges as the stable identity for moments discussed earlier in the chat. If an earlier message referred to a moment before cuts were made, first find that moment in source time, then convert it to the current timeline using the clip mapping above.`
    );
    const contextText = contextLines.join('\n');

    const contextContent: Anthropic.ContentBlockParam[] = [];

    const frames = (context?.frames as IndexedVideoFrame[] | undefined) ?? [];
    const denseFrames = frames.filter((frame) => frame.kind === 'dense');
    if (denseFrames.length > 0) {
      for (const frame of denseFrames) {
        if (!frame.image) continue;
        contextContent.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: frame.image },
        });
      }
    }

    const overviewFrames = selectRelevantOverviewFrames(
      frames.filter((frame) => frame.kind === 'overview'),
      messages,
    );
    const overviewFrameNote = overviewFrames.length > 0
      ? `\n[Overview frame summaries: showing ${overviewFrames.length} most relevant/recently sampled entries from the video index]\n` +
        overviewFrames.map((frame, index) =>
          `Frame ${index + 1}: source ${fmtSec(frame.sourceTime)}, ` +
          `${frame.visibleOnTimeline === false
            ? 'currently cut from the timeline'
            : `current timeline ${fmtSec(frame.projectedTimelineTime ?? frame.timelineTime)}`}, ` +
          `${frame.description ?? 'Visual summary unavailable.'}`
        ).join('\n')
      : '';
    const denseFrameNote = denseFrames.length > 0
      ? `\n[${denseFrames.length} dense video frame(s) are attached above as images in this exact order. Use the mapping below when reasoning about timestamps.]\n` +
        denseFrames.map((frame, index) =>
          `Dense frame ${index + 1}: timeline ${fmtSec(frame.timelineTime)}, source ${fmtSec(frame.sourceTime)}, ${frame.kind}` +
          (frame.rangeStart !== undefined && frame.rangeEnd !== undefined ? `, requested from ${fmtSec(frame.rangeStart)} to ${fmtSec(frame.rangeEnd)}` : '') +
          (frame.description ? `, summary: ${frame.description}` : '')
        ).join('\n')
      : '';
    contextContent.push({ type: 'text', text: contextText + overviewFrameNote + denseFrameNote });

    const anthropicMessages: Anthropic.MessageParam[] = [
      { role: 'user', content: contextContent },
      { role: 'assistant', content: 'Got it — I have the video context. What would you like to edit?' },
      ...messages.map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: anthropicMessages,
    });

    const rawText = response.content.find(b => b.type === 'text')?.text ?? '';
    const actionMatch = rawText.match(/<action>([\s\S]*?)<\/action>/);
    let action: EditAction | null = null;

    if (actionMatch) {
      try { action = JSON.parse(actionMatch[1]) as EditAction; } catch { /* ignore */ }
    }

    const message = rawText.replace(/<action>[\s\S]*?<\/action>/, '').trim();
    return NextResponse.json({ message, action });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
