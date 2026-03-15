import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getSupabaseServer } from '@/lib/supabase/server';
import { buildBetaLimitExceededResponse, consumeBetaUsage } from '@/lib/server/betaLimits';
import { enforceRateLimit, enforceSameOrigin, getRateLimitIdentity } from '@/lib/server/requestSecurity';

const client = new OpenAI();

type FrameRequest = {
  image: string;
  timelineTime: number;
  sourceTime: number;
};

type FrameDescription = {
  index: number;
  description: string;
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

    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
      {
        type: 'text',
        text:
          'Describe each video frame in one short sentence for retrieval. ' +
          'Focus on visible subjects, actions, text on screen, scene changes, and standout objects. ' +
          'Do not speculate beyond what is visible. ' +
          'Return strict JSON as {"frames":[{"index":0,"description":"..."}]}.',
      },
    ];

    frames.forEach((frame, index) => {
      content.push({
        type: 'text',
        text: `Frame ${index}: timeline ${frame.timelineTime.toFixed(2)}s, source ${frame.sourceTime.toFixed(2)}s.`,
      });
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${frame.image}`, detail: 'low' },
      });
    });

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1800,
      temperature: 0,
      messages: [{ role: 'user', content }],
    });

    const rawText = response.choices[0]?.message?.content ?? '';
    const parsed = parseDescriptions(rawText);

    if (!parsed) {
      return NextResponse.json({ error: 'Could not parse frame descriptions from model output.' }, { status: 502 });
    }

    const descriptions: FrameDescription[] = [];
    for (let index = 0; index < frames.length; index += 1) {
      const match = parsed.find((entry) => entry.index === index);
      const description = match?.description?.trim() ?? '';
      if (!description) {
        return NextResponse.json({ error: 'Incomplete frame descriptions from model output.' }, { status: 502 });
      }
      descriptions.push({
        index,
        description,
      });
    }

    return NextResponse.json({ descriptions });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
