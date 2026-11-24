import Link from 'next/link';
import { LivePoller } from '@/app/ui/live-poller';
import { REQUESTS_PAGE_SIZE, RETAINED_REQUESTS, readRequests } from '@/lib/lifecycle';
import { loadEndpoint } from '../data';
import { RequestsLog } from './requests-log';

// Every request that hit the endpoint, newest first, REQUESTS_PAGE_SIZE rows a page. The runtime keeps
// the newest RETAINED_REQUESTS in the endpoint's store, the same on every instance (GET /v0/events).
// Pages are cursors in the URL (?before=<id> older, ?after=<id> newer), so a page keeps its rows while
// new requests land on top; LivePoller refreshes it in place. Click a row for its trace (RequestsLog,
// client). Read-only; no actions.

export default async function RequestsLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string; after?: string }>;
}) {
  const { id } = await params;
  const { before, after } = await searchParams;
  const { ep } = await loadEndpoint(id);
  const data = await readRequests(ep, { before, after });
  const isFirstPage = data.ok && !data.hasNewer;
  const href = (query: Record<string, string>) => `/endpoints/${id}/requests${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`;
  const newest = data.ok ? data.events[0]?.id : undefined;
  const oldest = data.ok ? data.events.at(-1)?.id : undefined;

  return (
    <>
      <LivePoller />
      <section className="card">
        <div className="section-head">
          <h2 className="section-title">Requests log</h2>
          {data.ok && (
            <span className="muted small">
              {data.total} total{data.events.length < data.total ? ` · ${isFirstPage ? 'latest' : 'showing'} ${data.events.length}` : ''}
            </span>
          )}
        </div>
        {!data.ok ? (
          <p className="muted small" role="status">{data.reason}</p>
        ) : data.events.length === 0 ? (
          isFirstPage ? (
            <p className="lc-empty">No requests yet.</p>
          ) : (
            <p className="lc-empty">
              No requests on this page. <Link href={href({})}>Back to the newest</Link>
            </p>
          )
        ) : (
          <>
            <RequestsLog endpointId={id} events={data.events} />
            {(data.hasNewer || data.hasOlder) && (
              <nav className="pager" aria-label="Requests log pages">
                <div>
                  {data.hasNewer && newest && (
                    <>
                      <Link className="btn-ghost" href={href({})}>Newest</Link>
                      <Link className="btn-ghost" href={href({ after: newest })} rel="prev">← Newer</Link>
                    </>
                  )}
                </div>
                <div>
                  {data.hasOlder && oldest && (
                    <Link className="btn-ghost" href={href({ before: oldest })} rel="next">Older →</Link>
                  )}
                </div>
              </nav>
            )}
            {!data.hasOlder && data.total > RETAINED_REQUESTS && (
              <p className="muted small">Only the latest {RETAINED_REQUESTS} requests are kept; {REQUESTS_PAGE_SIZE} a page.</p>
            )}
          </>
        )}
      </section>
    </>
  );
}
