import { SlimeError } from '../../shared/errors.js';

const INSUFFICIENT_PRIVILEGE = '42501';
const READ_ONLY_TRANSACTION = '25006';
const QUERY_CANCELED = '57014';
// Class 22 "data exception": 22P02 invalid text for a type, 22007 bad date, 22003 out of range, ...
const DATA_EXCEPTION_CLASS = '22';
const CLIENT_TIMEOUT = /timeout/i;

/** Maps a pg error to the SlimeError a caller sees; a denied table or a write is final, a timeout retryable. */
export function toSlimeError(error: unknown, timeoutMs: number, params: readonly unknown[] = []): SlimeError {
  if (error instanceof SlimeError) return error;
  const { code, message = String(error) } = error as { code?: string; message?: string };
  if (code?.startsWith(DATA_EXCEPTION_CLASS) && quotesBoundValue(message, params)) {
    return new SlimeError('INVALID_REQUEST', `An input value does not fit how this request uses it: ${message}`, { details: { sqlState: code } });
  }
  if (code === INSUFFICIENT_PRIVILEGE) return new SlimeError('ACCESS_DENIED', `The database refused access: ${message}`);
  if (code === READ_ONLY_TRANSACTION) return new SlimeError('WRITE_REFUSED', `The database refused a write: ${message}`);
  if (code === QUERY_CANCELED || CLIENT_TIMEOUT.test(message)) {
    return new SlimeError('EXECUTION_TIMEOUT', `Query exceeded ${timeoutMs} ms.`, { retryable: true });
  }
  return new SlimeError('QUERY_ERROR', message, code ? { details: { sqlState: code } } : {});
}

// Postgres quotes the offending value ('invalid input syntax for type integer: "many"'). When that value
// is one the caller bound, the input does not fit the SQL: a 400 for a saved handler. While generating,
// the engine still repairs once (the model may have cast a text parameter to int), then reports the 400.
// A data exception on a value from a table (a bad cast in the SQL) still falls through to QUERY_ERROR.
function quotesBoundValue(message: string, params: readonly unknown[]): boolean {
  return params.flat().some((value) => (typeof value === 'string' || typeof value === 'number') && message.includes(`"${value}"`));
}
