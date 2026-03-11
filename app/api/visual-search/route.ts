import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { buildBetaLimitExceededResponse, consumeBetaUsage } from '@/lib/server/betaLimits';
import { getPrimaryMediaAsset } from '@/lib/analysisJobs';
import {
  confidenceBandForCandidates,
  parseVisualQuery,
  retrieveVisualCandidates,
} from '@/lib/visualRetrieval';
import { enforceRateLimit, enforceSameOrigin, getRateLimitIdentity } from '@/lib/server/requestSecurity';

export async function POST(req: NextRequest) {
  const csrfError = enforceSameOrigin(req);
  if (csrfError) return csrfError;

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rateLimitError = enforceRateLimit({
    key: `visual-search:${getRateLimitIdentity(req.headers, user.id)}`,
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const body = await req.json().catch(() => ({}));
  const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
  const query = typeof body?.query === 'string' ? body.query : '';
  const requestedMaxCandidates = Number(body?.maxCandidates);
  const maxCandidates = Number.isFinite(requestedMaxCandidates)
    ? Math.max(1, Math.min(20, Math.floor(requestedMaxCandidates)))
    : 5;

  if (!projectId || !query.trim()) {
    return NextResponse.json({ error: 'projectId and query are required' }, { status: 400 });
  }

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const usage = await consumeBetaUsage('visual_searches', user.id, 1);
  if (!usage.allowed) {
    return buildBetaLimitExceededResponse('visual_searches', usage);
  }

  const asset = await getPrimaryMediaAsset(supabase, projectId);
  if (!asset) {
    return NextResponse.json({
      intent: parseVisualQuery(query),
      candidates: [],
      confidenceBand: 'low',
      followUpPrompt: 'No indexed source video is available for this project yet.',
    });
  }

  const intent = parseVisualQuery(query);
  const candidates = await retrieveVisualCandidates(supabase, asset, intent, maxCandidates);
  const confidenceBand = confidenceBandForCandidates(candidates);

  return NextResponse.json({
    assetId: asset.id,
    intent,
    candidates,
    confidenceBand,
    followUpPrompt: confidenceBand === 'low'
      ? 'I could not verify a strong visual match yet. Try an approximate timestamp or a more specific description.'
      : undefined,
  });
}
