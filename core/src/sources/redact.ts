const REDACTED = '[redacted]';

/** Replaces every non-empty secret in `text`; longer secrets first, so one containing another is fully removed (MS16). */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const ordered = secrets.filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  return ordered.reduce((redacted, secret) => redacted.split(secret).join(REDACTED), text);
}
