'use server';

// Every action records one span; redirect() throws, so it always runs outside
// withSpan to keep redirects from being recorded as errors.
import { redirect } from 'next/navigation';
import { endSession, requireUser, startSession } from '@/lib/auth';
import { createEndpoint, isProvider, requestDelete, revealToken } from '@/lib/endpoints';
import { CodedError, hasCode } from '@/lib/errors';
import { withSpan } from '@/lib/telemetry';
import { checkLogin, createUser } from '@/lib/users';

const field = (form: FormData, name: string) => String(form.get(name) ?? '');

const SIGNUP_ERRORS: Record<string, string> = { EMAIL_TAKEN: 'taken', WEAK_PASSWORD: 'weak', INVALID_EMAIL: 'email' };

export async function signup(form: FormData): Promise<void> {
  let email: string;
  try {
    email = await withSpan('auth.signup', {}, () => createUser(field(form, 'email'), field(form, 'password')));
  } catch (err) {
    if (err instanceof CodedError && SIGNUP_ERRORS[err.code]) redirect(`/login?error=${SIGNUP_ERRORS[err.code]}`);
    throw err;
  }
  await startSession(email);
  redirect('/');
}

export async function login(form: FormData): Promise<void> {
  const email = field(form, 'email').trim().toLowerCase();
  const ok = await withSpan('auth.login', {}, () => checkLogin(email, field(form, 'password')));
  if (!ok) redirect('/login?error=invalid');
  await startSession(email);
  redirect('/');
}

export async function logout(): Promise<void> {
  await endSession();
  redirect('/login');
}

export async function createEndpointAction(form: FormData): Promise<void> {
  const owner = await requireUser();
  const provider = field(form, 'provider');
  let endpointId: string;
  try {
    endpointId = await withSpan(
      'endpoint.create',
      isProvider(provider) ? { 'slime.endpoint.provider': provider } : {},
      async (span) => {
        const id = await createEndpoint(owner, {
          name: field(form, 'name'),
          provider,
          databaseUrl: field(form, 'databaseUrl'),
        });
        span.setAttribute('slime.endpoint.id', id);
        return id;
      },
    );
  } catch (err) {
    if (hasCode(err, 'INVALID')) redirect(`/?error=${encodeURIComponent((err as Error).message)}`);
    throw err;
  }
  redirect(`/endpoints/${endpointId}`);
}

export async function deleteEndpointAction(form: FormData): Promise<void> {
  const owner = await requireUser();
  const endpointId = field(form, 'endpointId');
  try {
    await withSpan('endpoint.delete', { 'slime.endpoint.id': endpointId }, () => requestDelete(owner, endpointId));
  } catch (err) {
    if (hasCode(err, 'NOT_DELETABLE')) {
      redirect(`/endpoints/${endpointId}?error=${encodeURIComponent((err as Error).message)}`);
    }
    throw err;
  }
  redirect('/');
}

export async function revealTokenAction(endpointId: string): Promise<string | null> {
  const owner = await requireUser();
  const token = await withSpan('endpoint.reveal_token', { 'slime.endpoint.id': endpointId }, () =>
    revealToken(owner, endpointId),
  );
  return token ?? null;
}
