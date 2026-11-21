import Link from 'next/link';
import type { ReactNode } from 'react';
import { CopyButton } from '@/app/ui/copy-button';
import { PROVIDER_INFO } from '@/app/ui/providers';
import { StatusBadge } from '@/app/ui/status-badge';
import { StatusPoller } from '@/app/ui/status-poller';
import { CONNECTOR_SPECS } from '@/lib/connectors';
import { TRANSIENT_STATUSES } from '@/lib/endpoints';
import { loadEndpoint } from './data';
import { Tabs } from './tabs';

export default async function EndpointLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ep } = await loadEndpoint(id);
  return (
    <>
      <StatusPoller active={TRANSIENT_STATUSES.includes(ep.status)} />
      <header className="ep-head">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/endpoints">Endpoints</Link>
          <span aria-hidden="true">/</span>
          <span className="mono">{ep.endpointId}</span>
        </nav>
        <div className="ep-title-row">
          <h1 className="page-title">{ep.name}</h1>
          <StatusBadge status={ep.status} />
        </div>
        <div className="ep-meta">
          <span className="chip">{PROVIDER_INFO[ep.provider]?.label ?? ep.provider}</span>
          <span className="chip">{CONNECTOR_SPECS[ep.connectorType].label}</span>
          {ep.url ? (
            <div className="copy-field">
              <code>{ep.url}</code>
              <CopyButton value={ep.url} label="Copy URL" />
            </div>
          ) : (
            <span className="muted small">The URL appears once the endpoint is ready.</span>
          )}
        </div>
      </header>
      <Tabs endpointId={ep.endpointId} />
      {children}
    </>
  );
}
