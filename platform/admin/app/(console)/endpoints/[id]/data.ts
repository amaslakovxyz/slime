import { notFound } from 'next/navigation';
import { cache } from 'react';
import { requireUser } from '@/lib/auth';
import { getEndpoint } from '@/lib/endpoints';

/** The layout and the tab page share one GetItem per request. */
export const loadEndpoint = cache(async (id: string) => {
  const email = await requireUser();
  const ep = await getEndpoint(email, id);
  if (!ep) notFound();
  return { email, ep };
});
