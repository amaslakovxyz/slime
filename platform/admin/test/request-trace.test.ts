// One feed event becomes 12 layer rows, a verdict, a lit route and a waterfall (request trace design T5).
// Fixtures mirror the mockup's REQUESTS: r1 miss-with-repair, r2 coalesced, r3 refused at lint,
// r4 Liquid hit, r5 Crystal, r6 too-expensive on two attempts, r7 rate-limited, plus an edge stop
// and an old event recorded before traces existed.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LAYERS, notableAttempts, routeOf, traceRows, verdictOf, waterfallOf } from '../lib/request-trace';
import type { RuntimeEvent } from '../lib/lifecycle';

const span = (layer: string, status: string, extra: Record<string, unknown> = {}) => ({ layer, status, ...extra });

// r1: a miss whose first generation was repaired after an INVALID_HANDLER stop at lint.
const MISS: RuntimeEvent = {
  at: '2026-11-22T14:32:08.412Z', handlerKey: 'a3f9c1e07d', tier: 'gas', cache: 'miss', ms: 2214.6, status: 200,
  intent: 'Top customers by revenue', inputs: ['days', 'limit'],
  trace: [span('edge', 'pass'), span('key', 'pass'), span('route', 'pass', { note: 'cache miss → generate' }), span('limits', 'pass'),
    span('generate', 'pass', { attempt: 1, ms: 1000 }), span('lint', 'stop', { attempt: 1, note: 'INVALID_HANDLER: copies an input value' }),
    span('generate', 'pass', { attempt: 2, ms: 1049 }), span('lint', 'pass', { attempt: 2 }), span('cost', 'pass', { attempt: 2 }),
    span('execute', 'pass', { attempt: 2, ms: 121 }), span('shape', 'pass', { attempt: 2, ms: 3 }), span('output', 'pass', { attempt: 2 }),
    span('cache', 'pass'), span('review', 'pending')] as RuntimeEvent['trace'],
  generated: { sql: 'SELECT 1', assumptions: [] },
};

// r3: a write refused at lint.
const REFUSED: RuntimeEvent = {
  at: '2026-11-22T14:31:52.077Z', handlerKey: '7be2104a9c', ms: 1318, status: 403, code: 'WRITE_REFUSED', stopAt: 'lint',
  trace: [span('edge', 'pass'), span('key', 'pass'), span('route', 'pass'), span('limits', 'pass'), span('generate', 'pass', { attempt: 1 }), span('lint', 'stop', { attempt: 1 })] as RuntimeEvent['trace'],
};

// r2: coalesced — joined a same-request generation already in flight.
const COALESCED: RuntimeEvent = {
  at: '2026-11-22T14:30:01.000Z', handlerKey: 'c0ffee1234', tier: 'gas', cache: 'coalesced', ms: 980, status: 200,
  trace: [span('edge', 'pass'), span('key', 'pass'), span('route', 'pass', { note: 'same request already generating → joined it' }),
    span('limits', 'skip', { note: 'joined a generation in flight' }),
    span('generate', 'skip', { ms: 850, note: "waited for the same request's generation" }),
    span('lint', 'skip', { note: 'checked in the shared generation' }), span('cost', 'skip', { note: 'checked in the shared generation' }),
    span('execute', 'pass', { ms: 90 }), span('shape', 'pass', { ms: 2 }), span('output', 'pass'),
    span('cache', 'pass'), span('review', 'skip', { note: 'review starts at 3 runs' })] as RuntimeEvent['trace'],
};

// r4: a Liquid cache hit — the generation layers are skipped without a wait, so they stay dim.
const HIT: RuntimeEvent = {
  at: '2026-11-22T14:29:40.000Z', handlerKey: 'd00dfeed56', tier: 'liquid', cache: 'hit', ms: 134, status: 200,
  trace: [span('edge', 'pass'), span('key', 'pass'), span('route', 'pass', { note: 'cache hit · liquid' }),
    span('limits', 'skip', { note: 'no model call' }), span('generate', 'skip', { note: 'code written 2026-11-20' }),
    span('lint', 'skip', { note: 'checked when generated' }), span('cost', 'skip', { note: 'checked when generated' }),
    span('execute', 'pass', { ms: 80 }), span('shape', 'pass', { ms: 1 }), span('output', 'pass'),
    span('cache', 'pass', { note: '7 of 10 runs' }), span('review', 'skip', { note: 'no reviewer configured' })] as RuntimeEvent['trace'],
};

