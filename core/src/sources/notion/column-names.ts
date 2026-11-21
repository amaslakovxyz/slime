// Notion property names become identifiers the model and shape() can use, with
// no person needed at startup (MS12, design §4.2).
const DIACRITICS = /[̀-ͯ]/g;
const NON_ALPHANUMERIC = /[^A-Za-z0-9]+/;
const STARTS_WITH_DIGIT = /^[0-9]/;
const RESERVED = new Set(['id']);
const EMPTY_NAME_PREFIX = 'property';
const DIGIT_PREFIX = 'p';

/** "Created date" → "createdDate"; collisions with `taken` get a numeric suffix, in call order. */
export function columnName(propertyName: string, taken: Set<string>, position: number): string {
  const words = propertyName.normalize('NFKD').replace(DIACRITICS, '').split(NON_ALPHANUMERIC).filter(Boolean);
  let name = words.map((word, index) => (index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase())).join('');
  if (!name) name = `${EMPTY_NAME_PREFIX}${position}`;
  if (STARTS_WITH_DIGIT.test(name)) name = `${DIGIT_PREFIX}${name}`;
  let unique = RESERVED.has(name) ? `${name}2` : name;
  for (let suffix = 2; taken.has(unique); suffix++) unique = `${name}${suffix}`;
  taken.add(unique);
  return unique;
}
