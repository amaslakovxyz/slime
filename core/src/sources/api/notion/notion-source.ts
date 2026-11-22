// The Notion adapter (design §4.2, MS12): data sources listed in config become
// query operations described from Notion's own schema at startup.
import { SlimeConfigError } from '../../../shared/errors.js';
import { createHttpClient, type HttpClient } from '../http/http-client.js';
import type { FetchFunction } from '../http/retry.js';
import { SourceError } from '../source-error.js';
import type { ApiSchema, ApiSource, CallOptions, SourceCallOptions } from '../types.js';
import { limitConcurrency } from './limit-concurrency.js';
import { filterFromArgs } from './notion-filter.js';
import { rowFromPage } from './notion-rows.js';
import { operationFromDataSource, type NotionOperation } from './notion-schema.js';
import type { NotionDataSource, NotionQueryResult, NotionUser } from './notion-types.js';
import { sanitizeMetadata } from './sanitize.js';

export interface NotionSourceOptions {
  /** The integration's token; give it only the "Read content" capability. */
  token: string;
  /** Alias → data source id. Only these are exposed: the allowlist acts as a GRANT. */
  dataSources: Record<string, string>;
  /** Pinned; check Notion's changelog before moving it. */
  notionVersion?: string;
  /** Alias → property names never exposed. */
  exclude?: Record<string, string[]>;
  /** Alias → column → comment, for example { feedback: { account: 'matches db.accounts.name' } }. */
  comments?: Record<string, Record<string, string>>;
  /** Use Notion property descriptions as column comments; off by default (S8). */
  useNotionDescriptions?: boolean;
  fetchImpl?: FetchFunction;
}

export const NOTION_VERSION = '2025-09-03';
const BASE_URL = 'https://api.notion.com';
const MAX_IN_FLIGHT = 2;
const PAGE_SIZE = 100;
const NEWEST_FIRST = [{ timestamp: 'created_time', direction: 'descending' }];
const BAD_REQUEST = 400;
const ALIAS = /^[a-z][A-Za-z0-9]*$/;
const DATA_SOURCE_ID = /^[0-9a-fA-F-]{32,36}$/;
const DEFAULT_USER = 'Notion integration';

export function notionSource(options: NotionSourceOptions): ApiSource {
  const problems = optionProblems(options);
  if (problems.length > 0) throw new SlimeConfigError(problems.map((problem) => `notionSource: ${problem}`));
  const version = options.notionVersion ?? NOTION_VERSION;
  const headers = { authorization: `Bearer ${options.token}`, 'notion-version': version };
  const limited = limitConcurrency(MAX_IN_FLIGHT);
  const http = (signal: AbortSignal): HttpClient => createHttpClient({ baseUrl: BASE_URL, headers, signal, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  let operations: Map<string, NotionOperation> | undefined;

  const describe = async ({ signal }: SourceCallOptions): Promise<ApiSchema> => {
    const described = await Promise.all(
      Object.entries(options.dataSources).map(async ([alias, id]) => {
        const dataSource = await limited(() => http(signal).getJson<NotionDataSource>(`/v1/data_sources/${id}`));
        return operationFromDataSource(alias, dataSource, schemaOptions(options, alias));
      }),
    );
    operations = new Map(described.map((operation) => [operation.info.name, operation]));
    return { service: `Notion API ${version} (read-only access)`, operations: described.map((operation) => operation.info) };
  };

  return {
    kind: 'api',
    name: 'notion',
    secrets: Object.freeze([options.token, headers.authorization]),
    describe,
    async call(operationName: string, args: Readonly<Record<string, unknown>>, callOptions: CallOptions) {
      if (!operations) await describe(callOptions);
      const operation = operations?.get(operationName);
      if (!operation) throw new SourceError(`Notion has no operation "${operationName}".`, { status: BAD_REQUEST, isRetryable: false });
      const unknownArgs = Object.keys(args).filter((arg) => !operation.info.params.some((param) => param.name === arg));
      if (unknownArgs.length > 0) throw new SourceError(`${operationName} has no param ${unknownArgs.join(', ')}.`, { status: BAD_REQUEST, isRetryable: false });
      return queryPages(operation, args, callOptions, (body, signal) => limited(() => http(signal).requestJson<NotionQueryResult>({ method: 'POST', path: `/v1/data_sources/${operation.dataSourceId}/query`, body })));
    },
    // One call: a data source that can't be read already fails describe(), so startup costs N+1 calls.
    async safetyCheck({ signal }) {
      const user = await http(signal).getJson<NotionUser>('/v1/users/me');
      return { ok: true, user: sanitizeMetadata(user.name ?? '') || DEFAULT_USER, problems: [] };
    },
    close: async () => {},
  };
}

type QueryPage = (body: Record<string, unknown>, signal: AbortSignal) => Promise<NotionQueryResult>;

async function queryPages(operation: NotionOperation, args: Readonly<Record<string, unknown>>, { rowCap, signal }: CallOptions, queryPage: QueryPage) {
  const startedAt = performance.now();
  const filter = filterFromArgs(operation.properties, args);
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let hasMore = false;
  let isIncomplete = false;
  do {
    const page = await queryPage({ page_size: PAGE_SIZE, sorts: NEWEST_FIRST, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) }, signal);
    rows.push(...page.results.map((result) => rowFromPage(operation.properties, result)));
    hasMore = page.has_more && page.next_cursor !== null;
    // Notion stops at 10,000 results and says so on a page; has_more is then false.
    isIncomplete = isIncomplete || page.request_status?.type === 'incomplete';
    cursor = page.next_cursor;
  } while (hasMore && rows.length < rowCap && !isIncomplete);
  const truncated = rows.length > rowCap || (rows.length >= rowCap && hasMore) || isIncomplete;
  return { rows: rows.slice(0, rowCap), truncated, ms: performance.now() - startedAt };
}

function schemaOptions({ exclude, comments, useNotionDescriptions }: NotionSourceOptions, alias: string) {
  return { ...(exclude?.[alias] ? { exclude: exclude[alias] } : {}), ...(comments?.[alias] ? { comments: comments[alias] } : {}), ...(useNotionDescriptions ? { useNotionDescriptions } : {}) };
}

function optionProblems({ token, dataSources }: NotionSourceOptions): string[] {
  const problems: string[] = [];
  if (typeof token !== 'string' || !token.trim()) problems.push('token must be the integration token');
  const entries = Object.entries(dataSources ?? {});
  if (entries.length === 0) problems.push('dataSources must list at least one { alias: data source id }');
  for (const [alias, id] of entries) {
    if (!ALIAS.test(alias)) problems.push(`dataSources.${alias}: an alias starts with a lowercase letter and has only letters and digits`);
    if (!DATA_SOURCE_ID.test(id)) problems.push(`dataSources.${alias}: "${id}" is not a Notion data source id`);
  }
  return problems;
}
