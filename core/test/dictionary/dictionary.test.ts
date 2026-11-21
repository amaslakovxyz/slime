import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDictionary } from '../../src/dictionary/dictionary.js';
import type { SchemaInfo } from '../../src/connectors/types.js';

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
    const { text } = buildDictionary({ schema, glossary: { revenue: 'sum of paid invoices' }, rules: ['Count only paid invoices.'] });
    assert.equal(
      text,
      [
        'Database: postgresql 16',
        'Table accounts -- one row per customer\n  id integer not null primary key\n  plan_id integer null references plans.id\n  status text not null one of: active, canceled -- lifecycle',
        'Glossary:\n  revenue: sum of paid invoices',
        'Rules:\n  - Count only paid invoices.',
      ].join('\n\n'),
    );
  });

  test('the same inputs give the same hash; rules change the dictionary but not the schema hash', () => {
    const base = buildDictionary({ schema, glossary: {}, rules: [] });
    assert.deepEqual(buildDictionary({ schema, glossary: {}, rules: [] }), base);
    const withRule = buildDictionary({ schema, glossary: {}, rules: ['x'] });
    assert.notEqual(withRule.hash, base.hash);
    assert.equal(withRule.schemaHash, base.schemaHash);
  });
});
