// Each Crystal can have its own token: it opens only that Crystal's route
// (POST /v0/e/<key>), so it can be handed to a frontend or a partner without
// giving them the endpoint's key (which can generate new handlers). Tokens live
// in the endpoint's secrets as one JSON map, CRYSTAL_TOKENS { key: token }. The
// local runner passes it to the runtime at start; in the cloud the shared runtime
// re-reads it from SSM within its TTL, and at once after /v0/reload.
import { randomBytes } from 'node:crypto';
import { secretStore } from './secrets';

export const CRYSTAL_TOKENS = 'CRYSTAL_TOKENS';

async function read(endpointId: string): Promise<Record<string, string>> {
  const raw = await secretStore().get(endpointId, CRYSTAL_TOKENS);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

/**
 * Read-change-write of the token map, one at a time per endpoint. Only the admin's server actions
 * write it (Crystallize and Issue token can run together), so a queue in this process is enough.
 */
const issuing = new Map<string, Promise<unknown>>();

/** Issues a token for each key that has none; returns the keys that got one. Existing tokens are kept. */
export function issueCrystalTokens(endpointId: string, keys: readonly string[]): Promise<string[]> {
  const next = (issuing.get(endpointId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const tokens = await read(endpointId);
      const issued = keys.filter((key) => !tokens[key]);
      if (issued.length === 0) return [];
      for (const key of issued) tokens[key] = 'slc_' + randomBytes(24).toString('base64url');
      await secretStore().put(endpointId, CRYSTAL_TOKENS, JSON.stringify(tokens), { overwrite: true });
      return issued;
    });
  issuing.set(endpointId, next);
  return next;
}

/** Last four characters per Crystal key, safe to render. */
export async function crystalTokenHints(endpointId: string): Promise<Record<string, string>> {
  const tokens = await read(endpointId);
  return Object.fromEntries(Object.entries(tokens).map(([key, token]) => [key, token.slice(-4)]));
}

export async function crystalToken(endpointId: string, key: string): Promise<string | undefined> {
  return (await read(endpointId))[key];
}
