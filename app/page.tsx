import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';

export default async function Home() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? '/new' : '/auth/login');
}
