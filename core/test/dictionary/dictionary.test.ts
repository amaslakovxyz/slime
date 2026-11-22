import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDictionary } from '../../src/dictionary/dictionary.js';
import type { SchemaInfo } from '../../src/connectors/types.js';
import type { ApiSchema } from '../../src/sources/types.js';

const schema: SchemaInfo = {
  dialect: 'postgresql 16',
  tables: [
    {
      name: 'accounts',
      comment: 'one row per customer',
      columns: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'plan_id', type: 'integer', nullable: true },
        { name: 'status', type: 'text', nullable: false, values: ['active', 'canceled'], comment: 'lifecycle' },
      ],
      primaryKey: ['id'],
      foreignKeys: [{ column: 'plan_id', references: 'plans.id' }],
    },
  ],
};

describe('dictionary (§4.4)', () => {
  test('renders tables, keys, enum values, glossary and rules without a model (D2)', () => {
    const { text } = buildDictionary({ sqlSourceName: 'db', schema, glossary: { revenue: 'sum of paid invoices' }, rules: ['Count only paid invoices.'] });
    assert.equal(
      text,
      [
        'Database source "db": postgresql 16',
        'Table accounts -- one row per customer\n  id integer not null primary key\n  plan_id integer null references plans.id\n  status text not null one of: active, canceled -- lifecycle',
        'Glossary:\n  revenue: sum of paid invoices',
        'Rules:\n  - Count only paid invoices.',
      ].join('\n\n'),
    );
  });

  test('the same inputs give the same hash; rules change the dictionary but not the schema hash', () => {
    const base = buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: [] });
    assert.deepEqual(buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: [] }), base);
    const withRule = buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: ['x'] });
    assert.notEqual(withRule.hash, base.hash);
    assert.equal(withRule.schemaHash, base.schemaHash);
  });
});

describe('dictionary with API sources (MS2, MS17)', () => {
  const feedback: ApiSchema = {
    service: 'Notion API 2025-09-03 (read-only access)',
    operations: [
      {
        name: 'feedback.query',
        description: 'Customer feedback entries, newest first',
        params: [
          { name: 'sentiment', type: 'string', values: ['positive', 'negative'] },
          { name: 'createdFrom', type: 'date' },
        ],
        columns: [
          { name: 'id', type: 'string', nullable: false },
          { name: 'account', type: 'string', nullable: true, comment: 'matches db.accounts.name' },
        ],
        primaryKey: ['id'],
      },
    ],
  };
  const films: ApiSchema = { service: 'Studio Ghibli API', operations: [{ name: 'films.list', params: [], columns: [{ name: 'title', type: 'string', nullable: false }] }] };

  test('names the SQL source and renders each API source after the tables', () => {
    const { text } = buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: ['Count only paid invoices.'], apiSchemas: { notion: feedback, films } });
    assert.equal(
      text,
      [
        'Database source "db": postgresql 16',
        'Table accounts -- one row per customer\n  id integer not null primary key\n  plan_id integer null references plans.id\n  status text not null one of: active, canceled -- lifecycle',
        [
          'API source "notion": Notion API 2025-09-03 (read-only access)',
          'Operation feedback.query: Customer feedback entries, newest first',
          '  params (all optional; null = not given):',
          '    sentiment string one of: positive, negative',
          '    createdFrom date',
          '  returns rows:',
          '    id string not null primary key',
          '    account string null -- matches db.accounts.name',
        ].join('\n'),
        'API source "films": Studio Ghibli API\nOperation films.list\n  params: none\n  returns rows:\n    title string not null',
        'Rules:\n  - Count only paid invoices.',
      ].join('\n\n'),
    );
  });

  test('uses the configured SQL source name', () => {
    const { text } = buildDictionary({ schema, glossary: {}, rules: [], apiSchemas: { films }, sqlSourceName: 'warehouse' });
    assert.ok(text.startsWith('Database source "warehouse": postgresql 16'));
  });

  test('the schema hash depends on every source schema, never on rows', () => {
    const base = buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: [], apiSchemas: { notion: feedback } });
    assert.notEqual(base.schemaHash, buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: [] }).schemaHash);
    const withColumn: ApiSchema = { ...feedback, operations: [{ ...feedback.operations[0]!, columns: [...feedback.operations[0]!.columns, { name: 'title', type: 'string', nullable: true }] }] };
    assert.notEqual(buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: [], apiSchemas: { notion: withColumn } }).schemaHash, base.schemaHash);
    assert.equal(buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: [], apiSchemas: { notion: feedback } }).schemaHash, base.schemaHash);
  });

  test('records one hash per source', () => {
    const { sourceHashes } = buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: [], apiSchemas: { notion: feedback, films } });
    assert.deepEqual(Object.keys(sourceHashes), ['db', 'notion', 'films']);
    const withoutFilms = buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: [], apiSchemas: { notion: feedback } }).sourceHashes;
    assert.equal(withoutFilms.db, sourceHashes.db, 'the SQL source hash ignores API sources');
  });

  test('a database alone keeps the database hash, so earlier handlers and Crystal still match (C10)', () => {
    const databaseOnly = buildDictionary({ sqlSourceName: 'db', schema, glossary: {}, rules: [] });
    assert.deepEqual(databaseOnly.sourceHashes, { db: databaseOnly.schemaHash });
  });
});
