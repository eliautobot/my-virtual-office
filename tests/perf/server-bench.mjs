// Perf harness: server.py of ANY app/ folder on a private loopback port with a throwaway HOME (27 OpenClaw agents
// with real session transcripts on disk, the fake gateway from tests/test_life_e2e.py, Office Life on). Measures time,
// CPU and bytes per endpoint, ETag/304 and gzip, idle CPU and memory. Never touches a real office or gateway.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS = path.resolve(HERE, '..');
const FORBIDDEN = new Set([8085, 8088, 8090, 8095, 8096, 8097, 8099, 9128, 8642, 8954, 8977, 18789]);
const CLK = 100; // USER_HZ on Linux
const CHILDREN = new Set();   // killed on any exit, so a crash never leaves a private server behind
for (const ev of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(ev, (e) => {
    for (const c of CHILDREN) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    if (ev === 'uncaughtException') { console.error(e); process.exit(1); }
    if (ev !== 'exit') process.exit(1);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = x => Math.round(x * 100) / 100;

function cpuTicks(pid) {   // utime + stime of the whole process (all threads)
  const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const rest = f.slice(f.lastIndexOf(')') + 2).split(' ');
  return Number(rest[11]) + Number(rest[12]);
}
function rssMB(pid) {
  const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  return m ? Math.round(Number(m[1]) / 1024) : 0;
}

function seed(root, nAgents) {
  const home = path.join(root, 'home'); const oc = path.join(home, '.openclaw'); const data = path.join(root, 'data');
  fs.mkdirSync(oc, { recursive: true }); fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(root, 'run'), { recursive: true });
  const list = [];
  const words = 'the build test report review merge deploy plan check log file page data user agent office chat task fix'.split(' ');
  for (let i = 0; i < nAgents; i++) {
    const id = i === 0 ? 'main' : 'agent' + i;
    list.push({ id, name: 'Agent ' + i, default: i === 0 });
    const sdir = path.join(oc, 'agents', id, 'sessions'); fs.mkdirSync(sdir, { recursive: true });
    const sid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const t0 = Date.now() - 3 * 3600e3;
    fs.writeFileSync(path.join(sdir, 'sessions.json'), JSON.stringify({ [`agent:${id}:main`]: { sessionId: sid, updatedAt: t0 + 3000e3, label: 'Main' } }));
    const lines = [];
    for (let k = 0; k < 120; k++) {      // ~120 transcript entries per agent: user, assistant text + tool call, tool result
      const ts = new Date(t0 + k * 60e3).toISOString();
      const txt = Array.from({ length: 20 + (k * 7) % 90 }, (_, j) => words[(i + j * k) % words.length]).join(' ');
      if (k % 3 === 0) lines.push({ type: 'message', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: txt }] } });
      else if (k % 3 === 1) lines.push({ type: 'message', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: txt },
        { type: 'toolCall', id: 'c' + k, name: 'read', arguments: { path: 'notes/' + k + '.md' } }] } });
      else lines.push({ type: 'message', timestamp: ts, message: { role: 'toolResult', toolCallId: 'c' + (k - 1), content: [{ type: 'text', text: txt.repeat(4) }] } });
    }
    fs.writeFileSync(path.join(sdir, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(oc, 'openclaw.json'), JSON.stringify({ agents: { defaults: { model: 'fake/gpt-x' }, list },
    gateway: { port: 1, auth: { mode: 'token', token: 'test-token' } } }));
  fs.writeFileSync(path.join(data, 'vo-config.json'), JSON.stringify({ codex: { enabled: false }, claudeCode: { enabled: false },
    openCode: { enabled: false }, antigravity: { enabled: false }, hermes: { enabled: false }, officeLife: { enabled: true } }));
  fs.writeFileSync(path.join(root, 'run', 'serve.py'), `import os, runpy, socketserver, sys
try:
    import websockets
except Exception:
    websockets = None
_orig_bind = socketserver.TCPServer.server_bind
def _bind(self):
    host, port = self.server_address[:2]
    if host in ("0.0.0.0", "", "::"):
        self.server_address = ("127.0.0.1", port)
    return _orig_bind(self)
socketserver.TCPServer.server_bind = _bind
if websockets is not None:
    _orig_serve = websockets.serve
    def _serve(handler, host=None, port=None, *a, **kw):
        return _orig_serve(handler, "127.0.0.1" if host in ("0.0.0.0", "", None) else host, port, *a, **kw)
    websockets.serve = _serve
app = sys.argv[1]
sys.path.insert(0, app)
os.chdir(app)
sys.argv = [os.path.join(app, "server.py")]
runpy.run_path(os.path.join(app, "server.py"), run_name="__main__")
`);
  return { home, data, ids: list.map(a => a.id) };
}

