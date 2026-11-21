'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { logout } from '@/app/actions';

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

const NAV = [
  {
    href: '/',
    label: 'Overview',
    active: (p: string) => p === '/',
    icon: icon(
      <>
        <rect x="3" y="3" width="7" height="9" rx="2" />
        <rect x="14" y="3" width="7" height="5" rx="2" />
        <rect x="14" y="12" width="7" height="9" rx="2" />
        <rect x="3" y="16" width="7" height="5" rx="2" />
      </>,
    ),
  },
  {
    href: '/endpoints',
    label: 'Endpoints',
    active: (p: string) => p.startsWith('/endpoints'),
    icon: icon(
      <>
        <path d="M12 3c4.5 3 6.5 6.2 6.5 9.2A6.5 6.5 0 0 1 5.5 12.2C5.5 9.2 7.5 6 12 3Z" />
        <path d="M9.5 13.5a2.5 2.5 0 0 0 2.5 2.5" />
      </>,
    ),
  },
  {
    href: '/billing',
    label: 'Billing',
    active: (p: string) => p.startsWith('/billing'),
    icon: icon(
      <>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M3 10h18M7 15h4" />
      </>,
    ),
  },
];

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <div className="sidebar-inner">
        <Link href="/" className="brand" aria-label="slime cloud overview">
          <span className="wordmark">slime</span>
          <span className="brand-sub">cloud</span>
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} aria-current={item.active(pathname) ? 'page' : undefined}>
              {item.icon}
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user" title={email}>
            <span className="avatar" aria-hidden="true">
              {email.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-email">{email}</span>
          </div>
          <form action={logout}>
            <button className="btn-ghost btn-sm" type="submit">
              Log out
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
