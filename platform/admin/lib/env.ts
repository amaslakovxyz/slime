// Admin configuration, read on every call so tests and scripts can set
// process.env after import. SLIME_RUNTIME_URL selects the mode: set (the hosted
// admin), the admin drives endpoints through the shared runtime Lambda itself;
// unset, the local runner does (scripts/local-runner.ts).
export interface Env {
  sessionSecret: string;
  controlTable: string;
  handlersTable: string;
  secrets: string;
  secretsFile: string;
  /** Shared runtime base URL, always with a trailing slash; endpoints live under `ep/<id>/`. */
  runtimeUrl?: string;
  /** S3 bucket holding Crystal modules under `endpoints/<id>/` (cloud mode). */
  crystalBucket?: string;
  /** Lower-cased emails that may sign up; undefined means sign-up is open (local mode only: the hosted admin treats it as empty). */
  allowedEmails?: string[];
  /** Value CloudFront sends in `x-slime-origin`; requests without it are refused (proxy.ts). */
  originSecret?: string;
  /** Local mode only: with no session cookie, every request is this user, so testing needs no login. Ignored in cloud mode. */
  devUser?: string;
}

export function env(): Env {
  const sessionSecret = process.env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const runtimeUrl = process.env.SLIME_RUNTIME_URL;
  const allowed = process.env.ADMIN_ALLOWED_EMAILS;
  return {
    sessionSecret,
    controlTable: process.env.SLIME_CONTROL_TABLE || 'slime-control',
    handlersTable: process.env.SLIME_HANDLERS_TABLE || 'slime-handlers',
    secrets: process.env.SLIME_SECRETS || 'file',
    secretsFile: process.env.SLIME_SECRETS_FILE || '.data/secrets.json',
    runtimeUrl: runtimeUrl ? (runtimeUrl.endsWith('/') ? runtimeUrl : `${runtimeUrl}/`) : undefined,
    crystalBucket: process.env.SLIME_CRYSTAL_BUCKET || undefined,
    // Comma-separated, trimmed, lower-cased. Set but empty means nobody is invited, never "open".
    // The hosted admin fails closed: a missing SSM parameter must not open sign-up to the internet.
    allowedEmails:
      allowed === undefined
        ? runtimeUrl
          ? []
          : undefined
        : allowed
            .split(',')
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean),
    originSecret: process.env.SLIME_ORIGIN_SECRET || undefined,
    // Never in cloud mode: the hosted admin's login must not be skippable by an env var.
    devUser: (!runtimeUrl && process.env.ADMIN_DEV_USER?.trim().toLowerCase()) || undefined,
  };
}

/** Cloud mode: the admin provisions, re-checks and tears down endpoints itself (Contract 3). */
export const isCloud = (): boolean => Boolean(env().runtimeUrl);
