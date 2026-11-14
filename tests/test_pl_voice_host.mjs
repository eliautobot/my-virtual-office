// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The office's voice on the provider layer (vo-host.mjs + server/voice/ + vo-voice.mjs), end to end over HTTP with fake
// voice services (no real keys): the office's Whisper server adopted once; a voice service added with a key that is
// never sent back nor logged; Settings → Voice saved and read back after a restart; an account's defaults (auto read,
// speed); an agent's own voice saved with it and used when it speaks; "default" again; dictation heard by the listening
// service; what a member may not do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHost } from '../app/provider-layer/vo-host.mjs';
import { signPrincipal, PRINCIPAL_HEADER } from '../app/provider-layer/vo-router.mjs';
import { wav } from './helpers/pl-voice-audio.mjs';

const KEY = 'SECRET-VOICE-KEY-7f3a9c';
const secret = 'test-boot-secret-0123456789';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-uV-voice-host-'));
const officeDir = path.join(tmp, 'office'), data = path.join(officeDir, 'provider-layer');
fs.mkdirSync(data, { recursive: true });

// the fakes: an OpenAI-compatible speech server (/v1) and the office's Whisper server (/transcribe)
const seen = [];
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    let json = null; try { json = JSON.parse(raw.toString()); } catch { /* audio */ }
    seen.push({ url: req.url, headers: req.headers, json, bytes: raw.length });
    if (req.url === '/v1/audio/speech') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(wav(0.4)); }
    if (req.url === '/v1/audio/voices') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ voices: ['af_bella', 'am_adam', 'bf_emma'] })); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'kokoro' }, { id: 'kokoro-hd' }, { id: 'whisper-1' }] })); }
    if (req.url === '/whisper/transcribe') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ text: 'hello from the office whisper' })); }
    res.writeHead(404); res.end();
  });
});

