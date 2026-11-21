'use client';

import { useState, useTransition } from 'react';
import { revealTokenAction } from '@/app/actions';
import { CopyButton } from '@/app/ui/copy-button';

// An intent the offline handler set answers (sandbox/offline/handlers.json).
const QUERY_BODY = '{"intent":"number of accounts on each plan","input":{},"output":[{"plan":"string","accounts":"integer"}]}';

export function TokenReveal({ endpointId, url, tokenHint }: { endpointId: string; url?: string; tokenHint: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  const reveal = () =>
    startTransition(async () => {
      const value = await revealTokenAction(endpointId);
      setFailed(value === null);
      setToken(value);
    });

  // Double quotes so the $SLIME_TOKEN placeholder expands when pasted into a shell.
  const curl = `curl -X POST ${url ?? '<url>'}v0/query \\\n  -H "x-api-key: ${token ?? '$SLIME_TOKEN'}" \\\n  -H 'content-type: application/json' \\\n  -d '${QUERY_BODY}'`;

  return (
    <div className="token">
      <div className="copy-field token-field">
        <code data-testid="token">{token ?? `slm_${'•'.repeat(12)}${tokenHint}`}</code>
        {token ? (
          <CopyButton value={token} />
        ) : (
          <button className="btn btn-sm" type="button" onClick={reveal} disabled={pending}>
            {pending ? 'Revealing…' : 'Reveal'}
          </button>
        )}
      </div>
      {failed && <p className="alert">Token not found in the secret store.</p>}
      <div className="code-wrap">
        <div className="code-head">
          <span>Try it</span>
          <CopyButton value={curl} />
        </div>
        <pre className="code">{curl}</pre>
      </div>
    </div>
  );
}
