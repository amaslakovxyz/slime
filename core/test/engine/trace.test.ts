// The per-request trace: spans per layer, value-free stop notes, and errors that carry it (design T1–T4).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeError } from '../../src/shared/errors.js';
import { LAYER_IDS, layerOfError } from '../../src/shared/trace.js';
import { Trace } from '../../src/engine/trace.js';

describe('layerOfError', () => {
  const cases: [SlimeError, string][] = [
    [new SlimeError('INVALID_REQUEST', 'x'), 'key'],
    [new SlimeError('GENERATION_RATE_LIMITED', 'x'), 'limits'],
    [new SlimeError('GENERATION_FAILED', 'x'), 'generate'],
    [new SlimeError('GENERATION_TIMEOUT', 'x'), 'generate'],
    [new SlimeError('INTENT_UNSATISFIABLE', 'x'), 'generate'],
    [new SlimeError('WRITE_REFUSED', 'x', { details: { enforcedBy: 'model' } }), 'generate'],
    [new SlimeError('WRITE_REFUSED', 'x', { details: { enforcedBy: 'lint' } }), 'lint'],
    [new SlimeError('WRITE_REFUSED', 'x', { details: { enforcedBy: 'database' } }), 'execute'],
    [new SlimeError('INVALID_HANDLER', 'Step "a" calls x'), 'lint'],
    [new SlimeError('INVALID_HANDLER', 'The handler returned 9 rows, but input.limit is 5.'), 'output'],
    [new SlimeError('QUERY_TOO_LARGE', 'x'), 'cost'],
    [new SlimeError('QUERY_TOO_EXPENSIVE', 'x'), 'cost'],
    [new SlimeError('QUERY_ERROR', 'x'), 'execute'],
    [new SlimeError('EXECUTION_TIMEOUT', 'x'), 'execute'],
    [new SlimeError('SOURCE_ERROR', 'x'), 'execute'],
    [new SlimeError('ACCESS_DENIED', 'x'), 'execute'],
    [new SlimeError('SANDBOX_ERROR', 'x'), 'shape'],
    [new SlimeError('SHAPE_MISMATCH', 'x'), 'output'],
    [new SlimeError('HANDLER_NOT_FOUND', 'x'), 'route'],
  ];
  for (const [error, layer] of cases) {
    test(`${error.code} (${String(error.details?.['enforcedBy'] ?? error.message)}) stops at ${layer}`, () => {
      assert.equal(layerOfError(error), layer);
    });
  }

  test('the layer order is fixed', () => {
    assert.deepEqual([...LAYER_IDS], ['edge', 'key', 'route', 'limits', 'generate', 'lint', 'cost', 'execute', 'shape', 'output', 'cache', 'review']);
  });
});

describe('Trace', () => {
  test('time() records a pass with its ms and note, and returns the result', async () => {
    const trace = new Trace();
    const result = await trace.time('lint', () => 42, { attempt: 1, note: (n) => `got ${n}` });
    assert.equal(result, 42);
    assert.equal(trace.spans.length, 1);
    const [span] = trace.spans;
    assert.deepEqual({ ...span, ms: undefined }, { layer: 'lint', status: 'pass', note: 'got 42', attempt: 1, ms: undefined });
    assert.equal(typeof span!.ms, 'number');
  });

  test('time() records a value-free stop and rethrows the same error', async () => {
    const trace = new Trace();
    const error = new SlimeError('QUERY_ERROR', `invalid input syntax for type integer: "secret-value"`);
    await assert.rejects(trace.time('execute', () => { throw error; }), (e) => e === error);
    assert.equal(trace.spans[0]!.status, 'stop');
    assert.equal(trace.spans[0]!.note, 'QUERY_ERROR: invalid input syntax for type integer: <value>');
  });

  test('notes are cut at 200 characters and ms rounded to 2 decimals', () => {
    const trace = new Trace();
    trace.add('route', 'pass', { ms: 1.23456, note: 'x'.repeat(300) });
    assert.equal(trace.spans[0]!.note!.length, 200);
    assert.equal(trace.spans[0]!.ms, 1.23);
  });

  test('addExecution() adds execute, shape and output spans without values', () => {
    const trace = new Trace();
    trace.addExecution({ data: [{ secret: 'v' }], truncated: false, runMs: 12.5, shapeMs: 1.5, steps: [{ name: 'main', source: 'postgres', rows: 5, ms: 12 }] }, 2);
    assert.deepEqual(trace.spans.map((s) => [s.layer, s.status, s.attempt]), [['execute', 'pass', 2], ['shape', 'pass', 2], ['output', 'pass', 2]]);
    assert.equal(trace.spans[0]!.note, '1 step · 5 rows');
    assert.ok(!JSON.stringify(trace.spans).includes('secret'));
  });

  test('addExecution() marks shape skipped when there is no shape function', () => {
    const trace = new Trace();
    trace.addExecution({ data: [], truncated: true, runMs: 3, shapeMs: 0 });
    assert.deepEqual(trace.spans.map((s) => [s.layer, s.status]), [['execute', 'pass'], ['shape', 'skip'], ['output', 'pass']]);
    assert.equal(trace.spans[0]!.note, '1 query · cut at the row cap');
  });

  test('attach() returns a copy carrying this request\'s trace and key; toJSON() is unchanged', () => {
    const trace = new Trace();
    trace.add('key', 'pass');
    const original = new SlimeError('GENERATION_RATE_LIMITED', 'cap', { retryable: true, details: { a: 1 } });
    const attached = trace.attach(original, 'k1') as SlimeError;
    assert.notEqual(attached, original, 'a shared (coalesced) error must not be mutated');
    assert.equal(attached.code, 'GENERATION_RATE_LIMITED');
    assert.equal(attached.status, 429);
    assert.equal(attached.retryable, true);
    assert.deepEqual(attached.toJSON(), original.toJSON());
    assert.equal(attached.handlerKey, 'k1');
    assert.deepEqual(attached.trace!.map((s) => [s.layer, s.status]), [['key', 'pass'], ['limits', 'stop']]);
    assert.equal(original.trace, undefined);
  });

  test('attach() does not add a second stop when the last span already stopped at that layer', () => {
    const trace = new Trace();
    trace.add('cost', 'stop', { note: 'QUERY_TOO_EXPENSIVE: ...' });
    const attached = trace.attach(new SlimeError('QUERY_TOO_EXPENSIVE', 'x')) as SlimeError;
    assert.equal(attached.trace!.filter((s) => s.status === 'stop').length, 1);
  });

  test('attach() passes non-Slime errors through untouched', () => {
    const error = new TypeError('boom');
    assert.equal(new Trace().attach(error), error);
  });

  test('fail() adds a stop at the error\'s layer', () => {
    const trace = new Trace();
    trace.fail(new SlimeError('SANDBOX_ERROR', 'Shaping function threw: TypeError: x'), 1);
    assert.deepEqual(trace.spans, [{ layer: 'shape', status: 'stop', note: 'SANDBOX_ERROR: the shape function threw a TypeError', attempt: 1 }]);
  });
});
