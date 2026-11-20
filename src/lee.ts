import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { anthropicGenerate, dryRun, generateWithRepair } from "./build-path";
import { openAppDb } from "./db";
import { createFetchHandler, devSession } from "./dispatcher";
import { sha256Hex } from "./hash";
import { makeHarness } from "./harness";
import { FnRunner } from "./runner";
import { FileSlotStore } from "./slot-store";
import { makeIntentLoader } from "./spec";
import { GAS_TTL_MS, PROMOTE_HITS, type Generate, type RequestDeps, type Runner } from "./types";

const USAGE = "usage: lee serve [--handler-file <path> | --handler-dir <dir>] | lee build <intent> [--handler-file <path> | --handler-dir <dir>]";

function die(msg: string): never { console.error(msg); process.exit(1); }

async function pickRunner(): Promise<{ runner: Runner; name: string }> {
  try {
    const { createQuickJsRunner } = await import("./quickjs-runner");
    return { runner: await createQuickJsRunner(), name: "quickjs" };
  } catch {
    console.warn("! quickjs unavailable, falling back to FnRunner (NO isolation)");
    return { runner: new FnRunner(), name: "fn (NO isolation)" };
  }
}

// Offline modes replace the agent: --handler-file returns one file's bytes for every intent;
// --handler-dir returns <dir>/<intent>.handler.js (a missing file fails that request with 500).
async function pickGenerator(flags: string[]): Promise<(intent: string) => Generate> {
  if (flags.length === 0) return () => anthropicGenerate;
  if (flags.length !== 2) die(USAGE);
  const [flag, path] = flags;
  if (flag === "--handler-file") {
    if (!(await Bun.file(path).exists())) die(`handler file not found: ${path}`);
    return () => async () => Bun.file(path).text();
  }
  if (flag === "--handler-dir") {
    if (!existsSync(path) || !statSync(path).isDirectory()) die(`handler dir not found: ${path}`);
    return intent => async () => Bun.file(join(path, `${intent}.handler.js`)).text();
  }
  die(USAGE);
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) die(`${name} must be a positive integer`);
  return Number(raw);
}

async function serve(flags: string[]) {
  const generatorFor = await pickGenerator(flags);
  const ttlMs = positiveInt("LEE_GAS_TTL_MS", GAS_TTL_MS);
  const promoteHits = positiveInt("LEE_PROMOTE_HITS", PROMOTE_HITS);
  const { runner, name } = await pickRunner();
  const harness = makeHarness(runner);
  const deps: RequestDeps = {
    loadIntent: makeIntentLoader("intents"),
    store: new FileSlotStore(process.cwd(), { now: Date.now, ttlMs, promoteHits }),
    harness,
    db: openAppDb(process.env.LEE_DB ?? "data/lee.sqlite"),
    generateHandler: spec => generateWithRepair(generatorFor(spec.name), spec, harness),
  };
  const fetch = createFetchHandler(deps, devSession);
  const log = process.env.LEE_LOG !== "0";
  if (log) {
    const generate = deps.generateHandler;
    deps.generateHandler = async spec => {
      const t0 = performance.now();
      console.log(`  ⚙ JIT generate ${spec.name} (cache miss)…`);
      const gen = await generate(spec);
      const ms = (performance.now() - t0).toFixed(1);
      console.log(gen.ok
        ? `  ⚙ generated ${spec.name} handler ${sha256Hex(gen.source).slice(0, 12)} in ${ms} ms; ${gen.runs.length} try input(s) passed`
        : `  ⚙ generation failed for ${spec.name} in ${ms} ms: ${gen.detail}`);
      return gen;
    };
  }
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    fetch: log ? req => logged(fetch, req) : fetch,
  });
  console.log(`lee serve on http://localhost:${server.port}  runner: ${name}  gasTtlMs: ${ttlMs}  promoteHits: ${promoteHits}`);
}

// One line per request for hands-on demos; disable with LEE_LOG=0 (benchmarks do).
async function logged(fetch: (req: Request) => Promise<Response>, req: Request): Promise<Response> {
  const t0 = performance.now();
  const res = await fetch(req);
  const b = await res.clone().json() as Record<string, unknown>;
  const outcome = res.status === 200 ? `${b.tier} ${String(b.handlerHash).slice(0, 12)}`
    : [b.tier, b.stage, b.reason ?? b.error, b.detail].filter(x => x !== undefined && x !== null).join(" ");
  console.log(`${req.method} ${b.intent ?? new URL(req.url).pathname} → ${res.status} ${outcome}  ${(performance.now() - t0).toFixed(1)} ms`);
  return res;
}

async function build(intent: string, flags: string[]) {
  const generate = (await pickGenerator(flags))(intent);
  const loaded = await makeIntentLoader("intents")(intent);
  if (!loaded) die(`unknown intent '${intent}' (no intents/${intent}.md)`);
  const { spec } = loaded;
  const { runner, name } = await pickRunner();
  const harness = makeHarness(runner);

  let source: string;
  if (flags.length > 0) source = await generate("");
  else {
    const gen = await generateWithRepair(generate, spec, harness);
    if (!gen.ok) die(`BUILD FAIL ${gen.reason}: ${gen.detail}`);
    source = gen.source;
  }

  console.log(`intent: ${intent}  handler: ${sha256Hex(source).slice(0, 12)}  runner: ${name}  (build path — dry run, nothing committed)\n`);
  let failed = false;
  for (const { input, outcome: out } of dryRun(harness, spec, source)) {
    console.log(`try ${JSON.stringify(input)}`);
    if (out.ok) {
      console.log(`  response: ${JSON.stringify(out.response)}`);
      console.log(`  effects (proposed, rolled back):\n${JSON.stringify(out.effects, null, 2).replace(/^/gm, "    ")}`);
    } else {
      failed = true;
      console.log(`  REJECTED at ${out.stage}: ${out.reason} — ${out.detail}`);
    }
  }
  console.log(failed ? "\nBUILD FAIL" : "\nBUILD PASS — all try inputs survived the harness; db rolled back");
  process.exit(failed ? 1 : 0);
}

const [cmd, ...args] = Bun.argv.slice(2);
if (cmd === "serve") await serve(args);
else if (cmd === "build" && args[0] && !args[0].startsWith("--")) await build(args[0], args.slice(1));
else die(USAGE);
