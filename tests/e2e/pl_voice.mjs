// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// Voice in the one chat window (unify uV-voice), real browser: the unified chat window's 🎤 dictation, 🔊 read aloud (voice service and the browser's own
// voice), 🎧 voice mode, Settings → Voice and the Agent Studio's Voice tab, against a fake voice service (tools/
// fake-voice.mjs) and the lab OpenClaw (agent main). Chrome's fake microphone; speechSynthesis recorded by a stub.
// Stack: tests/tools/pl-voice-lab.sh start (lab OpenClaw, the fake voice service, an office whose vo-config names the
// fake as its Whisper server). Then:
//   VO_URL=http://127.0.0.1:19710 LAB_OC=/tmp/vo-pl-voice/oc LAB_OC_URL=ws://127.0.0.1:19714 PL_OUT=/tmp/vo-pl-voice/out \
//   FAKE=http://127.0.0.1:19716 node tests/e2e/pl_voice.mjs desk|phone
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { check, summary, ensureOpenClaw, sleep, VO, api } from './pl_lib.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(process.env.HOME, '.hermes/hermes-agent/node_modules/playwright-core'));
const FAKE = process.env.FAKE || 'http://127.0.0.1:19716';
const mode = process.argv[2] || 'desk', phone = mode === 'phone';
const OUT = process.env.PL_OUT || '/tmp/vo-pl-voice/out';
fs.mkdirSync(OUT, { recursive: true });

const oc = await ensureOpenClaw();
check('lab OpenClaw connected', oc?.status?.state === 'connected', oc?.status?.state);
const seen = async () => (await (await fetch(`${FAKE}/_seen`)).json());
const reset = () => fetch(`${FAKE}/_reset`, { method: 'POST' });

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
async function context({ ears = true, mouth = true } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true } : { viewport: { width: 1600, height: 900 } });
  await ctx.grantPermissions(['microphone'], { origin: VO });
  await ctx.addInitScript(({ ears, mouth }) => {
    try { localStorage.setItem('vo-ui-theme', 'dark'); } catch { /* private */ }
    if (!ears) { try { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; } catch { /* */ } window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; }
    window.__said = [];
    if (!mouth) { try { delete window.speechSynthesis; } catch { /* */ } window.speechSynthesis = undefined; window.SpeechSynthesisUtterance = undefined; return; }
    // the browser's own voice, recorded: each utterance "ends" after a moment
    const fake = { speaking: false, pending: false, paused: false, getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() { this.speaking = false; }, pause() {}, resume() {},
      speak(u) { window.__said.push(u.text); this.speaking = true; setTimeout(() => { this.speaking = false; u.onend?.(); }, 250); } };
    Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
  }, { ears, mouth });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror ${e.message}`));
  page.on('response', r => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url().slice(0, 90)}`); });
  await page.goto(`${VO}/`, { waitUntil: 'domcontentloaded' });
  if (!(await page.evaluate(async () => !!(await window.voPLReady)))) throw new Error('layer not mounted');
  for (let k = 0; k < 3; k++) { await page.keyboard.press('Escape'); await sleep(120); }
  await sleep(600);
  return { ctx, page, errors };
}
const W = '.chat-back:not(.min)';
const vis = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.hidden'); }, sel);
async function openMain(page) {
  await page.evaluate(() => window.voPL.open('main'));
  await page.waitForSelector(`${W} .cw-in`, { timeout: 15000 });
  await sleep(900);
}
const answers = page => page.evaluate(s => document.querySelectorAll(`${s} .cw-msg.assistant[data-id]`).length, W);
async function send(page, text) {
  const n = await answers(page);
  await page.fill(`${W} .cw-in`, text);
  await page.press(`${W} .cw-in`, 'Enter');
  for (let i = 0; i < 120 && (await answers(page)) <= n; i++) await sleep(250);
  await page.waitForFunction(s => !document.querySelector(`${s} .cw-stop:not(.hidden)`), W, { timeout: 30000 }).catch(() => {});
  await sleep(500);
  return (await answers(page)) > n;
}
const overflowX = page => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
async function settingsVoice(page) {
  await page.evaluate(() => window.VOUI.openSettings('voice'));
  await page.waitForSelector('#voVoiceSettings .vs', { timeout: 15000 });
  await sleep(500);
}
const L = phone ? 'phone' : 'desk';
async function closeSettings(page) {
  // (the office's panels close from their scrim, top one first)
  for (let k = 0; k < 4 && (await page.evaluate(() => !!document.querySelector('.ui-panel-scrim.visible'))); k++) {
    await page.evaluate(() => document.querySelector('.ui-panel-scrim.visible')?.click()); await sleep(450);
  }
}
/** A known start: no voice services but the office's Whisper (as adopted at a first start), no choices, main's voice reset. */
async function known() {
  const conns = ((await api('/api/connections')).body?.connections || []).filter(c => c.kind === 'voice');
  for (const c of conns) if (c.config?.provider !== 'whisper') await api('/api/connections/remove', { method: 'POST', body: { id: c.id } });
  let w = conns.find(c => c.config?.provider === 'whisper');
  if (!w) w = (await api('/api/connections', { method: 'POST', body: { kind: 'voice', label: 'This office\'s Whisper', scope: 'installation', config: { provider: 'whisper', baseUrl: `${FAKE}/whisper` } } })).body;
  await api('/api/voice/settings', { method: 'POST', body: { values: { listenConnection: String(w.id), speakConnection: '' } } });
  await api('/api/voice/prefs', { method: 'POST', body: { listen: { connection: null }, speak: { connection: null, voice: '' }, autoRead: false } });
}
await known();

