'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth/AuthProvider';
import { getSupabaseBrowser } from '@/lib/supabase/client';

type SubscriptionContextValue = {
  isSubscribed: boolean;
  status: string | null;
  loading: boolean;
};

const SubscriptionContext = createContext<SubscriptionContextValue>({
  isSubscribed: false,
  status: null,
  loading: true,
});

export function useSubscription() { return useContext(SubscriptionContext); }

export default function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const { user, initialized } = useAuth();
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!initialized) return;
    if (!user) {
      setIsSubscribed(false);
      setStatus(null);
      setLoading(false);
      return;
    }

    const supabase = getSupabaseBrowser();
    supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', user.id)
      .in('status', ['active', 'trialing'])
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        setIsSubscribed(Boolean(data));
        setStatus(data?.status ?? null);
        setLoading(false);
      });
  }, [user, initialized]);

  return (
    <SubscriptionContext.Provider value={{ isSubscribed, status, loading }}>
      {children}
    </SubscriptionContext.Provider>
  );
}
