// v0.11 Docker bridge: OpenClaw's gateway client sends the token over plain ws:// only to a loopback/private ADDRESS
// (or a .local / .ts.net name), so the compose default ws://host.docker.internal:18789 was refused before dialling and
// the office said "The gateway is not answering". The copied link (app/provider-layer/server/providers/openclaw/link.js)
// now dials the address such a name stands for, and says plainly when the client refuses an address.
// Fake DNS and gateway client, no network.  Run: node tests/test_pl_link_dial.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GatewayLink, dialUrl } = await import(path.join(here, '../app/provider-layer/server/providers/openclaw/link.js'));
const dns = (...addrs) => async () => addrs.map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }));
const tick = () => new Promise(r => setTimeout(r, 5));

let pass = 0;
async function t(name, fn) { await fn(); pass++; console.log('ok', name); }

await t('a name for a private or loopback address is dialled by its address', async () => {
  assert.equal(await dialUrl('ws://host.docker.internal:18789', dns('172.17.0.1')), 'ws://172.17.0.1:18789/');
  assert.equal(await dialUrl('ws://nas:18789/gw', dns('192.168.1.20')), 'ws://192.168.1.20:18789/gw');
  assert.equal(await dialUrl('ws://box:1', dns('fd00::5')), 'ws://[fd00::5]:1/');
  assert.equal(await dialUrl('ws://dual:1', dns('fe80::1', '10.1.2.3')), 'ws://10.1.2.3:1/', 'IPv4 first');
  assert.equal(await dialUrl('ws://cgnat:1', dns('100.70.1.2')), 'ws://100.70.1.2:1/');
});

await t('everything else is left as it is (the client decides)', async () => {
  const never = async () => { throw new Error('not asked'); };
  assert.equal(await dialUrl('ws://gw.example.com:18789', dns('93.184.216.34')), 'ws://gw.example.com:18789');
  assert.equal(await dialUrl('ws://mixed:1', dns('10.0.0.2', '8.8.8.8')), 'ws://mixed:1', 'one public address: no');
  assert.equal(await dialUrl('ws://gone:1', async () => { throw new Error('ENOTFOUND'); }), 'ws://gone:1');
  for (const u of ['wss://host.docker.internal:1', 'ws://172.17.0.1:1', 'ws://127.0.0.1:1', 'ws://localhost:1', 'ws://pc.local:1', 'ws://pc.tail1.ts.net:1', 'nonsense']) {
    assert.equal(await dialUrl(u, never), u, u);
  }
});

await t('the link dials dialUrl, keeps its own address, and a refused plain ws:// says so', async () => {
  const built = [];
  class Client {
    constructor(o) { this.o = o; built.push(this); }
    start() {
      if (/example\.com/.test(this.o.url)) setTimeout(() => this.o.onConnectError(new Error('SECURITY ERROR: Cannot connect to "gw.example.com" over plaintext ws://. Both credentials and chat data would be exposed')), 1);
    }
    stop() {}
    stopAndWait() { return Promise.resolve(); }
  }
  const link = new GatewayLink({ connectionId: '1', emit: () => {}, persist: () => {}, Client });
  link.configure({ url: 'ws://host.docker.internal:18789', dialUrl: 'ws://172.17.0.1:18789/', auth: 'token', access: 'full' }, { token: 'tok' });
  assert.equal(built[0].o.url, 'ws://172.17.0.1:18789/');
  assert.equal(link.url, 'ws://host.docker.internal:18789', 'its address (web routes, settings) stays the name');
  assert.ok(built[0].o.deviceIdentity, 'not loopback: pairs as a device');
  link.configure({ url: 'ws://gw.example.com:18789', auth: 'token', access: 'full' }, { token: 'tok' });
  await tick();
  assert.equal(link.status.state, 'error');
  assert.equal(link.status.code, 'insecure_ws');
  assert.match(link.status.fix, /wss:\/\//);
});

console.log(`${pass} passed`);
