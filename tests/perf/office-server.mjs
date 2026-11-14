// Perf harness: a loopback-only fixture office for the browser runs.
// Serves the static files of ANY app/ folder the way server.py does (ETag + 304, gzip >= 1 KiB, no-cache) and answers
// the office API from a synthetic but live-like office: 27 agents across OpenClaw / Hermes / Codex / Claude Code, a
// /status that changes every poll when busy, /agent-chat (lite) with fresh messages, Office Life state + a real
// long-lived SSE stream. Every non-GET is refused with 405 and counted, so a run can never write anywhere.
// Layout and Office Life state may come from a captured fixtures folder (see capture() in run.mjs); agents, chat and
// status are always synthetic (no personal data).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.webp': 'image/webp',
};
const GZIP_TYPES = /^(text\/|application\/json|application\/javascript|image\/svg)/;
const KINDS = ['openclaw', 'hermes', 'codex', 'claude-code'];
// 27 agents: 13 OpenClaw, 6 Hermes, 4 Codex, 4 Claude Code (the mix of a real multi-provider office).
const KIND_PLAN = [].concat(Array(13).fill('openclaw'), Array(6).fill('hermes'), Array(4).fill('codex'), Array(4).fill('claude-code'));
const NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eve', 'Fin', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kai', 'Lu', 'Max', 'Nia', 'Oz', 'Pia',
  'Quin', 'Rex', 'Sol', 'Tia', 'Uma', 'Vic', 'Wes', 'Xan', 'Yui', 'Zed', 'Ace', 'Bea', 'Cal', 'Dot'];
const TASKS = ['Reviewing the pull request', 'Writing the release notes', 'Running the test suite', 'Reading the logs',
  'Fixing a flaky test', 'Drafting the weekly report', 'Searching the docs', 'Refactoring the parser'];
const WORDS = ('the a build test report review merge deploy plan check log file page data user agent office chat task note '
  + 'fix bug patch step run tool result summary error ok done next draft queue sync').split(' ');

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function sentence(r, n) { const w = []; for (let i = 0; i < n; i++) w.push(WORDS[Math.floor(r() * WORDS.length)]); return w.join(' ') + '.'; }

export function loadFixtures(dir) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* skip */ }
  }
  return out;
}

// Build the synthetic office. `fix` = captured fixtures ({office_config, office_life_state, vo_config} optional).
export function buildOffice(appDir, fix = {}, nAgents = 27) {
  let cfg = fix.office_config;
  if (!cfg) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(appDir, 'default-office-config.json'), 'utf8')); } catch { cfg = {}; }
  }
  cfg = JSON.parse(JSON.stringify(cfg));
  const placed = Array.isArray(cfg.agents) ? cfg.agents : [];
  const r = rng(42);
  const agents = [];
  for (let i = 0; i < nAgents; i++) {
    const kind = KIND_PLAN[i % KIND_PLAN.length];
    const id = placed[i] ? placed[i].id : `${kind === 'openclaw' ? 'oc' : kind}-${i}`;
    const name = NAMES[i % NAMES.length];
    if (placed[i]) { placed[i].name = name; placed[i].statusKey = placed[i].statusKey || id; }
    agents.push({ id, statusKey: (placed[i] && placed[i].statusKey) || id, name, kind, emoji: '🤖', role: 'Agent ' + (i + 1) });
  }
  cfg.agents = placed.slice(0, nAgents);
  const chat = {};
  agents.forEach((a, i) => {
    const msgs = [];
    const base = Date.now() - 3600e3;
    for (let k = 0; k < 14; k++) {
      const user = k % 2 === 0;
      const ms = base + (i * 14 + k) * 9000;
      msgs.push({ role: user ? 'user' : 'assistant', text: sentence(r, user ? 8 : 30 + Math.floor(r() * 60)),
        ts: new Date(ms).toISOString(), epochMs: ms, from: user ? 'You' : a.name, fromType: user ? 'user' : 'agent',
        tools: user ? [] : [{ name: 'read', status: 'done' }], approval: null, attachments: [] });
    }
    chat[a.statusKey] = msgs;
  });
  const lifeState = fix.office_life_state || { ok: true, seq: 1, settings: { enabled: true, calm: false, features: {} },
    open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], birthdayYears: {}, cake: false }, paper: { ready: false } };
  const voConfig = Object.assign({ version: '0.10.0', office: { name: 'Perf office' }, features: {} }, fix.vo_config || {},
    { officeLife: { enabled: true } });
  return { cfg, agents, chat, lifeState, voConfig };
}

