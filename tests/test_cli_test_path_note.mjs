// Test buttons of the Codex / Claude Code setup (setup.html and Settings -> Models): the server never runs a CLI path
// a test request sends (only the saved one), so a path typed and not saved yet must not look tested. The result then
// says the typed path is used once saved; with no typed change it says nothing extra.
// Real Chrome against a PRIVATE server from this tree (scratch data dir, free loopback port).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { APP, launch } from './test_v10_editor_lib.mjs';

const PORT = await new Promise((resolve, reject) => {
  const srv = net.createServer(); srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-clipath-'));
fs.mkdirSync(path.join(dataDir, 'openclaw'), { recursive: true });
const code = ['import sys', `sys.path.insert(0, ${JSON.stringify(APP)})`, 'import server',
  `httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", ${PORT}), server.OfficeHandler)`,
  'print("ready", flush=True)', 'httpd.serve_forever()'].join('\n');
const env = Object.assign({}, process.env, { VO_STATUS_DIR: dataDir, VO_CONFIG: path.join(dataDir, 'vo-config.json'),
  VO_OPENCLAW_PATH: path.join(dataDir, 'openclaw'), OPENCLAW_HOME: path.join(dataDir, 'home'), VO_CODEX_BIN: path.join(dataDir, 'no-cli', 'codex'), VO_CODEX_HOME: path.join(dataDir, 'codex-home'),
  VO_CLAUDE_CODE_BIN: path.join(dataDir, 'no-cli', 'claude'), VO_CLAUDE_CODE_HOME: path.join(dataDir, 'claude-home'), VO_CODEX_INCLUDE_NATIVE_AGENTS: '0', VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS: '0' });
const proc = spawn('python3', ['-c', code], { env, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('private server did not start')), 60000);
  proc.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(t); resolve(); } });
  proc.on('exit', (c) => { clearTimeout(t); reject(new Error('private server exited ' + c)); });
});

const NOTE = /CLI path you typed is used once you (finish setup|save)|only run once it is saved/;
const TYPED = path.join(dataDir, 'not-saved', 'codex');
const browser = await launch('test_cli_test_path_note');
let failed = 0;
const check = (ok, name) => { console.log((ok ? '[PASS] ' : '[FAIL] ') + name); if (!ok) failed++; };
async function settled(page, sel) {
  let t = '';
  for (let i = 0; i < 60; i++) { t = (await page.locator(sel).innerText().catch(() => '')).trim(); if (t && !/^Testing/.test(t)) break; await page.waitForTimeout(500); }
  return t;
}
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  // setup.html (first run): Codex panel
  await page.goto(BASE + '/setup.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('s-codex-bin'), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const p = document.getElementById('s-codex-bin').closest('[data-panel], .step-panel, section'); if (p) { p.hidden = false; p.style.display = 'block'; } });
  await page.locator('[data-action="test-codex"]').evaluate(b => b.click());
  let t = await settled(page, '#codex-test-status');
  check(t && !NOTE.test(t), 'setup: no typed path -> plain result');
  await page.locator('#s-codex-bin').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, TYPED);
  await page.locator('[data-action="test-codex"]').evaluate(b => b.click());
  t = await settled(page, '#codex-test-status');
  check(NOTE.test(t), 'setup: typed, unsaved Codex path -> the result says it is used once setup is finished');

  // Settings -> Models: Codex section
  await page.goto(BASE + '/models.html', { waitUntil: 'load' });
  const shown = await page.waitForFunction(() => document.getElementById('setup-codex-bin'), null, { timeout: 30000 }).then(() => true).catch(() => false);
  check(shown, 'models: the Codex setup form is there');
  if (shown) {
    await page.locator('#setup-codex-bin').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, TYPED);
    await page.locator('[data-action="test-codex"]').first().evaluate(b => b.click());
    t = await settled(page, '#setup-codex-status');
    check(NOTE.test(t), 'models: typed, unsaved Codex path -> the result says it is used once saved');
  }
  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors[0] : ''));
} finally {
  await browser.close();
  proc.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
if (failed) { console.log(`FAILED test_cli_test_path_note: ${failed}`); process.exit(1); }
console.log('ALL test_cli_test_path_note checks passed');
