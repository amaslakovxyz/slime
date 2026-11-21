// Constant-time check of the `x-api-key` header, shared by the Lambda and local entries.
import { createHash, timingSafeEqual } from 'node:crypto';

export function keyMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  // Hash both sides so timingSafeEqual gets equal lengths.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
