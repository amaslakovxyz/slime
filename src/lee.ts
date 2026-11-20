import { anthropicGenerate, dryRun, generateWithRepair } from "./build-path";
import { openAppDb } from "./db";
import { createFetchHandler, devSession } from "./dispatcher";
import { sha256Hex } from "./hash";
import { makeHarness } from "./harness";
import { FnRunner } from "./runner";
import { FileSlotStore } from "./slot-store";
import { makeIntentLoader } from "./spec";
import { GAS_TTL_MS, PROMOTE_HITS, type Generate, type RequestDeps, type Runner } from "./types";

const USAGE = "usage: lee serve [--handler-file <path>] | lee build <intent> [--handler-file <path>]";

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

// --handler-file switches generation to offline mode: every "generation" returns the file's bytes.
async function pickGenerate(flags: string[]): Promise<Generate> {
  if (flags.length === 0) return anthropicGenerate;
  if (flags.length !== 2 || flags[0] !== "--handler-file") die(USAGE);
  const path = flags[1];
  if (!(await Bun.file(path).exists())) die(`handler file not found: ${path}`);
  return async () => Bun.file(path).text();
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) die(`${name} must be a positive integer`);
  return Number(raw);
}

async function serve(flags: string[]) {
  const generate = await pickGenerate(flags);
  const ttlMs = positiveInt("LEE_GAS_TTL_MS", GAS_TTL_MS);
  const promoteHits = positiveInt("LEE_PROMOTE_HITS", PROMOTE_HITS);
  const { runner, name } = await pickRunner();
  const harness = makeHarness(runner);
  const deps: RequestDeps = {
    loadIntent: makeIntentLoader("intents"),
    store: new FileSlotStore(process.cwd(), { now: Date.now, ttlMs, promoteHits }),
    harness,
    db: openAppDb(process.env.LEE_DB ?? "data/lee.sqlite"),
    generateHandler: spec => generateWithRepair(generate, spec, harness),
  };
  const server = Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: createFetchHandler(deps, devSession) });
  console.log(`lee serve on http://localhost:${server.port}  runner: ${name}  gasTtlMs: ${ttlMs}  promoteHits: ${promoteHits}`);
}

async function build(intent: string, flags: string[]) {
  const generate = await pickGenerate(flags);
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
