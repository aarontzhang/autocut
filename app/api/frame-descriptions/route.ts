import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getSupabaseServer } from '@/lib/supabase/server';
import { buildBetaLimitExceededResponse, consumeBetaUsage } from '@/lib/server/betaLimits';
import { enforceRateLimit, enforceSameOrigin, getRateLimitIdentity } from '@/lib/server/requestSecurity';
import {
  FRAME_DESCRIPTION_IMAGE_DETAIL,
  FRAME_DESCRIPTION_SERVER_SUB_BATCH_SIZE,
} from '@/lib/frameDescriptionConfig';

const FRAME_DESCRIPTION_MODEL = process.env.OPENAI_FRAME_DESCRIPTION_MODEL?.trim() || 'gpt-4o-mini';
const FRAME_DESCRIPTION_MAX_RETRIES = 3;
const FRAME_DESCRIPTION_RETRY_BASE_DELAY_MS = 2000;

type FrameRequest = {
  image: string;
  timelineTime: number;
  sourceTime: number;
};

type FrameDescription = {
  index: number;
  description: string;
};

type OpenAIErrorLike = Error & {
  status?: number;
  headers?: Headers | Record<string, string | null | undefined>;
};

function parseDescriptions(text: string): FrameDescription[] | null {
  const normalized = text.trim();
  const candidates = [
    normalized,
    normalized.replace(/^```json\s*/i, '').replace(/\s*```$/, ''),
    normalized.replace(/^```\s*/i, '').replace(/\s*```$/, ''),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { frames?: FrameDescription[] } | FrameDescription[];
      const frames = Array.isArray(parsed) ? parsed : parsed.frames;
      if (!Array.isArray(frames)) continue;
      return frames
        .filter((entry): entry is FrameDescription => (
          typeof entry?.index === 'number' &&
          typeof entry?.description === 'string'
        ))
        .map((entry) => ({
          index: entry.index,
          description: entry.description.trim(),
        }));
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Frame description is not configured. Missing OPENAI_API_KEY.');
  }
  return new OpenAI({ apiKey });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getHeaderValue(
  headers: Headers | Record<string, string | null | undefined> | undefined,
  key: string,
): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) {
    return headers.get(key);
  }

  const loweredKey = key.toLowerCase();
  for (const [entryKey, entryValue] of Object.entries(headers)) {
    if (entryKey.toLowerCase() === loweredKey && typeof entryValue === 'string') {
      return entryValue;
    }
  }
  return null;
}

function getRetryDelayMs(error: OpenAIErrorLike, attempt: number) {
  const retryAfterSeconds = Number(getHeaderValue(error.headers, 'retry-after'));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  return FRAME_DESCRIPTION_RETRY_BASE_DELAY_MS * (attempt + 1);
}

function isRetriableFrameDescriptionError(error: OpenAIErrorLike) {
  return error.status === 429 || (typeof error.status === 'number' && error.status >= 500);
}

function normalizeFrameDescriptionError(error: unknown, fallback: string): OpenAIErrorLike {
  if (error instanceof Error) return error as OpenAIErrorLike;
  return new Error(fallback) as OpenAIErrorLike;
}

function buildFrameDescriptionInput(frames: FrameRequest[]) {
  return [{
    role: 'user' as const,
    content: [
      {
        type: 'input_text' as const,
        text:
          'Describe each video frame in one short sentence for retrieval. ' +
          'Focus on visible subjects, actions, text on screen, scene changes, and standout objects. ' +
          'Do not speculate beyond what is visible. ' +
          'Return strict JSON as {"frames":[{"index":0,"description":"..."}]}.',
      },
      ...frames.flatMap((frame, index) => ([
        {
          type: 'input_text' as const,
          text: `Frame ${index}: timeline ${frame.timelineTime.toFixed(2)}s, source ${frame.sourceTime.toFixed(2)}s.`,
        },
        {
          type: 'input_image' as const,
          image_url: `data:image/jpeg;base64,${frame.image}`,
          detail: FRAME_DESCRIPTION_IMAGE_DETAIL,
        },
      ])),
    ],
  }];
}

