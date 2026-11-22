// Column and comment lines shared by the database and API sections (D2).
import type { ColumnInfo } from '../sources/types.js';

export const INDENT = '  ';

export interface ColumnKeys {
  isPrimaryKey: boolean;
  references: string | undefined;
}

export function renderColumn(column: ColumnInfo, { isPrimaryKey, references }: ColumnKeys): string {
  const parts = [column.name, column.type, column.nullable ? 'null' : 'not null'];
  if (isPrimaryKey) parts.push('primary key');
  if (references) parts.push(`references ${references}`);
  if (column.values?.length) parts.push(`one of: ${column.values.join(', ')}`);
  return withComment(parts.join(' '), column.comment);
}

export function withComment(text: string, comment: string | undefined): string {
  return comment ? `${text} -- ${comment}` : text;
}
