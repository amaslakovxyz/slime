// Systems an endpoint can read from. Only Postgres is wired through the runtime
// today; the rest render as "coming soon" so the picker shows where it goes.
import { CodedError } from './errors';

export const CONNECTOR_TYPES = ['postgres'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export interface ConnectorInfo {
  type: string;
  label: string;
  blurb: string;
  available: boolean;
}

export const CONNECTORS: ConnectorInfo[] = [
  { type: 'postgres', label: 'PostgreSQL', blurb: 'Postgres 12+', available: true },
  { type: 'mysql', label: 'MySQL', blurb: 'MySQL 8 and MariaDB', available: false },
  { type: 'clickhouse', label: 'ClickHouse', blurb: 'Analytical warehouses', available: false },
  { type: 'rest', label: 'REST / OpenAPI', blurb: 'Any API described by an OpenAPI spec', available: false },
  { type: 'graphql', label: 'GraphQL', blurb: 'Introspected GraphQL schemas', available: false },
];

/** Per available connector: the secret the runtime reads and how the form labels it. */
export const CONNECTOR_SPECS: Record<ConnectorType, { label: string; secret: string; field: string; placeholder: string }> = {
  postgres: {
    label: 'PostgreSQL',
    secret: 'DATABASE_URL',
    field: 'Connection URL',
    placeholder: 'postgres://reader:password@db.example.com:5432/app',
  },
};

export const isConnectorType = (value: string): value is ConnectorType =>
  (CONNECTOR_TYPES as readonly string[]).includes(value);

/** Trimmed URL, or a CodedError('INVALID') the forms show as is. */
export function validateConnectionUrl(type: string, url: string): string {
  if (!isConnectorType(type)) throw new CodedError('INVALID', `Connector "${type}" is not available yet`);
  const trimmed = url.trim();
  if (!trimmed.startsWith('postgres://') && !trimmed.startsWith('postgresql://')) {
    throw new CodedError('INVALID', 'Postgres URL must start with postgres:// or postgresql://');
  }
  return trimmed;
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
