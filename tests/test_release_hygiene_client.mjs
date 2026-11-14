// Release hygiene for the public client files (app/ pages, scripts, styles, the provider-layer client) and the
// browser tests that ship next to them: nothing personal or tied to one install.
//   - no home folders of a real user (/home/<name>/, /Users/<name>/; the documented "youruser" placeholder is fine)
//   - no Tailscale / CGNAT addresses (100.64.0.0/10) or *.ts.net names in app/ (tests may use made-up ones to test
//     the address rules)
//   - no review quotes credited to a person and a date in comments ("(<Name> <M>-<D>: ...")
//   - optional: VO_PRIVATE_NAMES_FILE = a local file (never committed) with one private name per line (owner, agent
//     names); none may appear as a word.
// No browser, no server. node tests/test_release_hygiene_client.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.ts']);
const SKIP = new Set(['marked.min.js', 'node_modules', 'vendor']);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}

const APP = path.join(ROOT, 'app');
const appFiles = fs.readdirSync(APP, { withFileTypes: true })
  .filter(e => e.isFile() && EXT.has(path.extname(e.name)) && !SKIP.has(e.name)).map(e => path.join(APP, e.name))
  .concat(...['office-life', 'furniture-variants', 'provider-layer/client'].map(d => walk(path.join(APP, d), [])));
const testFiles = fs.readdirSync(path.join(ROOT, 'tests')).filter(n => /\.(mjs|cjs|js)$/.test(n)).map(n => path.join(ROOT, 'tests', n));

const HOME = /\/(?:home|Users)\/(?!youruser\/|user\/|you\/|me\/)[A-Za-z][A-Za-z0-9_.-]*\//;
const CGNAT = /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b|\b[a-z0-9-]+\.ts\.net\b/i;
const CREDIT = /\([A-Z][a-z]{1,15} \d{1,2}-\d{1,2}\b/;
let names = [];
if (process.env.VO_PRIVATE_NAMES_FILE) {
  names = fs.readFileSync(process.env.VO_PRIVATE_NAMES_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s.length >= 3);
}
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAMES = names.length ? new RegExp('\\b(?:' + names.map(escape).join('|') + ')\\b') : null;

const problems = [];
function scan(file, rules) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [what, re] of rules) if (re && re.test(line)) problems.push(`${path.relative(ROOT, file)}:${i + 1} ${what}`);
  });
}
for (const f of appFiles) scan(f, [['home folder', HOME], ['tailnet address', CGNAT], ['credited review quote', CREDIT], ['private name', NAMES]]);
for (const f of testFiles) scan(f, [['home folder', HOME], ['credited review quote', CREDIT], ['private name', NAMES]]);

if (problems.length) {
  // File and line only (never the matched text: it may be the private value itself).
  for (const p of problems.slice(0, 40)) console.log('FAIL ' + p);
  console.log(`FAIL release hygiene: ${problems.length} line(s)`);
  process.exit(1);
}
console.log(`PASS release hygiene: ${appFiles.length} app files, ${testFiles.length} test files${NAMES ? `, ${names.length} private names` : ''}`);
