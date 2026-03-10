import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { CaptionEntry } from '@/lib/types';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
type WhisperWord = { start: number; end: number; word: string };

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audio = formData.get('audio') as Blob | null;
    const startTime = parseFloat((formData.get('startTime') as string) ?? '0');
    const wordsPerCaption = Math.max(1, Math.min(12, parseInt((formData.get('wordsPerCaption') as string) ?? '4', 10) || 4));

    if (!audio) return NextResponse.json({ error: 'No audio provided' }, { status: 400 });

    const file = new File([audio], 'audio.mp3', { type: 'audio/mpeg' });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    const words = transcription.words ?? [];
    const wordEntries: CaptionEntry[] = words
      .map((word) => {
        const typedWord = word as WhisperWord;
        const text = typedWord.word.trim();
        if (!text) return null;
        return {
          startTime: startTime + typedWord.start,
          endTime: startTime + typedWord.end,
          text,
        };
      })
      .filter((entry): entry is CaptionEntry => entry !== null);
    const captions: CaptionEntry[] = [];

    for (let i = 0; i < wordEntries.length; i += wordsPerCaption) {
      const chunk = wordEntries.slice(i, i + wordsPerCaption);
      if (chunk.length === 0) continue;
      captions.push({
        startTime: chunk[0].startTime,
        endTime: chunk[chunk.length - 1].endTime,
        text: chunk.map((w) => w.text).join(' '),
      });
    }

    return NextResponse.json({ captions, words: wordEntries });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
