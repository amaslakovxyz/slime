// What a failed attempt tells the model on repair: codes, paths and types, never
// values, because rows can hold text written by outside users (MS15, S8).
import type { SlimeError } from '../../shared/errors.js';

const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const QUOTED_PLACEHOLDER = '<value>';
const THROWN_NAME = /^Shaping function threw: ([A-Za-z]+):/;
// Built by core's own checks from the model's code, never from data: the model needs them verbatim to repair.
const LINT_CODES = new Set(['INVALID_HANDLER', 'WRITE_REFUSED', 'QUERY_TOO_LARGE', 'QUERY_TOO_EXPENSIVE', 'INVALID_REQUEST']);

export function repairMessage(error: SlimeError): string {
  return `${error.code}: ${valueFreeText(error)}`;
}

function valueFreeText({ code, message }: SlimeError): string {
  // SHAPE_MISMATCH messages are already built without values (validateData isValueFree).
  if (code === 'SHAPE_MISMATCH' || LINT_CODES.has(code)) return message;
  if (code === 'SANDBOX_ERROR') {
    const thrownName = THROWN_NAME.exec(message)?.[1];
    return thrownName ? `the shape function threw a ${thrownName}` : 'the shape function failed';
  }
  // Database and other messages quote the offending value; keep the wording, drop the value.
  return message.replace(QUOTED, QUOTED_PLACEHOLDER);
}
