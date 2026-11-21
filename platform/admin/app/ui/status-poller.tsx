'use client';

// Re-renders the server components every 5 s while the provisioner works.
// router.refresh() merges the new payload and keeps client state (a revealed
// token stays revealed), unlike a meta refresh that reloads the page.
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function StatusPoller({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
