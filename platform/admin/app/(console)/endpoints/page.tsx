import Link from 'next/link';
import { EndpointsTable } from '@/app/ui/endpoints-table';
import { requireUser } from '@/lib/auth';
import { listWithStats } from '@/lib/endpoints';

export default async function EndpointsPage() {
  const email = await requireUser();
  const rows = await listWithStats(email);
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{rows.length === 1 ? '1 endpoint' : `${rows.length} endpoints`}</div>
          <h1 className="page-title">Endpoints</h1>
          <p className="page-sub">Each endpoint is its own Lambda on the shared Gas layer, reading one database.</p>
        </div>
        <Link className="btn" href="/endpoints/new">
          New endpoint
        </Link>
      </header>
      {rows.length === 0 ? (
        <div className="card empty">
          <p>No endpoints yet.</p>
          <Link className="btn" href="/endpoints/new">
            Create your first endpoint
          </Link>
        </div>
      ) : (
        <EndpointsTable rows={rows} />
      )}
    </>
  );
}
