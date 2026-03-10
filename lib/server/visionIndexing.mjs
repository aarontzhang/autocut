import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import jpeg from 'jpeg-js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const execFileAsync = promisify(execFile);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const FRAME_DESCRIPTION_MODEL = process.env.ANTHROPIC_FRAME_DESCRIPTION_MODEL ?? 'claude-sonnet-4-6';
const TEXT_EMBED_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, options);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeDownloadToFile(download, filePath) {
  const arrayBuffer = await download.arrayBuffer();
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));
}

export async function downloadAssetToTempFile(supabase, asset, prefix = 'asset') {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const filePath = path.join(tmpDir, path.basename(asset.storagePath || `${asset.id}.mp4`));
  const { data, error } = await supabase.storage.from('videos').download(asset.storagePath);
  if (error || !data) {
    throw error ?? new Error(`Failed to download source asset ${asset.storagePath}`);
  }
  await writeDownloadToFile(data, filePath);
  return { tmpDir, filePath };
}

export async function probeVideo(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath,
  ]);
  const parsed = JSON.parse(stdout);
  const videoStream = (parsed.streams ?? []).find((stream) => stream.codec_type === 'video') ?? {};
  const rate = String(videoStream.avg_frame_rate || videoStream.r_frame_rate || '0/1');
  const [num, den] = rate.split('/').map((value) => Number(value));
  const fps = num > 0 && den > 0 ? num / den : null;
  return {
    duration: parsed.format?.duration ? Number(parsed.format.duration) : null,
    fps,
    width: videoStream.width ? Number(videoStream.width) : null,
    height: videoStream.height ? Number(videoStream.height) : null,
  };
}

export async function extractFramesAtInterval(filePath, outputDir, intervalSeconds, scaleWidth = 320) {
  await ensureDir(outputDir);
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', filePath,
    '-vf', `fps=${1 / intervalSeconds},scale=${scaleWidth}:-1`,
    '-q:v', '3',
    path.join(outputDir, 'frame_%05d.jpg'),
  ]);

  const frameNames = (await fs.readdir(outputDir))
    .filter((name) => name.endsWith('.jpg'))
    .sort();

  return Promise.all(frameNames.map(async (name, index) => {
    const fileName = path.join(outputDir, name);
    const bytes = await fs.readFile(fileName);
    const descriptor = computeImageDescriptor(bytes);
    return {
      index,
      sourceTime: Number((index * intervalSeconds).toFixed(3)),
      fileName,
      imageBase64: bytes.toString('base64'),
      ...descriptor,
    };
  }));
}

function computeImageDescriptor(buffer) {
  const decoded = jpeg.decode(buffer, { useTArray: true });
  const { data, width, height } = decoded;
  let brightnessSum = 0;
  let brightnessSqSum = 0;
  let edgeAccumulator = 0;
  let saturationSum = 0;
  const grayscale = new Float32Array(width * height);

  for (let index = 0, pixelIndex = 0; index < data.length; index += 4, pixelIndex += 1) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    grayscale[pixelIndex] = brightness;
    brightnessSum += brightness;
    brightnessSqSum += brightness * brightness;
    saturationSum += max === 0 ? 0 : (max - min) / max;
  }

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const current = grayscale[y * width + x];
      const right = grayscale[y * width + x + 1];
      const down = grayscale[(y + 1) * width + x];
      edgeAccumulator += Math.abs(current - right) + Math.abs(current - down);
    }
  }

  const pixelCount = width * height;
  const meanBrightness = brightnessSum / pixelCount;
  const variance = Math.max(brightnessSqSum / pixelCount - meanBrightness * meanBrightness, 0);
  const contrast = Math.sqrt(variance);
  const edgeDensity = edgeAccumulator / Math.max((width - 1) * (height - 1) * 2, 1);
  const avgSaturation = saturationSum / pixelCount;

  return {
    width,
    height,
    brightness: Number(meanBrightness.toFixed(4)),
    contrast: Number(contrast.toFixed(4)),
    edgeDensity: Number(edgeDensity.toFixed(4)),
    darknessScore: Number((1 - meanBrightness).toFixed(4)),
    fogScore: Number(clamp((1 - contrast) * (1 - avgSaturation), 0, 1).toFixed(4)),
  };
}