// r5: a Crystal's own route.
const CRYSTAL: RuntimeEvent = {
  at: '2026-11-22T14:28:00.000Z', handlerKey: 'ee11ee22ee', tier: 'crystal', cache: 'hit', ms: 45, status: 200, route: 'crystal',
  trace: [span('edge', 'pass'), span('key', 'pass'), span('route', 'pass', { note: 'Crystal ee11ee22ee33' }),
    span('limits', 'skip', { note: 'no model call' }), span('generate', 'skip', { note: 'frozen code' }),
    span('lint', 'skip', { note: 'checked before freezing' }), span('cost', 'skip', { note: 'checked before freezing' }),
    span('execute', 'pass', { ms: 20 }), span('shape', 'pass', { ms: 1 }), span('output', 'pass'),
    span('cache', 'skip', { note: 'Crystal: nothing to promote' }), span('review', 'skip', { note: 'no reviewer configured' })] as RuntimeEvent['trace'],
};

// r6: too expensive on both attempts — lint still passed on the last attempt.
const EXPENSIVE: RuntimeEvent = {
  at: '2026-11-22T14:27:10.000Z', handlerKey: 'f00ff00ff0', ms: 640, status: 400, code: 'QUERY_TOO_EXPENSIVE', stopAt: 'cost',
  trace: [span('edge', 'pass'), span('key', 'pass'), span('route', 'pass'), span('limits', 'pass'),
    span('generate', 'pass', { attempt: 1, ms: 500 }), span('lint', 'pass', { attempt: 1 }), span('cost', 'stop', { attempt: 1, note: 'EXPLAIN cost over 1,000,000' }),
    span('generate', 'pass', { attempt: 2, ms: 120 }), span('lint', 'pass', { attempt: 2 }), span('cost', 'stop', { attempt: 2, note: 'EXPLAIN cost over 1,000,000' })] as RuntimeEvent['trace'],
};

// r7: rate limited before a model call.
const RATE_LIMITED: RuntimeEvent = {
  at: '2026-11-22T14:26:00.000Z', handlerKey: '', ms: 5, status: 429, code: 'GENERATION_RATE_LIMITED', stopAt: 'limits',
  trace: [span('edge', 'pass'), span('key', 'pass'), span('route', 'pass'), span('limits', 'stop', { note: '200 of 200 this hour' })] as RuntimeEvent['trace'],
};

// A body too large — the host's own edge layer stops it before the engine ever sees it.
const EDGE_STOP: RuntimeEvent = {
  at: '2026-11-22T14:25:00.000Z', handlerKey: '', ms: 0, status: 413, code: 'INVALID_REQUEST', stopAt: 'edge',
  trace: [span('edge', 'stop', { note: 'INVALID_REQUEST: Body larger than 16 KB.' })] as RuntimeEvent['trace'],
};

describe('traceRows', () => {
  test('12 rows in the fixed order', () => {
    assert.deepEqual(traceRows(MISS)!.map((r) => r.id), LAYERS.map((l) => l.id));
    assert.equal(LAYERS.length, 12);
  });
  test('the last attempt decides a row; earlier attempts are kept', () => {
    const lint = traceRows(MISS)!.find((r) => r.id === 'lint')!;
    assert.equal(lint.status, 'pass');
    assert.deepEqual(lint.attempts.map((a) => [a.attempt, a.status]), [[1, 'stop'], [2, 'pass']]);
  });
  test('layers after the stop are unreached', () => {
    const rows = traceRows(REFUSED)!;
    assert.equal(rows.find((r) => r.id === 'lint')!.status, 'stop');
    assert.deepEqual(rows.filter((r) => r.status === 'unreached').map((r) => r.id), ['cost', 'execute', 'shape', 'output', 'cache', 'review']);
  });
  test('an old event without a trace gives null', () => {
    assert.equal(traceRows({ at: 'x', handlerKey: 'k', tier: 'gas', cache: 'hit', ms: 1 }), null);
  });
  test('an unknown status renders as unknown', () => {
    const rows = traceRows({ ...MISS, trace: [span('key', 'teleported')] as RuntimeEvent['trace'] })!;
    assert.equal(rows.find((r) => r.id === 'key')!.status, 'unknown');
  });
  test('layers after a limits stop are unreached', () => {
    const rows = traceRows(RATE_LIMITED)!;
    assert.equal(rows.find((r) => r.id === 'generate')!.status, 'unreached');
    assert.equal(rows.find((r) => r.id === 'limits')!.status, 'stop');
  });
  test('a layer with no span and no stop is skipped with a note', () => {
    const rows = traceRows({ ...MISS, trace: [span('key', 'teleported')] as RuntimeEvent['trace'] })!;
    assert.equal(rows.find((r) => r.id === 'route')!.status, 'skip');
    assert.equal(rows.find((r) => r.id === 'route')!.note, 'not on this route');
  });
  test('two attempts both stopping at cost are both kept', () => {
    const cost = traceRows(EXPENSIVE)!.find((r) => r.id === 'cost')!;
    assert.equal(cost.status, 'stop');
    assert.deepEqual(cost.attempts.map((a) => a.attempt), [1, 2]);
    // lint passed on the last attempt even though the request still failed at cost.
    assert.equal(traceRows(EXPENSIVE)!.find((r) => r.id === 'lint')!.status, 'pass');
  });
  test('an edge stop reaches nothing else', () => {
    const rows = traceRows(EDGE_STOP)!;
    assert.equal(rows.find((r) => r.id === 'edge')!.status, 'stop');
    assert.equal(rows.filter((r) => r.status === 'unreached').length, 11);
  });
});

