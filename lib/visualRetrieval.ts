import { SupabaseClient } from '@supabase/supabase-js';
import {
  AssetVisualSample,
  MediaAsset,
  VerifiedSourceRange,
  VideoClip,
  VisualCandidateWindow,
  VisualConfidenceBand,
  VisualEditProposal,
  VisualQueryIntent,
} from './types';
import { sourceRangeToTimelineRanges } from './timelineUtils';

type JsonMap = Record<string, unknown>;

const VISUAL_MOTIF_TERMS = [
  'show', 'screen', 'appear', 'appears', 'overlay', 'transition', 'logo',
  'cloud', 'clouds', 'black', 'text', 'caption', 'frame', 'scene', 'visual',
  'see', 'looks', 'look', 'image',
];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function tokenize(text: string): string[] {
  return normalize(text).split(/[^a-z0-9]+/g).filter((token) => token.length >= 2);
}

function mapSample(row: Record<string, unknown>): AssetVisualSample {
  return {
    id: String(row.id),
    assetId: String(row.asset_id),
    sourceTime: Number(row.source_time ?? 0),
    windowDuration: Number(row.window_duration ?? 0),
    sampleKind: row.sample_kind as AssetVisualSample['sampleKind'],
    thumbnailPath: row.thumbnail_path ? String(row.thumbnail_path) : null,
    ocrText: row.ocr_text ? String(row.ocr_text) : null,
    embedding: Array.isArray(row.embedding) ? row.embedding.map((value) => Number(value)) : null,
    brightness: row.brightness == null ? null : Number(row.brightness),
    contrast: row.contrast == null ? null : Number(row.contrast),
    edgeDensity: row.edge_density == null ? null : Number(row.edge_density),
    motionScore: row.motion_score == null ? null : Number(row.motion_score),
    fogScore: row.fog_score == null ? null : Number(row.fog_score),
    darknessScore: row.darkness_score == null ? null : Number(row.darkness_score),
    metadata: (row.metadata as JsonMap | null) ?? null,
  };
}

export function isLikelyVisualQuery(query: string): boolean {
  const text = normalize(query);
  if (!text) return false;
  if (/\bframe|screen|overlay|visual|scene|show|appears?|look|image|logo|transition|black clouds?\b/.test(text)) {
    return true;
  }
  return VISUAL_MOTIF_TERMS.some((term) => text.includes(term));
}

export function parseVisualQuery(query: string): VisualQueryIntent {
  const text = normalize(query);
  const tokens = tokenize(text);
  const actionType = /\bdelete|remove|cut\b/.test(text) ? 'delete' : /\bfind|locate|where\b/.test(text) ? 'locate' : 'inspect';
  const targetType = /\btext|subtitle|caption|word|title\b/.test(text)
    ? 'text_on_screen'
    : /\bscene|shot\b/.test(text)
      ? 'scene'
      : tokens.length > 0
        ? 'visual_motif'
        : 'unknown';

  return {
    rawQuery: query,
    normalizedQuery: text,
    actionType,
    targetType,
    transcriptRelevance: targetType === 'text_on_screen' ? 'medium' : 'low',
    visualEvidencePriority: 'high',
    expectedDurationSeconds: /\btransition|flash|overlay\b/.test(text) ? 0.75 : 1.5,
    confidenceThreshold: actionType === 'delete' ? 0.8 : 0.65,
    allowRepeatDetection: /\ball|every|each|throughout|repeated|repeat\b/.test(text),
  };
}

