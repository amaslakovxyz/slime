import type { ReactNode } from 'react';
import { requireUser } from '@/lib/auth';
import { Sidebar } from './sidebar';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const email = await requireUser();
  return (
    <div className="app">
      <Sidebar email={email} />
      <main className="main">{children}</main>
    </div>
  );
}