// ---------------------------------------------------------------- 1. nothing set up for speaking; the browser can't listen
await reset();
{
  const { ctx, page, errors } = await context({ ears: false, mouth: true });
  await settingsVoice(page);
  const txt = await page.evaluate(() => document.querySelector('#voVoiceSettings').innerText);
  check(`${L}: Settings → Voice lists the office's Whisper (adopted once) as who listens`, /This office's Whisper/.test(txt), txt.slice(0, 120));
  check(`${L}: Settings → Voice: no sideways scroll`, !(await overflowX(page)));
  await page.screenshot({ path: `${OUT}/${L}-settings-voice.jpg`, type: 'jpeg', quality: 55 });
  {
    // remove the Whisper service: nothing listens any more (this page has no speech recognition)
        await page.evaluate(() => [...document.querySelectorAll('#voVoiceSettings .conn')].find(c => /This office's Whisper/.test(c.innerText))?.querySelector('.vs-c-del')?.click());
    let native = 0; page.on('dialog', d => { native++; d.dismiss().catch(() => {}); });
    const ok = await page.waitForSelector('.vo-dialog button, [role="alertdialog"] button', { timeout: 3000 }).catch(() => null);
    if (ok) { const btns = await page.$$('[role="alertdialog"] button, .vo-dialog button'); for (const b of btns) if ((await b.innerText()).trim() === 'Remove') { await b.click(); break; } }
    await sleep(1200);
    const after = await page.evaluate(() => document.querySelector('#voVoiceSettings').innerText);
    check(`${L}: the Whisper service removed (Remove asks in the office's own dialog)`, !!ok && !native && !/This office's Whisper/.test(after), after.slice(0, 160));
  }
  await closeSettings(page);
  await openMain(page);
  check(`${L}: no listening service and no recognition → 🎤 hidden`, !(await vis(page, `${W} .cw-mic`)));
  check(`${L}: … and 🎧 hidden`, !(await vis(page, `${W} .cw-vm`)));
  const got = await send(page, 'Say hello please');
  check(`${L}: the agent answered`, got);
  check(`${L}: the browser can speak → 🔊 shown under the answer`, await vis(page, `${W} .cw-msg.assistant [data-a="speak"]`));
  await page.click(`${W} .cw-msg.assistant:last-of-type [data-a="speak"]`).catch(async () => { const b = await page.$$(`${W} .cw-msg.assistant [data-a="speak"]`); await b.at(-1).click(); });
  for (let i = 0; i < 40 && !(await page.evaluate(() => window.__said.length)); i++) await sleep(150);
  const said = await page.evaluate(() => window.__said.join(' '));
  check(`${L}: 🔊 with no voice service: the browser's own voice reads the answer`, said.length > 3, said.slice(0, 80));
  check(`${L}: no page errors (1)`, !errors.length, errors.slice(0, 3).join(' | '));
  await ctx.close();
}
// ---------------------------------------------------------------- 2. nothing can speak or listen at all
{
  const { ctx, page, errors } = await context({ ears: false, mouth: false });
  if (phone) { await api('/api/voice/settings', { method: 'POST', body: { values: { listenConnection: '' } } }); await page.reload({ waitUntil: 'domcontentloaded' }); await page.evaluate(async () => !!(await window.voPLReady)); await sleep(500); }
  await openMain(page);
  await sleep(600);
  check(`${L}: nothing configured, no browser speech → 🎤 hidden`, !(await vis(page, `${W} .cw-mic`)));
  check(`${L}: … 🎧 hidden`, !(await vis(page, `${W} .cw-vm`)));
  check(`${L}: … 🔊 hidden under answers`, !(await vis(page, `${W} .cw-msg.assistant [data-a="speak"]`)) && (await answers(page)) > 0);
  check(`${L}: no page errors (2)`, !errors.length, errors.slice(0, 3).join(' | '));
  await ctx.close();
}
// ---------------------------------------------------------------- 3. a voice service added in Settings → Voice
{
  const { ctx, page, errors } = await context({ ears: false, mouth: true });
  await settingsVoice(page);
  const mine = await page.evaluate(() => [...document.querySelectorAll('#voVoiceSettings .conn b')].map(b => b.textContent));
  if (!mine.includes('Fake voice')) {
    await page.evaluate(() => { const d = document.querySelector('#voVoiceSettings .vs-add'); if (d) d.open = true; });
    await page.selectOption('#voVoiceSettings .vs-f-prov', 'custom');
    await page.fill('#voVoiceSettings .vs-f-url', `${FAKE}/v1`);
    await page.selectOption('#voVoiceSettings .vs-f-does', 'both');
    await page.fill('#voVoiceSettings .vs-f-label', 'Fake voice');
    await page.fill('#voVoiceSettings .vs-f-key', 'fake-key-not-real');
    const scope = await page.$('#voVoiceSettings .vs-f-scope');
    if (scope) await page.selectOption('#voVoiceSettings .vs-f-scope', 'installation');
    await page.click('#voVoiceSettings .vs-form button[type="submit"]');
    await page.waitForFunction(() => /Fake voice/.test(document.querySelector('#voVoiceSettings')?.innerText || '') && !!document.querySelector('#voVoiceSettings .conn'), null, { timeout: 30000 });
    await sleep(800);
  }
  const txt = await page.evaluate(() => document.querySelector('#voVoiceSettings').innerText);
  check(`${L}: added and tested: it listens and speaks for the owner now`, /Fake voice/.test(txt) && !/✗/.test(txt), txt.match(/Now: [^\n]*/g)?.join(' / '));
  const g = await api('/api/connections');
  check(`${L}: its key is never sent back`, !JSON.stringify(g.body).includes('fake-key-not-real'));
  const voices = await page.evaluate(() => [...document.querySelectorAll('#voVoiceSettings .vs-voice option')].map(o => o.value));
  check(`${L}: Its voice lists the service's own voices`, ['af_bella', 'am_adam', 'bf_emma'].every(v => voices.includes(v)), voices.join(','));
  // its models, from the service's own list: pick the speaking one
  await page.evaluate(() => { const d = [...document.querySelectorAll('#voVoiceSettings .conn')].find(c => /Fake voice/.test(c.innerText))?.querySelector('.vs-c-models'); if (d) d.open = true; });
  await page.waitForFunction(() => [...document.querySelectorAll('#voVoiceSettings datalist[id^="vs-dl-s-"] option')].some(o => o.value === 'tts-1-hd'), null, { timeout: 15000 }).catch(() => {});
  const ms = await page.evaluate(() => [...document.querySelectorAll('#voVoiceSettings datalist[id^="vs-dl-s-"] option')].map(o => o.value));
  const ml = await page.evaluate(() => [...document.querySelectorAll('#voVoiceSettings datalist[id^="vs-dl-l-"] option')].map(o => o.value));
  check(`${L}: Models: the service's own speaking and listening models offered`, ms.includes('tts-1-hd') && ms.includes('kokoro') && ml.includes('whisper-1') && !ms.includes('chat-model'), `${ms.join(',')} / ${ml.join(',')}`);
  await page.fill('#voVoiceSettings .vs-c-models[open] .vs-c-sm', 'tts-1-hd');
  await page.click('#voVoiceSettings .vs-c-models[open] button[type="submit"]');
  await sleep(1200);
  await closeSettings(page);
  // 🎤 dictation through the service (Chrome's fake microphone)
  await openMain(page);
  check(`${L}: a listening service → 🎤 shown (even without the browser's recognition)`, await vis(page, `${W} .cw-mic`));
  check(`${L}: … 🎧 shown`, await vis(page, `${W} .cw-vm`));
  await reset();
  await page.click(`${W} .cw-mic`);
  await page.waitForSelector(`${W} .cw-rec:not(.hidden)`, { timeout: 5000 });
  await sleep(1600);
  await page.click(`${W} .cw-rec-ok`);
  await page.waitForFunction(s => /two plus two/.test(document.querySelector(`${s} .cw-in`)?.value || ''), W, { timeout: 15000 }).catch(() => {});
  const box = await page.inputValue(`${W} .cw-in`);
  check(`${L}: 🎤 → the recording heard by the service, the words in the box`, /what is two plus two/.test(box), box);
  check(`${L}: … sent to /v1/audio/transcriptions`, (await seen()).some(s => s.url === '/v1/audio/transcriptions' && s.bytes > 1000));
  await page.fill(`${W} .cw-in`, '');
  // 🔊 read aloud through the service
  await send(page, 'Tell me something short');
  await reset();
  const b = await page.$$(`${W} .cw-msg.assistant [data-a="speak"]`); await b.at(-1).click();
  await page.waitForFunction(s => !!document.querySelector(`${s} .cw-msg.assistant [data-a="speak"].on`), W, { timeout: 8000 }).catch(() => {});
  const speak1 = (await seen()).filter(s => s.url === '/v1/audio/speech');
  check(`${L}: 🔊 → the voice service speaks the answer`, speak1.length >= 1 && (speak1[0].input || '').length > 3, JSON.stringify(speak1[0] || {}).slice(0, 120));
  check(`${L}: … with the speaking model picked in Settings → Voice`, speak1[0]?.model === 'tts-1-hd', speak1[0]?.model);
  for (let i = 0; i < 40 && (await page.evaluate(s => !!document.querySelector(`${s} [data-a="speak"].on`), W)); i++) await sleep(200);
  check(`${L}: … and the 🔊 comes back when it ends`, !(await page.evaluate(s => !!document.querySelector(`${s} [data-a="speak"].on`), W)));
  check(`${L}: no page errors (3)`, !errors.length, errors.slice(0, 3).join(' | '));
  await ctx.close();
}
// ---------------------------------------------------------------- 4. the agent's own voice (Agent Studio → Voice)
if (!phone) {
  const { ctx, page, errors } = await context({ ears: true, mouth: true });
  // (the lab office runs as a demo, where Agent Studio is a licensed feature: as tests/test_v10_studio_lib.mjs does)
  await page.evaluate(() => { if (window._voLicense) window._voLicense.demo = false; if (typeof toggleAgentPanel === 'function') toggleAgentPanel(); });
  await page.waitForFunction(() => !!window.VOStudio && document.getElementById('agent-creator-panel')?.classList.contains('visible'), null, { timeout: 20000 });
  await sleep(600);
  await page.evaluate(() => { if (typeof _acpSelectAgent === 'function') _acpSelectAgent('main'); });
  await sleep(800);
  await page.evaluate(() => window.VOStudio.showCategory('voice'));
  await page.waitForSelector('.st-voice .sv-svc', { timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.st-voice .sv-vsel option')].some(o => o.value === 'bf_emma'), null, { timeout: 15000 }).catch(() => {});
  check('desk: Agent Studio → Voice shows the service\'s voices for main', await page.evaluate(() => [...document.querySelectorAll('.st-voice .sv-vsel option')].some(o => o.value === 'bf_emma')));
  await page.selectOption('.st-voice .sv-vsel', 'bf_emma');
  await sleep(1200);
  const o = await api(`/api/voice/options?agent=${(await page.evaluate(() => window.voPL.layerIdFor('main')))}`);
  check('desk: saved with the agent (its voice now bf_emma)', o.body?.speak?.voice === 'bf_emma', JSON.stringify(o.body?.speak || {}).slice(0, 140));
  await page.screenshot({ path: `${OUT}/desk-studio-voice.jpg`, type: 'jpeg', quality: 55 });
  await closeSettings(page);
  await page.evaluate(() => { const p = document.getElementById('agent-creator-panel'); if (p && p.classList.contains('visible') && typeof toggleAgentPanel === 'function') toggleAgentPanel(); });
  await closeSettings(page);
  await openMain(page);
  await reset();
  const b = await page.$$(`${W} .cw-msg.assistant [data-a="speak"]`); await b.at(-1).click();
  for (let i = 0; i < 40 && !(await seen()).some(s => s.url === '/v1/audio/speech'); i++) await sleep(150);
  const sp = (await seen()).find(s => s.url === '/v1/audio/speech');
  check('desk: 🔊 now speaks in main\'s own voice', sp?.voice === 'bf_emma', sp?.voice);
  await page.click(`${W} [data-a="speak"].on`).catch(() => {});
  // 🎧 voice mode: listen → (tap: done talking) → heard → sent → answer spoken → listening again
  await reset();
  const n = await answers(page);
  await page.click(`${W} .cw-vm`);
  await page.waitForFunction(s => /Listening/.test(document.querySelector(`${s} .cw-vm-state`)?.textContent || ''), W, { timeout: 10000 }).catch(() => {});
  const st0 = await page.evaluate(s => document.querySelector(`${s} .cw-vm-state`)?.textContent || '', W);
  check('desk: 🎧 → voice mode listening', /Listen/.test(st0), st0);
  await sleep(1800);
  await page.click(`${W} .cw-vm-state`);   // (done talking)
  for (let i = 0; i < 120 && (await answers(page)) <= n; i++) await sleep(250);
  const thread = await page.evaluate(s => document.querySelector(`${s} .cw-thread`)?.innerText || '', W);
  check('desk: what was said is sent as a message', /what is two plus two/i.test(thread));
  check('desk: … and answered', (await answers(page)) > n);
  for (let i = 0; i < 60 && !(await seen()).some(s => s.url === '/v1/audio/speech'); i++) await sleep(200);
  const vs = (await seen()).filter(s => s.url === '/v1/audio/speech');
  check('desk: the answer spoken in voice mode, in main\'s voice', vs.length >= 1 && vs.every(s => s.voice === 'bf_emma'), vs.map(s => s.voice).join(','));
  await page.waitForFunction(s => /Listening/.test(document.querySelector(`${s} .cw-vm-state`)?.textContent || ''), W, { timeout: 20000 }).catch(() => {});
  const st1 = await page.evaluate(s => document.querySelector(`${s} .cw-vm-state`)?.textContent || '', W);
  check('desk: … then listening again (the loop)', /Listen/.test(st1), st1);
  await page.click(`${W} .cw-vm`);
  await sleep(500);
  check('desk: 🎧 again ends voice mode', !(await vis(page, `${W} .cw-vm-state`)) || !/Listen|Speak|Think/.test(await page.evaluate(s => document.querySelector(`${s} .cw-vm-state`)?.textContent || '', W)));
  // read every answer aloud (Settings → Voice)
  await settingsVoice(page);
  await page.check('#voVoiceSettings .vs-auto');
  for (let i = 0; i < 20 && !(await api('/api/voice/options')).body?.prefs?.autoRead; i++) await sleep(200);
  await closeSettings(page);
  await reset();
  await send(page, 'One more short answer');
  for (let i = 0; i < 40 && !(await seen()).some(s => s.url === '/v1/audio/speech'); i++) await sleep(200);
  check('desk: "read every answer aloud": the answer is read as it ends, without a click', (await seen()).some(s => s.url === '/v1/audio/speech'));
  await settingsVoice(page);
  await page.uncheck('#voVoiceSettings .vs-auto');
  await sleep(800);
  check('desk: no page errors (4)', !errors.length, errors.slice(0, 3).join(' | '));
  await ctx.close();
}
// ---------------------------------------------------------------- phone: the window's voice buttons fit
if (phone) {
  const { ctx, page, errors } = await context({ ears: true, mouth: true });
  await openMain(page);
  check('phone: 🎤 and 🎧 shown in the sheet', (await vis(page, `${W} .cw-mic`)) && (await vis(page, `${W} .cw-vm`)));
  check('phone: no sideways scroll with the window open', !(await overflowX(page)));
  await page.screenshot({ path: `${OUT}/phone-window.jpg`, type: 'jpeg', quality: 55 });
  check('phone: no page errors (5)', !errors.length, errors.slice(0, 3).join(' | '));
  await ctx.close();
}
await browser.close();
process.exit(summary(`uV-voice ${mode}`));
