// The allowlist that Crystal code must pass to run in-process without a sandbox.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CrystalCodeError, checkShapeSource, parseModule, renderModule } from '../src/crystal/module.js';

const ok = (body: string) => checkShapeSource(`function shape(rows, input) { ${body} }`);
const refused = (body: string, why?: RegExp) =>
  assert.throws(() => ok(body), (err: unknown) => err instanceof CrystalCodeError && (!why || why.test(err.message)), body);

describe('Crystal allowlist: accepted', () => {
  test('typical shaping code', () => {
    ok(`
      const byPlan = new Map();
      for (const r of rows) {
        if (!byPlan.has(r.plan)) byPlan.set(r.plan, []);
        byPlan.get(r.plan).push({ name: r.name, risk: Math.round(r.risk * 100) / 100 });
      }
      return { plans: [...byPlan].map(([plan, accounts]) => ({ plan, accounts })) };
    `);
    ok(`return rows.filter((r) => r.total > input.min).map(({ id, total }) => ({ id: String(id), total: Number(total) }));`);
    ok(`const fmt = new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }); return rows.map((r) => fmt.format(r.cents / 100));`);
    ok(`return Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, v]) => [k, v ?? null]));`);
    ok(`const first = rows[0]; return { label: \`\${first?.name ?? 'none'}\`, when: new Date(first.at).toISOString() };`);
    ok(`function pct(a, b) { return b ? a / b : 0; } return rows.map((r) => pct(r.a, r.b));`);
    ok(`try { return JSON.parse(rows[0].payload); } catch (e) { return null; }`);
  });
});

describe('Crystal allowlist: refused', () => {
  test('host access', () => {
    refused('return process.env', /process/);
    refused('return require("fs")', /require/);
    refused('return globalThis', /globalThis/);
    refused('return fetch("http://x")', /fetch/);
    refused('setTimeout(() => 1, 0); return rows', /setTimeout/);
    refused('return Buffer.from("x")', /Buffer/);
    refused('return arguments', /arguments/);
  });

  test('ways to reach the Function constructor', () => {
    refused('return eval("1")', /eval/);
    refused('return Function("return process")()', /Function/);
    refused('return (() => 1).constructor("return process")()', /constructor/);
    refused('return rows.constructor', /constructor/);
    refused('const k = "constr" + "uctor"; return ({})[k][k]("return process")()', /variable key/);
    refused('return ({})["constructor"]', /variable key/);
  });

  test('a shorthand property still counts as reading the variable', () => {
    refused('return { process }', /process/);
  });

  test('global mutation and prototype pollution', () => {
    refused('Math.max = () => 0; return rows', /changing a global/);
    refused('delete Math.max; return rows', /changing a global/);
    refused('Object.assign(Math, { max: null }); return rows', /Object\.assign/);
    refused('const m = Math; m.max = null; return rows', /using `Math` as a value/);
    refused('Object.defineProperty(rows, "x", {}); return rows', /defineProperty/);
    refused('return Array.prototype', /prototype/);
    refused('rows.__proto__.polluted = 1; return rows', /__proto__/);
  });

  test('constructs that can hang or escape', () => {
    refused('while (true) {} return rows', /while/);
    refused('for (;;) {} return rows', /for/);
    refused('for (const k in rows) {} return rows', /for\.\.\.in/);
    refused('let i = 0; do { i++ } while (i < 3); return rows', /do\.\.\.while/);
    refused('return this', /this/);
    refused('return import("fs")', /import/);
    refused('class A {} return rows', /classes/);
    refused('return (async () => 1)()', /async/);
  });

  test('static members outside the allowed list', () => {
    refused('return String.raw`x`', /String\.raw/);
    refused('return Object.getOwnPropertyNames(rows)', /Object\.getOwnPropertyNames/);
  });

  test('rejects anything that is not exactly one shape function', () => {
    assert.throws(() => checkShapeSource('const shape = (rows) => rows'), CrystalCodeError);
    assert.throws(() => checkShapeSource('async function shape(rows) { return rows }'), CrystalCodeError);
  });
});

describe('Crystal module format', () => {
  test('renders and parses back the same code', () => {
    const code = { sql: 'SELECT name FROM plans WHERE id = $1::int', params: ['id'], shape: 'function shape(rows) {\n  return rows.map((r) => r.name);  \n}' };
    const parsed = parseModule(renderModule(code));
    assert.equal(parsed.sql, code.sql);
    assert.deepEqual(parsed.params, code.params);
    assert.equal(parsed.shape, 'function shape(rows) {\n  return rows.map((r) => r.name);\n}', 'trailing whitespace is stripped');
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
