// Notion metadata (property names, option labels, descriptions, titles) is
// written by Notion users and goes into the model's dictionary, so it is made
// single-line, stripped of control characters and capped (MS12, S8).
const MAX_METADATA_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const WHITESPACE_RUN = /\s+/g;

export function sanitizeMetadata(text: string): string {
  const singleLine = text.replace(CONTROL_CHARACTERS, ' ').replace(WHITESPACE_RUN, ' ').trim();
  return singleLine.length <= MAX_METADATA_LENGTH ? singleLine : singleLine.slice(0, MAX_METADATA_LENGTH);
}
