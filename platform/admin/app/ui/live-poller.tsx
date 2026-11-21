'use client';

// Re-renders the Lifecycle tab every 2 s so new requests and stage changes show
// up live. router.refresh() keeps client state (selection, revealed token).
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function LivePoller({ everyMs = 2000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [everyMs, router]);
  return null;
}
