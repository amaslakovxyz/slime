'use client';

import { useState, useTransition } from 'react';
import { revealTokenAction } from '@/app/actions';

const QUERY_BODY = '{"intent":"list products","input":{},"output":{"items":[{"name":"string"}]}}';

export function TokenReveal({ endpointId, url, tokenHint }: { endpointId: string; url?: string; tokenHint: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const reveal = () =>
    startTransition(async () => {
      const value = await revealTokenAction(endpointId);
      setFailed(value === null);
      setToken(value);
    });

  const copy = async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const curl = `curl -X POST ${url ?? '<url>'}v0/query -H 'x-api-key: ${token ?? '$SLIME_TOKEN'}' -H 'content-type: application/json' -d '${QUERY_BODY}'`;

  return (
    <div className="stack" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row">
        <code className="codeblock" data-testid="token" style={{ flex: '1 1 260px' }}>
          {token ?? `slm_…${tokenHint}`}
        </code>
        {token ? (
          <button className="btn-ghost" type="button" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : (
          <button className="btn" type="button" onClick={reveal} disabled={pending}>
            {pending ? 'Revealing…' : 'Reveal'}
          </button>
        )}
      </div>
      {failed && <p className="alert">Token not found in the secret store.</p>}
      <div>
        <div className="stat-label" style={{ marginBottom: 6 }}>
          Try it
        </div>
        <pre className="codeblock">{curl}</pre>
      </div>
    </div>
  );
}