export async function retrieveVisualCandidates(
  supabase: SupabaseClient,
  asset: MediaAsset,
  intent: VisualQueryIntent,
  maxCandidates = 5,
): Promise<VisualCandidateWindow[]> {
  const { data, error } = await supabase
    .from('asset_visual_index')
    .select('*')
    .eq('asset_id', asset.id)
    .order('source_time', { ascending: true })
    .limit(400);

  if (error) throw error;
  const queryTokens = tokenize(intent.normalizedQuery);
  const samples = ((data ?? []) as Record<string, unknown>[]).map(mapSample);

  const scored = samples.map((sample) => {
    let score = 0.05;
    const reasons: string[] = [];
    const ocrText = normalize(sample.ocrText ?? '');
    const metadataText = normalize(JSON.stringify(sample.metadata ?? {}));

    for (const token of queryTokens) {
      if (ocrText.includes(token)) {
        score += 0.35;
        reasons.push(`OCR matched "${token}"`);
      }
      if (metadataText.includes(token)) {
        score += 0.2;
        reasons.push(`Metadata matched "${token}"`);
      }
    }

    if (/\bblack|dark|shadow\b/.test(intent.normalizedQuery) && sample.darknessScore != null) {
      score += Math.min(sample.darknessScore, 1) * 0.25;
      reasons.push('Darkness heuristic matched');
    }
    if (/\bfog|cloud|smoke|mist\b/.test(intent.normalizedQuery) && sample.fogScore != null) {
      score += Math.min(sample.fogScore, 1) * 0.25;
      reasons.push('Fog heuristic matched');
    }
    if (/\btransition|flash|cut\b/.test(intent.normalizedQuery) && sample.motionScore != null) {
      score += Math.min(sample.motionScore, 1) * 0.15;
      reasons.push('Motion/transition heuristic matched');
    }
    if (sample.contrast != null && /\bcontrast|dim|fade\b/.test(intent.normalizedQuery)) {
      score += Math.min(sample.contrast, 1) * 0.1;
      reasons.push('Contrast heuristic matched');
    }

    return { sample, score, reasons };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.sample.sourceTime - b.sample.sourceTime)
    .slice(0, Math.max(1, maxCandidates))
    .map(({ sample, score, reasons }) => ({
      id: sample.id,
      assetId: asset.id,
      sourceStart: Math.max(0, sample.sourceTime - 0.5),
      sourceEnd: sample.sourceTime + Math.max(sample.windowDuration, intent.expectedDurationSeconds) + 0.5,
      retrievalScore: Number(score.toFixed(3)),
      retrievalReasons: reasons.length > 0 ? reasons : ['Fallback visual retrieval score'],
      thumbnailPath: sample.thumbnailPath,
      ocrText: sample.ocrText,
      verificationStatus: 'not_requested',
      confidenceBand: score >= 0.85 ? 'high' : score >= 0.45 ? 'medium' : 'low',
    }));
}

export function confidenceBandForCandidates(candidates: VisualCandidateWindow[]): VisualConfidenceBand {
  const best = candidates[0]?.retrievalScore ?? 0;
  if (best >= 0.85) return 'high';
  if (best >= 0.45) return 'medium';
  return 'low';
}

export function projectVerifiedRangesToProposal(
  clips: VideoClip[],
  assetId: string,
  intent: VisualQueryIntent,
  sourceRanges: VerifiedSourceRange[],
): VisualEditProposal {
  const timelineRanges = sourceRanges.flatMap((range) => (
    sourceRangeToTimelineRanges(clips, range.sourceStart, range.sourceEnd)
  ));
  const bestConfidence = Math.max(
    0,
    ...sourceRanges.map((range) => Math.min(range.verificationConfidence, range.boundaryConfidence)),
  );

  return {
    assetId,
    intent,
    confidenceBand: bestConfidence >= intent.confidenceThreshold
      ? 'high'
      : bestConfidence >= 0.5
        ? 'medium'
        : 'low',
    sourceRanges,
    timelineRanges,
    followUpPrompt: timelineRanges.length === 0
      ? 'I found this in source media, but it is already cut out of the current timeline.'
      : undefined,
  };
}

export function makeDeleteRangesAction(proposal: VisualEditProposal) {
  if (proposal.timelineRanges.length === 0) return null;
  return {
    type: 'delete_ranges' as const,
    ranges: proposal.timelineRanges.map((range) => ({
      start: range.timelineStart,
      end: range.timelineEnd,
    })),
    message: proposal.timelineRanges.length === 1
      ? 'Removed the verified visual match.'
      : `Removed ${proposal.timelineRanges.length} verified visual matches.`,
  };
}
