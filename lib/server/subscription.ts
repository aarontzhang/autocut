import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';

const ACTIVE_STATUSES = ['active', 'trialing'];

export async function getSubscriptionStatus(userId: string) {
  const supabase = getSupabaseAdmin();

  // Existing users with projects are grandfathered — skip paywall
  const { data: existingProject } = await supabase
    .from('projects')
    .select('id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (existingProject) {
    return {
      isActive: true,
      status: 'grandfathered' as const,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };
  }

  const { data } = await supabase
    .from('subscriptions')
    .select('status, current_period_end, cancel_at_period_end')
    .eq('user_id', userId)
    .in('status', ACTIVE_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    isActive: Boolean(data),
    status: data?.status ?? null,
    currentPeriodEnd: data?.current_period_end ?? null,
    cancelAtPeriodEnd: data?.cancel_at_period_end ?? false,
  };
}

export function subscriptionRequiredResponse() {
  return NextResponse.json({ error: 'Active subscription required' }, { status: 403 });
}
