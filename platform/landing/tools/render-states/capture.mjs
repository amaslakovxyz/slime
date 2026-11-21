// Render state.html?s=<state> in headless Chrome and save a transparent WebP per state.
// usage: node capture.mjs <outDir> [preview]   (preview renders on a dark background)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
const preview = process.argv[3] === 'preview';
const here = dirname(fileURLToPath(import.meta.url));
const port = 9500 + Math.floor(Math.random() * 90);
const proc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, '--window-size=960,720', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets; for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
for (const s of ['gas', 'liquid', 'crystal']) {
  await send('Page.navigate', { url: `file://${here}/state.html?s=${s}${preview ? '&bg=1' : ''}` });
  for (let i = 0; i < 60 && !(await ev('window.__done === true')); i++) await sleep(250);
  await sleep(500);
  const r = await send('Page.captureScreenshot', { format: 'webp', quality: 88, clip: { x: 0, y: 0, width: 960, height: 720, scale: 1 } });
  writeFileSync(join(out, preview ? `prev-${s}.webp` : `state-${s}.webp`), Buffer.from(r.result.data, 'base64'));
  console.log('saved', s);
}
ws.close(); proc.kill();
