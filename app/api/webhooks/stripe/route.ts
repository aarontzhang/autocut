import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get('stripe-signature');

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === 'subscription' && session.subscription && session.metadata?.user_id) {
        const subscription = await getStripe().subscriptions.retrieve(
          session.subscription as string,
        );
        await upsertSubscription(supabase, session.metadata.user_id, subscription);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = await resolveUserId(supabase, subscription);
      if (userId) {
        await upsertSubscription(supabase, userId, subscription);
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

async function upsertSubscription(
  supabase: SupabaseAdmin,
  userId: string,
  subscription: Stripe.Subscription,
) {
  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price.id ?? null;
  const periodStart = firstItem?.current_period_start;
  const periodEnd = firstItem?.current_period_end;
  await supabase.from('subscriptions').upsert(
    {
      user_id: userId,
      stripe_customer_id: subscription.customer as string,
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      price_id: priceId,
      current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
    },
    { onConflict: 'stripe_subscription_id' },
  );
}

async function resolveUserId(
  supabase: SupabaseAdmin,
  subscription: Stripe.Subscription,
): Promise<string | null> {
  if (subscription.metadata?.user_id) return subscription.metadata.user_id;

  const { data } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', subscription.customer as string)
    .limit(1)
    .maybeSingle();

  return data?.user_id ?? null;
}