const logs = [];
const log = Object.assign((...a) => logs.push(a.join(' ')), { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), debug: () => {} });
let h = null, base = '';
async function start() {
  h = await createHost({ data, secret, keyFile: path.join(tmp, 'pl.key'), officeDir, log });
  await new Promise(r => h.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${h.server.address().port}`;
  for (let i = 0; i < 100 && !h.registry.implemented('voice'); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(h.registry.implemented('voice'), 'the helper loaded the voice adapter');
}
const who = role => signPrincipal(secret, { role, via: 'session', authAt: Date.now(), csrf: 'csrf-1' });
const bodies = [];
async function call(method, url, body, { role = 'owner', raw = null, type = null } = {}) {
  const headers = { [PRINCIPAL_HEADER]: who(role), 'x-csrf-token': 'csrf-1' };
  if (body !== undefined && raw === null) headers['content-type'] = 'application/json';
  if (raw) headers['content-type'] = type || 'application/octet-stream';
  const r = await fetch(base + url, { method, headers, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = /json/.test(r.headers.get('content-type') || '') ? buf.toString() : '';
  bodies.push(text);
  return { status: r.status, json: text ? JSON.parse(text) : null, buf, headers: r.headers };
}

test.before(async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  fs.writeFileSync(path.join(officeDir, 'vo-config.json'), JSON.stringify({ features: { whisper: true }, whisper: { url: `http://127.0.0.1:${port}/whisper` } }));
  await start();
});
test.after(async () => { try { await h?.close(); } catch { /* closing */ } fake.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let kokoro = null, whisper = null, ada = null, bob = null;

test('the office\'s Whisper server becomes its listening service, once', async () => {
  const c = await call('GET', '/api/connections');
  const list = c.json.connections.filter(x => x.kind === 'voice');
  assert.equal(list.length, 1); assert.equal(list[0].config.provider, 'whisper'); assert.equal(list[0].scope, 'installation');
  whisper = list[0].id;
  const s = await call('GET', '/api/voice/settings');
  assert.equal(s.status, 200); assert.equal(s.json.values.listenConnection, String(whisper));
});

test('a voice service is added with a key that is never sent back and never logged', async () => {
  const port = fake.address().port;
  const r = await call('POST', '/api/connections', { kind: 'voice', label: 'Kokoro here', scope: 'installation',
    config: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, does: 'speak', speakModel: 'kokoro' }, secrets: { apiKey: KEY } });
  assert.equal(r.status, 200, JSON.stringify(r.json)); kokoro = r.json.id;
  const t = await call('POST', '/api/connections/test', { id: kokoro });
  assert.equal(t.json.ok, true, JSON.stringify(t.json));
  assert.equal(seen.filter(x => x.url === '/v1/audio/speech').at(-1).headers.authorization, `Bearer ${KEY}`, 'the key reaches the service');
  const g = await call('GET', '/api/connections');
  const mine = g.json.connections.find(x => x.id === kokoro);
  assert.ok(mine.secrets && !JSON.stringify(mine.secrets).includes(KEY), 'the page sees only that a key is set');
  const v = await call('GET', `/api/voice/voices?connection=${kokoro}`);
  assert.deepEqual(v.json.voices.map(x => x.id), ['af_bella', 'am_adam', 'bf_emma'], 'the voices come from the service');
  const m = await call('GET', `/api/voice/models?connection=${kokoro}`);
  assert.equal(m.status, 200, JSON.stringify(m.json));
  assert.deepEqual(m.json.speak, ['kokoro', 'kokoro-hd'], 'the models come from the service (its speaking ones: it only speaks)');
  assert.deepEqual(m.json.listen, []);
  assert.equal((await call('GET', '/api/voice/models?connection=999')).status, 404);
  const u = await call('POST', '/api/connections/update', { id: kokoro, config: { speakModel: 'kokoro-hd' } });
  assert.equal(u.status, 200, JSON.stringify(u.json)); assert.equal(u.json.config.speakModel, 'kokoro-hd');
});

test('Settings → Voice is saved, read back after a restart, and only the owner changes it', async () => {
  const bad = await call('POST', '/api/voice/settings', { values: { listenConnection: kokoro } });
  assert.equal(bad.status, 400, 'a speaking-only server is not the one that hears');
  const ok = await call('POST', '/api/voice/settings', { values: { speakConnection: String(kokoro), perMinute: '120', dailyUsd: '0' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const p = await call('POST', '/api/voice/prefs', { autoRead: true, speak: { speed: 1.25 }, listen: { language: 'en-US' } });
  assert.equal(p.status, 200, JSON.stringify(p.json)); assert.equal(p.json.autoRead, true);
  assert.equal((await call('GET', '/api/voice/settings', undefined, { role: 'member' })).status, 403, 'a member does not see the office\'s voice settings');
  assert.equal((await call('POST', '/api/voice/settings', { values: { enabled: false } }, { role: 'member' })).status, 403);
  await h.close();
  await start();
  const s = await call('GET', '/api/voice/settings');
  assert.deepEqual(s.json.values, { enabled: true, listenConnection: String(whisper), speakConnection: String(kokoro), perMinute: '120', dailyUsd: '0' });
  const o = await call('GET', '/api/voice/options');
  assert.equal(o.json.prefs.autoRead, true); assert.equal(o.json.prefs.speak.speed, 1.25); assert.equal(o.json.prefs.listen.language, 'en-US');
  assert.equal(o.json.speak.service.id, kokoro); assert.equal(o.json.listen.service.id, whisper);
  assert.equal((await call('GET', '/api/connections')).json.connections.filter(x => x.kind === 'voice').length, 2, 'the Whisper server was adopted once, not again');
});

test('an agent\'s own voice is saved with it and used when it speaks; "default" again', async () => {
  ada = h.agents.create({ key: 'office:ada', name: 'Ada' }).id;
  bob = h.agents.create({ key: 'office:bob', name: 'Bob' }).id;
  const set = await call('POST', '/api/voice/agent', { agent: ada, for: kokoro, voice: 'bf_emma', speed: 0.9 });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(h.agents.get(ada).voice.voices[String(kokoro)], 'bf_emma', 'kept with the agent (agents.voice_json)');
  const o = await call('GET', `/api/voice/options?agent=${ada}`);
  assert.equal(o.json.speak.voice, 'bf_emma'); assert.equal(o.json.agent.manage, true);
  const n = seen.length;
  const r = await call('POST', '/api/voice/speak', { agent: ada, text: 'Hello from Ada.', long: true });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /audio/); assert.ok(r.buf.length > 1000, 'audio bytes');
  const q = seen.slice(n).find(x => x.url === '/v1/audio/speech');
  assert.equal(q.json.voice, 'bf_emma'); assert.equal(q.json.input, 'Hello from Ada.');
  // Bob has none: one of the service's voices is picked for him, not Ada's
  const b = await call('GET', `/api/voice/options?agent=${bob}`);
  assert.ok(b.json.speak.voice && b.json.speak.voice !== 'bf_emma', b.json.speak.voice);
  // back to the default: Ada's service choice "default" (null) keeps the office's speaking service
  const d = await call('POST', '/api/voice/agent', { agent: ada, connection: null, for: kokoro, voice: '' });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const o2 = await call('GET', `/api/voice/options?agent=${ada}`);
  assert.equal(o2.json.speak.service.id, kokoro); assert.notEqual(o2.json.speak.chosen, true);
  // a member hears agents but does not change their voice
  assert.equal((await call('POST', '/api/voice/speak', { agent: ada, text: 'Hi.' }, { role: 'member' })).status, 200);
  assert.equal((await call('POST', '/api/voice/agent', { agent: ada, voice: 'am_adam', for: kokoro }, { role: 'member' })).status, 404);
});

test('dictation is heard by the listening service (the office\'s Whisper server)', async () => {
  const n = seen.length;
  const r = await call('POST', '/api/voice/transcribe', undefined, { raw: wav(1), type: 'audio/wav' });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.text, 'hello from the office whisper');
  assert.ok(seen.slice(n).some(x => x.url === '/whisper/transcribe' && x.bytes === wav(1).length));
});

test('the key never shows in any answer or log line', () => {
  for (const b of bodies) assert.ok(!b.includes(KEY), 'an answer carried the key');
  for (const l of logs) assert.ok(!l.includes(KEY), `a log line carried the key: ${l.slice(0, 80)}`);
});
