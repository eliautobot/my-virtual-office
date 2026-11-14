// v0.11 C2 acceptance: the copied Agent Providers window and the providers' own menus in the office, labs only.
// Usage: VO_URL=... LAB_OC=... LAB_OC_URL=... LAB_H=... LAB_PORT_A=... node tests/e2e/pl_menu.mjs
// OpenClaw: every tab (Overview .. Settings) renders from the lab gateway; Agents: a model change shows the from -> to
// confirm and lands on the gateway (lab cli config get), then goes back. Hermes: every tab renders. Also: the office's
// "Manage in Agent Providers" and providers.html open the copied window; it sits in the office's modal band; the theme.
import { check, summary, launch, api, sleep, shot, ensureOpenClaw, ensureHermes, labCli, VO } from './pl_lib.mjs';

const tabs = page => page.$$eval('.ap-back .ap-tabs .tab', b => b.map(x => ({ id: x.dataset.tab, label: x.textContent.trim() })));
const body = page => page.evaluate(() => (document.querySelector('.ap-back .ap-tabbody')?.innerText || '').replace(/\s+/g, ' ').trim());
async function openTab(page, id) {
  await page.evaluate(t => document.querySelector(`.ap-back .ap-tabs .tab[data-tab="${t}"]`)?.click(), id);
  const end = Date.now() + 20000;
  let text = '';
  while (Date.now() < end) {
    text = await body(page);
    if (text && !/^Loading/.test(text)) break;
    await sleep(300);
  }
  return text;
}
async function everyTab(page, label) {
  const list = (await tabs(page)).filter(t => t.id !== 'connection' && t.id !== 'keys');
  const bad = [];
  for (const t of list) {
    const text = await openTab(page, t.id);
    if (!text || /^Loading|Could not|failed|not allowed/i.test(text.slice(0, 80))) bad.push(`${t.id}: ${text.slice(0, 60)}`);
  }
  check(`${label} tabs render (${list.map(t => t.id).join(', ')})`, list.length >= 8 && !bad.length, bad.join(' | ') || `${list.length} tabs`);
  return list;
}

