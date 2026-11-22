// The allowlist Crystal code must pass to run in the app's process with no sandbox (C10).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CrystalCodeError, checkShapeSource } from '../src/allowlist.js';
import { apiSourcesOf, inputNamesOf, parseModule, renderModule, sqlStatementsOf, type QueryCode, type StepsCode } from '../src/module-format.js';

const accepts = (body: string) => checkShapeSource(`function shape(rows, input) { ${body} }`);
const refuses = (body: string, why: RegExp) =>
  assert.throws(() => accepts(body), (error: unknown) => error instanceof CrystalCodeError && why.test(error.message), body);

describe('Crystal allowlist: accepted', () => {
  test('typical shaping code', () => {
    accepts(`
      const byPlan = new Map();
      for (const r of rows) {
        if (!byPlan.has(r.plan)) byPlan.set(r.plan, []);
        byPlan.get(r.plan).push({ name: r.name, risk: Math.round(r.risk * 100) / 100 });
      }
      return { plans: [...byPlan].map(([plan, accounts]) => ({ plan, accounts })) };
    `);
    accepts('return rows.filter((r) => r.total > input.min).map(({ id, total }) => ({ id: String(id), total: Number(total) }));');
    accepts("const fmt = new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }); return rows.map((r) => fmt.format(r.cents / 100));");
    accepts('return Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, v]) => [k, v ?? null]));');
    accepts("const first = rows[0]; return { label: `${first?.name ?? 'none'}`, when: new Date(first.at).toISOString() };");
    accepts('function pct(a, b) { return b ? a / b : 0; } return rows.map((r) => pct(r.a, r.b));');
    accepts('try { return JSON.parse(rows[0].payload); } catch (e) { return null; }');
  });
});

describe('Crystal allowlist: refused', () => {
  test('host access', () => {
    refuses('return process.env', /process/);
    refuses('return require("fs")', /require/);
    refuses('return globalThis', /globalThis/);
    refuses('return fetch("http://x")', /fetch/);
    refuses('setTimeout(() => 1, 0); return rows', /setTimeout/);
    refuses('return Buffer.from("x")', /Buffer/);
    refuses('return arguments', /arguments/);
  });

  test('ways to reach the Function constructor', () => {
    refuses('return eval("1")', /eval/);
    refuses('return Function("return process")()', /Function/);
    refuses('return (() => 1).constructor("return process")()', /constructor/);
    refuses('return rows.constructor', /constructor/);
    refuses('const k = "constr" + "uctor"; return ({})[k][k]("return process")()', /variable key/);
    refuses('return ({})["constructor"]', /variable key/);
  });

  test('a shorthand property still counts as reading the variable', () => {
    refuses('return { process }', /process/);
  });

  test('global mutation and prototype pollution', () => {
    refuses('Math.max = () => 0; return rows', /changing a global/);
    refuses('delete Math.max; return rows', /changing a global/);
    refuses('Object.assign(Math, { max: null }); return rows', /Object\.assign/);
    refuses('const m = Math; m.max = null; return rows', /using `Math` as a value/);
    refuses('Object.defineProperty(rows, "x", {}); return rows', /defineProperty/);
    refuses('return Array.prototype', /prototype/);
    refuses('rows.__proto__.polluted = 1; return rows', /__proto__/);
  });

  test('constructs that can hang or escape', () => {
    refuses('while (true) {} return rows', /while/);
    refuses('for (;;) {} return rows', /for/);
    refuses('for (const k in rows) {} return rows', /for\.\.\.in/);
    refuses('let i = 0; do { i++ } while (i < 3); return rows', /do\.\.\.while/);
    refuses('return this', /this/);
    refuses('return import("fs")', /import/);
    refuses('class A {} return rows', /classes/);
    refuses('return (async () => 1)()', /async/);
  });

  test('static members outside the allowed list', () => {
    refuses('return String.raw`x`', /String\.raw/);
    refuses('return Object.getOwnPropertyNames(rows)', /Object\.getOwnPropertyNames/);
  });

  test('anything that is not exactly one shape function', () => {
    assert.throws(() => checkShapeSource('const shape = (rows) => rows'), CrystalCodeError);
    assert.throws(() => checkShapeSource('async function shape(rows) { return rows }'), CrystalCodeError);
  });
});

