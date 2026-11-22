import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { defineApiSource } from '../../../src/sources/api/define-api-source.js';
import type { ApiSourceDeclaration } from '../../../src/sources/api/declaration.js';
import type { FetchFunction } from '../../../src/sources/api/http/retry.js';
import { SlimeConfigError } from '../../../src/shared/errors.js';
import { SourceError } from '../../../src/sources/api/source-error.js';

const FILMS = [
  { id: 'a', title: 'Totoro', director: 'Hayao Miyazaki', release_date: '1988' },
  { id: 'b', title: 'Grave of the Fireflies', director: 'Isao Takahata', release_date: '1988' },
];
const fetchImpl = (async (url: string) => {
  const director = new URL(url).searchParams.get('director');
  return new Response(JSON.stringify(director ? FILMS.filter((film) => film.director === director) : FILMS));
}) as unknown as FetchFunction;

function declaration(overrides: Partial<ApiSourceDeclaration> = {}): ApiSourceDeclaration {
  return {
    service: 'Films API',
    baseUrl: 'https://films.example',
    fetchImpl,
    operations: {
      'films.list': {
        description: 'Feature films',
        params: { director: { type: 'string', comment: 'exact director name' } },
        columns: { id: 'string', title: 'string', director: { type: 'string|null', comment: 'matches db.people.name' }, releaseYear: 'integer' },
        primaryKey: ['id'],
        run: async ({ director }, { http }) => {
          const films = await http.getJson<typeof FILMS>('/films', { director: director as string | null });
          return films.map((film) => ({ id: film.id, title: film.title, director: film.director, releaseYear: Number(film.release_date) }));
        },
      },
    },
    ...overrides,
  };
}

const options = (rowCap = 10) => ({ timeoutMs: 1_000, rowCap, signal: new AbortController().signal });

describe('defineApiSource (MS2)', () => {
  test('describes its operations in declaration order with typed columns', async () => {
    const schema = await defineApiSource(declaration()).describe({ timeoutMs: 1_000, signal: new AbortController().signal });
    assert.deepEqual(schema, {
      service: 'Films API',
      operations: [
        {
          name: 'films.list',
          description: 'Feature films',
          params: [{ name: 'director', type: 'string', comment: 'exact director name' }],
          columns: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'title', type: 'string', nullable: false },
            { name: 'director', type: 'string', nullable: true, comment: 'matches db.people.name' },
            { name: 'releaseYear', type: 'integer', nullable: false },
          ],
          primaryKey: ['id'],
        },
      ],
    });
  });

  test('calls run through the constrained client and passes params through', async () => {
    const source = defineApiSource(declaration());
    const { rows, truncated } = await source.call('films.list', { director: 'Isao Takahata' }, options());
    assert.deepEqual(rows, [{ id: 'b', title: 'Grave of the Fireflies', director: 'Isao Takahata', releaseYear: 1988 }]);
    assert.equal(truncated, false);
  });

  test('cuts rows at rowCap', async () => {
    const { rows, truncated } = await defineApiSource(declaration()).call('films.list', { director: null }, options(1));
    assert.equal(rows.length, 1);
    assert.equal(truncated, true);
  });

  test('refuses unknown operations and params as client errors', async () => {
    const source = defineApiSource(declaration());
    await assert.rejects(source.call('films.delete', {}, options()), (error: SourceError) => error.status === 400 && error.isRetryable === false);
    await assert.rejects(source.call('films.list', { studio: 'Ghibli' }, options()), /has no param studio/);
  });

  test('header values become secrets', () => {
    assert.deepEqual(defineApiSource(declaration({ headers: { authorization: 'Bearer t0k3n' }, secrets: ['other'] })).secrets, ['other', 'Bearer t0k3n']);
  });

  test('reports every declaration problem at once', () => {
    const bad = declaration({
      baseUrl: 'ftp://films.example',
      operations: { Films: { params: { 'bad-name': { type: 'text' } }, columns: { id: 'uuid' }, primaryKey: ['key'], run: async () => [] } },
    });
    assert.throws(() => defineApiSource(bad), (error: SlimeConfigError) => {
      assert.equal(error.problems.length, 6, error.problems.join('\n'));
      return true;
    });
  });
});
