'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthProvider';
import { getSupabaseBrowser } from '@/lib/supabase/client';

type SubscriptionState = {
  isSubscribed: boolean;
  status: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const SubscriptionContext = createContext<SubscriptionState>({
  isSubscribed: false,
  status: null,
  loading: true,
  refresh: async () => {},
});

export function useSubscription() {
  return useContext(SubscriptionContext);
}

const ACTIVE = new Set(['active', 'trialing']);

export default function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const { user, initialized } = useAuth();
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setIsSubscribed(false);
      setStatus(null);
      setLoading(false);
      return;
    }

    const { data } = await getSupabaseBrowser()
      .from('subscriptions')
      .select('status')
      .eq('user_id', user.id)
      .in('status', ['active', 'trialing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    setIsSubscribed(data ? ACTIVE.has(data.status) : false);
    setStatus(data?.status ?? null);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (!initialized) return;
    void refresh();
  }, [initialized, refresh]);

  return (
    <SubscriptionContext.Provider value={{ isSubscribed, status, loading, refresh }}>
      {children}
    </SubscriptionContext.Provider>
  );
}
