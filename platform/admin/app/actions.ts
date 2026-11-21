'use server';

// Every action records one span; redirect() throws, so it always runs outside
// withSpan to keep redirects from being recorded as errors. Span attributes
// carry ids, providers and connector types only.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { endSession, requireUser, startSession } from '@/lib/auth';
import { isConnectorType } from '@/lib/connectors';
import { testConnection, type ConnectionTest } from '@/lib/connectors/postgres';
import {
  connectionUrl,
  createEndpoint,
  isProvider,
  getEndpoint,
  requestDelete,
  requestRestart,
  revealToken,
  updateConnector,
  updateSettings,
} from '@/lib/endpoints';
import { CodedError, hasCode } from '@/lib/errors';
import { crystalToken, issueCrystalTokens } from '@/lib/crystal-tokens';
import { crystallizeOn, type CrystallizeReport } from '@/lib/lifecycle';
import { withSpan } from '@/lib/telemetry';
import { checkLogin, createUser } from '@/lib/users';

const field = (form: FormData, name: string) => String(form.get(name) ?? '');
const withParam = (path: string, key: string, value: string) => `${path}?${key}=${encodeURIComponent(value)}`;
/** Errors a form shows to the user; anything else is a bug and propagates. */
const userFacing = (err: unknown) =>
  err instanceof CodedError && ['INVALID', 'NOT_UPDATABLE', 'NOT_DELETABLE', 'NOT_FOUND'].includes(err.code);

// Layouts survive same-route redirects; the endpoint header (name, status) must re-render.
const refreshEndpoint = () => revalidatePath('/endpoints/[id]', 'layout');

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

export interface FormState {
  error?: string;
}

/** useActionState action: returns a validation error, or redirects to the new endpoint. */
export async function createEndpointAction(_prev: FormState, form: FormData): Promise<FormState> {
  const owner = await requireUser();
  const provider = field(form, 'provider');
  const connectorType = field(form, 'connectorType') || 'postgres';
  let endpointId: string;
  try {
    endpointId = await withSpan(
      'endpoint.create',
      {
        ...(isProvider(provider) ? { 'slime.endpoint.provider': provider } : {}),
        ...(isConnectorType(connectorType) ? { 'slime.connector.type': connectorType } : {}),
      },
      async (span) => {
        const id = await createEndpoint(owner, {
          name: field(form, 'name'),
          provider,
          connectorType,
          databaseUrl: field(form, 'databaseUrl'),
        });
        span.setAttribute('slime.endpoint.id', id);
        return id;
      },
    );
  } catch (err) {
    if (userFacing(err)) return { error: (err as Error).message };
    throw err;
  }
  redirect(`/endpoints/${endpointId}/lifecycle`);
}

/** Tests a URL typed into the create form; the URL already travels to the server for create. */
export async function testConnectionAction(databaseUrl: string): Promise<ConnectionTest> {
  await requireUser();
  return withSpan('connector.test', { 'slime.connector.type': 'postgres' }, async (span) => {
    const result = await testConnection(databaseUrl);
    span.setAttribute('slime.connector.ok', result.ok);
    return result;
  });
}

/** Re-tests the stored URL server-side, so it never reaches the browser. */
export async function testStoredConnectionAction(endpointId: string): Promise<ConnectionTest> {
  const owner = await requireUser();
  return withSpan('connector.test', { 'slime.endpoint.id': endpointId, 'slime.connector.type': 'postgres' }, async (span) => {
    const url = await connectionUrl(owner, endpointId);
    const result: ConnectionTest = url
      ? await testConnection(url)
      : { ok: false, user: null, database: null, serverVersion: null, tables: null, problems: [], error: 'No stored connection URL' };
    span.setAttribute('slime.connector.ok', result.ok);
    return result;
  });
}

