import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_LIMITS, DEFAULT_TIERS, SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import { SlimeConfigError } from '../../src/shared/errors.js';
import type { SlimeStore } from '../../src/stores/types.js';
import { fakeConnector, fakeGenerator, fakeReviewer } from '../../src/testing/fakes.js';

function problems(options: unknown): readonly string[] {
  try {
    new SlimeConfig(options as SlimeOptions);
  } catch (err) {
    assert.ok(err instanceof SlimeConfigError);
    return err.problems;
  }
  assert.fail('expected SlimeConfigError');
}

describe('SlimeConfig (C4)', () => {
  test('a connector alone is enough: defaults fill the rest, and it is locked (C6)', () => {
    const config = new SlimeConfig({ connector: fakeConnector() });
    assert.equal(config.mode, 'locked');
    assert.equal(config.generator, undefined);
    assert.equal(config.store, undefined, 'createSlime() builds the default file store');
    assert.deepEqual(config.tiers, DEFAULT_TIERS);
    assert.deepEqual(config.limits, DEFAULT_LIMITS);
    assert.equal(config.crystal, false);
    assert.deepEqual(config.glossary, {});
    assert.deepEqual(config.rules, []);
  });

  test('a generator makes it explore mode', () => {
    assert.equal(new SlimeConfig({ connector: fakeConnector(), generator: fakeGenerator() }).mode, 'explore');
  });

  test('partial tiers and limits are merged over the defaults', () => {
    const config = new SlimeConfig({ connector: fakeConnector(), tiers: { gasToLiquidRuns: 5 }, limits: { rowCap: 50 } });
    assert.equal(config.tiers.gasToLiquidRuns, 5);
    assert.equal(config.tiers.gasWindowMs, DEFAULT_TIERS.gasWindowMs);
    assert.equal(config.limits.rowCap, 50);
    assert.equal(config.limits.statementTimeoutMs, DEFAULT_LIMITS.statementTimeoutMs);
  });

  test('reports every problem at once, not only the first', () => {
    const found = problems({
      generator: { model: '' },
      store: { type: 'redis' },
      glossary: { revenue: '' },
      tiers: { gasToLiquidRuns: 0 },
      limits: { rowCap: 2.5, nope: 1 },
      onEvent: 'log',
      typo: true,
    });
    const expected = [
      /unknown option typo/,
      /connector is required/,
      /generator is missing method generate/,
      /generator\.model must be a non-empty string/,
      /generator\.promptHash must be a non-empty string/,
      /store is missing methods get, put, list, delete/,
      /glossary\.revenue must be a non-empty description/,
      /tiers\.gasToLiquidRuns must be an integer of at least 1/,
      /limits\.rowCap must be an integer of at least 1/,
      /unknown option limits\.nope/,
      /onEvent must be a function/,
    ];
    for (const re of expected) assert.ok(found.some((p) => re.test(p)), `${re} not in:\n${found.join('\n')}`);
    assert.equal(found.length, expected.length, found.join('\n'));
  });

  test('the error message lists the problems', () => {
    assert.throws(() => new SlimeConfig({} as SlimeOptions), /Invalid Slime config:\n - connector is required/);
  });

  test('a connector without the required methods is refused', () => {
    const { run: _run, close: _close, ...partial } = fakeConnector();
    assert.deepEqual(problems({ connector: partial }), ['connector is missing methods run, close']);
  });

  test('a reviewer without a generator is refused: nothing would ever be reviewed', () => {
    assert.match(problems({ connector: fakeConnector(), reviewer: fakeReviewer() }).join(), /reviewer is set but generator is not/);
  });

  test('is immutable', () => {
    const config = new SlimeConfig({ connector: fakeConnector(), glossary: { revenue: 'paid invoices' }, rules: ['a'] });
    assert.throws(() => Object.assign(config, { mode: 'explore' }), TypeError);
    assert.throws(() => Object.assign(config.tiers, { gasToLiquidRuns: 9 }), TypeError);
    assert.throws(() => Object.assign(config.glossary, { x: 'y' }), TypeError);
    assert.throws(() => (config.rules as string[]).push('b'), TypeError);
  });

  test('does not keep references to the caller\'s objects', () => {
    const glossary = { revenue: 'paid invoices' };
    const config = new SlimeConfig({ connector: fakeConnector(), glossary });
    glossary.revenue = 'changed later';
    assert.equal(config.glossary.revenue, 'paid invoices');
  });

  test('with() returns a changed copy and merges tiers and limits key by key', () => {
    const base = new SlimeConfig({ connector: fakeConnector(), generator: fakeGenerator(), tiers: { maxReviews: 3 } });
    const changed = base.with({ tiers: { gasToLiquidRuns: 7 } });
    assert.equal(changed.tiers.gasToLiquidRuns, 7);
    assert.equal(changed.tiers.maxReviews, 3);
    assert.equal(base.tiers.gasToLiquidRuns, DEFAULT_TIERS.gasToLiquidRuns);
    assert.equal(base.with({ generator: undefined }).mode, 'locked');
  });

  test('with() validates like the constructor', () => {
    const base = new SlimeConfig({ connector: fakeConnector() });
    assert.throws(() => base.with({ limits: { rowCap: 0 } }), SlimeConfigError);
  });
});

describe('store option (C14, §4.7)', () => {
  const connector = fakeConnector();

  test('accepts any SlimeStore and uses that same object', () => {
    const custom: SlimeStore = { get: async () => undefined, put: async () => {}, list: async () => [], delete: async () => {} };
    assert.equal(new SlimeConfig({ connector, store: custom }).store, custom);
  });

  test('a store must implement get, put, list and delete', () => {
    assert.deepEqual(problems({ connector, store: { get: async () => undefined } }), ['store is missing methods put, list, delete']);
  });

  test('a { type } option is not a store: stores are passed as objects', () => {
    assert.deepEqual(problems({ connector, store: { type: 'file', dir: '.slime' } }), ['store is missing methods get, put, list, delete']);
  });
});
