'use client';

// One Crystal as its own endpoint: its URL, its own token (opens only this
// route), and a ready call. The token stays masked until revealed.
import { useState, useTransition } from 'react';
import { issueCrystalTokenAction, revealCrystalTokenAction } from '@/app/actions';
import { CopyButton } from '@/app/ui/copy-button';
import type { HandlerRow } from '@/lib/lifecycle';

export function CrystalCard({
  endpointId,
  url,
  crystal,
  tokenHint,
  restarting,
}: {
  endpointId: string;
  url: string;
  crystal: HandlerRow;
  tokenHint?: string;
  restarting: boolean;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const route = `${url}v0/e/${crystal.key}`;
  const body = crystal.exampleBody ?? '{"input":{}}';
  const shownToken = token ?? (tokenHint ? `slc_${'•'.repeat(8)}${tokenHint}` : '$SLIME_TOKEN');
  const curl = `curl -X POST ${route} \\\n  -H "x-api-key: ${token ?? (tokenHint ? '$CRYSTAL_TOKEN' : '$SLIME_TOKEN')}" -H 'content-type: application/json' \\\n  -d '${body}'`;

  const reveal = () =>
    startTransition(async () => {
      const value = await revealCrystalTokenAction(endpointId, crystal.key);
      if (value) setToken(value);
      else setError('Token not found.');
    });
  const issue = () =>
    startTransition(async () => {
      const out = await issueCrystalTokenAction(endpointId, crystal.key);
      if (out.error) setError(out.error);
    });

  return (
    <div className="lc-route" data-testid="crystal-card">
      <span className="tier-pill tier-pill-crystal">crystal</span>
      <div className="lc-route-body">
        <div>{crystal.intent}</div>
        <code className="mono small">
          POST {url}v0/e/{crystal.shortKey}…  {body}
        </code>
        <div className="lc-route-token">
          <span className="muted small">Token</span>
          {tokenHint ? (
            <>
              <code className="mono small" data-testid="crystal-token">{shownToken}</code>
              {token ? (
                <CopyButton value={token} />
              ) : (
                <button className="btn-ghost btn-sm" type="button" onClick={reveal} disabled={pending}>
                  {pending ? 'Revealing…' : 'Reveal'}
                </button>
              )}
            </>
          ) : (
            <>
              <button className="btn-ghost btn-sm" type="button" onClick={issue} disabled={pending || restarting}>
                {pending ? 'Issuing…' : 'Issue token'}
              </button>
            </>
          )}
        </div>
        {error && <p className="alert">{error}</p>}
      </div>
      <div className="lc-route-actions">
        <CopyButton value={route} label="Copy URL" />
        <CopyButton value={curl} label="Copy curl" />
      </div>
    </div>
  );
}
