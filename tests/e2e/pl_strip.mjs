// v0.11 relmisc (Playtest #10): on a phone the copied Agent Providers window shows its providers as a sideways strip;
// an edge with more providers behind it fades out and has a small arrow that scrolls the strip. Desktop is unchanged.
// Needs a VO_PROVIDER_LAYER=1 office (tests/tools/pl-office.sh, or a Docker office) at VO_URL; adds unreachable
// fixture connections until there are 4 providers (labels "Strip check N") and removes them at the end.
//   VO_URL=http://127.0.0.1:18720 node tests/e2e/pl_strip.mjs
import { check, summary, launch, api, open, sleep } from './pl_lib.mjs';

const FADE = 64;   // (agent-providers.css: the fade's width; a chosen provider is kept clear of it)

const state = page => page.evaluate(() => {
  const side = document.querySelector('.ap-back .ap-side'), main = document.querySelector('.ap-back .ap-main');
  const box = el => {
    if (!el || getComputedStyle(el).display === 'none') return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), r: Math.round(r.right), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const right = document.querySelector('.ap-back .ap-more.r');
  return {
    sw: side.scrollWidth, cw: side.clientWidth, sl: Math.round(side.scrollLeft), dir: getComputedStyle(side).flexDirection,
    l: main.classList.contains('more-l'), r: main.classList.contains('more-r'),
    mask: getComputedStyle(side).maskImage || getComputedStyle(side).webkitMaskImage || 'none',
    side: box(side), ml: box(document.querySelector('.ap-back .ap-more.l')), mr: box(right),
    ink: right && getComputedStyle(right).color, disc: right && getComputedStyle(right, '::before').backgroundColor,
    on: box(document.querySelector('.ap-back .ap-side .on')),
    addLines: (() => {   // (lines of text in "Add provider": distinct tops of its text's line boxes)
      const b = document.querySelector('.ap-back .ap-add'); if (!b) return 0;
      const range = document.createRange(); range.selectNodeContents(b);
      return new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top))).size;
    })(),
    docW: document.documentElement.scrollWidth, vw: innerWidth,
  };
});
function lum(c) {
  const [r, g, b] = (String(c).match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(v => { v = +v / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const scrollTo = (page, where) => page.evaluate(w => { const x = document.querySelector('.ap-back .ap-side'); x.scrollLeft = w === 'end' ? x.scrollWidth : 0; }, where);

async function openProviders(opts) {
  const { browser, page, errors } = await launch(opts);
  if (opts.phone) await page.setViewportSize({ width: 412, height: 915 });   // (the playtest's phone)
  await open(page);
  await page.evaluate(() => window.voPL.openProviders());
  await page.waitForFunction(() => document.querySelectorAll('.ap-back .ap-side .ap-prov').length >= 4, null, { timeout: 20000 });
  await sleep(400);
  return { browser, page, errors };
}

const added = [];
let code = 1;
try {
  const have = (await api('/api/agent-providers')).body?.providers || [];
  for (let n = have.length; n < 4; n++) {
    const kind = n % 2 ? 'hermes' : 'openclaw', url = kind === 'hermes' ? `http://127.0.0.1:${9 + n}` : `ws://127.0.0.1:${9 + n}`;
    const r = await api('/api/connections', { method: 'POST', body: { kind, label: `Strip check ${n + 1}`, scope: 'installation', config: { url, auth: 'token', access: 'full' }, secrets: { token: 'x' } } });
    if (r.body?.id) added.push(r.body.id); else throw new Error(`fixture connection: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  for (const theme of ['dark', 'light']) {
    const T = `[phone 412 ${theme}]`;
    const { browser, page, errors } = await openProviders({ phone: true, theme });
    try {
      let s = await state(page);
      check(`${T} the providers are a sideways strip that overflows`, s.dir === 'row' && s.sw > s.cw + 40, `${s.sw} in ${s.cw}`);
      check(`${T} at the start the right edge fades, the left does not`, s.r && !s.l && /gradient/.test(s.mask), s.mask.slice(0, 60));
      check(`${T} a right arrow on the strip's right edge (44 px wide, the strip's height), no left arrow`,
        !!s.mr && !s.ml && Math.abs(s.mr.r - s.side.r) <= 1 && Math.abs(s.mr.y - s.side.y) <= 1 && Math.abs(s.mr.h - s.side.h) <= 1 && s.mr.w >= 44, JSON.stringify(s.mr));
      const c = contrast(s.ink, s.disc);
      check(`${T} the arrow reads on its disc (>= 4.5:1) and the disc is drawn`, c >= 4.5 && !/rgba\(0, 0, 0, 0\)/.test(s.disc), `${c.toFixed(1)}:1 on ${s.disc}`);
      check(`${T} "Add provider" on one line`, s.addLines === 1, `${s.addLines} line(s)`);
      check(`${T} the page itself does not scroll sideways`, s.docW <= s.vw, `${s.docW}/${s.vw}`);
      await page.tap('.ap-back .ap-more.r');
      await sleep(700);
      s = await state(page);
      check(`${T} the right arrow scrolls the strip; the left edge fades now and has its arrow`, s.sl > 100 && s.l && !!s.ml, `scrollLeft ${s.sl}`);
      await scrollTo(page, 'end');
      await sleep(300);
      s = await state(page);
      check(`${T} at the end: no right fade or arrow; left fade and arrow`, !s.r && s.l && !s.mr && !!s.ml && /gradient/.test(s.mask), `l=${s.l} r=${s.r}`);
      for (let k = 0; k < 3 && s.sl > 0; k++) { await page.tap('.ap-back .ap-more.l'); await sleep(700); s = await state(page); }
      check(`${T} the left arrow scrolls back to the start`, s.sl === 0 && !s.l && s.r && !s.ml, `scrollLeft ${s.sl}`);
      await page.evaluate(() => { const b = [...document.querySelectorAll('.ap-back .ap-side > .ap-prov')]; b[b.length - 1]?.click(); });
      await sleep(900);
      s = await state(page);
      check(`${T} a provider chosen near the end is scrolled into view, clear of a faded edge and its arrow`,
        !!s.on && s.on.x >= s.side.x + (s.l ? FADE : 0) - 1 && s.on.r <= s.side.r - (s.r ? FADE : 0) + 1 && (!s.mr || s.on.r <= s.mr.x) && (!s.ml || s.on.x >= s.ml.r), `${JSON.stringify(s.on)} l=${s.l} r=${s.r}`);
      await scrollTo(page, 'end');
      await sleep(200);
      await page.evaluate(() => document.querySelector('.ap-back .ap-side > .ap-prov')?.click());
      await sleep(900);
      s = await state(page);
      check(`${T} the first provider chosen from the far end: the strip is back at the start`, !!s.on && s.sl === 0 && !s.l, `scrollLeft ${s.sl}`);
      check(`${T} 0 page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    } finally { await browser.close(); }
  }
  const { browser, page, errors } = await openProviders({ phone: false, theme: 'dark' });
  try {
    const s = await state(page);
    check('[desktop] the providers column is unchanged: no fade, no arrows', s.dir === 'column' && s.mask === 'none' && !s.ml && !s.mr, `dir=${s.dir} mask=${s.mask}`);
    check('[desktop] 0 page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally { await browser.close(); }
  code = summary('pl_strip');
} catch (e) {
  console.log(`FAIL pl_strip: ${e.message}`);
} finally {
  for (const id of added) await api('/api/agent-providers/remove', { method: 'POST', body: { id } }).catch(() => {});
}
process.exit(code);
