import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { filterFromArgs } from '../../../../src/sources/api/notion/notion-filter.js';
import { rowFromPage } from '../../../../src/sources/api/notion/notion-rows.js';
import { operationFromDataSource } from '../../../../src/sources/api/notion/notion-schema.js';
import { FEEDBACK_SCHEMA } from './notion-schema.test.js';

const { properties } = operationFromDataSource('feedback', FEEDBACK_SCHEMA);

describe('Notion filters (MS12)', () => {
  test('null args add no filter', () => {
    assert.equal(filterFromArgs(properties, { sentiment: null, createdFrom: null }), undefined);
  });

  test('equality for select, status and checkbox; ranges for dates and timestamps', () => {
    assert.deepEqual(filterFromArgs(properties, { sentiment: 'negative', status: 'Open', pinned: true, createdFrom: '2026-10-01', lastEditedTo: '2026-11-01' }), {
      and: [
        { property: 'Sentiment', select: { equals: 'negative' } },
        { property: 'Status', status: { equals: 'Open' } },
        { property: 'Created', date: { on_or_after: '2026-10-01' } },
        { property: 'Pinned', checkbox: { equals: true } },
        { timestamp: 'last_edited_time', last_edited_time: { on_or_before: '2026-11-01' } },
      ],
    });
  });
});

describe('Notion pages → rows (MS12)', () => {
  test('flattens each property type, and empty cells are null', () => {
    const row = rowFromPage(properties, {
      id: 'page-1',
      properties: {
        Title: { type: 'title', title: [{ plain_text: 'Export ' }, { plain_text: 'is slow' }] },
        Account: { type: 'rich_text', rich_text: [] },
        Sentiment: { type: 'select', select: { name: 'negative' } },
        Status: { type: 'status', status: null },
        Area: { type: 'multi_select', multi_select: [{ name: 'Performance' }, { name: 'Export' }] },
        Created: { type: 'date', date: { start: '2026-11-01T10:00:00.000+02:00' } },
        Pinned: { type: 'checkbox', checkbox: false },
        Score: { type: 'number', number: null },
        'Last edited': { type: 'last_edited_time', last_edited_time: '2026-11-02T08:00:00.000Z' },
      },
    });
    assert.deepEqual(row, {
      id: 'page-1',
      title: 'Export is slow',
      account: null,
      sentiment: 'negative',
      status: null,
      area: 'Performance, Export',
      created: '2026-11-01',
      pinned: false,
      score: null,
      internalNotes: null,
      lastEdited: '2026-11-02T08:00:00.000Z',
    });
  });
});
