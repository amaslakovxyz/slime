// A Notion page → one flat row of the operation's columns. Empty cells are null.
import type { PropertyMapping } from './notion-schema.js';
import type { NotionPage, NotionPropertyValue, NotionRichText } from './notion-types.js';

const MULTI_SELECT_SEPARATOR = ', ';
const DATE_LENGTH = 'YYYY-MM-DD'.length;

export function rowFromPage(properties: readonly PropertyMapping[], page: NotionPage): Record<string, unknown> {
  const row: Record<string, unknown> = { id: page.id };
  for (const property of properties) row[property.column] = cellValue(page.properties[property.propertyName]);
  return row;
}

function cellValue(value: NotionPropertyValue | undefined): unknown {
  if (!value) return null;
  switch (value.type) {
    case 'title':
      return plainText(value.title);
    case 'rich_text':
      return plainText(value.rich_text);
    case 'number':
      return value.number ?? null;
    case 'select':
      return value.select?.name ?? null;
    case 'status':
      return value.status?.name ?? null;
    case 'multi_select':
      return value.multi_select && value.multi_select.length > 0 ? value.multi_select.map((option) => option.name).join(MULTI_SELECT_SEPARATOR) : null;
    case 'date':
      return value.date?.start ? value.date.start.slice(0, DATE_LENGTH) : null;
    case 'checkbox':
      return value.checkbox ?? null;
    case 'unique_id':
      return value.unique_id?.number == null ? null : `${value.unique_id.prefix ? `${value.unique_id.prefix}-` : ''}${value.unique_id.number}`;
    case 'created_time':
      return value.created_time ?? null;
    case 'last_edited_time':
      return value.last_edited_time ?? null;
    default:
      return (value[value.type as 'url' | 'email' | 'phone_number'] as string | null | undefined) ?? null;
  }
}

function plainText(parts: NotionRichText[] | undefined): string | null {
  const text = (parts ?? []).map((part) => part.plain_text).join('');
  return text.length > 0 ? text : null;
}
