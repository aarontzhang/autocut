import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getSupabaseServer } from '@/lib/supabase/server';
import { enforceRateLimit, enforceSameOrigin, getRateLimitIdentity } from '@/lib/server/requestSecurity';

const DESCRIBE_REQUESTS_PER_MINUTE = 10;
const MAX_BASE64_SIZE = 10 * 1024 * 1024; // ~10MB

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Server image description is not configured. Missing OPENAI_API_KEY.');
  }
  return new OpenAI({ apiKey });
}

export async function POST(req: NextRequest) {
  try {
    const csrfError = enforceSameOrigin(req);
    if (csrfError) return csrfError;

    const supabase = await getSupabaseServer();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const rateLimitError = enforceRateLimit({
      key: `describe-image:${getRateLimitIdentity(req.headers, user.id)}`,
      limit: DESCRIBE_REQUESTS_PER_MINUTE,
      windowMs: 60_000,
    });
    if (rateLimitError) return rateLimitError;

    const body = await req.json();
    const { imageBase64, mimeType } = body as { imageBase64?: string; mimeType?: string };

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return NextResponse.json({ error: 'Missing imageBase64' }, { status: 400 });
    }
    if (!mimeType || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
      return NextResponse.json({ error: 'Invalid mimeType' }, { status: 400 });
    }
    if (imageBase64.length > MAX_BASE64_SIZE) {
      return NextResponse.json({ error: 'Image too large' }, { status: 413 });
    }

    const dataUrl = `data:${mimeType};base64,${imageBase64}`;

    const response = await getOpenAIClient().chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content: 'Describe this image in one brief sentence for a video editor. Focus on what the image shows (e.g., a product logo, a screenshot, a photo of a person). Keep it under 30 words.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'low' },
            },
          ],
        },
      ],
    });

    const description = response.choices[0]?.message?.content?.trim() ?? '';

    return NextResponse.json({ description });
  } catch (error) {
    console.error('describe-image error:', error);
    return NextResponse.json(
      { error: 'Failed to describe image' },
      { status: 500 },
    );
  }
}
