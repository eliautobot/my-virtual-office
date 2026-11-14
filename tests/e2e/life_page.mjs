// Office life page checks (L10) on the private office: node tests/e2e/life_page.mjs desktop|phone|tabs|settings|tz
// Events come from the private server's injector (loopback only) or its real Settings buttons; the page runs the
// shipped client. Results: one PASS/FAIL line each (LIFE_QA_LOG appends them).
import { VO, SECRETS, check, sleep, api, inject, injectAction, now, launch, openOffice, shot, overlap, chromeRects, summary } from './life_lib.mjs';

const section = process.argv[2] || 'desktop';
const D = page => page.evaluate(() => ({
  life: window.VOLife._debug(), signs: window.VOLifeNeeds && window.VOLifeNeeds._signs ? window.VOLifeNeeds._signs() : null,
  crew: window.VOLifeCrew && window.VOLifeCrew._debug ? window.VOLifeCrew._debug() : null,
  moods: window.VOLifeMoods ? window.VOLifeMoods._debug() : null,
  party: window.VOLife.feature && null,
}));
const canvasBox = page => page.evaluate(() => { const r = document.getElementById('officeCanvas') || document.querySelector('canvas'); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
const signRects = page => page.evaluate(() => { const r = window.VOLifeNeeds._rects() || {}; const c = (document.getElementById('officeCanvas') || document.querySelector('canvas')).getBoundingClientRect(); const o = {}; for (const k of Object.keys(r)) if (r[k]) o[k] = { x: r[k].x + c.left, y: r[k].y + c.top, w: r[k].w, h: r[k].h }; return o; });

async function scenario(page, errors, tag) {
  const t = now(), u = `${tag}-${t}`;
  await page.evaluate(() => { window.__opened = []; addEventListener('vo:chat-opened-agent', e => window.__opened.push(e.detail)); });
  // 1 needs-you
  await inject({ type: 'needs.open', agent: 'main', provider: 'openclaw', need: 'approval', ref: `pg-${u}-a1`, cardId: `pg-${u}-a1`, session: 'agent:main:main', count: 1, at: now() });
  const signed = await page.waitForFunction(() => { const s = window.VOLifeNeeds._signs(); return s.main && s.main.posed; }, null, { timeout: 20000 }).then(() => true, () => false);
  await sleep(400);
  const rects = await signRects(page), chrome = await chromeRects(page), cb = await canvasBox(page);
  const edge = await page.evaluate(() => [...document.querySelectorAll('.vo-life-edge')].filter(b => b.getBoundingClientRect().width > 0 && !b.hidden).map(b => { const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, text: b.textContent.trim() }; }));
  const r = rects.main || null, e0 = edge.find(b => /Main/.test(b.text)) || null;
  check(`${tag}: needs-you sign up for main (posed at the front; on screen a sign, off screen an edge badge)`, signed && !!(r || e0),
    `sign ${JSON.stringify(r)} edge ${JSON.stringify(edge).slice(0, 120)}`, 'app/office-life/needs.js');
  const target = r || e0, hits = chrome.filter(c => overlap(target, c));
  check(`${tag}: ${r ? 'sign label' : 'edge badge'} inside the canvas and clear of map controls/top bar/chat`, target && target.x >= cb.x && target.y >= cb.y && target.x + target.w <= cb.x + cb.w + 0.5 && target.y + target.h <= cb.y + cb.h + 0.5 && !hits.length,
    `${JSON.stringify(target)} hits ${JSON.stringify(hits).slice(0, 120)}`, 'app/office-life/needs.js');
  if (target) await page.mouse.click(target.x + target.w / 2, target.y + target.h / 2);
  const opened = await page.waitForFunction(() => (window.__opened || []).length > 0, null, { timeout: 8000 }).then(() => true, () => false);
  const od = await page.evaluate(() => window.__opened);
  check(`${tag}: click on the sign opens main's chat (vo:chat-opened-agent)`, opened && od[0] && /main/.test(JSON.stringify(od[0])), JSON.stringify(od).slice(0, 160), 'app/office-life/needs.js + app/chat.js');
  await page.keyboard.press('Escape').catch(() => {});
  await inject({ type: 'needs.close', agent: 'main', provider: 'openclaw', ref: `pg-${u}-a1`, outcome: 'answered', at: now() });
  const cleared = await page.waitForFunction(() => !window.VOLifeNeeds._signs().main, null, { timeout: 15000 }).then(() => true, () => false);
  check(`${tag}: answered elsewhere -> sign clears (thanks flip, walks back)`, cleared, '', 'app/office-life/needs.js');
  // 2 interns + handoff
  await inject({ type: 'interns.set', agent: 'ops', count: 1, shown: 1, at: now() });
  const intern = await page.waitForFunction(() => { const d = window.VOLifeCrew._debug(); return d.interns.length === 1 && d.interns[0].parent === 'ops'; }, null, { timeout: 10000 }).then(() => true, () => false);
  check(`${tag}: interns.set -> an intern for ops walks in`, intern, JSON.stringify((await D(page)).crew.interns).slice(0, 160), 'app/office-life/crew.js');
  await inject({ type: 'handoff', agent: 'main', provider: 'office', to: 'ops', via: 'task', ref: `pg-${u}-h1`, at: now() });
  await sleep(600);
  const planes = await page.evaluate(() => (window.VOLifeHost && window.VOLifeHost.planesInFlight ? window.VOLifeHost.planesInFlight() : -1));
  const held = await page.evaluate(() => window.VOLife._debug().running);
  check(`${tag}: handoff main -> ops -> folder plane or handoff walk`, planes > 0 || held.includes('main'), `planes=${planes} running=${JSON.stringify(held)}`, 'app/office-life/crew.js');
  // 3 visitor + alarm clock
  await inject({ type: 'visitor', agent: 'ops', provider: 'openclaw', channel: ['telegram', 'discord', 'sms', 'email'][Math.floor(t / 1000) % 4], session: 'agent:ops:telegram:direct:1', at: now() },
    { type: 'cron.fire', agent: 'main', provider: 'openclaw', ref: `job-${u}`, name: 'Digest', runAt: now(), at: now() });
  await sleep(800);
  const crew = (await D(page)).crew;
  check(`${tag}: visitor -> courier with a channel envelope for ops`, crew.couriers.some(c => c.agent === 'ops') || (crew.envelopes || []).some(e => JSON.stringify(e).includes('ops')),
    JSON.stringify(crew.couriers).slice(0, 140), 'app/office-life/crew.js');
  check(`${tag}: cron.fire -> alarm clock on main's desk`, /clock|alarm/i.test(JSON.stringify(crew)) && JSON.stringify(crew).includes('main'), JSON.stringify(crew).slice(0, 200), 'app/office-life/crew.js');
  // 4 moods + 5 celebrations
  await inject({ type: 'mood', agent: 'hermes-lab-a', provider: 'hermes', mood: 'focused', at: now() },
    { type: 'xp', agent: 'ops', provider: 'office', points: 12, total: 99, reason: 'task', ref: `xp-${u}`, at: now() });
  await sleep(500);
  const st = await page.evaluate(() => ({ moods: window.VOLifeMoods._debug().moods, cel: window.VOLifeCelebrate ? window.VOLifeCelebrate._debug() : null }));
  check(`${tag}: mood focused -> badge state for hermes-lab-a`, JSON.stringify(st.moods).includes('focused'), JSON.stringify(st.moods).slice(0, 140), 'app/office-life/moods.js');
  check(`${tag}: xp -> "+12 XP" pop for ops`, st.cel && st.cel.pops.some(p => p.key === 'ops' && p.points === 12), JSON.stringify(st.cel && st.cel.pops).slice(0, 140), 'app/office-life/celebrate.js');
  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '), 'app/office-life/*');
}

async function standupAndTournament(page, tag) {
  const s = await api('/api/office-life/standup/now', {});
  const ok = await page.waitForFunction(() => { const d = window.VOLifeStandup && window.VOLifeStandup._debug(); return d && d.id; }, null, { timeout: 15000 }).then(() => true, () => false);
  const d0 = await page.evaluate(() => window.VOLifeStandup._debug());
  check(`${tag}: stand-up now -> gathering on the page (${d0.where || '?'})`, (s.status === 200 || s.status === 409) && ok, `${s.status} ${JSON.stringify(d0).slice(0, 160)}`, 'app/office-life/standup.js');
  await page.waitForFunction(() => { const d = window.VOLifeStandup._debug(); return d.phase === 'speak' || d.phase === 'summary'; }, null, { timeout: 30000 }).catch(() => {});
  const d1 = await page.evaluate(() => window.VOLifeStandup._debug());
  check(`${tag}: stand-up speakers in turn (phase ${d1.phase}, speaker ${d1.speak})`, d1.phase === 'speak' || d1.phase === 'summary', JSON.stringify(d1).slice(0, 160), 'app/office-life/standup.js');
  return d1;
}

const run = {
  async desktop() {
    const { browser, page, errors } = await launch({ width: 1600, height: 900 });
    try {
      await openOffice(page);
      await scenario(page, errors, 'desktop');
      await standupAndTournament(page, 'desktop');
      const r = (await signRects(page)).main;
      await shot(page, 'desktop-standup', { x: 300, y: 120, width: 800, height: 500 });
      const body = await page.evaluate(() => document.body.innerText);
      check('desktop: no secret text anywhere in the page DOM', !SECRETS.some(s => body.includes(s)), '', 'app/office-life/*');
    } catch (e) { check('desktop script', false, e.message.split('\n')[0]); } finally { await browser.close(); }
  },
  async phone() {
    const { browser, page, errors } = await launch({ width: 412, height: 915, mobile: true });
    try {
      await openOffice(page);
      await scenario(page, errors, 'phone');
      await api('/api/office-life/standup/now', {});
      const cap = await page.waitForFunction(() => { const el = document.querySelector('.vo-life-standup-cap'); const d = window.VOLifeStandup._debug(); return el && !el.hidden && el.getBoundingClientRect().height > 0 && d.cards === 0 ? (d.caption && d.caption.text || 'shown') : null; }, null, { timeout: 30000 }).then(h => h.jsonValue(), () => null);
      check('phone: stand-up -> one caption bar under the top bar (no canvas cards)', !!cap, String(cap), 'app/office-life/standup.js');
      const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: document.documentElement.clientWidth, x: scrollX }));
      check('phone: the office page does not scroll sideways', over.doc <= over.vw && over.body <= over.vw && over.x === 0, JSON.stringify(over), 'app/office-life/*.css');
      await shot(page, 'phone-office', { x: 0, y: 0, width: 412, height: 600 });
    } catch (e) { check('phone script', false, e.message.split('\n')[0]); } finally { await browser.close(); }
  },
  async tabs() {
    const A = await launch({ width: 1200, height: 800 }), B = await launch({ width: 1200, height: 800 });
    try {
      await openOffice(A.page); await openOffice(B.page);
      const r = await injectAction('tournament', { players: ['ops', 'hermes-lab-a'] });
      const got = await Promise.all([A.page, B.page].map(p => p.waitForFunction(() => { const d = window.VOLifeTournament._debug(); return d.id ? d.id : null; }, null, { timeout: 15000 }).then(h => h.jsonValue(), () => null)));
      check('tabs: two browsers see the same bracket id', got[0] && got[0] === got[1], `${JSON.stringify(r.json)} ${got.join(' / ')}`, 'app/office-life/tournament.js');
      const live = await A.page.waitForFunction(() => window.VOLifeTournament._debug().live, null, { timeout: 60000 }).then(h => h.jsonValue(), () => null);
      if (live) {
        const res = await api('/api/office-life/cheer', { agent: live.p1, tournament: got[0], match: live.match }).catch(() => ({ status: 0 }));
        await sleep(1500);
        const counts = await Promise.all([A.page, B.page].map(p => p.evaluate(() => window.VOLifeTournament._debug().cheers)));
        check('tabs: a cheer counted by the server reaches both tabs', res.status === 200 && counts[0] && counts[1] && JSON.stringify(counts[0]) === JSON.stringify(counts[1]), `${res.status} ${JSON.stringify(counts).slice(0, 160)}`, 'app/office-life/tournament.js');
      } else check('tabs: a match starts on both pages', false, 'no live match in 60 s', 'app/office-life/tournament.js');
      const t = Date.now() / 1000; for (let i = 1; i <= 8; i++) await injectAction('tick', { now: t + i * 45 });
      const ch = await Promise.all([A.page, B.page].map(p => p.waitForFunction(() => window.VOLifeTournament._debug().champion, null, { timeout: 15000 }).then(h => h.jsonValue(), () => null)));
      check('tabs: both tabs show the same champion', ch[0] && ch[0] === ch[1], ch.join(' / '), 'app/office-life/tournament.js');
      check('tabs: no page errors', !A.errors.length && !B.errors.length, [...A.errors, ...B.errors].slice(0, 2).join(' | '));
    } catch (e) { check('tabs script', false, e.message.split('\n')[0]); } finally { await A.browser.close(); await B.browser.close(); }
  },
};

const ALL = { needsYou: true, interns: true, handoffs: true, visitors: true, alarmClock: true, moods: true, celebrations: true, standup: true, seasons: true, tournaments: true, newspaper: true };
const saveLife = body => api('/api/office-life/settings', body);
const active = (page, name) => page.evaluate(n => { const f = window.VOLife._debug().features.find(x => x.name === n); return f ? f.active : null; }, name);
const waitSetting = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);

run.settings = async function () {
  const { browser, page, errors } = await launch({ width: 1600, height: 900 });
  try {
    await openOffice(page);
    const FEAT = { needsYou: 'needs', moods: 'moods', celebrations: 'celebrate', standup: 'standup', seasons: 'decor', tournaments: 'tournament', newspaper: 'paper' };
    for (const [key, feat] of Object.entries(FEAT)) {
      await saveLife({ features: { [key]: false } });
      const off = await waitSetting(page, ([n]) => { const f = window.VOLife._debug().features.find(x => x.name === n); return f && !f.active; }, [feat]);
      await saveLife({ features: { [key]: true } });
      const on = await waitSetting(page, ([n]) => { const f = window.VOLife._debug().features.find(x => x.name === n); return f && f.active; }, [feat]);
      check(`page settings: ${key} off -> ${feat} feature inactive on the open page (no reload), on again -> active`, off && on, `off=${off} on=${on}`, `app/office-life/${feat === 'celebrate' ? 'celebrate' : feat}.js`);
    }
    // functional: a switched-off feature ignores its events on the page (the injector bypasses the server gates)
    const u = now();
    await saveLife({ features: { needsYou: false, celebrations: false, interns: false, visitors: false } });
    await sleep(800);
    await inject({ type: 'needs.open', agent: 'ops', provider: 'openclaw', need: 'question', ref: `fx-${u}`, cardId: `fx-${u}`, session: 'agent:ops:main', count: 1, at: now() },
      { type: 'xp', agent: 'ops', provider: 'office', points: 7, total: 50, reason: 'manual', ref: `fx-${u}`, at: now() },
      { type: 'interns.set', agent: 'hermes-lab-a', count: 2, shown: 2, at: now() },
      { type: 'visitor', agent: 'main', provider: 'openclaw', channel: 'email', session: `agent:main:email:${u}`, at: now() });
    await sleep(2500);
    const fx = await page.evaluate(() => ({ sign: window.VOLifeNeeds._signs().ops || null, pops: window.VOLifeCelebrate._debug().pops.filter(p => p.points === 7).length,
      interns: window.VOLifeCrew._debug().interns.filter(i => i.parent === 'hermes-lab-a').length, couriers: window.VOLifeCrew._debug().couriers.filter(c => c.agent === 'main').length }));
    check('page settings: with needsYou/celebrations/interns/visitors off, injected events draw nothing (no sign, pop, intern, courier)',
      !fx.sign && !fx.pops && !fx.interns && !fx.couriers, JSON.stringify(fx), 'app/office-life/life.js (feature gating)');
    await inject({ type: 'needs.close', agent: 'ops', provider: 'openclaw', ref: `fx-${u}`, outcome: 'cancelled', at: now() }, { type: 'interns.set', agent: 'hermes-lab-a', count: 0, shown: 0, at: now() });
    // Calm mode (design 7.4): signs/icons/decor stay, no walking scripts, no confetti, no tournaments
    await saveLife({ features: ALL, calm: true });
    await waitSetting(page, () => window.VOLife.calm());
    const c = now();
    await inject({ type: 'needs.open', agent: 'main', provider: 'openclaw', need: 'approval', ref: `calm-${c}`, cardId: `calm-${c}`, session: 'agent:main:main', count: 1, at: now() },
      { type: 'xp', agent: 'main', provider: 'office', points: 9, total: 60, reason: 'manual', ref: `calm-${c}`, at: now() },
      { type: 'interns.set', agent: 'ops', count: 1, shown: 1, at: now() },
      { type: 'mood', agent: 'hermes-lab-a', provider: 'hermes', mood: 'stuck', at: now() });
    await sleep(2000);
    const cm = await page.evaluate(() => ({ sign: window.VOLifeNeeds._signs().main || null, pop: window.VOLifeCelebrate._debug().pops.find(p => p.key === 'main' && p.points === 9) || null, parts: window.VOLifeCelebrate._debug().parts, still: window.VOLife.noParticles(),
      intern: window.VOLifeCrew._debug().interns.find(i => i.parent === 'ops') || null, mood: (window.VOLifeMoods._debug().moods['hermes-lab-a'] || {}).mood }));
    check('page calm: needs-you sign kept, at the desk (not a walk to the front)', cm.sign && cm.sign.mode !== 'front', JSON.stringify(cm.sign), 'app/office-life/needs.js');
    check('page calm: XP text shown, fades in place (no rise), no confetti particles', !!cm.pop && cm.still === true && cm.parts === 0, `pop=${JSON.stringify(cm.pop)} parts=${cm.parts}`, 'app/office-life/celebrate.js');
    check('page calm: intern fades in at the seat (no walk)', cm.intern && cm.intern.phase !== 'walking', JSON.stringify(cm.intern), 'app/office-life/crew.js');
    check('page calm: mood icons kept (stuck)', cm.mood === 'stuck', String(cm.mood), 'app/office-life/moods.js');
    await inject({ type: 'needs.close', agent: 'main', provider: 'openclaw', ref: `calm-${c}`, outcome: 'answered', at: now() }, { type: 'interns.set', agent: 'ops', count: 0, shown: 0, at: now() },
      { type: 'mood', agent: 'hermes-lab-a', provider: 'hermes', mood: 'clear', at: now() });
    // master switch: the whole layer goes away on the open page
    await saveLife({ calm: false, enabled: false });
    const gone = await waitSetting(page, () => !window.VOLife.isOn() && window.VOLife._debug().features.every(f => !f.active));
    await saveLife({ enabled: true });
    const back = await waitSetting(page, () => window.VOLife.isOn() && window.VOLife._debug().features.some(f => f.active));
    check('page settings: master switch off hides every feature live, on brings them back', gone && back, `off=${gone} on=${back}`, 'app/office-life/life.js');
    // the form: one changed key is all that is sent
    await page.evaluate(() => window.VOUI.openSettings('life'));
    await page.waitForSelector('#voLifeSettings [data-field="features.moods"]', { timeout: 10000 });
    const sent = [];
    page.on('request', r => { if (r.url().includes('/api/office-life/settings') && r.method() === 'POST') sent.push(r.postData()); });
    await page.click('#voLifeSettings [data-field="features.moods"]');
    await page.click('#voLifeSettings [data-life-save]');
    await sleep(1500);
    const body = sent[0] ? JSON.parse(sent[0]) : null;
    check('page settings form: Save sends only the changed key', body && JSON.stringify(body) === JSON.stringify({ features: { moods: false } }), sent[0] || 'no request', 'app/office-life/settings.js');
    await saveLife({ features: ALL });
    check('page settings: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '), 'app/office-life/*');
  } catch (e) { check('settings script', false, e.message.split('\n')[0]); } finally { await saveLife({ enabled: true, calm: false, features: ALL }); await browser.close(); }
};

run.tz = async function () {
  const before = (await api('/api/office-life/state')).json;
  try {
    // a zone change while a page is open (the settings frame carries the resolved zone since 7dbd800/2774731)
    const A = await launch({ width: 1200, height: 800, timezoneId: 'America/New_York' });
    await openOffice(A.page);
    await saveLife({ timeZone: 'Asia/Tokyo' });
    await sleep(2500);
    const live = await A.page.evaluate(() => window.VOLife._debug().tz);
    check('tz: a zone saved elsewhere reaches an open page without a reload', live === 'Asia/Tokyo', `page tz=${live}`, 'app/office-life/life.js');
    await A.browser.close();
    // adoption once: the server on its UTC fallback adopts the first managing browser's zone, then never again
    await saveLife({ timeZone: '' });
    const fallback = (await api('/api/office-life/state')).json.tz;
    const B = await launch({ width: 1200, height: 800, timezoneId: 'Europe/Berlin' });
    await openOffice(B.page); await sleep(2500);
    const afterB = (await api('/api/office-life/state')).json;
    const C = await launch({ width: 1200, height: 800, timezoneId: 'Asia/Tokyo' });
    await openOffice(C.page); await sleep(2500);
    const afterC = (await api('/api/office-life/state')).json;
    check('tz: UTC fallback -> the first browser zone is adopted once (Europe/Berlin), a later Tokyo browser does not change it',
      fallback === 'UTC' && afterB.tz === 'Europe/Berlin' && afterC.tz === 'Europe/Berlin', `fallback=${fallback} afterB=${afterB.tz} afterC=${afterC.tz}`, 'app/office-life/settings.js');
    await C.page.evaluate(() => window.VOUI.openSettings('life'));
    await C.page.waitForSelector('#voLifeSettings', { timeout: 10000 }); await sleep(800);
    const warn = await C.page.evaluate(() => { const w = document.querySelector('#voLifeSettings .vo-ls-warn'); return w && w.getBoundingClientRect().height > 0 ? w.innerText.replace(/\s+/g, ' ') : ''; });
    check('tz: Settings warns when the browser zone (Tokyo) differs from the office zone (Berlin)', /Tokyo/.test(warn) && /Berlin/.test(warn), warn.slice(0, 160) || 'no .vo-ls-warn', 'app/office-life/settings.js');
    await B.browser.close(); await C.browser.close();
    // phone Settings form fits (known open note: 5 px overflow)
    const P = await launch({ width: 412, height: 915, mobile: true });
    await openOffice(P.page);
    await P.page.evaluate(() => window.VOUI.openSettings('life'));
    await P.page.waitForSelector('#voLifeSettings [data-field]', { timeout: 10000 }); await sleep(800);
    const ov = await P.page.evaluate(() => { const host = document.getElementById('voLifeSettings'); const vw = document.documentElement.clientWidth; let worst = null;
      for (const el of host.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.width && r.right > vw + 0.5 && (!worst || r.right > worst.right)) worst = { cls: el.className.toString().slice(0, 40) || el.tagName, right: Math.round(r.right), field: el.dataset && el.dataset.field }; }
      let sc = host; while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
      return { vw, worst, scroller: sc && sc.scrollWidth > sc.clientWidth + 0.5 ? (sc.className.toString().slice(0, 30) + ' ' + sc.scrollWidth + '>' + sc.clientWidth) : null }; });
    check('tz/phone: Settings > Office life fits 412 px (no element past the viewport, no sideways scroll)', !ov.worst && !ov.scroller, JSON.stringify(ov), 'app/office-life/settings.js');
    await P.browser.close();
  } catch (e) { check('tz script', false, e.message.split('\n')[0]); } finally { await saveLife({ timeZone: before.settings.timeZone || 'America/New_York' }); }
};

run.paper = async function () {
  const { browser, page, errors } = await launch({ width: 1600, height: 900 });
  try {
    await openOffice(page);
    const st = (await api('/api/office-life/state')).json;
    const srv = (await api(`/api/office-life/paper?day=${st.day}`)).json;
    const paper = srv.paper || srv;
    await page.evaluate(() => window.VOLifePaper.open());
    await page.waitForSelector('.vo-paper .vo-paper-headline', { timeout: 10000 });
    const view = await page.evaluate(() => ({ head: document.querySelector('.vo-paper .vo-paper-headline').textContent.trim(), cols: document.querySelectorAll('.vo-paper .vo-paper-col').length, text: document.querySelector('.vo-paper').innerText }));
    check('paper window: headline and agent columns match the server paper', view.head === paper.headline && view.cols === (paper.columns || []).length, `"${view.head}" cols ${view.cols}/${(paper.columns || []).length}`, 'app/office-life/paper.js');
    check('paper window: no command/question/message text', !SECRETS.some(x => view.text.includes(x)), '', 'app/office-life/paper.js');
    await page.evaluate(() => window.VOLifePaper.close());
    await page.evaluate(d => window.VOLifePaper.replay(d), st.day);
    const loaded = await page.waitForFunction(() => { const d = window.VOLifePaper._debug(); return d.replay && d.replay.loaded; }, null, { timeout: 15000 }).then(() => true, () => false);
    const bar = await page.evaluate(() => { const b = document.querySelector('.vo-life-replay'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, hidden: b.hidden }; });
    const chrome = await chromeRects(page);
    const rp = await page.evaluate(() => { const d = window.VOLifePaper._debug().replay; return { keys: d.keys.length, start: d.start, end: d.end, running: window.VOLife._debug().running.length }; });
    check('replay: loads the journal, holds every agent, bar shown clear of map controls', loaded && bar && !bar.hidden && rp.keys >= 3 && rp.running >= 3 && !chrome.filter(c => !/vo-life-replay/.test(c.sel)).some(c => overlap(bar, c)),
      `bar ${JSON.stringify(bar)} ${JSON.stringify(rp)}`, 'app/office-life/paper.js');
    const writesBefore = (await api('/api/office-life/state')).json.seq;
    await page.evaluate(() => { const i = document.querySelector('.vo-life-replay input[type=range]'); if (i) { i.value = String(Number(i.max) * 0.6 | 0); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); } });
    await sleep(1500);
    await page.keyboard.press('Escape');
    const out = await page.waitForFunction(() => !window.VOLifePaper.replaying() && window.VOLife._debug().running.length === 0, null, { timeout: 10000 }).then(() => true, () => false);
    const writesAfter = (await api('/api/office-life/state')).json.seq;
    check('replay: seek then Esc exits, releases every agent, nothing written (seq unchanged)', out && writesAfter === writesBefore, `exit=${out} seq ${writesBefore} -> ${writesAfter}`, 'app/office-life/paper.js');
    // seasons/occasions: a custom occasion for today reaches the open page (one static rebuild) and the decor plan
    const parts = await page.evaluate(() => window.VOLife.officeParts(Date.now()));
    const mmdd = String(parts.month).padStart(2, '0') + '-' + String(parts.day).padStart(2, '0');
    const b0 = await page.evaluate(() => window.__voStats.staticBuilds);
    await api('/api/office-life/settings', { seasons: { custom: [{ name: 'QA Day', date: mmdd, icon: 'star' }] } });
    await sleep(2000);
    const dec = await page.evaluate(() => { const s = window.VOLife.settings ? window.VOLife.settings() : null; const p = window.VOLifeSeasons.plan({ parts: window.VOLife.officeParts(Date.now()), seasons: (s || {}).seasons, lat: null }); return { custom: p.custom, builds: window.__voStats.staticBuilds }; });
    check('seasons: a custom occasion for today is in the decor plan and the static layer rebuilt (no reload)', JSON.stringify(dec.custom).includes('QA Day') && dec.builds > b0, `${JSON.stringify(dec.custom).slice(0, 100)} builds ${b0}->${dec.builds}`, 'app/office-life/decor.js');
    await api('/api/office-life/settings', { seasons: { custom: [] } });
    const bd = (await api('/api/office-life/state')).json.today;
    check('seasons: birthdays only from a recorded createdAt (none of the lab/fake agents has one -> none, not faked)', Array.isArray(bd.birthdays) && bd.birthdays.length === 0, JSON.stringify(bd.birthdays), 'app/office_life/scheduler.py');
    check('paper/replay: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '), 'app/office-life/*');
  } catch (e) { check('paper script', false, e.message.split('\n')[0]); } finally { await browser.close(); }
};

run.reduced = async function () {
  const { browser, page, errors } = await launch({ width: 1600, height: 900, reducedMotion: 'reduce' });
  try {
    await openOffice(page);
    const u = now();
    await inject({ type: 'needs.open', agent: 'ops', provider: 'openclaw', need: 'question', ref: `rm-${u}`, cardId: `rm-${u}`, session: 'agent:ops:main', count: 1, at: now() },
      { type: 'xp', agent: 'main', provider: 'office', points: 4, total: 70, reason: 'manual', ref: `rm-${u}`, at: now() },
      { type: 'visitor', agent: 'main', provider: 'openclaw', channel: 'sms', session: `agent:main:sms:${u}`, at: now() });
    await sleep(2000);
    const r = await page.evaluate(() => ({ atDesk: window.VOLife.atDesk(), sign: window.VOLifeNeeds._signs().ops || null, parts: window.VOLifeCelebrate._debug().parts,
      couriers: window.VOLifeCrew._debug().couriers.length, env: (window.VOLifeCrew._debug().envelopes || []).length }));
    check('reduced motion: at-desk variants (sign not at the front, no confetti, visitor = envelope only, no courier walk)',
      r.atDesk && r.sign && r.sign.mode !== 'front' && r.parts === 0 && r.couriers === 0, JSON.stringify(r), 'app/office-life/*');
    await inject({ type: 'needs.close', agent: 'ops', provider: 'openclaw', ref: `rm-${u}`, outcome: 'answered', at: now() });
    check('reduced motion: no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (e) { check('reduced script', false, e.message.split('\n')[0]); } finally { await browser.close(); }
};

await run[section]();
process.exit(summary('life_page ' + section) ? 1 : 0);
