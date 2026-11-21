// The hosted admin's Function URL is public (auth NONE: CloudFront OAC would break
// every POST server action). CloudFront adds `x-slime-origin: <SLIME_ORIGIN_SECRET>`
// to each request it forwards, so a request without it did not come through
// CloudFront and is refused. Unset (local), every request passes.
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from './lib/env';

/** Compares digests, so neither the length nor the content of the secret leaks through timing. */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export function proxy(request: NextRequest): NextResponse {
  const { originSecret } = env();
  if (originSecret && !sameSecret(request.headers.get('x-slime-origin') ?? '', originSecret)) {
    return new NextResponse('Forbidden', { status: 403 });
  }
  return NextResponse.next();
}

// Every path, static assets included: the Function URL serves them too.
export const config = { matcher: '/:path*' };