// Live-like /status: idle = the usual mix (1 working, 2 offline, rest idle); busy = two thirds working, tools running,
// one waiting for approval, all changing every 5 s tick.
function statusPayload(office, busy, tick) {
  const out = {};
  office.agents.forEach((a, i) => {
    let state = 'idle'; let task = '';
    if (busy) { if ((i + tick) % 3 !== 0) { state = 'working'; task = TASKS[(i + tick) % TASKS.length]; } }
    else if (i === 0) { state = 'working'; task = TASKS[0]; } else if (i >= office.agents.length - 2) state = 'offline';
    out[a.statusKey] = { state, task, updated: Math.floor(Date.now() / 1000) - (busy ? 0 : 600), source: 'snapshot',
      activeRunCount: state === 'working' ? 1 : 0, activeToolCount: busy && state === 'working' && (i + tick) % 2 ? 1 : 0,
      waitingApprovalCount: busy && i === 3 ? 1 : 0,
      providerHealth: { connected: state !== 'offline', connectionState: state === 'offline' ? 'disconnected' : 'connected',
        providerKind: a.kind, error: '', updated: busy ? Math.floor(Date.now() / 1000) : 1 } };
  });
  out._meetings = [];
  return out;
}

function agentRows(office) {
  return office.agents.map(a => ({ id: a.id, statusKey: a.statusKey, key: a.statusKey, agentId: a.id, sessionKey: `agent:${a.id}:main`,
    providerKind: a.kind, providerType: a.kind, providerAgentId: a.id, providerConnectionId: a.kind + '-1', name: a.name,
    emoji: a.emoji, role: a.role, model: 'model-x', provider: a.kind, profile: 'default', apiAvailable: true, cliAvailable: false,
    connectionModes: ['api'], capabilities: {}, available: true, enabled: true }));
}