async function describeFrameBatch(frames) {
  if (!anthropic || frames.length === 0) return frames.map(() => ({ description: '', ocrText: '' }));
  const content = [{
    type: 'text',
    text:
      'For each video frame, return strict JSON as {"frames":[{"index":0,"description":"...","ocrText":"..."}]}. ' +
      'Describe the visible scene briefly and include any readable on-screen text. ' +
      'Do not speculate beyond what is visible.',
  }];

  frames.forEach((frame, index) => {
    content.push({
      type: 'text',
      text: `Frame ${index}: source ${frame.sourceTime.toFixed(2)}s.`,
    });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: frame.imageBase64 },
    });
  });

  const response = await anthropic.messages.create({
    model: FRAME_DESCRIPTION_MODEL,
    max_tokens: 1800,
    temperature: 0,
    messages: [{ role: 'user', content }],
  });
  const text = response.content.find((block) => block.type === 'text')?.text ?? '';
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  const rows = Array.isArray(parsed) ? parsed : parsed.frames;
  return frames.map((_, index) => {
    const match = Array.isArray(rows) ? rows.find((entry) => Number(entry?.index) === index) : null;
    return {
      description: typeof match?.description === 'string' ? match.description.trim() : '',
      ocrText: typeof match?.ocrText === 'string' ? match.ocrText.trim() : '',
    };
  });
}

async function embedTexts(texts) {
  if (!openai || texts.length === 0) return texts.map(() => null);
  const safeTexts = texts.map((text) => text || 'visual frame');
  const response = await openai.embeddings.create({
    model: TEXT_EMBED_MODEL,
    input: safeTexts,
  });
  return safeTexts.map((_, index) => response.data[index]?.embedding ?? null);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = Number(a[index]);
    const bv = Number(b[index]);
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function buildScenes(samples, duration) {
  if (samples.length === 0) {
    return duration > 0 ? [{ sceneIndex: 0, sourceStart: 0, sourceEnd: duration, representativeIndex: 0 }] : [];
  }
  const scenes = [];
  let sceneStart = 0;
  let sceneIndex = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index];
    const prev = samples[index - 1];
    const forceBoundary = sample.motionScore > 0.18 || Math.abs(sample.brightness - prev.brightness) > 0.22;
    const longScene = sample.sourceTime - samples[sceneStart].sourceTime >= 4;
    if (!forceBoundary && !longScene) continue;
    const representativeIndex = Math.floor((sceneStart + index - 1) / 2);
    scenes.push({
      sceneIndex,
      sourceStart: samples[sceneStart].sourceTime,
      sourceEnd: sample.sourceTime,
      representativeIndex,
    });
    sceneIndex += 1;
    sceneStart = index;
  }
  scenes.push({
    sceneIndex,
    sourceStart: samples[sceneStart].sourceTime,
    sourceEnd: duration ?? samples[samples.length - 1].sourceTime + 0.25,
    representativeIndex: Math.floor((sceneStart + samples.length - 1) / 2),
  });
  return scenes;
}

