// v0.11 rel1102: the copied OpenClaw link (app/provider-layer/server/providers/openclaw/link.js) asks a request again when
// the gateway refused it before running it because it is restarting, suspending or still starting: OpenClaw 2026.9.x and
// 2026.11.x answer UNAVAILABLE, retryable: true, retryAfterMs 1000, details.reason gateway-restarting / gateway-suspending
// / startup-sidecars (2026.9.6 restarts itself to take some config changes: an agent's model changed twice in a row met
// it). Any other refusal is passed on at once, and the asking stops after AGAIN_MS. Fake gateway client, no network.
//   Run: node tests/test_pl_link_restart.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GatewayLink, askAgain, AGAIN_MS } = await import(path.join(here, '../app/provider-layer/server/providers/openclaw/link.js'));
const ALL = ['operator.read', 'operator.write', 'operator.approvals', 'operator.questions', 'operator.admin'];
const refusal = (method, reason, extra = {}) => Object.assign(new Error(`${method} unavailable during gateway restart`),
  { gatewayCode: 'UNAVAILABLE', code: 'UNAVAILABLE', retryable: true, retryAfterMs: 1, details: { method, reason }, ...extra });

function rig(answers) {
  const calls = [];
  class Client {
    constructor(o) { this.o = o; }
    start() { setTimeout(() => this.o.onHelloOk({ server: { version: '2026.9.6' }, auth: { scopes: ALL }, features: { methods: ['agents.update', 'models.list', 'chat.send'], events: [] } }), 1); }
    async request(method, params) {
      calls.push(method);
      const a = answers.length ? answers.shift() : { ok: true };
      if (a instanceof Error) throw a;
      return { ...a, method, params };
    }
    stop() {}
    stopAndWait() { return Promise.resolve(); }
  }
  const link = new GatewayLink({ connectionId: '1', emit: () => {}, persist: () => {}, Client });
  link.configure({ url: 'ws://127.0.0.1:18822', auth: 'token', access: 'full' }, { token: 'tok' });
  return { link, calls };
}

let pass = 0;
async function t(name, fn) { await fn(); pass++; console.log('ok', name); }

await t('askAgain: only a retryable UNAVAILABLE for a restart, a suspension or a start', () => {
  assert.equal(askAgain(refusal('m', 'gateway-restarting')), true);
  assert.equal(askAgain(refusal('m', 'gateway-suspending')), true);
  assert.equal(askAgain(refusal('m', 'startup-sidecars')), true);
  assert.equal(askAgain(refusal('m', 'gateway-restarting', { retryable: false })), false);
  assert.equal(askAgain(refusal('m', 'websocket-upgrade-rejected')), false);
  assert.equal(askAgain(refusal('m', 'gateway-restarting', { gatewayCode: 'INVALID_REQUEST', code: 'INVALID_REQUEST' })), false);
  assert.equal(askAgain(null), false);
  // (2026.9.6's models.list while its model catalog is rebuilt: a plain error, only a reading is asked again)
  const notReady = Object.assign(new Error('Error: Model catalog is not ready. Retry after Gateway startup or refresh finishes.'), { gatewayCode: 'UNAVAILABLE' });
  assert.equal(askAgain(notReady, 'models.list'), true);
  assert.equal(askAgain(notReady, 'models.authStatus'), true);
  assert.equal(askAgain(notReady, 'chat.send'), false);
  assert.equal(askAgain(notReady, 'agents.update'), false);
  assert.ok(AGAIN_MS >= 10000 && AGAIN_MS <= 60000);
});

await t('a request refused during a gateway restart is asked again and answered', async () => {
  const { link, calls } = rig([refusal('agents.update', 'gateway-restarting'), refusal('agents.update', 'gateway-restarting')]);
  const r = await link.request('agents.update', { agentId: 'ops', model: 'stub/stub-2' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params, { agentId: 'ops', model: 'stub/stub-2' });
  assert.deepEqual(calls, ['agents.update', 'agents.update', 'agents.update']);
});

await t('a suspended gateway (2026.11) too', async () => {
  const { link, calls } = rig([refusal('models.list', 'gateway-suspending')]);
  assert.equal((await link.request('models.list', {})).ok, true);
  assert.equal(calls.length, 2);
});

await t('models.list while the model catalog is not ready yet (2026.9.6 after a restart) is asked again', async () => {
  const notReady = () => Object.assign(new Error('Error: Model catalog is not ready. Retry after Gateway startup or refresh finishes.'), { gatewayCode: 'UNAVAILABLE' });
  const { link, calls } = rig([notReady(), notReady()]);
  assert.equal((await link.request('models.list', {})).ok, true);
  assert.equal(calls.length, 3);
  const w = rig([notReady()]);
  await assert.rejects(w.link.request('chat.send', { sessionKey: 's', message: 'hi' }), /Model catalog is not ready/);
  assert.equal(w.calls.length, 1, 'a chat message is never sent twice');
});

await t('any other refusal is passed on at once (no second ask)', async () => {
  const { link, calls } = rig([Object.assign(new Error('agent not found'), { gatewayCode: 'INVALID_REQUEST' })]);
  await assert.rejects(link.request('agents.update', { agentId: 'x' }), e => e.code === 'INVALID_REQUEST' && /agent not found/.test(e.message));
  assert.equal(calls.length, 1);
});

await t('a gateway that stays down: the asking stops after its time, with the gateway\'s words', async () => {
  const { link, calls } = rig(Array.from({ length: 1000 }, () => refusal('agents.update', 'gateway-restarting', { retryAfterMs: 300 })));
  const t0 = Date.now();
  await assert.rejects(link.request('agents.update', { agentId: 'ops' }, { againMs: 1200 }), e => e.code === 'UNAVAILABLE' && /during gateway restart/.test(e.message));
  assert.ok(Date.now() - t0 < 5000, 'stopped in time');
  assert.ok(calls.length >= 2 && calls.length <= 6, `asked ${calls.length} times`);
});

console.log(`${pass} passed`);
process.exit(0);
