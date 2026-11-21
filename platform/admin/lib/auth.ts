// Email/password accounts with stateless HMAC-signed session cookies.
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { env } from './env';

const scrypt = (password: string, salt: Buffer, keylen: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key))),
  );

const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  return timingSafeEqual(await scrypt(password, Buffer.from(salt, 'base64url'), KEY_LENGTH), expected);
}

export interface Session {
  email: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

export const SESSION_COOKIE = 'slime_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const sign = (body: string) => createHmac('sha256', env().sessionSecret).update(body).digest('base64url');

export function signSession(session: Session): string {
  const body = Buffer.from(JSON.stringify({ email: session.email, exp: session.exp })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifySession(token: string): Session | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const given = Buffer.from(signature, 'base64url');
  const expected = Buffer.from(sign(body), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const { email, exp } = (payload ?? {}) as Partial<Session>;
  if (typeof email !== 'string' || typeof exp !== 'number') return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;
  return { email, exp };
}

export async function currentUser(): Promise<string | null> {
  const cookie = (await cookies()).get(SESSION_COOKIE);
  return cookie ? (verifySession(cookie.value)?.email ?? null) : null;
}

export async function requireUser(): Promise<string> {
  const email = await currentUser();
  if (!email) redirect('/login');
  return email;
}

export async function startSession(email: string): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  (await cookies()).set(SESSION_COOKIE, signSession({ email, exp }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
