// Each Crystal can have its own token: it opens only that Crystal's route
// (POST /v0/e/<key>), so it can be handed to a frontend or a partner without
// giving them the endpoint's key (which can generate new handlers). Tokens live
// in the endpoint's secrets as one JSON map, CRYSTAL_TOKENS { key: token }; the
// runner (or SSM, in AWS) passes it to the runtime, which reads it at start.
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

/** Issues a token for each key that has none; returns the keys that got one. Existing tokens are kept. */
export async function issueCrystalTokens(endpointId: string, keys: readonly string[]): Promise<string[]> {
  const tokens = await read(endpointId);
  const issued = keys.filter((key) => !tokens[key]);
  if (issued.length === 0) return [];
  for (const key of issued) tokens[key] = 'slc_' + randomBytes(24).toString('base64url');
  await secretStore().put(endpointId, CRYSTAL_TOKENS, JSON.stringify(tokens), { overwrite: true });
  return issued;
}

/** Last four characters per Crystal key, safe to render. */
export async function crystalTokenHints(endpointId: string): Promise<Record<string, string>> {
  const tokens = await read(endpointId);
  return Object.fromEntries(Object.entries(tokens).map(([key, token]) => [key, token.slice(-4)]));
}

export async function crystalToken(endpointId: string, key: string): Promise<string | undefined> {
  return (await read(endpointId))[key];
}
