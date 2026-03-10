import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const FRAME_DESCRIPTION_MODEL = process.env.ANTHROPIC_FRAME_DESCRIPTION_MODEL ?? 'claude-sonnet-4-6';

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
    const body = await req.json();
    const frames = (Array.isArray(body?.frames) ? body.frames : []) as FrameRequest[];
    const requestedBatchSize = Number(body?.batchSize);
    const batchSize = Number.isFinite(requestedBatchSize)
      ? Math.max(1, Math.min(20, Math.floor(requestedBatchSize)))
      : 12;

    if (frames.length === 0) {
      return NextResponse.json({ descriptions: [] });
    }

    if (frames.length > batchSize) {
      return NextResponse.json({ error: `Too many frames in one request. Maximum is ${batchSize}.` }, { status: 400 });
    }

    const content: Anthropic.ContentBlockParam[] = [{
      type: 'text',
      text:
        'Describe each video frame in one short sentence for retrieval. ' +
        'Focus on visible subjects, actions, text on screen, scene changes, and standout objects. ' +
        'Do not speculate beyond what is visible. ' +
        'Return strict JSON as {"frames":[{"index":0,"description":"..."}]}.',
    }];

    frames.forEach((frame, index) => {
      content.push({
        type: 'text',
        text: `Frame ${index}: timeline ${frame.timelineTime.toFixed(2)}s, source ${frame.sourceTime.toFixed(2)}s.`,
      });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: frame.image },
      });
    });

    const response = await client.messages.create({
      model: FRAME_DESCRIPTION_MODEL,
      max_tokens: 1400,
      temperature: 0,
      messages: [{ role: 'user', content }],
    });

    const rawText = response.content.find(block => block.type === 'text')?.text ?? '';
    const parsed = parseDescriptions(rawText);

    if (!parsed) {
      return NextResponse.json({ error: 'Could not parse frame descriptions from model output.' }, { status: 502 });
    }

    const descriptions = frames.map((_, index) => {
      const match = parsed.find((entry) => entry.index === index);
      return {
        index,
        description: match?.description ?? 'Visual summary unavailable.',
      };
    });

    return NextResponse.json({ descriptions });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