export async function updateConnectorAction(form: FormData): Promise<void> {
  const owner = await requireUser();
  const endpointId = field(form, 'endpointId');
  const connectorType = field(form, 'connectorType') || 'postgres';
  const page = `/endpoints/${endpointId}/settings`;
  try {
    await withSpan(
      'endpoint.update_connector',
      { 'slime.endpoint.id': endpointId, ...(isConnectorType(connectorType) ? { 'slime.connector.type': connectorType } : {}) },
      () => updateConnector(owner, endpointId, { connectorType, databaseUrl: field(form, 'databaseUrl') }),
    );
  } catch (err) {
    if (userFacing(err)) redirect(withParam(page, 'error', (err as Error).message));
    throw err;
  }
  refreshEndpoint();
  redirect(`${page}?saved=1`);
}

export async function updateSettingsAction(form: FormData): Promise<void> {
  const owner = await requireUser();
  const endpointId = field(form, 'endpointId');
  const provider = field(form, 'provider');
  const page = `/endpoints/${endpointId}/settings`;
  try {
    await withSpan(
      'endpoint.update_settings',
      { 'slime.endpoint.id': endpointId, ...(isProvider(provider) ? { 'slime.endpoint.provider': provider } : {}) },
      () => updateSettings(owner, endpointId, { name: field(form, 'name'), provider }),
    );
  } catch (err) {
    if (userFacing(err)) redirect(withParam(page, 'error', (err as Error).message));
    throw err;
  }
  refreshEndpoint();
  redirect(`${page}?saved=1`);
}

export async function deleteEndpointAction(form: FormData): Promise<void> {
  const owner = await requireUser();
  const endpointId = field(form, 'endpointId');
  try {
    await withSpan('endpoint.delete', { 'slime.endpoint.id': endpointId }, () => requestDelete(owner, endpointId));
  } catch (err) {
    if (hasCode(err, 'NOT_DELETABLE')) {
      redirect(withParam(`/endpoints/${endpointId}/settings`, 'error', (err as Error).message));
    }
    throw err;
  }
  refreshEndpoint();
  redirect('/endpoints');
}

export async function revealTokenAction(endpointId: string): Promise<string | null> {
  const owner = await requireUser();
  const token = await withSpan('endpoint.reveal_token', { 'slime.endpoint.id': endpointId }, () =>
    revealToken(owner, endpointId),
  );
  return token ?? null;
}

export type CrystallizeResult = { reports: CrystallizeReport[]; restarting: boolean } | { error: string };

/** Lifecycle tab: crystallize the picked handlers, then restart the endpoint so they serve as Crystal. */
export async function crystallizeAction(endpointId: string, keys: string[]): Promise<CrystallizeResult> {
  const email = await requireUser();
  const ep = await getEndpoint(email, endpointId);
  if (!ep) return { error: 'Endpoint not found.' };
  if (keys.length === 0) return { error: 'Pick at least one handler.' };
  try {
    const reports = await withSpan('endpoint.crystallize', { 'slime.endpoint.id': endpointId, 'slime.handlers': keys.length }, () =>
      crystallizeOn(ep, keys),
    );
    const crystallized = reports.filter((r) => r.outcome === 'crystallized').map((r) => r.key);
    const restarting = crystallized.length > 0;
    if (restarting) {
      // Each new Crystal gets its own token; the restart hands the tokens to the runtime.
      await issueCrystalTokens(endpointId, crystallized);
      await requestRestart(email, endpointId);
    }
    refreshEndpoint();
    return { reports, restarting };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** A Crystal made before tokens existed: issue its own token and restart so the runtime accepts it. */
export async function issueCrystalTokenAction(endpointId: string, key: string): Promise<{ error?: string }> {
  const email = await requireUser();
  if (!(await getEndpoint(email, endpointId))) return { error: 'Endpoint not found.' };
  try {
    const issued = await withSpan('endpoint.crystal_token.issue', { 'slime.endpoint.id': endpointId }, () => issueCrystalTokens(endpointId, [key]));
    if (issued.length) await requestRestart(email, endpointId);
    refreshEndpoint();
    return {};
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function revealCrystalTokenAction(endpointId: string, key: string): Promise<string | null> {
  const email = await requireUser();
  if (!(await getEndpoint(email, endpointId))) return null;
  return (await withSpan('endpoint.crystal_token.reveal', { 'slime.endpoint.id': endpointId }, () => crystalToken(endpointId, key))) ?? null;
}
