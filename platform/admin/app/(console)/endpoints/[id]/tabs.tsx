'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { slug: '/lifecycle', label: 'Lifecycle' },
  { slug: '/usage', label: 'Usage' },
  { slug: '/settings', label: 'Settings' },
  { slug: '/requests', label: 'Requests log' },
];

export function Tabs({ endpointId }: { endpointId: string }) {
  const pathname = usePathname();
  const base = `/endpoints/${endpointId}`;
  return (
    <nav className="tabs" aria-label="Endpoint sections">
      {TABS.map((tab) => (
        <Link key={tab.slug} href={base + tab.slug} aria-current={pathname === base + tab.slug ? 'page' : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
