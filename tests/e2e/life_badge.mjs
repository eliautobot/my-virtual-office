// Needs-you edge badge re-check (life-qa2) on the PRIVATE office (tests/tools/life-e2e.sh, VO_URL):
//   node tests/e2e/life_badge.mjs
// main is panned off the bottom (and off the right) edge, a server-injected needs.open makes the edge badge; at
// 412x915, 390x844, 375x667 (phone) and 1600x900 (desktop) the badge must sit inside the canvas, clear of every
// chrome rect (phone DASHBOARD sheet included), be the element on top at its centre, and a tap/click opens main's chat.
// Desktop: the canvas chrome list stays the map controls + top bar (unchanged by the phone-sheet fix).
import { VO, check, inject, launch, openOffice, chromeRects, overlap, sleep, now, summary } from './life_lib.mjs';

if (!/^http:\/\/127\.0\.0\.1:/.test(VO) || /:8096\b/.test(VO)) { console.error('refusing: not the private office'); process.exit(2); }

const SIZES = [[412, 915, 'down'], [412, 915, 'right'], [390, 844, 'down'], [375, 667, 'down'], [375, 667, 'right'], [1600, 900, 'down']];

async function one(W, H, dir) {
  const phone = W < 700, tag = `${phone ? 'phone' : 'desktop'} ${W}x${H} ${dir}`, ref = `badge-${W}-${dir}-${now()}`;
  const { browser, page, errors } = await launch({ width: W, height: H, mobile: phone });
  try {
    await openOffice(page);
    await page.evaluate(() => { window.__opened = []; addEventListener('vo:chat-opened-agent', e => window.__opened.push(e.detail)); });
    await inject({ type: 'needs.open', agent: 'main', provider: 'openclaw', need: 'approval', ref, cardId: ref, session: 'agent:main:main', count: 1, at: now() });
    await page.waitForFunction(() => { const s = window.VOLifeNeeds._signs(); return s.main && s.main.posed; }, null, { timeout: 20000 }).catch(() => {});
    await page.evaluate((dir) => {
      try { if (typeof _cameraMode !== 'undefined') _cameraMode = 'manual'; } catch (e) {}
      const H = window.VOLifeHost, a = window.agentMap.main, v = H.view(), p0 = H.worldToCanvas(a.x, a.y - 60);
      const k = (H.worldToCanvas(a.x, a.y + 100).y - H.worldToCanvas(a.x, a.y).y) / 100;
      if (dir === 'down') camera.y -= (v.h + 90 - p0.y) / k; else camera.x -= (v.w + 90 - p0.x) / k;
      H.markDirty && H.markDirty();
    }, dir);
    await sleep(1200);
    const r = await page.evaluate(() => {
      const c = (document.getElementById('officeCanvas') || document.querySelector('canvas')).getBoundingClientRect();
      const el = [...document.querySelectorAll('.vo-life-edge')].find(e => e.getBoundingClientRect().width > 0 && !e.hidden && /Main/.test(e.textContent));
      if (!el) return { c: { x: c.left, y: c.top, w: c.width, h: c.height }, b: null };
      const q = el.getBoundingClientRect(), top = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
      const chrome = window.VOLifeHost.chrome().map(o => (o.sel || o.el && o.el.className || '').toString().slice(0, 24));
      return { c: { x: c.left, y: c.top, w: c.width, h: c.height }, b: { x: q.left, y: q.top, w: q.width, h: q.height },
        onTop: !!top && (top === el || el.contains(top)), topSel: top ? (top.className || top.tagName).toString().slice(0, 30) : null, hostChrome: window.VOLifeHost.chrome().length };
    });
    const chrome = await chromeRects(page), hits = r.b ? chrome.filter(c => overlap(r.b, c)) : [];
    const b = r.b, c = r.c;
    const inside = b && b.x >= c.x - 0.5 && b.y >= c.y - 0.5 && b.x + b.w <= c.x + c.w + 0.5 && b.y + b.h <= c.y + c.h + 0.5;
    const box = b ? [b.x, b.y, b.w, b.h].map(Math.round).join(',') : 'none';
    check(`${tag}: edge badge inside the canvas, clear of chrome, on top`, !!b && inside && !hits.length && r.onTop,
      `badge ${box} top=${r.topSel} hits ${JSON.stringify(hits.map(h => h.sel))}`, 'app/game.js _canvasChromeObstacles / app/office-life/needs.js');
    if (b) { if (phone) await page.touchscreen.tap(b.x + b.w / 2, b.y + b.h / 2); else await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2); }
    const opened = await page.waitForFunction(() => (window.__opened || []).length > 0, null, { timeout: 8000 }).then(() => true, () => false);
    const od = await page.evaluate(() => window.__opened);
    check(`${tag}: tap on the badge opens main's chat`, opened && /main/.test(JSON.stringify(od[0] || '')), JSON.stringify(od).slice(0, 100), 'app/office-life/needs.js + app/chat.js');
    if (!phone) {
      // every host chrome rect (canvas coords) must come from .vo-mapctl / the chat window buttons on it / .vo-topbar / [data-vo-canvas-obstacle]
      const d = await page.evaluate(() => {
        const c = (document.getElementById('officeCanvas') || document.querySelector('canvas')).getBoundingClientRect();
        const els = [document.querySelector('.vo-mapctl'), document.querySelector('#chat-window-rail:not(.is-strip)'), document.querySelector('.vo-topbar'), ...document.querySelectorAll('[data-vo-canvas-obstacle]')]
          .filter(Boolean).map(e => { const q = e.getBoundingClientRect(); return { x: q.left - c.left, y: q.top - c.top, w: q.width, h: q.height }; });
        const host = window.VOLifeHost.chrome().filter(o => o.chrome);
        const ov = (a, b) => a.x < b.x + b.w + 6 && b.x < a.x + a.w + 6 && a.y < b.y + b.h + 6 && b.y < a.y + a.h + 6;
        return { phoneQuery: matchMedia('(max-width: 640px)').matches, host: host.length, foreign: host.filter(h => !els.some(e => ov(h, e))).length };
      });
      check(`${tag}: desktop canvas chrome unchanged (map controls/top bar/obstacles only)`, !d.phoneQuery && d.foreign === 0, JSON.stringify(d));
    }
    check(`${tag}: no page errors`, !errors.length, errors[0] || '');
    await inject({ type: 'needs.close', agent: 'main', provider: 'openclaw', ref, outcome: 'answered', at: now() });
  } finally { await browser.close(); }
}

for (const [W, H, dir] of SIZES) await one(W, H, dir);
process.exit(summary('life_badge') ? 1 : 0);