async function waitHttp(url, secs) {
  for (let i = 0; i < secs * 4; i++) {
    try { const r = await get(url); if (r.status === 200) return true; } catch { /* retry */ }
    await sleep(250);
  }
  return false;
}

export async function startPrivateServer({ appDir, port = 18460, gwCtl = 18462, root, nAgents = 27, log = () => {} }) {
  for (const p of [port, port + 1, gwCtl]) if (FORBIDDEN.has(p)) throw new Error('refusing a shared port ' + p);
  root = root || fs.mkdtempSync(path.join(os.tmpdir(), 'vo-perf-srv-'));
  fs.rmSync(path.join(root, 'home'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
  const s = seed(root, nAgents);
  const py = 'python3';
  const site = await new Promise(res => {
    const c = spawn(py, ['-c', 'import os, websockets; print(os.path.dirname(os.path.dirname(websockets.__file__)))']);
    let o = ''; c.stdout.on('data', d => { o += d; }); c.on('close', () => res(o.trim())); c.on('error', () => res(''));
  });
  const portFile = path.join(root, 'run', 'gw.port'); fs.rmSync(portFile, { force: true });
  const gwLog = fs.openSync(path.join(root, 'gw.log'), 'w');
  const gw = spawn(py, ['-u', path.join(TESTS, 'test_life_e2e.py'), '--fake-gateway', portFile, String(gwCtl)],
    { stdio: ['ignore', gwLog, gwLog], env: { PATH: '/usr/bin:/bin', HOME: s.home, PYTHONPATH: [site, TESTS].filter(Boolean).join(':') } });
  CHILDREN.add(gw);
  for (let i = 0; i < 40 && !(fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim()); i++) await sleep(250);
  const gwPort = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8').trim() : '';
  if (!gwPort) { gw.kill('SIGTERM'); throw new Error('fake gateway did not start; see ' + root + '/gw.log'); }
  const srvLog = fs.openSync(path.join(root, 'server.log'), 'w');
  const srv = spawn(py, ['-u', path.join(root, 'run', 'serve.py'), path.resolve(appDir)], { stdio: ['ignore', srvLog, srvLog],
    env: { HOME: s.home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: site,
      VO_PORT: String(port), VO_WS_PORT: String(port + 1), VO_STATUS_DIR: s.data, OPENCLAW_HOME: path.join(s.home, '.openclaw'),
      VO_GATEWAY_URL: 'ws://127.0.0.1:' + gwPort, VO_GATEWAY_HTTP: 'http://127.0.0.1:' + gwPort, VO_GATEWAY_TOKEN: 'test-token' } });
  CHILDREN.add(srv);
  const url = 'http://127.0.0.1:' + port;
  const stop = async () => {
    for (const c of [srv, gw]) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
    await sleep(300);
    for (const c of [srv, gw]) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  };
  if (!(await waitHttp(url + '/health', 45))) { await stop(); throw new Error('private server did not answer; see ' + root + '/server.log'); }
  log('private server ' + url + ' pid ' + srv.pid + ' root ' + root);
  return { url, pid: srv.pid, ids: s.ids, root, stop };
}

// node:http, not fetch: undici asserts on some HTTP/1.0 close-delimited answers of the stdlib server.
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const t = performance.now();
    const req = http.get(url, { headers: Object.assign({ 'Accept-Encoding': 'identity' }, headers), agent: false }, res => {
      const parts = [];
      res.on('data', d => parts.push(d));
      res.on('end', () => {
        const b = Buffer.concat(parts);
        resolve({ status: res.statusCode, ms: performance.now() - t, body: b, etag: res.headers.etag || null,
          enc: res.headers['content-encoding'] || null, len: Number(res.headers['content-length'] || b.length) });
      });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export function endpointList(ids) {
  const three = ids.slice(0, 3).join(',');
  return [
    ['/', 'page'], ['/game.js', 'static'], ['/style.css', 'static'],
    ['/status', 'poll 5s'], [`/agent-chat?agents=${encodeURIComponent(three)}&limit=20&lite=1`, 'poll 3s'],
    ['/agent-chat?limit=20&lite=1', 'all agents'], ['/api/agents', 'roster'], ['/agents-list', 'roster'],
    ['/api/office-config', 'load'], ['/vo-config', 'load'], ['/api/office-life/state', 'load'],
    ['/api/previews?after=0', 'poll'], ['/api/meetings/active', 'poll'], ['/api/projects?status=active', 'load'],
    [`/api/agent-chat/tasks?agent=${ids[0]}&session=agent%3A${ids[0]}%3Amain&scope=chat`, 'poll'], ['/api/license', 'load'],
  ];
}

// Per endpoint: n sequential GETs; wall ms p50/p95, server CPU ms per request, raw/gzip bytes, ETag + 304 support.
export async function benchEndpoints(srv, { n = 15, idleCpuPerSec = 0 } = {}) {
  const out = [];
  for (const [p, role] of endpointList(srv.ids)) {
    const u = srv.url + p;
    let first;
    try { first = await get(u); } catch (e) { out.push({ path: p, role, error: String(e.message) }); continue; }
    const gz = await get(u, { 'Accept-Encoding': 'gzip' });
    const ms = [];
    const c0 = cpuTicks(srv.pid); const w0 = performance.now();
    for (let i = 0; i < n; i++) ms.push((await get(u, { 'Accept-Encoding': 'gzip' })).ms);
    const c1 = cpuTicks(srv.pid); const wall = (performance.now() - w0) / 1000;
    const cpuMs = Math.max(0, ((c1 - c0) * 1000 / CLK) - idleCpuPerSec * wall * 1000) / n;
    let revalidate = null;
    if (gz.etag) revalidate = (await get(u, { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.etag })).status;
    const sorted = ms.slice().sort((a, b) => a - b);
    out.push({ path: p.replace(/agents=[^&]*/, 'agents=3'), role, status: first.status, raw: first.body.length,
      gz: gz.enc === 'gzip' ? gz.body.length : null, etag: !!gz.etag, revalidate,
      p50: r2(sorted[Math.floor(n / 2)]), p95: r2(sorted[Math.floor(n * 0.95)]), cpuMs: r2(cpuMs) });
  }
  return out;
}

export async function idleCpu(srv, secs = 30) {
  const c0 = cpuTicks(srv.pid); const w0 = Date.now();
  await sleep(secs * 1000);
  const c1 = cpuTicks(srv.pid);
  const wall = (Date.now() - w0) / 1000;
  return { cpuPct: r2(100 * ((c1 - c0) / CLK) / wall), cpuMsPerSec: r2(1000 * ((c1 - c0) / CLK) / wall), rssMB: rssMB(srv.pid) };
}

// One browser client's steady polling mix replayed for `secs` (rates per minute by path from the client run).
export async function pollMix(srv, rates, secs = 30) {
  const plan = [];
  for (const [p, perMin] of Object.entries(rates)) if (perMin > 0) plan.push({ p, every: 60000 / perMin, next: 0, etag: null });
  const c0 = cpuTicks(srv.pid); const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    const now = Date.now() - t0;
    for (const x of plan) {
      if (now < x.next) continue;
      x.next = now + x.every;
      try {
        const r = await get(srv.url + x.p, x.etag ? { 'Accept-Encoding': 'gzip', 'If-None-Match': x.etag } : { 'Accept-Encoding': 'gzip' });
        if (r.etag) x.etag = r.etag;
      } catch { /* keep going */ }
    }
    await sleep(50);
  }
  const c1 = cpuTicks(srv.pid);
  const wall = (Date.now() - t0) / 1000;
  return { cpuPct: r2(100 * ((c1 - c0) / CLK) / wall), rssMB: rssMB(srv.pid) };
}

export function gzipLen(buf) { return zlib.gzipSync(buf, { level: 6 }).length; }
export { get };