let failed = 0;
try {
  const oc = await ensureOpenClaw();
  const hm = await ensureHermes();
  const { browser, page, errors } = await launch();
  try {
    // the office's Settings -> Connections "Manage in Agent Providers" opens the copied window in place
    await page.evaluate(() => { const a = document.querySelector('a[data-ap-manage="openclaw"]'); a?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    const opened = await page.waitForSelector('.ap-back .ap-tabs .tab', { timeout: 20000 }).then(() => true, () => false);
    const z = await page.evaluate(() => +getComputedStyle(document.querySelector('.ap-back')).zIndex);
    check('"Manage in Agent Providers" opens the copied window (modal band)', opened && z >= 600 && z < 700, `z ${z}`);

    // OpenClaw: Overview .. Settings
    const ocTabs = await everyTab(page, 'OpenClaw');
    check('OpenClaw tabs are Overview..Settings', ['overview', 'agents', 'models', 'tools', 'skills', 'automations', 'approvals', 'sessions', 'settings'].every(t => ocTabs.some(x => x.id === t)), ocTabs.map(t => t.id).join(','));

    // Agents: change ops' model -> confirm shows from -> to -> lands on the gateway
    const opsCfg = () => { try { return JSON.parse(labCli('config', 'get', 'agents.entries.ops', '--json').stdout || '{}'); } catch { return {}; } };
    const before = opsCfg();
    // (a real change: ops gets an explicit model first, so the change to the default must remove it on the gateway)
    await api('/api/agent-providers/call', { method: 'POST', body: { id: oc.id, method: 'agents.update', params: { agentId: 'ops', model: 'stub/stub-1' } } });
    const pre = JSON.stringify(opsCfg().model ?? null);
    await page.evaluate(() => document.querySelector('.ap-back .ap-tabs .tab[data-tab="overview"]')?.click());
    await openTab(page, 'agents');
    await page.evaluate(() => { const r = [...document.querySelectorAll('.ap-back .op-row')].find(x => /\bops\b/.test(x.innerText)); r?.querySelector('[data-do="model"]')?.click(); });
    const sel = await page.waitForSelector('.ap-back .op-inline select', { timeout: 8000 }).then(() => true, () => false);
    const pick = sel ? await page.evaluate(() => { const s = document.querySelector('.ap-back .op-inline select'); const o = [...s.options].find(x => !x.selected); if (!o) return null; s.value = o.value; return o.value; }) : null;
    let diff = null, landed = false;
    if (pick !== null) {
      await page.evaluate(() => document.querySelector('.ap-back .op-inline [type="submit"]').click());
      diff = await page.waitForSelector('.ap-back .ap-confirm .ap-diff', { timeout: 8000 }).then(() => page.$eval('.ap-back .ap-confirm .ap-diff tbody', t => t.innerText.replace(/\s+/g, ' ').trim()), () => null);
      if (diff) await page.click('.ap-back .ap-confirm .ap-yes');
      const end = Date.now() + 20000;
      while (Date.now() < end && !landed) {
        const m = opsCfg().model;
        landed = pick ? JSON.stringify(m ?? '').includes(pick) : m === undefined || m === null;
        if (!landed) await sleep(1000);
      }
    }
    check('Agents: model change shows from -> to and lands on the gateway', /stub-1/.test(pre) && !!diff && diff.includes(pick || '(default)') && landed, `before ${pre} | pick "${pick}" | ${diff} | landed ${landed}`);
    // (back to what ops had, through the same call the tab makes)
    const was = typeof before.model === 'string' ? before.model : before.model?.primary ?? null;
    if (pick !== null) await api('/api/agent-providers/call', { method: 'POST', body: { id: oc.id, method: 'agents.update', params: { agentId: 'ops', model: was } } });
    await shot(page, 'pl-menu-openclaw', '.ap-back .ap');

    // Hermes: its tabs
    await page.evaluate(id => window.voPL.openProviders(id), hm.id);
    await page.waitForFunction(() => /Hermes/i.test(document.querySelector('.ap-back .ap-pane')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.ap-back .ap-tabs .tab[data-tab]:not([data-tab="connection"])', { timeout: 15000 }).catch(() => {});
    await everyTab(page, 'Hermes');
    // the office's Keys tab (kept from VO's own Hermes menu): names with set / not set only; setting one asks first
    const kt = await openTab(page, 'keys');
    const keyName = await page.evaluate(() => [...document.querySelectorAll('.ap-back .op-key')].find(r => /Not set/.test(r.innerText))?.dataset.key || null);
    let keySet = false;
    if (keyName) {
      await page.evaluate(k => document.querySelector(`.ap-back .op-key[data-key="${k}"] [data-do="open"]`)?.click(), keyName);
      await page.fill('.ap-back .op-kval', 'plui-lab-value');
      await page.evaluate(() => document.querySelector('.ap-back .op-keyedit [type="submit"]').click());
      const asked = await page.waitForSelector('.ap-back .ap-confirm .ap-yes', { timeout: 8000 }).then(() => true, () => false);
      if (asked) await page.click('.ap-back .ap-confirm .ap-yes');
      keySet = asked && await page.waitForFunction(k => /\bSet\b/.test(document.querySelector(`.ap-back .op-key[data-key="${k}"] .tag`)?.textContent || ''), keyName, { timeout: 15000 }).then(() => true, () => false);
    }
    const leak = /plui-lab-value/.test(JSON.stringify((await api('/api/agent-providers/call', { method: 'POST', body: { id: hm.id, method: 'env.list', params: {} } })).body || {}));
    check('Hermes Keys tab: set / not set only, a key set after the confirm, no value back', /of \d+ set/.test(kt) && keySet && !leak, `${keyName} set ${keySet} leak ${leak}`);
    check('no page errors / 5xx (menus)', !errors.length, errors.slice(0, 3).join(' | '));

    // a second gateway connection (its own device, its own agents), then removing it removes its device on the gateway
    const pairedList = () => { try { return JSON.parse(labCli('devices', 'list', '--json').stdout || '{}').paired || []; } catch { return null; } };
    const paired = () => { const l = pairedList(); return l ? l.length : -1; };
    const devs = () => (pairedList() || []).map(d => [String(d.deviceId || d.id || '').slice(0, 8), d.clientId, d.clientMode, d.remoteIp || d.ip].filter(Boolean).join('/')).join(' ');
    const d0 = devs(), n0 = paired();
    const token = (await import('node:fs')).readFileSync(`${process.env.LAB_OC || '/tmp/vo-openclaw-lab'}/token`, 'utf8').trim();
    const port = (process.env.LAB_OC_URL || '').split(':').pop() || process.env.LAB_OC_PORT;
    const c2 = (await api('/api/connections', { method: 'POST', body: { kind: 'openclaw', label: 'Lab gateway (second)', scope: 'installation', config: { url: `ws://127.0.0.1:${port}`, auth: 'token', access: 'full' }, secrets: { token } } })).body;
    let two = null;
    for (let k = 0; k < 120 && c2?.id; k++) {
      const p2 = (await api('/api/agent-providers')).body.providers.find(x => x.id === c2.id);
      if (p2?.status?.state === 'pairing' && k % 10 === 0) { const req = (JSON.parse(labCli('devices', 'list', '--json').stdout || '{}').pending || []).slice(-1)[0]; if (req) labCli('devices', 'approve', req.requestId || req.id); }
      if (p2?.status?.state === 'connected' && (p2.agents || []).length) { two = p2; break; }
      await sleep(1000);
    }
    const both = (await api('/api/pl/agents')).body.agents.filter(a => a.provider?.kind === 'openclaw').map(a => a.key);
    // (a loopback client with the gateway token: OpenClaw may approve it silently and list it, or keep no device record
    //  for it (2026.11.2 never lists it; 2026.9.6 labs here did not either): one more device at most, never another one
    //  left behind when it is removed)
    const n1 = paired(), gwv = String(two?.status?.version || '');
    const noRecord = n1 === n0;
    console.log(`devices (${gwv}): before [${d0}] after [${devs()}]`);
    check('several gateways: a second connection pairs with its own agents', !!two && both.some(k => k.startsWith(`prov-${c2.id}-`)) && both.some(k => k.startsWith(`prov-${oc.id}-`)) && (n1 === n0 || n1 === n0 + 1),
      `${both.join(',')} paired ${n0} -> ${n1} (OpenClaw ${gwv || '?'}${noRecord ? ': no device record for a loopback client' : ''})`);
    const rm = await api('/api/connections/remove', { method: 'POST', body: { id: c2?.id } });
    await sleep(2000);
    const n2 = paired(), first = (await api('/api/agent-providers')).body.providers.find(x => x.id === oc.id);
    check('removing a connection removes its device on the gateway', rm.status === 200 && n2 === n0 && first?.status?.state === 'connected', `remove ${rm.status} paired ${n2} (was ${n0}), first ${first?.status?.state}`);

    // providers.html: the OpenClaw page's Agent Providers slot opens the copied window
    await page.goto(`${VO}/providers.html?provider=openclaw`, { waitUntil: 'domcontentloaded' });
    const slot = await page.waitForSelector('#ps-agent-providers .pl-ap-open', { timeout: 15000 }).then(() => true, () => false);
    const win = await page.waitForSelector('.ap-back .ap', { timeout: 15000 }).then(() => true, () => false);
    check('providers.html: OpenClaw opens the copied Agent Providers window', slot && win);
  } finally { await browser.close(); }
} catch (e) { check('run', false, e.stack || e.message); }
failed = summary('pl_menu');
process.exitCode = failed;
