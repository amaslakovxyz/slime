'use client';

import { useState, useTransition } from 'react';
import { testConnectionAction, testStoredConnectionAction } from '@/app/actions';
import type { ConnectionTest } from '@/lib/connectors/postgres';

/**
 * Either tests `url` (create form) or the endpoint's stored URL, which stays
 * on the server. Clears its result when the URL changes.
 */
export function TestConnection({ url, endpointId }: { url?: string; endpointId?: string }) {
  const [result, setResult] = useState<{ for: string; value: ConnectionTest } | null>(null);
  const [pending, startTransition] = useTransition();
  const key = endpointId ?? url ?? '';
  const shown = result && result.for === key ? result.value : null;

  const run = () =>
    startTransition(async () => {
      const value = endpointId ? await testStoredConnectionAction(endpointId) : await testConnectionAction(url ?? '');
      setResult({ for: key, value });
    });

  return (
    <div className="test-connection">
      <div className="test-connection-row">
        <button className="btn-ghost" type="button" onClick={run} disabled={pending || (!endpointId && !url)}>
          {pending ? 'Testing…' : 'Test connection'}
        </button>
        <span className="field-hint">Runs from the admin server&apos;s network, 5 s timeout.</span>
      </div>
      {shown && <ConnectionResult result={shown} />}
    </div>
  );
}

function ConnectionResult({ result }: { result: ConnectionTest }) {
  if (result.error) {
    return (
      <div className="result result-fail" role="status">
        <strong>Could not connect</strong>
        <span className="mono">{result.error}</span>
      </div>
    );
  }
  return (
    <div className={`result ${result.ok ? 'result-ok' : 'result-warn'}`} role="status">
      <strong>{result.ok ? 'Connected · read-only role' : 'Connected, but the role is unsafe'}</strong>
      <dl className="result-facts">
        <div>
          <dt>user</dt>
          <dd className="mono">{result.user}</dd>
        </div>
        <div>
          <dt>database</dt>
          <dd className="mono">{result.database}</dd>
        </div>
        <div>
          <dt>server</dt>
          <dd className="mono">{result.serverVersion?.split(' ')[0]}</dd>
        </div>
        <div>
          <dt>tables</dt>
          <dd className="mono">{result.tables}</dd>
        </div>
      </dl>
      {result.problems.length > 0 && (
        <ul className="result-problems">
          {result.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
