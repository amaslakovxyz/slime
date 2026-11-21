// The declaration an app writes to wrap a REST API, and its checks (MS2).
import type { ColumnInfo } from '../../connectors/types.js';
import { isLeafType } from '../../request/shape.js';
import type { OperationInfo, ParamInfo } from '../types.js';
import type { HttpClient } from './http-client.js';
import type { FetchFunction } from './retry.js';

export interface ApiParamDeclaration {
  type: string;
  comment?: string;
  values?: string[];
}

/** A leaf type such as "integer" or "string|null", or the same with a comment and allowed values. */
export type ApiColumnDeclaration = string | { type: string; comment?: string; values?: string[] };

export interface ApiRunContext {
  http: HttpClient;
  signal: AbortSignal;
}

export type ApiRow = Record<string, unknown>;

export interface ApiOperationDeclaration {
  description?: string;
  params?: Record<string, ApiParamDeclaration>;
  columns: Record<string, ApiColumnDeclaration>;
  primaryKey?: string[];
  order?: string;
  /** Receives only declared params; null means "not given" (R5). Returns flat rows of the declared columns. */
  run(args: Readonly<Record<string, unknown>>, context: ApiRunContext): Promise<ApiRow[]>;
}

export interface ApiSourceDeclaration {
  /** Shown to the model, for example "Studio Ghibli API (public, read-only)". */
  service: string;
  baseUrl: string;
  /** Adapter name in errors; defaults to the base URL's host. */
  name?: string;
  headers?: Record<string, string>;
  secrets?: string[];
  operations: Record<string, ApiOperationDeclaration>;
  /** A cheap read that proves the API is reachable and the credentials work. */
  check?(context: ApiRunContext): Promise<void>;
  fetchImpl?: FetchFunction;
}

const NULLABLE_SUFFIX = '|null';
const OPERATION_NAME = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function declarationProblems({ service, baseUrl, operations }: ApiSourceDeclaration): string[] {
  const problems: string[] = [];
  if (!service.trim()) problems.push('service must be a non-empty description');
  if (!URL.canParse(baseUrl) || !/^https?:$/.test(new URL(baseUrl).protocol)) problems.push(`baseUrl must be an http(s) URL, got "${baseUrl}"`);
  if (Object.keys(operations).length === 0) problems.push('operations must declare at least one operation');
  for (const [name, operation] of Object.entries(operations)) problems.push(...operationProblems(name, operation));
  return problems;
}

function operationProblems(name: string, { params = {}, columns, primaryKey = [], run }: ApiOperationDeclaration): string[] {
  const where = `operations.${name}`;
  const problems = OPERATION_NAME.test(name) ? [] : [`${where}: an operation name is dotted lowercase words, for example "films.list"`];
  if (typeof run !== 'function') problems.push(`${where}.run must be a function`);
  for (const [param, { type }] of Object.entries(params)) {
    if (!FIELD_NAME.test(param)) problems.push(`${where}.params.${param}: not an identifier`);
    if (!isLeafType(type)) problems.push(`${where}.params.${param}: "${type}" is not a type (string, number, integer, boolean, date, datetime)`);
  }
  if (Object.keys(columns).length === 0) problems.push(`${where}.columns must declare at least one column`);
  for (const [column, declared] of Object.entries(columns)) {
    if (!FIELD_NAME.test(column)) problems.push(`${where}.columns.${column}: not an identifier`);
    if (!isLeafType(baseType(typeOf(declared)))) problems.push(`${where}.columns.${column}: "${typeOf(declared)}" is not a type`);
  }
  for (const key of primaryKey) if (!(key in columns)) problems.push(`${where}.primaryKey: "${key}" is not a column`);
  return problems;
}

export function operationInfo(name: string, { description, params = {}, columns, primaryKey, order }: ApiOperationDeclaration): OperationInfo {
  return {
    name,
    ...(description ? { description } : {}),
    params: Object.entries(params).map(([paramName, declared]) => paramInfo(paramName, declared)),
    columns: Object.entries(columns).map(([columnName, declared]) => columnInfo(columnName, declared)),
    ...(primaryKey ? { primaryKey } : {}),
    ...(order ? { order } : {}),
  };
}

function paramInfo(name: string, { type, comment, values }: ApiParamDeclaration): ParamInfo {
  return { name, type: type as ParamInfo['type'], ...(comment ? { comment } : {}), ...(values ? { values } : {}) };
}

function columnInfo(name: string, declared: ApiColumnDeclaration): ColumnInfo {
  const type = typeOf(declared);
  const extras: { comment?: string; values?: string[] } = typeof declared === 'string' ? {} : declared;
  return { name, type: baseType(type), nullable: type.endsWith(NULLABLE_SUFFIX), ...(extras.comment ? { comment: extras.comment } : {}), ...(extras.values ? { values: extras.values } : {}) };
}

function typeOf(declared: ApiColumnDeclaration): string {
  return typeof declared === 'string' ? declared : declared.type;
}

function baseType(type: string): string {
  return type.endsWith(NULLABLE_SUFFIX) ? type.slice(0, -NULLABLE_SUFFIX.length) : type;
}
