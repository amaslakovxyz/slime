// Systems an endpoint can read from. Postgres and Supabase (Postgres behind its
// pooler) are wired through the runtime, which reads both as DATABASE_URL; the
// rest render as "coming soon" so the picker shows where it goes.
import { CodedError } from './errors';

export const CONNECTOR_TYPES = ['postgres', 'supabase'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export interface ConnectorInfo {
  type: string;
  label: string;
  blurb: string;
  available: boolean;
}

export const CONNECTORS: ConnectorInfo[] = [
  { type: 'postgres', label: 'PostgreSQL', blurb: 'Postgres 12+', available: true },
  { type: 'supabase', label: 'Supabase', blurb: 'Supabase Postgres through its pooler', available: true },
  { type: 'mysql', label: 'MySQL', blurb: 'MySQL 8 and MariaDB', available: false },
  { type: 'clickhouse', label: 'ClickHouse', blurb: 'Analytical warehouses', available: false },
  { type: 'rest', label: 'REST / OpenAPI', blurb: 'Any API described by an OpenAPI spec', available: false },
  { type: 'graphql', label: 'GraphQL', blurb: 'Introspected GraphQL schemas', available: false },
];

/** Per available connector: the secret the runtime reads and how the form labels it. */
export const CONNECTOR_SPECS: Record<
  ConnectorType,
  { label: string; secret: string; field: string; placeholder: string; hint: string }
> = {
  postgres: {
    label: 'PostgreSQL',
    secret: 'DATABASE_URL',
    field: 'Connection URL',
    placeholder: 'postgres://reader:password@db.example.com:5432/app',
    hint: 'Read-only role.',
  },
  supabase: {
    label: 'Supabase',
    secret: 'DATABASE_URL',
    field: 'Pooler connection URL',
    placeholder: 'postgresql://slime_reader.<project-ref>:password@aws-1-eu-west-1.pooler.supabase.com:6543/postgres',
    hint: 'Session (5432) or transaction (6543) pooler URL with the read-only role. TLS is added when missing.',
  },
};

export const isConnectorType = (value: string): value is ConnectorType =>
  (CONNECTOR_TYPES as readonly string[]).includes(value);

/** The URL to store (trimmed; Supabase also normalized), or a CodedError('INVALID') the forms show as is. */
export function validateConnectionUrl(type: string, url: string): string {
  if (!isConnectorType(type)) throw new CodedError('INVALID', `Connector "${type}" is not available yet`);
  const trimmed = url.trim();
  if (!trimmed.startsWith('postgres://') && !trimmed.startsWith('postgresql://')) {
    throw new CodedError('INVALID', 'Postgres URL must start with postgres:// or postgresql://');
  }
  return type === 'supabase' ? supabaseUrl(trimmed) : trimmed;
}

const SUPABASE_DIRECT_HOST = /^db\.[a-z0-9]+\.supabase\.co$/;
const SUPABASE_POOLER_HOST = /\.pooler\.supabase\.com$/;

/**
 * Supabase rules, all measured against a live project (2026-11-24):
 * - the direct host db.<ref>.supabase.co has only an AAAA record, and the runtime
 *   Lambda (no VPC) reaches the internet over IPv4 only, so only the pooler works;
 * - TLS is required: without sslmode (or with disable/allow) node `pg` logs in to the
 *   pooler in plaintext. `sslmode=require` alone means verify-full in pg 8, which fails
 *   on Supabase's own CA (SELF_SIGNED_CERT_IN_CHAIN), so require/prefer/none become
 *   libpq's require via `uselibpqcompat=true` (encrypted, certificate not verified), as
 *   the test RDS URLs use. verify-ca/verify-full are refused: the CA would have to be a
 *   file on the admin and the runtime Lambda, and sslrootcert/sslcert/sslkey are refused
 *   because pg reads them as local file paths on whichever server opens the connection.
 */
function supabaseUrl(url: string): string {
  let parsed: URL;
  let user: string;
  try {
    parsed = new URL(url);
    user = decodeURIComponent(parsed.username);
  } catch {
    throw new CodedError('INVALID', 'Supabase URL could not be parsed');
  }
  const host = parsed.hostname.toLowerCase();
  if (SUPABASE_DIRECT_HOST.test(host)) {
    throw new CodedError(
      'INVALID',
      'db.<ref>.supabase.co is IPv6-only and Slime connects over IPv4: copy the Session or Transaction pooler URL from Connect in the Supabase dashboard',
    );
  }
  if (!SUPABASE_POOLER_HOST.test(host)) {
    throw new CodedError(
      'INVALID',
      'Supabase URL must use the pooler host (….pooler.supabase.com); use the PostgreSQL connector for any other host',
    );
  }
  const port = parsed.port || '5432';
  if (port !== '5432' && port !== '6543') {
    throw new CodedError('INVALID', 'Supabase pooler port is 5432 (session) or 6543 (transaction)');
  }
  // Supavisor routes on the project ref after the dot: slime_reader.<ref>.
  if (!/^[^.]+\.[a-z0-9]+$/.test(user)) {
    throw new CodedError('INVALID', 'Supabase pooler user must be <role>.<project-ref>, e.g. slime_reader.abcdefghijklmnopqrst');
  }
  for (const param of ['sslrootcert', 'sslcert', 'sslkey']) {
    if (parsed.searchParams.has(param)) {
      throw new CodedError('INVALID', `${param} is a file path on Slime's servers and is not accepted; remove it`);
    }
  }
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode === 'disable' || sslmode === 'allow') {
    throw new CodedError('INVALID', `sslmode=${sslmode} sends the password and data in plaintext; remove it and TLS is added`);
  }
  if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
    throw new CodedError('INVALID', `Slime cannot verify Supabase's CA yet; remove sslmode=${sslmode} to use encrypted require`);
  }
  parsed.searchParams.set('sslmode', 'require');
  parsed.searchParams.set('uselibpqcompat', 'true');
  return parsed.href;
}