export async function indexAssetFromStorage(supabase, asset) {
  const download = await downloadAssetToTempFile(supabase, asset, 'autocut-index');
  try {
    const metadata = await probeVideo(download.filePath);
    const duration = metadata.duration ?? asset.sourceDuration ?? 0;
    const baseInterval = duration > 0 && duration / 0.25 > 1600 ? duration / 1600 : 0.25;
    const sampleInterval = Number(baseInterval.toFixed(3));
    const sampleDir = path.join(download.tmpDir, 'frames');
    const samples = await extractFramesAtInterval(download.filePath, sampleDir, sampleInterval);

    let previousBrightness = samples[0]?.brightness ?? 0;
    let previousContrast = samples[0]?.contrast ?? 0;
    for (const sample of samples) {
      const motionScore = Math.abs(sample.brightness - previousBrightness) + Math.abs(sample.contrast - previousContrast);
      sample.motionScore = Number(clamp(motionScore, 0, 1).toFixed(4));
      previousBrightness = sample.brightness;
      previousContrast = sample.contrast;
    }

    const representativeFrames = samples.filter((_, index) => index % Math.max(1, Math.round(0.5 / sampleInterval)) === 0);
    const descriptions = [];
    for (let index = 0; index < representativeFrames.length; index += 8) {
      const batch = representativeFrames.slice(index, index + 8);
      const batchDescriptions = await describeFrameBatch(batch);
      descriptions.push(...batchDescriptions);
    }
    const embeddings = await embedTexts(descriptions.map((row) => `${row.description}\n${row.ocrText}`.trim()));

    const descriptionByTime = new Map();
    representativeFrames.forEach((frame, index) => {
      descriptionByTime.set(frame.sourceTime.toFixed(3), {
        description: descriptions[index]?.description ?? '',
        ocrText: descriptions[index]?.ocrText ?? '',
        embedding: embeddings[index] ?? null,
      });
    });

    const scenes = buildScenes(samples, duration);

    await supabase.from('asset_scenes').delete().eq('asset_id', asset.id);
    await supabase.from('asset_visual_index').delete().eq('asset_id', asset.id);
    await supabase.from('asset_transcript_words').delete().eq('asset_id', asset.id);

    if (scenes.length > 0) {
      const sceneRows = scenes.map((scene) => ({
        asset_id: asset.id,
        scene_index: scene.sceneIndex,
        source_start: scene.sourceStart,
        source_end: scene.sourceEnd,
        representative_thumbnail_path: null,
        metadata: {
          representative_source_time: samples[scene.representativeIndex]?.sourceTime ?? scene.sourceStart,
        },
      }));
      const { error: sceneError } = await supabase.from('asset_scenes').insert(sceneRows);
      if (sceneError) throw sceneError;
    }

    const visualRows = samples.map((sample, index) => {
      const keyed = descriptionByTime.get(sample.sourceTime.toFixed(3));
      return {
        asset_id: asset.id,
        source_time: sample.sourceTime,
        window_duration: sampleInterval,
        sample_kind: keyed ? 'scene_rep' : 'window_250ms',
        thumbnail_path: null,
        ocr_text: keyed?.ocrText || null,
        embedding: keyed?.embedding ?? null,
        brightness: sample.brightness,
        contrast: sample.contrast,
        edge_density: sample.edgeDensity,
        motion_score: sample.motionScore ?? (index === 0 ? 0 : Math.abs(sample.brightness - samples[index - 1].brightness)),
        fog_score: sample.fogScore,
        darkness_score: sample.darknessScore,
        metadata: {
          description: keyed?.description ?? '',
          width: sample.width,
          height: sample.height,
        },
      };
    });
    if (visualRows.length > 0) {
      const { error: visualError } = await supabase.from('asset_visual_index').insert(visualRows);
      if (visualError) throw visualError;
    }

    await supabase.from('media_assets').update({
      duration_seconds: duration || null,
      fps: metadata.fps ?? asset.fps ?? 30,
      width: metadata.width ?? asset.width ?? null,
      height: metadata.height ?? asset.height ?? null,
      status: 'ready',
      indexed_at: new Date().toISOString(),
    }).eq('id', asset.id);

    return {
      duration,
      fps: metadata.fps ?? 30,
      sampleCount: visualRows.length,
      sceneCount: scenes.length,
      sampleInterval,
    };
  } finally {
    await fs.rm(download.tmpDir, { recursive: true, force: true });
  }
}

export async function embedQueryText(query) {
  const result = await embedTexts([query]);
  return result[0] ?? null;
}

export function scoreVisualSample(sample, queryText, queryEmbedding) {
  const description = String(sample.metadata?.description ?? '').toLowerCase();
  const ocrText = String(sample.ocr_text ?? '').toLowerCase();
  let score = 0.05;
  const reasons = [];
  if (queryEmbedding && Array.isArray(sample.embedding)) {
    const similarity = cosineSimilarity(sample.embedding, queryEmbedding);
    score += Math.max(0, similarity) * 0.55;
    if (similarity > 0.35) reasons.push('Embedding similarity matched');
  }
  for (const token of queryText.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean)) {
    if (description.includes(token)) {
      score += 0.18;
      reasons.push(`Description matched "${token}"`);
    }
    if (ocrText.includes(token)) {
      score += 0.25;
      reasons.push(`OCR matched "${token}"`);
    }
  }
  if (/\bblack|dark|shadow\b/i.test(queryText) && sample.darkness_score != null) {
    score += Math.min(Number(sample.darkness_score), 1) * 0.2;
    reasons.push('Darkness heuristic matched');
  }
  if (/\bcloud|fog|smoke|mist\b/i.test(queryText) && sample.fog_score != null) {
    score += Math.min(Number(sample.fog_score), 1) * 0.2;
    reasons.push('Fog heuristic matched');
  }
  return {
    score: Number(score.toFixed(3)),
    reasons: reasons.length > 0 ? [...new Set(reasons)] : ['Fallback score'],
  };
}

