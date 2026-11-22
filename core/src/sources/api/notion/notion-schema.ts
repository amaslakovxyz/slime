// A Notion data source becomes one operation, `<alias>.query`, built from its
// schema at startup with no person involved (MS12, design §4.2).
import type { ColumnInfo } from '../../types.js';
import type { LeafType } from '../../../request/shape.js';
import type { OperationInfo, ParamInfo } from '../types.js';
import { columnName } from './column-names.js';
import type { NotionDataSource, NotionPropertySchema } from './notion-types.js';
import { sanitizeMetadata } from './sanitize.js';

/** How one Notion property is read and filtered. */
export interface PropertyMapping {
  propertyName: string;
  propertyType: string;
  column: string;
  /** Param names that filter on this property: one for equality, two for a date range. */
  equalsParam?: string;
  fromParam?: string;
  toParam?: string;
}

export interface NotionOperation {
  dataSourceId: string;
  info: OperationInfo;
  properties: PropertyMapping[];
}

export interface SchemaOptions {
  exclude?: readonly string[];
  comments?: Readonly<Record<string, string>>;
  useNotionDescriptions?: boolean;
}

const COLUMN_TYPES: Readonly<Record<string, LeafType>> = {
  title: 'string',
  rich_text: 'string',
  number: 'number',
  select: 'string',
  status: 'string',
  multi_select: 'string',
  date: 'date',
  checkbox: 'boolean',
  url: 'string',
  email: 'string',
  phone_number: 'string',
  unique_id: 'string',
  created_time: 'datetime',
  last_edited_time: 'datetime',
};
const EQUALITY_FILTERED = new Set(['select', 'status', 'checkbox']);
const RANGE_FILTERED = new Set(['date', 'created_time', 'last_edited_time']);
const ID_COLUMN: ColumnInfo = { name: 'id', type: 'string', nullable: false, comment: 'Notion page id' };
const MULTI_SELECT_COMMENT = 'option names joined with ", "';
const DATE_COMMENT = 'start date only';
const QUERY_SUFFIX = '.query';
const ROW_ORDER = 'created desc';

export function operationFromDataSource(alias: string, dataSource: NotionDataSource, options: SchemaOptions = {}): NotionOperation {
  const taken = new Set(['id']);
  const excluded = new Set(options.exclude ?? []);
  const properties: PropertyMapping[] = [];
  const columns: ColumnInfo[] = [ID_COLUMN];
  const params: ParamInfo[] = [];
  Object.values(dataSource.properties).forEach((property, position) => {
    const type = COLUMN_TYPES[property.type];
    if (!type || excluded.has(property.name)) return;
    const mapping: PropertyMapping = { propertyName: property.name, propertyType: property.type, column: columnName(sanitizeMetadata(property.name), taken, position) };
    columns.push(columnInfo(mapping.column, type, property, comment(mapping.column, property, options)));
    params.push(...filterParams(mapping, property, taken));
    properties.push(mapping);
  });
  const title = sanitizeMetadata((dataSource.title ?? []).map((part) => part.plain_text).join(''));
  const info: OperationInfo = { name: `${alias}${QUERY_SUFFIX}`, description: `${title || alias}, newest first`, params, columns, primaryKey: ['id'], order: ROW_ORDER };
  return { dataSourceId: dataSource.id, info, properties };
}

function columnInfo(name: string, type: LeafType, property: NotionPropertySchema, commentText: string | undefined): ColumnInfo {
  const values = optionNames(property);
  return { name, type, nullable: true, ...(values ? { values } : {}), ...(commentText ? { comment: commentText } : {}) };
}

function comment(column: string, property: NotionPropertySchema, { comments = {}, useNotionDescriptions = false }: SchemaOptions): string | undefined {
  const fromConfig = comments[column];
  if (fromConfig) return fromConfig;
  if (property.type === 'multi_select') return MULTI_SELECT_COMMENT;
  if (property.type === 'date') return DATE_COMMENT;
  if (useNotionDescriptions && property.description) return sanitizeMetadata(property.description) || undefined;
  return undefined;
}

function filterParams(mapping: PropertyMapping, property: NotionPropertySchema, taken: Set<string>): ParamInfo[] {
  if (EQUALITY_FILTERED.has(property.type)) {
    // The param shares the column's name, which is already unique.
    mapping.equalsParam = mapping.column;
    const values = optionNames(property);
    return [{ name: mapping.column, type: property.type === 'checkbox' ? 'boolean' : 'string', ...(values ? { values } : {}) }];
  }
  if (!RANGE_FILTERED.has(property.type)) return [];
  mapping.fromParam = uniqueParam(`${mapping.column}From`, taken);
  mapping.toParam = uniqueParam(`${mapping.column}To`, taken);
  return [
    { name: mapping.fromParam, type: 'date', comment: `on or after this date` },
    { name: mapping.toParam, type: 'date', comment: `on or before this date` },
  ];
}

function uniqueParam(name: string, taken: Set<string>): string {
  let unique = name;
  for (let suffix = 2; taken.has(unique); suffix++) unique = `${name}${suffix}`;
  taken.add(unique);
  return unique;
}

function optionNames(property: NotionPropertySchema): string[] | undefined {
  const options = property.select?.options ?? property.status?.options;
  return options ? options.map((option) => sanitizeMetadata(option.name)) : undefined;
}