export const SUPABASE_READER_ROLE = 'slime_reader';

/**
 * SQL the form shows for Supabase's SQL Editor (run as `postgres`): a login role that
 * passes the safety check (no superuser, CREATEROLE, CREATEDB or write grants).
 * BYPASSRLS is on because Supabase's `ensure_rls` event trigger enables RLS on every
 * new public table, and policies target anon/authenticated: without it the role reads
 * 0 rows everywhere (measured 2026-11-24). Grants still decide what Slime can see.
 * `password` must be URL-safe (the form uses hex) so it drops into the pooler URL as is.
 */
export function supabaseReaderSql(password: string): string {
  const role = SUPABASE_READER_ROLE;
  return [
    `-- Supabase: SQL Editor → New query → Run. A read-only login role for Slime.`,
    `create role ${role} login password '${password}';`,
    `grant usage on schema public to ${role};`,
    `grant select on all tables in schema public to ${role};`,
    `-- Tables you create in public later are readable too.`,
    `alter default privileges in schema public grant select on tables to ${role};`,
    `alter role ${role} set default_transaction_read_only = on;`,
    `-- Supabase turns on row level security (RLS) for every new table, with policies for app users only;`,
    `-- like service_role, this role reads past RLS. The grants above still decide which tables and columns it sees.`,
    `alter role ${role} bypassrls;`,
  ].join('\n');
}

export interface MaskedUrl {
  scheme: string;
  user: string;
  host: string;
  port: string;
  database: string;
  /** Whole URL with the password replaced by ****. */
  display: string;
}

/** Everything but the password, for showing a stored URL in the browser. */
export function maskConnectionUrl(url: string): MaskedUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, '');
  const user = decodeURIComponent(parsed.username);
  const port = parsed.port || '5432';
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const sslmode = parsed.searchParams.get('sslmode');
  const auth = user ? `${user}${parsed.password ? ':****' : ''}@` : '';
  return {
    scheme,
    user,
    host: parsed.hostname,
    port,
    database,
    display: `${scheme}://${auth}${parsed.hostname}:${port}/${database}${sslmode ? `?sslmode=${sslmode}` : ''}`,
  };
}
