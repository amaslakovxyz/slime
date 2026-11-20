// Shop benchmark for the Liquid Engine.
// Run from the worktree root:  bun run bench/shop.bench.ts
// Self-contained: creates temp server roots, spawns `lee serve --handler-dir` subprocesses (offline generator,
// no LLM), drives load with fetch, kills every server, deletes temp dirs, and rewrites bench/RESULTS.md.
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openAppDb } from "../src/db";
import { sha256Hex } from "../src/hash";
import { runThroughHarness } from "../src/harness";
import { createQuickJsRunner } from "../src/quickjs-runner";
import { FnRunner } from "../src/runner";
import { FileSlotStore } from "../src/slot-store";
import { makeIntentLoader, parseIntent } from "../src/spec";
import type { Ctx, DbApi, Fixture, Runner } from "../src/types";

const REPO = resolve(import.meta.dir, "..");
const TMP = realpathSync(tmpdir()); // macOS: /var → /private/var
const ORDER = { productId: 5, qty: 1 };
const LIST = {};
const BIG_STOCK = 1_000_000_000;

// ── sample sizes (kept so the whole run stays well under 10 minutes) ──
const N = {
  jitWarm: 20, jit: 400,
  tierWarm: 200, tier: 2000,
  concWarm: 200, concTotal: 4000,
  scaleWarm: 100, scale: 1000,
  inprocWarm: 300, inproc: 3000,
  invQuery: 300,
};

const tempDirs: string[] = [];
const servers: Server[] = [];
const anomalies: string[] = [];
const md: string[] = [];

// ── stats ──
type Stats = { n: number; mean: number; p50: number; p95: number; p99: number; max: number };
function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, p50: pct(50), p95: pct(95), p99: pct(99), max: s[s.length - 1] };
}
const f = (x: number, d = 3) => x.toFixed(d);
// The shipped invariant, exactly as the kernel runs it (tenant-scoped via :tenant_id).
const INV_SQL = parseIntent(readFileSync(join(REPO, "intents", "place_order.md"), "utf8"), "place_order").invariants[0].sql;
const TENANT = { ":tenant_id": 1 };
const statCells = (s: Stats) => `${s.n} | ${f(s.mean)} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.p99)} | ${f(s.max)}`;
const STAT_HDR = "n | mean ms | p50 ms | p95 ms | p99 ms | max ms";
const STAT_SEP = "---:|---:|---:|---:|---:|---:";

// ── server roots ──
// Plain byte copy of a directory's files (subdirectories such as examples/attacks are skipped). Not cpSync: on this machine its APFS clonefileat intermittently
// stalled for 30+ s (outside timed regions, but it made total run time unbounded).
function copyDir(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true }))
    if (e.isFile()) writeFileSync(join(to, e.name), readFileSync(join(from, e.name)));
}

function makeRoot(label: string): { root: string; dbPath: string } {
  const root = mkdtempSync(join(TMP, `lee-bench-${label}-`));
  tempDirs.push(root);
  copyDir(join(REPO, "intents"), join(root, "intents"));
  copyDir(join(REPO, "examples"), join(root, "examples"));
  return { root, dbPath: join(root, "data", "app.sqlite") };
}

// Seed + optional bulk data. Product 5 gets effectively infinite stock so place_order never runs out.
function prepareDb(dbPath: string, opts: { products?: number; orders?: number } = {}) {
  const db = openAppDb(dbPath);
  db.run("UPDATE products SET stock = ? WHERE id = 5", [BIG_STOCK]);
  const extraProducts = Math.max(0, (opts.products ?? 0) - 5);
  if (extraProducts > 0) {
    const ins = db.prepare("INSERT INTO products (id, tenant_id, sku, name, price_cents, stock) VALUES (?, 1, ?, ?, ?, ?)");
    db.transaction(() => {
      for (let i = 0; i < extraProducts; i++) {
        const id = 1000 + i;
        ins.run(id, `SKU-${id}`, `Bulk product ${id}`, 100 + (i % 9000), 1000);
      }
    })();
  }
  if (opts.orders) {
    const ins = db.prepare("INSERT INTO orders (tenant_id, user_id, product_id, qty, promo_code, total_cents) VALUES (1, ?, ?, 1, NULL, ?)");
    db.transaction(() => {
      for (let i = 0; i < opts.orders!; i++) ins.run(1 + (i % 500), 1 + (i % 5), 300);
    })();
  }
  db.close();
}

