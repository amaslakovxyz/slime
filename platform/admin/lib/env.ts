// Admin configuration, read on every call so tests and scripts can set
// process.env after import.
export interface Env {
  sessionSecret: string;
  controlTable: string;
  secrets: string;
  secretsFile: string;
}

export function env(): Env {
  const sessionSecret = process.env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return {
    sessionSecret,
    controlTable: process.env.SLIME_CONTROL_TABLE || 'slime-control',
    secrets: process.env.SLIME_SECRETS || 'file',
    secretsFile: process.env.SLIME_SECRETS_FILE || '.data/secrets.json',
  };
}
