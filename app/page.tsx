import { redirect } from 'next/navigation';
import LandingPage from '@/components/landing/LandingPage';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSubscriptionStatus } from '@/lib/server/subscription';

export default async function Home() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { isActive } = await getSubscriptionStatus(user.id, user.app_metadata?.manually_subscribed);
    redirect(isActive ? '/projects' : '/subscribe');
  }

  return <LandingPage />;
}
