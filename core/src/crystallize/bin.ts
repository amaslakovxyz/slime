#!/usr/bin/env node
// slime-crystal: for the app's CI and for whoever edits a Crystal folder.
//   check <dir>                          no database or model
//   pin <dir>                            after editing a module: re-check it, pin its hash, regenerate
//   verify <dir> --database-url <url>    equivalence with the pinned Liquid reference, and plan cost
import { checkCrystalFolder } from './check.js';
import { pinCrystalFolder } from './pin.js';
import { verifyCrystalFolder } from './verify.js';

const USAGE = 'usage: slime-crystal check <dir> | pin <dir> | verify <dir> --database-url <read-only url>';
const DATABASE_URL_FLAG = '--database-url';
const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;

const [command, dir, ...flags] = process.argv.slice(2);
if (!dir || !['check', 'pin', 'verify'].includes(command ?? '')) usage();

if (command === 'pin') {
  try {
    const keys = await pinCrystalFolder(dir!);
    console.log(keys.length > 0 ? `Pinned ${keys.length} edited Crystal module(s): ${keys.join(', ')}` : 'Nothing to pin: no module changed.');
  } catch (error) {
    fail(`Crystal pin failed: ${(error as Error).message}`);
  }
} else {
  const problems = command === 'verify' ? await verify(dir!) : await checkCrystalFolder(dir!);
  if (problems.length > 0) fail(`Crystal ${command} failed:\n  ${problems.join('\n  ')}`);
  console.log(`Crystal ${command} passed: ${dir}`);
}

async function verify(folder: string): Promise<string[]> {
  const urlIndex = flags.indexOf(DATABASE_URL_FLAG);
  const url = urlIndex >= 0 ? flags[urlIndex + 1] : undefined;
  if (!url) usage();
  const { postgresConnector } = await import('../sources/sql/postgres/index.js');
  const connector = postgresConnector({ url: url! });
  try {
    return await verifyCrystalFolder(folder, { connector });
  } finally {
    await connector.close();
  }
}

function usage(): never {
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

function fail(message: string): never {
  console.error(message);
  process.exit(EXIT_PROBLEMS);
}
