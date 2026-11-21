'use client';

// One Crystal as its own endpoint: its URL, its own token (opens only this
// route), and a ready call. The token stays masked until revealed.
import { useState, useTransition } from 'react';
import { issueCrystalTokenAction, revealCrystalTokenAction } from '@/app/actions';
import { CopyButton } from '@/app/ui/copy-button';
import type { HandlerRow } from '@/lib/lifecycle';

/** Cloud: other warm instances re-read Crystals and tokens within their 30 s TTL. */
export const CLOUD_CRYSTAL_NOTE = 'Crystal endpoint active on all instances within 30 s';

export function CrystalCard({
  endpointId,
  url,
  crystal,
  tokenHint,
  restarting,
  cloud,
}: {
  endpointId: string;
  url: string;
  crystal: HandlerRow;
  tokenHint?: string;
  restarting: boolean;
  cloud: boolean;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState(false);
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
      else setIssued(true);
    });

  return (
    <div className="lc-route" data-testid="crystal-card" data-key={crystal.key}>
      <div className="lc-route-body">
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
        {cloud && issued && <p className="muted small" role="status">{CLOUD_CRYSTAL_NOTE}</p>}
      </div>
      <div className="lc-route-actions">
        <CopyButton value={route} label="Copy URL" />
        <CopyButton value={curl} label="Copy curl" />
      </div>
    </div>
  );
}