async function requestDescriptionBatch(
  client: OpenAI,
  frames: FrameRequest[],
): Promise<FrameDescription[]> {
  let lastError: OpenAIErrorLike | null = null;

  for (let attempt = 0; attempt <= FRAME_DESCRIPTION_MAX_RETRIES; attempt += 1) {
    try {
      const response = await client.responses.create({
        model: FRAME_DESCRIPTION_MODEL,
        input: buildFrameDescriptionInput(frames),
        max_output_tokens: Math.min(1800, Math.max(240, frames.length * 120)),
      });

      const rawText = response.output_text ?? '';
      const parsed = parseDescriptions(rawText);

      if (!parsed) {
        throw new Error('Could not parse frame descriptions from model output.');
      }

      const descriptions: FrameDescription[] = [];
      for (let index = 0; index < frames.length; index += 1) {
        const match = parsed.find((entry) => entry.index === index);
        const description = match?.description?.trim() ?? '';
        if (!description) {
          throw new Error('Incomplete frame descriptions from model output.');
        }
        descriptions.push({
          index,
          description,
        });
      }

      return descriptions;
    } catch (error) {
      const normalized = normalizeFrameDescriptionError(error, 'Failed to describe video frames.');
      lastError = normalized;
      if (attempt >= FRAME_DESCRIPTION_MAX_RETRIES || !isRetriableFrameDescriptionError(normalized)) {
        break;
      }
      await sleep(getRetryDelayMs(normalized, attempt));
    }
  }

  if (frames.length > 1) {
    const midpoint = Math.ceil(frames.length / 2);
    const left = await requestDescriptionBatch(client, frames.slice(0, midpoint));
    const right = await requestDescriptionBatch(client, frames.slice(midpoint));
    return [
      ...left,
      ...right.map((entry) => ({
        ...entry,
        index: entry.index + midpoint,
      })),
    ];
  }

  throw lastError ?? new Error('Failed to describe video frames.');
}

async function describeFrames(client: OpenAI, frames: FrameRequest[]) {
  const descriptions: FrameDescription[] = [];
  for (let start = 0; start < frames.length; start += FRAME_DESCRIPTION_SERVER_SUB_BATCH_SIZE) {
    const batch = frames.slice(start, start + FRAME_DESCRIPTION_SERVER_SUB_BATCH_SIZE);
    const batchDescriptions = await requestDescriptionBatch(client, batch);
    descriptions.push(...batchDescriptions.map((entry) => ({
      ...entry,
      index: entry.index + start,
    })));
  }
  return descriptions;
}

export async function POST(req: NextRequest) {
  try {
    const csrfError = enforceSameOrigin(req);
    if (csrfError) return csrfError;

    const supabase = await getSupabaseServer();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const rateLimitError = enforceRateLimit({
      key: `frame-descriptions:${getRateLimitIdentity(req.headers, user.id)}`,
      limit: 120,
      windowMs: 60_000,
    });
    if (rateLimitError) return rateLimitError;

    const body = await req.json();
    const frames = (Array.isArray(body?.frames) ? body.frames : []) as FrameRequest[];
    const requestedBatchSize = Number(body?.batchSize);
    const batchSize = Number.isFinite(requestedBatchSize)
      ? Math.max(1, Math.min(20, Math.floor(requestedBatchSize)))
      : 20;

    if (frames.length === 0) {
      return NextResponse.json({ descriptions: [] });
    }

    if (frames.length > batchSize) {
      return NextResponse.json({ error: `Too many frames in one request. Maximum is ${batchSize}.` }, { status: 400 });
    }

    const usage = await consumeBetaUsage('frame_descriptions', user.id, frames.length);
    if (!usage.allowed) {
      return buildBetaLimitExceededResponse('frame_descriptions', usage);
    }

    const descriptions = await describeFrames(getOpenAIClient(), frames);

    return NextResponse.json({ descriptions });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
