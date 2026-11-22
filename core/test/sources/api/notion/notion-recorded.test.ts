// The Notion adapter over responses recorded from a real workspace (P5.5), when
// they exist. They prove the hand-written fixtures' assumptions about Notion.
import { existsSync } from 'node:fs';
import { notionSource } from '../../../../src/sources/api/notion/notion-source.js';
import { describeApiSourceContract } from '../../../../src/testing/api-source-contract.js';
import { fixtureFetch } from '../../../../src/testing/fixture-fetch.js';

const RECORDED = new URL('../../../fixtures/notion-recorded/', import.meta.url);
const isRecorded = existsSync(RECORDED);
const FEEDBACK_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const MOVIE_NIGHTS_ID = '1a1b1c1d-1e1f-4a2b-8c3d-4e5f60718293';

describeApiSourceContract({
  name: 'notion (recorded from a real workspace)',
  skip: !isRecorded,
  makeSource: () => notionSource({ token: 'recorded', dataSources: { feedback: FEEDBACK_ID, movieNights: MOVIE_NIGHTS_ID }, fetchImpl: fixtureFetch(RECORDED) }),
  cases: [{ operation: 'feedback.query', args: { sentiment: 'negative' }, allNullArgs: { sentiment: null } }],
});