// ── server processes ──
type Server = { port: number; proc: Subprocess; banner: string; stopped: boolean };
async function startServer(root: string, dbPath: string, env: Record<string, string> = {}): Promise<Server> {
  const proc = Bun.spawn([process.execPath, "run", join(REPO, "src", "lee.ts"), "serve", "--handler-dir", "examples"], {
    cwd: root,
    env: { ...process.env, PORT: "0", LEE_DB: dbPath, LEE_LOG: "0", ...env }, // no per-request logging in measurements
    stdout: "pipe", stderr: "pipe",
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 15_000;
  while (true) {
    const m = buf.match(/lee serve on http:\/\/localhost:(\d+)\s+runner: (\S+)[^\n]*/);
    if (m) {
      const server: Server = { port: Number(m[1]), proc, banner: m[0], stopped: false };
      servers.push(server);
      if (m[2] !== "quickjs") anomalies.push(`server in ${root} started with runner ${m[2]} (expected quickjs)`);
      (async () => { while (!(await reader.read()).done) {} })(); // keep draining stdout
      return server;
    }
    if (Date.now() > deadline) { proc.kill(); throw new Error(`server did not start in ${root}: ${buf}`); }
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited before banner in ${root}: ${buf}\n${await new Response(proc.stderr as ReadableStream).text()}`);
    buf += dec.decode(value);
  }
}
async function stopServer(s: Server) {
  if (s.stopped) return;
  s.stopped = true;
  s.proc.kill();
  await s.proc.exited;
}

// ── client ──
type ReplyBody = { tier?: string; handlerHash?: string; response?: { products?: unknown[] } };
type Reply = { status: number; body: ReplyBody; ms: number };
async function call(port: number, intent: string, payload: unknown): Promise<Reply> {
  const t0 = performance.now();
  const res = await fetch(`http://localhost:${port}/dispatch`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent, payload }),
  });
  const body = (await res.json()) as ReplyBody;
  return { status: res.status, body, ms: performance.now() - t0 };
}

type SeqResult = { stats: Stats; non200: number; tiers: Record<string, number>; hashes: Set<string>; last: ReplyBody };
// Sequential latency; every measured reply must be 200 with the expected tier (hard failure otherwise).
async function seq(label: string, port: number, intent: string, payload: unknown, warm: number, n: number,
  expectTier: string, opts: { gapMs?: number; before?: (i: number) => void } = {}): Promise<SeqResult> {
  for (let i = 0; i < warm; i++) {
    opts.before?.(-1 - i);
    await call(port, intent, payload);
    if (opts.gapMs) await Bun.sleep(opts.gapMs);
  }
  const ms: number[] = []; const tiers: Record<string, number> = {}; const hashes = new Set<string>();
  let non200 = 0; let last: ReplyBody = {};
  for (let i = 0; i < n; i++) {
    opts.before?.(i);
    const r = await call(port, intent, payload);
    ms.push(r.ms); last = r.body;
    if (r.status !== 200) { non200++; anomalies.push(`${label}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); }
    const tier = r.body.tier ?? `HTTP${r.status}`;
    tiers[tier] = (tiers[tier] ?? 0) + 1;
    if (r.body.handlerHash) hashes.add(r.body.handlerHash);
    if (opts.gapMs) await Bun.sleep(opts.gapMs);
  }
  if (Object.keys(tiers).length !== 1 || !tiers[expectTier])
    throw new Error(`${label}: expected every reply tier=${expectTier}, got ${JSON.stringify(tiers)}`);
  if (non200 > 0) throw new Error(`${label}: ${non200} non-200 replies`);
  return { stats: stats(ms), non200, tiers, hashes, last };
}

type ConcResult = { stats: Stats; rps: number; non200: number; tiers: Record<string, number>; wallMs: number };
async function concurrent(port: number, intent: string, payload: unknown, conc: number, total: number): Promise<ConcResult> {
  const ms: number[] = []; const tiers: Record<string, number> = {};
  let issued = 0; let non200 = 0;
  const worker = async () => {
    while (issued < total) {
      issued++;
      const r = await call(port, intent, payload);
      ms.push(r.ms);
      if (r.status !== 200) non200++;
      const tier = r.body.tier ?? `HTTP${r.status}`;
      tiers[tier] = (tiers[tier] ?? 0) + 1;
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, worker));
  const wallMs = performance.now() - t0;
  return { stats: stats(ms), rps: total / (wallMs / 1000), non200, tiers, wallMs };
}

// Promote both intents to Liquid (default promoteHits 3 ⇒ request #5 is the first Liquid response).
async function promoteToLiquid(port: number) {
  for (const [intent, payload] of [["place_order", ORDER], ["list_products", LIST]] as const) {
    let tier: string | undefined;
    for (let i = 0; i < 10 && tier !== "liquid"; i++) tier = (await call(port, intent, payload)).body.tier;
    if (tier !== "liquid") throw new Error(`${intent} did not reach liquid`);
  }
}

// ── environment ──
function environment(): string[] {
  const cpu = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"]).stdout.toString().trim() || cpus()[0]?.model;
  const qjs = JSON.parse(readFileSync(join(REPO, "node_modules", "quickjs-emscripten", "package.json"), "utf8")).version;
  const probe = new Database(":memory:");
  const sqliteVersion = (probe.query("SELECT sqlite_version() AS v").get() as { v: string }).v;
  probe.close();
  const tmpDb = join(mkdtempSync(join(TMP, "lee-bench-env-")), "x.sqlite");
  tempDirs.push(resolve(tmpDb, ".."));
  const app = openAppDb(tmpDb);
  const jm = (app.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  const sync = (app.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
  app.close();
  return [
    "## Environment",
    "",
    `- Date: ${new Date().toISOString()}`,
    `- Commit: \`${Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO }).stdout.toString().trim()}\`${Bun.spawnSync(["git", "status", "--porcelain", "--", "src", "intents", "examples"], { cwd: REPO }).stdout.toString().trim() ? " (+ uncommitted changes in src/intents/examples)" : ""}`,
    `- CPU: ${cpu}, ${cpus().length} logical cores; OS: ${platform()} ${release()}`,
    `- Bun ${Bun.version}; SQLite ${sqliteVersion} (bun:sqlite); quickjs-emscripten ${qjs}`,
    `- App DB as opened by \`openAppDb\`: journal_mode=${jm}, synchronous=${sync} (defaults; every committed request is a rollback-journal transaction on the DB file)`,
    "- Server: `lee serve --handler-dir examples` in a separate process (runner: quickjs); client: `fetch` from the bench process, keep-alive, same machine.",
    "- **LLM generation time was NOT measured**: `ANTHROPIC_API_KEY` is not set and was not used. The JIT-miss rows use the offline generator (reads `examples/<intent>.handler.js`), so they include intent load + dry-run of the `try` inputs on seed copies + live harness, but **zero** model latency. A real miss adds one or more Anthropic API round-trips (seconds) on top.",
    `- Sample sizes: JIT miss n=${N.jit} (+${N.jitWarm} warm-up); tier latency n=${N.tier} (+${N.tierWarm}); concurrency ${N.concTotal} requests/level (+${N.concWarm}); data scale n=${N.scale} (+${N.scaleWarm}); in-process n=${N.inproc} (+${N.inprocWarm}). Latencies are client-observed wall time via \`performance.now()\`.`,
    "",
  ];
}

// ── 1. tier latency ──
async function tierLatency(): Promise<{ liquidRoot: { root: string; dbPath: string } }> {
  const rows: string[] = [];
  const row = (tier: string, intent: string, r: SeqResult, note: string) =>
    rows.push(`| ${tier} | ${intent} | ${statCells(r.stats)} | ${(1000 / r.stats.mean).toFixed(0)} | ${note} |`);

  // JIT miss: TTL 1 ms + 2 ms gap ⇒ every request finds an expired Gas slot (or none) and regenerates.
  // Proof: the handler file gets a unique trailing comment before each request, so every miss yields a new handlerHash.
  console.log("1a. JIT miss");
  {
    const r = makeRoot("jit"); prepareDb(r.dbPath);
    const s = await startServer(r.root, r.dbPath, { LEE_GAS_TTL_MS: "1", LEE_PROMOTE_HITS: "1000000000" });
    for (const [intent, payload] of [["place_order", ORDER], ["list_products", LIST]] as const) {
      const file = join(r.root, "examples", `${intent}.handler.js`);
      const base = readFileSync(file, "utf8");
      const res = await seq(`jit ${intent}`, s.port, intent, payload, N.jitWarm, N.jit, "gas", {
        gapMs: 2, before: i => writeFileSync(file, `${base}\n// bench miss ${i}\n`),
      });
      if (res.hashes.size !== N.jit) throw new Error(`jit ${intent}: ${res.hashes.size} distinct handlerHash for ${N.jit} requests — not all misses`);
      row("JIT miss (offline gen)", intent, res, `tier=gas ×${N.jit}; ${res.hashes.size} distinct handlerHash ⇒ every request regenerated`);
    }
    await stopServer(s);
  }

  console.log("1b. Gas hit");
  {
    const r = makeRoot("gas"); prepareDb(r.dbPath);
    const s = await startServer(r.root, r.dbPath, { LEE_PROMOTE_HITS: "1000000000" });
    for (const [intent, payload] of [["place_order", ORDER], ["list_products", LIST]] as const) {
      const res = await seq(`gas ${intent}`, s.port, intent, payload, N.tierWarm, N.tier, "gas");
      if (res.hashes.size !== 1) throw new Error(`gas ${intent}: handler changed`);
      row("Gas hit", intent, res, `tier=gas ×${N.tier}; 1 handlerHash`);
    }
    await stopServer(s);
  }

  console.log("1c. Liquid hit");
  const lr = makeRoot("liquid"); prepareDb(lr.dbPath);
  {
    const s = await startServer(lr.root, lr.dbPath);
    await promoteToLiquid(s.port);
    for (const [intent, payload] of [["place_order", ORDER], ["list_products", LIST]] as const) {
      const res = await seq(`liquid ${intent}`, s.port, intent, payload, N.tierWarm, N.tier, "liquid");
      row("Liquid hit", intent, res, `tier=liquid ×${N.tier}`);
    }
    await stopServer(s);
  }

  console.log("1d. Crystal hit");
  {
    const lock: Record<string, unknown> = {};
    for (const intent of ["place_order", "list_products"]) {
      const state = JSON.parse(readFileSync(join(lr.root, "state", `${intent}.json`), "utf8"));
      const specHash = sha256Hex(readFileSync(join(lr.root, "intents", `${intent}.md`), "utf8"));
      if (specHash !== state.specHash) throw new Error(`specHash mismatch for ${intent}`);
      readFileSync(join(lr.root, "handlers", `${state.handlerHash}.js`)); // written by Liquid promotion
      lock[intent] = { intent, handlerHash: state.handlerHash, specHash, frozenAt: new Date().toISOString() };
    }
    writeFileSync(join(lr.root, "lee.lock"), JSON.stringify(lock, null, 2) + "\n");
    const s = await startServer(lr.root, lr.dbPath);
    for (const [intent, payload] of [["place_order", ORDER], ["list_products", LIST]] as const) {
      const res = await seq(`crystal ${intent}`, s.port, intent, payload, N.tierWarm, N.tier, "crystal");
      row("Crystal hit", intent, res, `tier=crystal ×${N.tier}`);
    }
    await stopServer(s);
    rmSync(join(lr.root, "lee.lock")); // back to Liquid for the concurrency section
  }

  md.push(
    "## 1. Latency per tier over HTTP (sequential, concurrency 1)",
    "",
    "`place_order` = `{productId: 5, qty: 1}` (stock raised to 1e9 beforehand, every request commits an order + stock update); `list_products` = `{}` (read-only). Every measured reply was HTTP 200 with the tier shown (asserted).",
    "",
    `| tier | intent | ${STAT_HDR} | req/s (1/mean) | tier check |`,
    `|---|---|${STAT_SEP}|---:|---|`,
    ...rows,
    "",
  );
  return { liquidRoot: lr };
}

// ── 2. concurrency on Liquid ──
async function concurrency(lr: { root: string; dbPath: string }) {
  console.log("2. concurrency");
  const s = await startServer(lr.root, lr.dbPath);
  const rows: string[] = [];
  for (const [intent, payload] of [["list_products", LIST], ["place_order", ORDER]] as const) {
    for (const c of [1, 8, 32, 64]) {
      await concurrent(s.port, intent, payload, c, N.concWarm);
      const r = await concurrent(s.port, intent, payload, c, N.concTotal);
      if (r.non200) anomalies.push(`concurrency ${intent} c=${c}: ${r.non200} non-200`);
      if (!r.tiers.liquid || Object.keys(r.tiers).length !== 1) throw new Error(`concurrency ${intent} c=${c}: tiers ${JSON.stringify(r.tiers)}`);
      rows.push(`| ${intent} | ${c} | ${N.concTotal} | ${f(r.wallMs, 0)} | **${r.rps.toFixed(0)}** | ${f(r.stats.mean)} | ${f(r.stats.p50)} | ${f(r.stats.p95)} | ${f(r.stats.p99)} | ${f(r.stats.max)} | ${r.non200} |`);
    }
  }
  await stopServer(s);
  md.push(
    "## 2. Throughput / concurrency (Liquid tier, one server process)",
    "",
    "Closed loop: `c` client workers each issue the next request as soon as the previous reply arrives, until the fixed request count is reached. All replies tier=liquid (asserted).",
    "",
    "| intent | concurrency | requests | wall ms | req/s | mean ms | p50 ms | p95 ms | p99 ms | max ms | non-200 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    "The harness (`runThroughHarness`: BEGIN IMMEDIATE → QuickJS → gatekeeper → invariants → COMMIT) is fully synchronous on the server's single event loop, so requests are serialized inside the server; extra concurrency only queues them.",
    "",
  );
}

// ── 3. data scale ──
async function dataScale() {
  console.log("3. data scale");
  const rows: string[] = [];
  const invRows: string[] = [];
  for (const products of [1_000, 10_000, 100_000]) {
    for (const orders of [0, 1_000_000]) {
      const r = makeRoot(`scale-${products}-${orders}`);
      const t0 = performance.now();
      prepareDb(r.dbPath, { products, orders });
      const seedMs = performance.now() - t0;
      const s = await startServer(r.root, r.dbPath);
      await promoteToLiquid(s.port);
      const po = await seq(`scale ${products}/${orders} place_order`, s.port, "place_order", ORDER, N.scaleWarm, N.scale, "liquid");
      const lp = await seq(`scale ${products}/${orders} list_products`, s.port, "list_products", LIST, N.scaleWarm, N.scale, "liquid");
      await stopServer(s);
      const returned = lp.last.response?.products?.length;
      rows.push(`| ${products.toLocaleString("en-US")} | ${orders.toLocaleString("en-US")} | place_order | ${statCells(po.stats)} | — |`);
      rows.push(`| ${products.toLocaleString("en-US")} | ${orders.toLocaleString("en-US")} | list_products | ${statCells(lp.stats)} | ${returned} |`);

      // Invariant cost in isolation, on the same DB file, then with an index on stock (bench-local; src untouched).
      if (orders === 0) {
        const db = new Database(r.dbPath);
        const plan = (db.query(`EXPLAIN QUERY PLAN ${INV_SQL}`).all(TENANT) as { detail: string }[]).map(p => p.detail).join("; ");
        const time = () => {
          const q = db.query(INV_SQL);
          for (let i = 0; i < 50; i++) q.all(TENANT);
          const xs: number[] = [];
          for (let i = 0; i < N.invQuery; i++) { const a = performance.now(); q.all(TENANT); xs.push(performance.now() - a); }
          return stats(xs);
        };
        const noIdx = time();
        db.exec("CREATE INDEX bench_products_tenant_stock ON products(tenant_id, stock)");
        const planIdx = (db.query(`EXPLAIN QUERY PLAN ${INV_SQL}`).all(TENANT) as { detail: string }[]).map(p => p.detail).join("; ");
        const idx = time();
        db.close();
        invRows.push(`| ${products.toLocaleString("en-US")} | ${plan} | ${f(noIdx.mean)} | ${f(noIdx.p99)} | ${planIdx} | ${f(idx.mean)} | ${f(idx.p99)} |`);
      }
      console.log(`   ${products}/${orders}: seed ${f(seedMs, 0)} ms, place_order p50 ${f(po.stats.p50)}, list p50 ${f(lp.stats.p50)}`);
      rmSync(r.root, { recursive: true, force: true });
    }
  }
  md.push(
    "## 3. Data scale (Liquid tier, sequential)",
    "",
    "Tenant-1 catalog bulk-inserted to N products (ids 1000+, stock 1000) and `orders` pre-filled with 0 or 1,000,000 rows before the server starts.",
    "",
    `| products | orders rows | intent | ${STAT_HDR} | products returned |`,
    `|---:|---:|---|${STAT_SEP}|---:|`,
    ...rows,
    "",
    "`products returned` is the length of the last `list_products` response: `db.read` caps every read at `LIMIT 100` (ordered by primary key) and the handler then drops sold-out rows (seed product 4), so at every catalog size the reply holds 99 products. `list_products` latency is therefore flat in catalog size, but the catalog is silently truncated beyond 100 rows.",
    "",
    `**Invariant \`no_negative_stock\` in isolation** (\`${INV_SQL}\` with \`:tenant_id = 1\`, as the kernel binds it; bun:sqlite in the bench process, n=${N.invQuery}; the index exists only in this bench copy):`,
    "",
    "| products | query plan (as shipped) | mean ms | p99 ms | plan with `INDEX ON products(tenant_id, stock)` | mean ms | p99 ms |",
    "|---:|---|---:|---:|---|---:|---:|",
    ...invRows,
    "",
  );
}

// ── 4. in-process breakdown ──
async function inProcess() {
  console.log("4. in-process");
  const spec = parseIntent(readFileSync(join(REPO, "intents", "place_order.md"), "utf8"), "place_order");
  const listSpec = parseIntent(readFileSync(join(REPO, "intents", "list_products.md"), "utf8"), "list_products");
  const src = readFileSync(join(REPO, "examples", "place_order.handler.js"), "utf8");
  const listSrc = readFileSync(join(REPO, "examples", "list_products.handler.js"), "utf8");
  const ctx: Ctx = { tenantId: 1, userId: 42, role: "user", now: new Date().toISOString() };
  const qjs = await createQuickJsRunner();
  const fn = new FnRunner();
  const dir = mkdtempSync(join(TMP, "lee-bench-inproc-")); tempDirs.push(dir);

  const bench = (fnc: () => void) => {
    for (let i = 0; i < N.inprocWarm; i++) fnc();
    const xs: number[] = [];
    for (let i = 0; i < N.inproc; i++) { const a = performance.now(); fnc(); xs.push(performance.now() - a); }
    return stats(xs);
  };
  const harnessCall = (runner: Runner, db: Database, s = spec, source = src, input: unknown = ORDER) => () => {
    const out = runThroughHarness(runner, s, source, input, ctx, db, { commit: true });
    if (!out.ok) throw new Error(`harness rejected: ${JSON.stringify(out)}`);
  };
  // Same work as place_order by hand: read product + promo, insert order, update stock, invariant, one transaction.
  const rawOrder = (db: Database) => {
    const qp = db.query("SELECT id, price_cents, stock FROM products WHERE id = ? AND tenant_id = ? LIMIT 100");
    const qpr = db.query("SELECT code, pct FROM promos WHERE code = ? AND tenant_id = ? LIMIT 100");
    const ins = db.query("INSERT INTO orders (user_id, product_id, qty, promo_code, total_cents, tenant_id) VALUES (?,?,?,?,?,?)");
    const upd = db.query("UPDATE products SET stock = ? WHERE id = ? AND tenant_id = ?");
    const inv = db.query("SELECT id FROM products WHERE tenant_id = ? AND stock < 0");
    return () => {
      db.exec("BEGIN IMMEDIATE");
      const p = qp.get(5, 1) as { id: number; price_cents: number; stock: number };
      qpr.all("NONE", 1);
      ins.run(42, p.id, 1, null, p.price_cents, 1);
      upd.run(p.stock - 1, p.id, 1);
      if (inv.all(1).length) throw new Error("invariant");
      db.exec("COMMIT");
    };
  };
  const rawList = (db: Database) => {
    const q = db.query("SELECT id, sku, name, price_cents, stock FROM products WHERE tenant_id = ? LIMIT 100");
    return () => { db.exec("BEGIN IMMEDIATE"); (q.all(1) as { id: number; stock: number }[]).filter(p => p.stock > 0).sort((a, b) => a.id - b.id); db.exec("COMMIT"); };
  };
  // QuickJS runner alone: runtime + context creation, host fns, eval — DB stubbed with constant rows, no SQLite.
  const stubDb: DbApi = {
    read: q => q.table === "products" ? [{ id: 5, price_cents: 300, stock: BIG_STOCK }] : [],
    emit: () => {},
  };

  const rows: string[] = [];
  for (const kind of ["file", "memory"] as const) {
    const open = (name: string) => {
      const db = openAppDb(kind === "file" ? join(dir, `${name}.sqlite`) : ":memory:");
      db.run("UPDATE products SET stock = ? WHERE id = 5", [BIG_STOCK]);
      return db;
    };
    const label = kind === "file" ? "file DB (as served)" : ":memory: DB";
    const dq = open("qjs"), df = open("fn"), dr = open("raw");
    rows.push(`| place_order | ${label} | harness + QuickJS runner | ${statCells(bench(harnessCall(qjs, dq)))} |`);
    rows.push(`| place_order | ${label} | harness + FnRunner (no isolation) | ${statCells(bench(harnessCall(fn, df)))} |`);
    rows.push(`| place_order | ${label} | raw bun:sqlite, same work by hand | ${statCells(bench(rawOrder(dr)))} |`);
    rows.push(`| list_products | ${label} | harness + QuickJS runner | ${statCells(bench(harnessCall(qjs, dq, listSpec, listSrc, LIST)))} |`);
    rows.push(`| list_products | ${label} | harness + FnRunner (no isolation) | ${statCells(bench(harnessCall(fn, df, listSpec, listSrc, LIST)))} |`);
    rows.push(`| list_products | ${label} | raw bun:sqlite, same work by hand | ${statCells(bench(rawList(dr)))} |`);
    for (const d of [dq, df, dr]) d.close();
  }
  rows.push(`| place_order | none (stub DbApi) | QuickJS \`runner.run\` alone | ${statCells(bench(() => qjs.run(src, ORDER, stubDb, ctx)))} |`);
  rows.push(`| place_order | none (stub DbApi) | FnRunner \`run\` alone | ${statCells(bench(() => fn.run(src, ORDER, stubDb, ctx)))} |`);

  // Request-path work outside the harness, per request: intent load (read + parse + sha256) and slot resolve.
  const root = mkdtempSync(join(TMP, "lee-bench-store-")); tempDirs.push(root);
  copyDir(join(REPO, "intents"), join(root, "intents"));
  const loader = makeIntentLoader(join(root, "intents"));
  const loaded = (await loader("place_order"))!;
  const store = new FileSlotStore(root, { now: Date.now, ttlMs: 600_000, promoteHits: 1 });
  const fx: Fixture = { intent: "place_order", handlerHash: sha256Hex(src), input: ORDER, ctx, response: null, effects: [] };
  store.admitGas("place_order", loaded.specHash, src, fx);
  const gasStats = bench(() => store.resolve("place_order", loaded.specHash)); // hits grow; promotion happens only in afterGasRun
  if (store.resolve("place_order", loaded.specHash)?.tier !== "gas") throw new Error("expected gas slot");
  store.afterGasRun("place_order", fx);
  if (store.resolve("place_order", loaded.specHash)?.tier !== "liquid") throw new Error("expected liquid slot");
  const liquidStats = bench(() => store.resolve("place_order", loaded.specHash));
  const loadStats: number[] = [];
  for (let i = 0; i < N.inprocWarm; i++) await loader("place_order");
  for (let i = 0; i < N.inproc; i++) { const a = performance.now(); await loader("place_order"); loadStats.push(performance.now() - a); }
  writeFileSync(join(root, "lee.lock"), JSON.stringify({ place_order: { intent: "place_order", handlerHash: sha256Hex(src), specHash: loaded.specHash, frozenAt: new Date().toISOString() } }));
  if (store.resolve("place_order", loaded.specHash)?.tier !== "crystal") throw new Error("expected crystal slot");
  const crystalStats = bench(() => store.resolve("place_order", loaded.specHash));
  rows.push(`| place_order | — | \`loadIntent\` (read .md + parse + sha256), every request | ${statCells(stats(loadStats))} |`);
  rows.push(`| place_order | — | \`store.resolve\` → Gas (Map lookup) | ${statCells(gasStats)} |`);
  rows.push(`| place_order | — | \`store.resolve\` → Liquid (read state + handler file + sha256) | ${statCells(liquidStats)} |`);
  rows.push(`| place_order | — | \`store.resolve\` → Crystal (read lee.lock + handler file + sha256) | ${statCells(crystalStats)} |`);

  md.push(
    "## 4. In-process breakdown (no HTTP)",
    "",
    "Per-call cost of `runThroughHarness` (role → BEGIN IMMEDIATE → runner → gatekeeper → apply effects + invariant → COMMIT) with each runner, vs a raw bun:sqlite baseline doing the same reads/writes/invariant in one transaction. Every harness call committed (`commit: true`, asserted ok). Separate DBs per row; product 5 stock raised to 1e9.",
    "",
    `| intent | DB | what | ${STAT_HDR} |`,
    `|---|---|---|${STAT_SEP}|`,
    ...rows,
    "",
  );
}

// ── main ──
const t0 = performance.now();
const outPath = join(REPO, "bench", "RESULTS.md");
try {
  const env = environment();
  const { liquidRoot } = await tierLatency();
  await concurrency(liquidRoot);
  await dataScale();
  await inProcess();
  const totalS = (performance.now() - t0) / 1000;
  const doc = [
    "# Liquid Engine — shop benchmark results",
    "",
    `Generated by \`bun run bench/shop.bench.ts\` (total run ${totalS.toFixed(0)} s). Numbers are from a single run on the machine below; treat differences under ~10% as noise.`,
    "",
    ...env,
    ...md,
    "## Anomalies",
    "",
    ...(anomalies.length ? anomalies.map(a => `- ${a}`) : ["- None: every measured reply was HTTP 200 with the expected tier; all servers started with runner quickjs."]),
    "",
  ].join("\n");
  writeFileSync(outPath, doc);
  console.log(`wrote ${outPath} in ${totalS.toFixed(0)} s`);
} finally {
  for (const s of servers) await stopServer(s);
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}