// start({appDir, office, port?, mode: 'idle'|'busy'}) -> {url, stats, setMode, close}
export function startOfficeServer({ appDir, office, port = 0, mode = 'idle', sseEveryMs = 15000 }) {
  appDir = path.resolve(appDir);
  const fileCache = new Map();
  const stats = { started: Date.now(), requests: [], refused: [] };
  let busy = mode === 'busy';
  let chatSeq = 0;
  const streams = new Set();
  const tickOf = () => Math.floor(Date.now() / 5000);
  let lastChatTick = -1;

  function grow() {           // busy: three agents get a new message per 5 s tick
    const t = tickOf();
    if (!busy || t === lastChatTick) return;
    lastChatTick = t;
    for (let j = 0; j < 3; j++) {
      const a = office.agents[(t * 3 + j) % office.agents.length];
      const ms = Date.now();
      const list = office.chat[a.statusKey];
      list.push({ role: 'assistant', text: 'Update ' + (++chatSeq) + ': ' + TASKS[chatSeq % TASKS.length] + '.', ts: new Date(ms).toISOString(),
        epochMs: ms, from: a.name, fromType: 'agent', tools: [{ name: 'exec', status: 'running' }], approval: null, attachments: [] });
      if (list.length > 40) list.shift();
    }
  }
  function api(u) {
    const p = u.pathname;
    if (p === '/status') return statusPayload(office, busy, tickOf());
    if (p === '/agent-chat') {
      grow();
      const want = (u.searchParams.get('agents') || '').split(',').filter(Boolean);
      const limit = Number(u.searchParams.get('limit') || 20);
      const out = {};
      for (const [k, v] of Object.entries(office.chat)) if (!want.length || want.includes(k)) out[k] = v.slice(-limit);
      out._projectWork = {};
      return out;
    }
    if (p === '/api/agents') return { agents: agentRows(office) };
    if (p === '/agents-list') return { agents: agentRows(office) };
    if (p === '/api/office-config') return office.cfg;
    if (p === '/vo-config') return office.voConfig;
    if (p === '/api/license') return { valid: true, demo: false, limits: {}, plan: 'perf' };
    if (p === '/api/office-life/state') return office.lifeState;
    if (p === '/api/previews') return { ok: true, schemaVersion: '1', cursor: Number(u.searchParams.get('after') || 0), previews: [] };
    if (p === '/api/meetings/active') return [];
    if (p === '/api/agent-chat/tasks') return { ok: true, tasks: [] };
    if (p === '/api/agent-chat/can') return { ok: true, can: { send: true, stop: true, attach: true } };
    if (p === '/api/projects') return { projects: [] };
    if (p === '/api/projects/scores') return { scores: {} };
    if (p === '/weather-proxy') return { current_condition: [], configured: false };
    if (p === '/gateway-info') return { connected: true, url: '', mode: 'perf' };
    if (p === '/browser-status' || p === '/sms-status') return { enabled: false };
    if (p === '/health') return { ok: true };
    return undefined;
  }
  function send(req, res, status, type, body, extra = {}) {
    const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': type.startsWith('application/json') ? 'no-store' : 'no-cache' }, extra);
    if (status === 200 && req.method === 'GET') {
      const etag = '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 24) + '"';
      headers.ETag = etag;
      const inm = String(req.headers['if-none-match'] || '');
      if (inm && inm.replace(/-gz/g, '').includes(etag.slice(1, -1))) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] }); res.end();
        return { status: 304, bytes: 0, raw: body.length };
      }
    }
    let out = body;
    if (body.length >= 1024 && GZIP_TYPES.test(type) && /gzip/.test(String(req.headers['accept-encoding'] || ''))) {
      out = zlib.gzipSync(body, { level: 6 }); headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
      if (headers.ETag) headers.ETag = headers.ETag.slice(0, -1) + '-gz"';
    }
    headers['Content-Length'] = out.length;
    res.writeHead(status, headers); res.end(out);
    return { status, bytes: out.length, raw: body.length };
  }
  function staticFile(p) {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.replace(/^\/+/, ''));
    const file = path.resolve(appDir, rel);
    if (!file.startsWith(appDir + path.sep)) return null;
    const ext = path.extname(file).toLowerCase();
    if (!TYPES[ext]) return null;
    let st; try { st = fs.statSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    const hit = fileCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const entry = { body: fs.readFileSync(file), type: TYPES[ext], mtime: st.mtimeMs };
    fileCache.set(file, entry);
    return entry;
  }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://office.test');
    const t0 = process.hrtime.bigint();
    const rec = (r, kind) => stats.requests.push({ t: Date.now(), p: u.pathname, kind, status: r.status, bytes: r.bytes, raw: r.raw,
      ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      stats.refused.push({ t: Date.now(), m: req.method, p: u.pathname });
      req.resume(); res.writeHead(405, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"perf":"read-only"}');
      return;
    }
    if (u.pathname === '/api/office-life/stream' || u.pathname === '/api/agent-chat/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': perf\n\n');
      const s = { res, n: 0 };
      streams.add(s);
      rec({ status: 200, bytes: 0, raw: 0 }, 'sse');
      req.on('close', () => streams.delete(s));
      return;
    }
    const data = api(u);
    if (data !== undefined) return rec(send(req, res, 200, 'application/json', Buffer.from(JSON.stringify(data))), 'api');
    const f = staticFile(u.pathname);
    if (f) return rec(send(req, res, 200, f.type, f.body), 'static');
    if (u.pathname.startsWith('/api/') || !path.extname(u.pathname)) {
      return rec(send(req, res, 200, 'application/json', Buffer.from('{}')), 'api');
    }
    res.writeHead(404); res.end(); rec({ status: 404, bytes: 0, raw: 0 }, 'static');
  });
  const hb = setInterval(() => {
    for (const s of streams) { try { s.res.write(': hb ' + (++s.n) + '\n\n'); } catch { /* closed */ } }
  }, sseEveryMs);
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + server.address().port;
    resolve({
      url, stats,
      setMode(m) { busy = m === 'busy'; },
      close() { clearInterval(hb); for (const s of streams) { try { s.res.end(); } catch { /* */ } } server.closeAllConnections?.(); return new Promise(r => server.close(() => r())); },
    });
  }));
}

export { KINDS };
