// v0.11 same-machine rule for the copied OpenClaw link (app/provider-layer/server/providers/openclaw/link.js): a gateway
// on a loopback address is signed in to with its token alone (client mode backend, no device, nothing to approve), as
// the office did in 0.10; it pairs as a device only when that hello lacks a scope it asked for. Other addresses always
// pair. Fake gateway client, no network.  Run: node tests/test_pl_link_local.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GatewayLink, isLoopback } = await import(path.join(here, '../app/provider-layer/server/providers/openclaw/link.js'));
const ALL = ['operator.read', 'operator.write', 'operator.approvals', 'operator.questions', 'operator.admin'];
const tick = () => new Promise(r => setTimeout(r, 5));

function rig(grants) {
  const built = [], persisted = [];
  class Client {
    constructor(o) { this.o = o; built.push(this); }
    start() {
      const local = this.o.deviceIdentity === null;
      setTimeout(() => this.o.onHelloOk({ server: { version: 't' }, auth: { scopes: local ? grants : ALL }, features: { methods: [], events: [] } }), 1);
    }
    stop() { this.stopped = true; }
    stopAndWait() { this.stopped = true; return Promise.resolve(); }
  }
  const link = new GatewayLink({ connectionId: '1', emit: () => {}, persist: (f, v) => persisted.push([f, v]), Client });
  return { link, built, persisted };
}

let pass = 0;
async function t(name, fn) { await fn(); pass++; console.log('ok', name); }

await t('isLoopback', () => {
  for (const u of ['ws://127.0.0.1:18789', 'ws://localhost:1/', 'ws://[::1]:5', 'wss://127.4.5.6']) assert.equal(isLoopback(u), true, u);
  for (const u of ['ws://172.17.0.1:18789', 'ws://10.0.0.2', 'ws://gateway.local', 'nonsense', '']) assert.equal(isLoopback(u), false, u);
});

await t('loopback + gateway token: token only, backend mode, no device key made, token kept', async () => {
  const { link, built, persisted } = rig(ALL);
  link.configure({ url: 'ws://127.0.0.1:18770', auth: 'token', access: 'full' }, { token: 'tok' });
  await tick();
  assert.equal(built.length, 1);
  assert.equal(built[0].o.deviceIdentity, null);
  assert.equal(built[0].o.mode, 'backend');
  assert.equal(built[0].o.token, 'tok');
  assert.equal(link.status.state, 'connected');
  assert.equal(link.identity, null);
  assert.deepEqual(persisted, []);          // no device key, the token is not handed off
  assert.equal(link.bearer(), 'tok');
});

await t('loopback hello without the scopes: pairs as a device (ui mode), once', async () => {
  const { link, built, persisted } = rig([]);
  link.configure({ url: 'ws://127.0.0.1:18770', auth: 'token', access: 'full' }, { token: 'tok' });
  await tick(); await tick();
  assert.equal(built.length, 2);
  assert.ok(built[1].o.deviceIdentity && built[1].o.deviceIdentity.deviceId);
  assert.equal(built[1].o.mode, 'ui');
  assert.ok(persisted.some(([f]) => f === 'deviceKey'));
  // the same settings again keep the device client (no flip back to token only)
  link.configure({ url: 'ws://127.0.0.1:18770', auth: 'token', access: 'full' }, { token: 'tok', deviceKey: link.deviceKey });
  assert.equal(built.length, 2);
});

await t('another address always pairs as a device', async () => {
  const { link, built } = rig(ALL);
  link.configure({ url: 'ws://172.17.0.1:18770', auth: 'token', access: 'full' }, { token: 'tok' });
  assert.ok(built[0].o.deviceIdentity);
  assert.equal(built[0].o.mode, 'ui');
});

await t('loopback with a paired device token keeps using the device', async () => {
  const first = rig(ALL);
  first.link.configure({ url: 'ws://172.17.0.1:1', auth: 'token' }, { token: 'tok' });
  const key = first.link.deviceKey, id = first.link.identity.deviceId;
  const { link, built } = rig(ALL);
  link.configure({ url: 'ws://127.0.0.1:18770', auth: 'token' }, { deviceKey: key, deviceToken: JSON.stringify({ deviceId: id, role: 'operator', token: 'dev', scopes: ALL }) });
  assert.equal(built[0].o.deviceIdentity.deviceId, id);
  assert.equal(built[0].o.mode, 'ui');
});

console.log(`${pass} passed`);
