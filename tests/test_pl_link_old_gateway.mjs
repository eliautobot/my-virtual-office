// v0.11 older OpenClaw gateways (2026.7.x, what a 0.7.4 office runs against) for the copied OpenClaw link
// (app/provider-layer/server/providers/openclaw/link.js): a request with a parameter such a gateway does not know yet
// ("invalid <method> params: at root: unexpected property 'x'") is asked again without it, the method remembers that,
// and any other refusal is passed on as before. Fake gateway client, no network.  Run: node tests/test_pl_link_old_gateway.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GatewayLink, unknownParams } = await import(path.join(here, '../app/provider-layer/server/providers/openclaw/link.js'));
const ALL = ['operator.read', 'operator.write', 'operator.approvals', 'operator.questions', 'operator.admin'];
const tick = () => new Promise(r => setTimeout(r, 5));
const KNOWN = { 'models.list': ['sessionKey'], 'sessions.messages.subscribe': ['key'], 'chat.send': ['sessionKey', 'message'] };

function rig() {
  const calls = [];
  let hello = null;
  class Client {
    constructor(o) { this.o = o; }
    start() { hello = () => this.o.onHelloOk({ server: { version: '2026.7.1-2' }, auth: { scopes: ALL }, features: { methods: Object.keys(KNOWN), events: [] } }); setTimeout(hello, 1); }
    async request(method, params) {
      calls.push([method, Object.keys(params).sort().join(',')]);
      const extra = Object.keys(params).filter(k => !KNOWN[method].includes(k));
      if (method === 'chat.send' && params.message === 'boom') throw Object.assign(new Error('invalid chat.send params: at /message: too long'), { gatewayCode: 'INVALID_REQUEST' });
      if (extra.length) throw Object.assign(new Error(`invalid ${method} params: ${extra.map(k => `at root: unexpected property '${k}'`).join('; ')}`), { gatewayCode: 'INVALID_REQUEST' });
      return { ok: true, method };
    }
    stop() {}
    stopAndWait() { return Promise.resolve(); }
  }
  const link = new GatewayLink({ connectionId: '1', emit: () => {}, persist: () => {}, Client });
  link.configure({ url: 'ws://127.0.0.1:18822', auth: 'token', access: 'full' }, { token: 'tok' });
  return { link, calls, rehello: () => hello() };
}

let pass = 0;
async function t(name, fn) { await fn(); pass++; console.log('ok', name); }

await t('unknownParams: only top-level properties this request sent', () => {
  const e = new Error("invalid models.list params: at root: unexpected property 'agentId'; at root: unexpected property 'x'");
  assert.deepEqual(unknownParams(e, { agentId: 'main', sessionKey: 's' }), ['agentId']);
  assert.deepEqual(unknownParams(new Error("invalid x params: at /a: unexpected property 'b'"), { b: 1 }), []);
  assert.deepEqual(unknownParams(new Error('missing scope: operator.read'), { agentId: 1 }), []);
  assert.deepEqual(unknownParams(null, { a: 1 }), []);
});

await t('asked again without the unknown parameter; the method remembers it until the next hello', async () => {
  const { link, calls, rehello } = rig();
  await tick();
  assert.deepEqual(await link.request('models.list', { agentId: 'main', sessionKey: 's' }), { ok: true, method: 'models.list' });
  assert.deepEqual(calls, [['models.list', 'agentId,sessionKey'], ['models.list', 'sessionKey']]);
  calls.length = 0;
  await link.request('models.list', { agentId: 'ops', sessionKey: 's' });
  assert.deepEqual(calls, [['models.list', 'sessionKey']], 'remembered: one call');
  calls.length = 0;
  await link.request('sessions.messages.subscribe', { key: 'k', agentId: 'main', includeApprovals: true });
  assert.deepEqual(calls, [['sessions.messages.subscribe', 'agentId,includeApprovals,key'], ['sessions.messages.subscribe', 'key']]);
  calls.length = 0;
  rehello(); await tick();   // (a gateway that reconnects may have been updated: learned again)
  await link.request('models.list', { agentId: 'main', sessionKey: 's' });
  assert.deepEqual(calls, [['models.list', 'agentId,sessionKey'], ['models.list', 'sessionKey']]);
});

await t('other refusals are passed on unchanged, with the gateway code', async () => {
  const { link, calls } = rig();
  await tick();
  await assert.rejects(link.request('chat.send', { sessionKey: 's', message: 'boom' }), e => e.code === 'INVALID_REQUEST' && /too long/.test(e.message));
  assert.equal(calls.length, 1);
});

console.log(`${pass} passed`);
