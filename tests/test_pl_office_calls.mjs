// v0.11 relfix: the office server's own OpenClaw calls (New agent wizard, chat list and delete, skills workshop, gateway
// restart, progress cards, workflow abort) go through the layer's link: a fixed list (menu.js OFFICE_CALLS), the
// gateway's answer as it is, the settings without a secret's value. Fake link, no network.
// Run: node tests/test_pl_office_calls.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { officeCall, OFFICE_CALLS, OFFICE_WRITE, MENU_READ, MENU_WRITE } = await import(path.join(here, '../app/provider-layer/server/providers/openclaw/menu.js'));

let pass = 0;
async function t(name, fn) { await fn(); pass++; console.log('ok', name); }
const fakeLink = answers => ({
  asked: [],
  hello: { server: { version: '2026.7.2' } },
  async request(method, params, opts) { this.asked.push({ method, params, opts }); const a = answers[method]; return typeof a === 'function' ? a(params) : a; },
});

await t('what the office server calls is listed; the sub-menu stays as it was', async () => {
  for (const m of ['agents.create', 'agents.files.set', 'agents.delete', 'agents.list', 'sessions.list', 'sessions.delete', 'skills.proposals.list',
    'skills.proposals.inspect', 'skills.proposals.apply', 'gateway.restart.request', 'progressCard.get', 'progressCard.put', 'chat.abort', 'health']) {
    assert.ok(OFFICE_CALLS.includes(m), m);
  }
  for (const m of MENU_WRITE) assert.ok(OFFICE_WRITE.includes(m), m);
  assert.ok(!MENU_READ.includes('agents.files.set') && !MENU_WRITE.includes('gateway.restart.request'), 'the pages\' sub-menu is not widened');
  assert.ok(!OFFICE_CALLS.includes('settings.outline'));
});

await t('a call not on the list never reaches the gateway', async () => {
  const link = fakeLink({});
  for (const m of ['chat.send', 'exec.run', 'devices.approve', 'config.apply', 'agents.files.get', 'node.invoke']) {
    await assert.rejects(officeCall(link, m, {}), e => e.code === 'unsupported', m);
  }
  assert.equal(link.asked.length, 0);
});

await t('the gateway answer comes back as it is, with the time asked for (bounded)', async () => {
  const link = fakeLink({ 'agents.create': { ok: true, agentId: 'ada', workspace: '/w/ada', token: 'kept-as-the-gateway-said' } });
  const out = await officeCall(link, 'agents.create', { name: 'Ada' }, 999999);
  assert.deepEqual(out, { ok: true, agentId: 'ada', workspace: '/w/ada', token: 'kept-as-the-gateway-said' });
  assert.deepEqual(link.asked[0], { method: 'agents.create', params: { name: 'Ada' }, opts: { timeoutMs: 120000 } });
  await officeCall(link, 'agents.create', {}, 10);
  assert.equal(link.asked[1].opts.timeoutMs, 1000);
});

await t('the settings come back without a secret\'s value', async () => {
  const link = fakeLink({
    'config.schema': { uiHints: { 'gateway.auth.token': { sensitive: true } }, schema: { properties: { gateway: {} } } },
    'config.get': { config: { gateway: { auth: { token: 'tok-abcdef', mode: 'token' } }, models: { providers: { x: { apiKey: 'sk-1' } } } }, hash: 'h1' },
  });
  const out = await officeCall(link, 'config.get', {});
  assert.deepEqual(out.config.gateway.auth.token, { secret: true, set: true });
  assert.deepEqual(out.config.models.providers.x.apiKey, { secret: true, set: true });
  assert.equal(out.config.gateway.auth.mode, 'token');
  assert.ok(!JSON.stringify(out).includes('tok-abcdef') && !JSON.stringify(out).includes('sk-1'));
});

console.log(`\n${pass} passed`);