describe('Crystal module format', () => {
  test('renders and parses back the same code, without trailing whitespace', () => {
    const code = { sql: 'SELECT name FROM plans WHERE id = $1::int', params: ['id'], shape: 'function shape(rows) {\n  return rows.map((r) => r.name);  \n}' };
    const parsed = parseModule(renderModule(code)) as QueryCode;
    assert.deepEqual([parsed.sql, parsed.params], [code.sql, code.params]);
    assert.equal(parsed.shape, 'function shape(rows) {\n  return rows.map((r) => r.name);\n}');
    assert.equal(parseModule(renderModule({ ...code, shape: null })).shape, null);
  });

  test('refuses extra statements, computed SQL and non-literal params', () => {
    const base = renderModule({ sql: 'SELECT 1', params: [], shape: null });
    assert.throws(() => parseModule(`${base}console.log("side effect");\n`), CrystalCodeError);
    assert.throws(() => parseModule(base.replace('"SELECT 1"', '`SELECT ${1}`')), CrystalCodeError);
    assert.throws(() => parseModule(base.replace('[]', '[process.env.X]')), CrystalCodeError);
    assert.throws(() => parseModule(base.replace('export const shape = null;', 'export const shape = (r) => r;')), CrystalCodeError);
  });
});

describe('Crystal module format: steps', () => {
  const STEPS: StepsCode = {
    steps: [
      { name: 'accounts', source: 'db', sql: 'SELECT name FROM accounts WHERE plan = $1::text', params: ['plan'] },
      { name: 'feedback', source: 'notion', operation: 'feedback.query', args: [{ param: 'sentiment', input: null, value: 'negative' }, { param: 'account', input: 'account', value: null }] },
    ],
    shape: 'function shape(data, input) {\n  return data.accounts.map((a) => ({ name: a.name, open: data.feedback.length }));\n}',
  };

  test('renders and parses back the same steps and shape', () => {
    const parsed = parseModule(renderModule(STEPS));
    assert.deepEqual(parsed, STEPS);
    assert.deepEqual(sqlStatementsOf(parsed), [{ sql: STEPS.steps[0] && 'sql' in STEPS.steps[0] ? STEPS.steps[0].sql : '', params: ['plan'] }]);
    assert.deepEqual(inputNamesOf(parsed), ['plan', 'account']);
    assert.deepEqual(apiSourcesOf(parsed), ['notion']);
  });

  test('writes exactly the keys a step has, whatever the stored artifact carried', () => {
    const extra = { ...STEPS, steps: [{ ...STEPS.steps[0]!, note: 'from the model' } as never, STEPS.steps[1]!] };
    assert.deepEqual(parseModule(renderModule(extra)), STEPS);
  });

  test('a null shape only with a single step', () => {
    assert.throws(() => parseModule(renderModule({ ...STEPS, shape: null })), /single step/);
    assert.deepEqual(parseModule(renderModule({ steps: [STEPS.steps[0]!], shape: null })), { steps: [STEPS.steps[0]], shape: null });
  });

  test('`steps` holds plain values only: nothing that runs, nothing from outside', () => {
    const base = renderModule(STEPS);
    for (const [from, to] of [
      ['"negative"', 'process.env.X'],
      ['"negative"', '`neg${1}`'],
      ['"negative"', 'String("negative")'],
      ['"value": null', '"value": null, ...{}'],
      ['"value": null', '"value": null, get x() { return 1; }'],
      ['"value": null', '["value"]: null'],
      ['"negative"', '/negative/'],
    ] as const) {
      assert.throws(() => parseModule(base.replace(from, to)), CrystalCodeError, `${from} -> ${to}`);
    }
  });

  test('every step has exactly its keys and types', () => {
    const base = renderModule(STEPS);
    for (const [from, to] of [
      ['"name": "accounts"', '"name": "feedback"'],
      ['"name": "accounts"', '"name": "1st"'],
      ['"params": [\n      "plan"\n    ]', '"params": [1]'],
      ['"operation": "feedback.query"', '"operation": ""'],
      ['"input": null,\n        "value": "negative"', '"input": "x",\n        "value": "negative"'],
      ['"input": null,\n        "value": "negative"', '"input": null,\n        "value": null'],
      ['"source": "db",', '"source": "db", "extra": 1,'],
    ] as const) {
      assert.ok(base.includes(from), from);
      assert.throws(() => parseModule(base.replace(from, to)), CrystalCodeError, `${from} -> ${to}`);
    }
  });

  test('a steps shape passes the same allowlist', () => {
    const hostile = renderModule({ ...STEPS, shape: 'function shape(data) { return process.env; }' });
    assert.throws(() => parseModule(hostile), CrystalCodeError);
  });
});
