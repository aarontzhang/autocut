import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { CaptionEntry } from '@/lib/types';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audio = formData.get('audio') as Blob | null;
    const startTime = parseFloat((formData.get('startTime') as string) ?? '0');

    if (!audio) return NextResponse.json({ error: 'No audio provided' }, { status: 400 });

    const file = new File([audio], 'audio.mp3', { type: 'audio/mpeg' });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    const WORDS_PER_CAPTION = 4;
    const words = transcription.words ?? [];
    const captions: CaptionEntry[] = [];

    for (let i = 0; i < words.length; i += WORDS_PER_CAPTION) {
      const chunk = words.slice(i, i + WORDS_PER_CAPTION);
      if (chunk.length === 0) continue;
      captions.push({
        startTime: startTime + chunk[0].start,
        endTime: startTime + chunk[chunk.length - 1].end,
        text: chunk.map((w: { word: string }) => w.word.trim()).join(' '),
      });
    }

    return NextResponse.json({ captions });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
