import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';

export async function GET() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = getSupabaseAdmin();
  const { data: sub } = await admin
    .from('subscriptions')
    .select('status, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id, price_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!sub) {
    return NextResponse.json({ error: 'No subscription found' }, { status: 404 });
  }

  const isGrandfathered = sub.stripe_subscription_id.startsWith('grandfathered_');

  return NextResponse.json({
    status: sub.status,
    currentPeriodEnd: sub.current_period_end,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    priceId: sub.price_id,
    isGrandfathered,
  });
}

export async function PATCH(req: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { action } = await req.json() as { action: string };
  if (action !== 'cancel' && action !== 'reactivate') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data: sub } = await admin
    .from('subscriptions')
    .select('stripe_subscription_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!sub?.stripe_subscription_id) {
    return NextResponse.json({ error: 'No subscription found' }, { status: 404 });
  }

  if (sub.stripe_subscription_id.startsWith('grandfathered_')) {
    await admin
      .from('subscriptions')
      .update({ cancel_at_period_end: action === 'cancel' })
      .eq('user_id', user.id)
      .eq('stripe_subscription_id', sub.stripe_subscription_id);

    return NextResponse.json({ ok: true });
  }

  const stripe = getStripe();
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: action === 'cancel',
  });

  return NextResponse.json({ ok: true });
}
