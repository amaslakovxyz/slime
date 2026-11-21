import Link from 'next/link';
import { PROVIDERS } from '@/lib/endpoints';
import { NewEndpointForm } from './form';

export default function NewEndpointPage() {
  return (
    <>
      <header className="page-head">
        <div>
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link href="/endpoints">Endpoints</Link>
            <span aria-hidden="true">/</span>
            <span>New</span>
          </nav>
          <h1 className="page-title">New endpoint</h1>
        </div>
      </header>
      <NewEndpointForm providers={[...PROVIDERS]} />
    </>
  );
}
