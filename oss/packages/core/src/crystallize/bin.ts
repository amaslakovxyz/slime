#!/usr/bin/env node
// slime-crystal check <dir>: for the app's CI. Needs no database or model.
import { checkCrystalFolder } from './check.js';

const USAGE = 'usage: slime-crystal check <crystal folder>';
const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;

const [command, dir] = process.argv.slice(2);
if (command !== 'check' || !dir) {
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}
const problems = await checkCrystalFolder(dir);
if (problems.length > 0) {
  console.error(`Crystal check failed:\n  ${problems.join('\n  ')}`);
  process.exit(EXIT_PROBLEMS);
}
console.log(`Crystal check passed: ${dir}`);
