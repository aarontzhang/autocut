'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthProvider';
import { getSupabaseBrowser } from '@/lib/supabase/client';

type SubscriptionState = {
  isSubscribed: boolean;
  isManual: boolean;
  status: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const SubscriptionContext = createContext<SubscriptionState>({
  isSubscribed: false,
  isManual: false,
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
  const [isManual, setIsManual] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setIsSubscribed(false);
      setIsManual(false);
      setStatus(null);
      setLoading(false);
      return;
    }

    if (user.app_metadata?.manually_subscribed) {
      setIsSubscribed(true);
      setIsManual(true);
      setStatus('active');
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
    setIsManual(false);
    setStatus(data?.status ?? null);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (!initialized) return;
    void refresh();
  }, [initialized, refresh]);

  return (
    <SubscriptionContext.Provider value={{ isSubscribed, isManual, status, loading, refresh }}>
      {children}
    </SubscriptionContext.Provider>
  );
}
