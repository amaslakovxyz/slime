// P5.5: records the Notion responses the example and core's tests replay, with
// the reader token. Scrubs by allowlist (only the fields the adapter reads) and
// maps every real id to a stable placeholder in requests and responses alike,
// so fixture keys still match (core/docs/multi-source-implementation.md P5.5).
//
//   node --env-file=.env scripts/record-notion-fixtures.mjs
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { notionSource } from '@slime-cloud/core/notion';

const OUT_DIRS = [new URL('../test/fixtures/notion/', import.meta.url), new URL('../../../core/test/fixtures/notion-recorded/', import.meta.url)];
// The ids src/config.mjs uses with FETCH_FIXTURES=1.
const PLACEHOLDER_IDS = { feedback: '0f0e0d0c-0b0a-4908-8706-050403020100', movieNights: '1a1b1c1d-1e1f-4a2b-8c3d-4e5f60718293' };
const KEPT_VALUE_FIELDS = ['title', 'rich_text', 'number', 'select', 'status', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone_number', 'unique_id', 'created_time', 'last_edited_time'];

const realIds = { feedback: required('NOTION_FEEDBACK_ID'), movieNights: required('NOTION_MOVIE_NIGHTS_ID') };
const idMap = new Map(Object.entries(realIds).map(([alias, id]) => [id, PLACEHOLDER_IDS[alias]]));
const recorded = [];

const recordingFetch = async (url, init = {}) => {
  const response = await fetch(url, init);
  const body = await response.clone().json();
  recorded.push({ method: init.method ?? 'GET', url: String(url), requestBody: init.body ? JSON.parse(init.body) : undefined, status: response.status, headers: retryHeaders(response), body });
  return response;
};

const notion = notionSource({ token: required('NOTION_TOKEN'), dataSources: realIds, fetchImpl: recordingFetch });
const options = { timeoutMs: 30_000, rowCap: 1_000, signal: new AbortController().signal };
await notion.safetyCheck(options);
await notion.describe(options);
// Exactly the calls the example's offline handlers and core's contract tests make.
await notion.call('feedback.query', { sentiment: 'negative', status: 'Open' }, options);
await notion.call('feedback.query', { sentiment: 'negative' }, options);
await notion.call('feedback.query', { sentiment: null }, options);
await notion.call('movieNights.query', {}, options);

for (const dir of OUT_DIRS) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [index, entry] of recorded.entries()) await writeFile(new URL(`${String(index + 1).padStart(2, '0')}-${slug(entry)}.json`, dir), `${JSON.stringify(fixtureOf(entry), null, 2)}\n`);
}
console.log(`recorded ${recorded.length} responses into ${OUT_DIRS.length} folders; review the diff before committing.`);

function fixtureOf({ method, url, requestBody, status, headers, body }) {
  const request = { method, url: mapIds(url), ...(requestBody ? { body: mapIdsDeep(requestBody) } : {}) };
  return { request, response: { status, ...(headers ? { headers } : {}), body: scrub(url, body) } };
}

function scrub(url, body) {
  if (url.endsWith('/v1/users/me')) return { object: 'user', type: 'bot', name: body.name ?? null };
  if (url.endsWith('/query')) {
    return { object: 'list', results: body.results.map((page) => ({ object: 'page', id: placeholderPageId(page.id), properties: scrubValues(page.properties) })), has_more: body.has_more, next_cursor: body.next_cursor ? mapCursor(body.next_cursor) : null, ...(body.request_status ? { request_status: { type: body.request_status.type } } : {}) };
  }
  return {
    object: 'data_source',
    id: mapIds(body.id),
    title: (body.title ?? []).map((part) => ({ plain_text: part.plain_text })),
    properties: Object.fromEntries(Object.entries(body.properties).map(([name, property]) => [name, scrubSchema(property)])),
  };
}

function scrubSchema({ name, type, description, select, status }) {
  return { name, type, ...(description ? { description } : {}), ...(select ? { select: { options: select.options.map((option) => ({ name: option.name })) } } : {}), ...(status ? { status: { options: status.options.map((option) => ({ name: option.name })) } } : {}) };
}

function scrubValues(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => KEPT_VALUE_FIELDS.includes(value.type)).map(([name, value]) => [name, { type: value.type, [value.type]: scrubValue(value.type, value[value.type]) }]));
}

function scrubValue(type, value) {
  if (type === 'title' || type === 'rich_text') return value.map((part) => ({ plain_text: part.plain_text }));
  if (type === 'select' || type === 'status') return value ? { name: value.name } : null;
  if (type === 'multi_select') return value.map((option) => ({ name: option.name }));
  if (type === 'date') return value ? { start: value.start } : null;
  if (type === 'unique_id') return { prefix: value.prefix, number: value.number };
  return value;
}

const pageIds = new Map();
function placeholderPageId(id) {
  if (!pageIds.has(id)) pageIds.set(id, `00000000-0000-4000-8000-${String(pageIds.size + 1).padStart(12, '0')}`);
  return pageIds.get(id);
}

// Cursors are page ids sent back in the next request body; map them the same way.
function mapCursor(cursor) {
  return placeholderPageId(cursor);
}

function mapIds(text) {
  let mapped = text;
  for (const [real, placeholder] of idMap) mapped = mapped.split(real).join(placeholder);
  return mapped;
}

function mapIdsDeep(value) {
  const json = mapIds(JSON.stringify(value));
  const parsed = JSON.parse(json);
  if (parsed.start_cursor) parsed.start_cursor = mapCursor(parsed.start_cursor);
  return parsed;
}

function retryHeaders(response) {
  const retryAfter = response.headers.get('retry-after');
  return retryAfter ? { 'retry-after': retryAfter } : undefined;
}

function slug({ method, url, requestBody }) {
  const path = new URL(url).pathname.split('/').filter(Boolean).pop();
  const filter = requestBody?.filter ? '-filtered' : requestBody?.start_cursor ? '-next-page' : '';
  return `${method.toLowerCase()}-${path === 'me' ? 'users-me' : path === 'query' ? 'query' : 'data-source'}${filter}`;
}

function required(name) {
  if (!process.env[name]) throw new Error(`Set ${name} in .env (see .env.example).`);
  return process.env[name];
}
