'use client';

// Card 1: what to paste into the coding agent. The token stays masked until the
// operator reveals it (same server action as the Overview tab).
import { useState, useTransition } from 'react';
import { revealTokenAction } from '@/app/actions';
import { CopyButton } from '@/app/ui/copy-button';

type Kind = 'prompt' | 'http';

const EXAMPLE_BODY = '{"intent":"number of accounts on each plan","input":{},"output":[{"plan":"string","accounts":"integer"}]}';

function snippet(kind: Kind, url: string, token: string): string {
  if (kind === 'http') {
    return `curl -X POST ${url}v0/query \\\n  -H "x-api-key: ${token}" \\\n  -H 'content-type: application/json' \\\n  -d '${EXAMPLE_BODY}'`;
  }
  return [
    'Use Slime for all the data this app needs. Do not write backend routes.',
    `POST ${url}v0/query with header x-api-key: ${token}`,
    'Body: { "intent": "<what you need, in words>", "input": { <values> }, "output": <the JSON shape you want back> }',
    'Put values in input, never in the intent text. Reuse the exact same intent text for the same need, so it is served from cache.',
    `Example body: ${EXAMPLE_BODY}`,
  ].join('\n');
}

export function AgentSnippet({ endpointId, url, tokenHint }: { endpointId: string; url: string; tokenHint: string }) {
  const [kind, setKind] = useState<Kind>('prompt');
  const [token, setToken] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const shown = snippet(kind, url, token ?? `slm_${'•'.repeat(8)}${tokenHint}`);

  const reveal = () =>
    startTransition(async () => {
      setToken(await revealTokenAction(endpointId));
    });

  return (
    <>
      <div className="lc-seg" role="tablist" aria-label="Snippet">
        {(['prompt', 'http'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {k === 'prompt' ? 'Prompt for your agent' : 'HTTP'}
          </button>
        ))}
      </div>
      <div className="lc-copy">
        <pre data-testid="agent-snippet">{shown}</pre>
        {token ? (
          <CopyButton value={shown} />
        ) : (
          <button className="btn btn-sm" type="button" onClick={reveal} disabled={pending}>
            {pending ? 'Revealing…' : 'Reveal token'}
          </button>
        )}
      </div>
    </>
  );
}
