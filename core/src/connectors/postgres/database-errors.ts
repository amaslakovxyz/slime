import { SlimeError } from '../../shared/errors.js';

const INSUFFICIENT_PRIVILEGE = '42501';
const READ_ONLY_TRANSACTION = '25006';
const QUERY_CANCELED = '57014';
const CLIENT_TIMEOUT = /timeout/i;

/** Maps a pg error to the SlimeError a caller sees; a denied table or a write is final, a timeout retryable. */
export function toSlimeError(error: unknown, timeoutMs: number): SlimeError {
  if (error instanceof SlimeError) return error;
  const { code, message = String(error) } = error as { code?: string; message?: string };
  if (code === INSUFFICIENT_PRIVILEGE) return new SlimeError('ACCESS_DENIED', `The database refused access: ${message}`);
  if (code === READ_ONLY_TRANSACTION) return new SlimeError('WRITE_REFUSED', `The database refused a write: ${message}`);
  if (code === QUERY_CANCELED || CLIENT_TIMEOUT.test(message)) {
    return new SlimeError('EXECUTION_TIMEOUT', `Query exceeded ${timeoutMs} ms.`, { retryable: true });
  }
  return new SlimeError('QUERY_ERROR', message, code ? { details: { sqlState: code } } : {});
}
