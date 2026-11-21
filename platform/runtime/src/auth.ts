// Constant-time check of the `x-api-key` header, shared by the Lambda and local entries.
import { createHash, timingSafeEqual } from 'node:crypto';

export function keyMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  // Hash both sides so timingSafeEqual gets equal lengths.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const CRYSTAL_ROUTE = /^\/v0\/e\/([^/]+)$/;

/** CRYSTAL_TOKENS is a JSON map { "<handler key>": "slc_…" }; anything else counts as none. */
export function parseCrystalTokens(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0));
  } catch {
    return {};
  }
}

/**
 * The endpoint key opens every route. A Crystal's own token opens only that
 * Crystal's route (POST /v0/e/<its key>): not /v0/query, not another Crystal,
 * not the admin views.
 */
export function isAuthorized(
  method: string,
  path: string,
  given: string | undefined,
  endpointKey: string | undefined,
  crystalTokens: Readonly<Record<string, string>>,
): boolean {
  if (keyMatches(given, endpointKey)) return true;
  const route = method === 'POST' ? CRYSTAL_ROUTE.exec(path) : null;
  return route ? keyMatches(given, crystalTokens[decodeURIComponent(route[1] ?? '')]) : false;
}