describe('verdictOf / routeOf / waterfallOf', () => {
  test('a refusal names its layer and code', () => {
    assert.deepEqual(verdictOf(REFUSED, traceRows(REFUSED)), { ok: false, passed: 5, skipped: 0, stopAt: 'lint', code: 'WRITE_REFUSED' });
  });
  test('a refusal at lint lights the path up to gen and stops at guard', () => {
    const route = routeOf(REFUSED, traceRows(REFUSED)!);
    assert.deepEqual(route.lit, ['app', 'edge', 'router', 'gen']);
    assert.equal(route.stop, 'guard');
  });
  test('a miss runs through generation, with review in the background', () => {
    const route = routeOf(MISS, traceRows(MISS)!);
    assert.deepEqual(route.lit, ['app', 'edge', 'router', 'gen', 'guard', 'exec', 'db', 'shape', 'out', 'answer']);
    assert.deepEqual(route.background.sort(), ['cache', 'review']);
  });
  test('waterfall bars start where the previous one ended', () => {
    const bars = waterfallOf(MISS);
    const gen2 = bars.find((b) => b.label === 'Generate #2')!;
    assert.equal(gen2.start, 1000);
    assert.equal(bars.at(-1)!.kind, 'background');
  });

  test('waterfall labels are the layer names; the attempt shows only when there were several', () => {
    assert.deepEqual(waterfallOf(MISS).slice(0, 5).map((b) => b.label), ['Edge', 'Parse & key', 'Route', 'Generation limits', 'Generate #1']);
    assert.ok(waterfallOf(HIT).every((b) => !b.label.includes('#')));
    assert.equal(waterfallOf(MISS).at(-1)!.label, 'Review (background)');
  });

  test('a Liquid hit lights cache but leaves gen dim', () => {
    const route = routeOf(HIT, traceRows(HIT)!);
    assert.ok(route.lit.includes('cache'));
    assert.ok(!route.lit.includes('gen'));
  });

  test('a Crystal lights its own node', () => {
    const route = routeOf(CRYSTAL, traceRows(CRYSTAL)!);
    assert.ok(route.lit.includes('crystal'));
  });

  test('a coalesced request lights gen via a skip-with-ms join', () => {
    const route = routeOf(COALESCED, traceRows(COALESCED)!);
    assert.ok(route.lit.includes('gen'));
    assert.equal(traceRows(COALESCED)!.find((r) => r.id === 'generate')!.status, 'skip');
  });

  test('rate limiting stops at gen and never lights it', () => {
    const route = routeOf(RATE_LIMITED, traceRows(RATE_LIMITED)!);
    assert.deepEqual(route.lit, ['app', 'edge', 'router']);
    assert.equal(route.stop, 'gen');
  });

  test('a body too large stops at edge and lights nothing else', () => {
    const route = routeOf(EDGE_STOP, traceRows(EDGE_STOP)!);
    assert.deepEqual(route.lit, ['app']);
    assert.equal(route.stop, 'edge');
    assert.deepEqual(route.background, []);
  });

  test('cost failing on both attempts still lights guard because lint passed last', () => {
    const route = routeOf(EXPENSIVE, traceRows(EXPENSIVE)!);
    assert.ok(route.lit.includes('guard'));
    assert.equal(route.stop, 'guard');
  });
});

describe('notableAttempts', () => {
  const row = (id: string, event: RuntimeEvent) => traceRows(event)!.find((r) => r.id === id)!;
  test('an earlier attempt that ended differently is shown', () => {
    assert.deepEqual(notableAttempts(row('lint', MISS)).map((a) => [a.attempt, a.status]), [[1, 'stop']]);
  });
  test('attempts that repeat the final outcome are hidden', () => {
    assert.deepEqual(notableAttempts(row('generate', MISS)), []);
    assert.deepEqual(notableAttempts(row('cost', EXPENSIVE)), [], 'both attempts stopped at cost with the same note');
  });
});
