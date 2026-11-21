// `npm run local`: the admin (next dev) and the local runner in one command.
// Ctrl+C stops both; if either exits, the other is stopped too.
import { spawn } from 'node:child_process';

const port = process.env.PORT || '3100';
const children = [
  spawn('npx', ['next', 'dev', '-p', port], { stdio: 'inherit' }),
  spawn(process.execPath, ['--import', 'tsx', 'scripts/local-runner.ts'], { stdio: 'inherit' }),
];
let stopping = false;
const stopAll = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3500).unref();
};
for (const child of children) child.on('exit', (code) => stopAll(code ?? 0));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
