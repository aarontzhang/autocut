import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import LandingPage from '@/components/landing/LandingPage';

export default async function Home() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) redirect('/new');

  return <LandingPage />;
}
