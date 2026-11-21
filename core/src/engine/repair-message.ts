// What a failed attempt tells the model on repair. v1 keeps today's text; v2
// sends codes, paths and types, never values, because API rows can hold text
// written by outside users (MS15, S8).
import type { ArtifactFormat } from '../models/types.js';
import type { SlimeError } from '../shared/errors.js';

const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const QUOTED_PLACEHOLDER = '<value>';
const THROWN_NAME = /^Shaping function threw: ([A-Za-z]+):/;

export function repairMessage(error: SlimeError, format: ArtifactFormat): string {
  if (format === 'v1') return `${error.code}: ${error.message}`;
  return `${error.code}: ${valueFreeText(error)}`;
}

function valueFreeText({ code, message }: SlimeError): string {
  // v2 SHAPE_MISMATCH messages are already built without values (validateData isValueFree).
  if (code === 'SHAPE_MISMATCH') return message;
  if (code === 'SANDBOX_ERROR') {
    const thrownName = THROWN_NAME.exec(message)?.[1];
    return thrownName ? `the shape function threw a ${thrownName}` : 'the shape function failed';
  }
  // Database and other messages quote the offending value; keep the wording, drop the value.
  return message.replace(QUOTED, QUOTED_PLACEHOLDER);
}