export async function verifyCandidatesAgainstQuery(supabase, asset, query, candidates) {
  if (!anthropic || candidates.length === 0) return [];
  const download = await downloadAssetToTempFile(supabase, asset, 'autocut-verify');
  try {
    const verificationFrames = [];
    for (const candidate of candidates.slice(0, 3)) {
      const frameDir = path.join(download.tmpDir, `verify-${candidate.id}`);
      await ensureDir(frameDir);
      const span = Math.max(candidate.sourceEnd - candidate.sourceStart, 0.4);
      const offsets = [0.2, 0.5, 0.8].map((ratio) => Number((candidate.sourceStart + span * ratio).toFixed(3)));
      for (let index = 0; index < offsets.length; index += 1) {
        const outputPath = path.join(frameDir, `frame_${index}.jpg`);
        await run('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-ss', String(offsets[index]),
          '-i', download.filePath,
          '-frames:v', '1',
          '-vf', 'scale=320:-1',
          '-q:v', '3',
          outputPath,
        ]);
        const buffer = await fs.readFile(outputPath);
        verificationFrames.push({
          candidateId: candidate.id,
          sourceTime: offsets[index],
          imageBase64: buffer.toString('base64'),
        });
      }
    }

    const grouped = new Map();
    for (const frame of verificationFrames) {
      if (!grouped.has(frame.candidateId)) grouped.set(frame.candidateId, []);
      grouped.get(frame.candidateId).push(frame);
    }

    const content = [{
      type: 'text',
      text:
        `The user wants: "${query}". ` +
        'For each candidate, decide whether the requested visual motif is actually present. ' +
        'Return strict JSON as {"candidates":[{"candidateId":"...","match":true,"confidence":0.0,"evidence":"..."}]}.',
    }];
    for (const candidate of candidates.slice(0, 3)) {
      content.push({
        type: 'text',
        text: `Candidate ${candidate.id}: source ${candidate.sourceStart.toFixed(2)}-${candidate.sourceEnd.toFixed(2)}s`,
      });
      for (const frame of grouped.get(candidate.id) ?? []) {
        content.push({
          type: 'text',
          text: `Frame for candidate ${candidate.id} at ${frame.sourceTime.toFixed(2)}s`,
        });
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: frame.imageBase64 },
        });
      }
    }

    const response = await anthropic.messages.create({
      model: FRAME_DESCRIPTION_MODEL,
      max_tokens: 1200,
      temperature: 0,
      messages: [{ role: 'user', content }],
    });
    const text = response.content.find((block) => block.type === 'text')?.text ?? '';
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned);
    const verdicts = Array.isArray(parsed) ? parsed : parsed.candidates;
    return candidates.slice(0, 3).flatMap((candidate) => {
      const verdict = Array.isArray(verdicts)
        ? verdicts.find((entry) => String(entry?.candidateId) === candidate.id)
        : null;
      if (!verdict?.match) return [];
      return [{
        candidateId: candidate.id,
        assetId: asset.id,
        sourceStart: candidate.sourceStart,
        sourceEnd: candidate.sourceEnd,
        frameStart: Math.round(candidate.sourceStart * (asset.fps ?? 30)),
        frameEnd: Math.round(candidate.sourceEnd * (asset.fps ?? 30)),
        verificationConfidence: Number(verdict.confidence ?? 0.7),
        boundaryConfidence: 0.72,
        evidence: [String(verdict.evidence ?? 'Vision verification matched')],
      }];
    });
  } finally {
    await fs.rm(download.tmpDir, { recursive: true, force: true });
  }
}
