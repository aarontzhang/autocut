import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

export type SubscriptionStatus = {
  isActive: boolean;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
};

export async function getSubscriptionStatus(userId: string, manuallySubscribed?: boolean): Promise<SubscriptionStatus> {
  if (manuallySubscribed) {
    return {
      isActive: true,
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      stripeCustomerId: null,
    };
  }

  const { data } = await getSupabaseAdmin()
    .from('subscriptions')
    .select('status, current_period_end, cancel_at_period_end, stripe_customer_id')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    isActive: Boolean(data) && ACTIVE_STATUSES.has(data?.status ?? ''),
    status: data?.status ?? null,
    currentPeriodEnd: data?.current_period_end ?? null,
    cancelAtPeriodEnd: data?.cancel_at_period_end ?? false,
    stripeCustomerId: data?.stripe_customer_id ?? null,
  };
}

export function subscriptionRequiredResponse() {
  return NextResponse.json(
    { error: 'Active subscription required', code: 'SUBSCRIPTION_REQUIRED' },
    { status: 403 },
  );
}
