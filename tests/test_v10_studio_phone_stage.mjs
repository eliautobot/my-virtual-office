// v0.10 R-03: on a phone the Agent Studio stage's controls (tools, facing, play/pause) keep off the figure,
// its legs and its name tag: no figure pixel under any control, standing or seated, at the full fit scale.
import { launch, openStudio, showStudio } from './test_v10_studio_lib.mjs';

const NAME = 'test_v10_studio_phone_stage';
const browser = await launch(NAME);
const results = [];
const check = (ok, label, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ': ' + detail}`); results.push(ok); };
try {
  const s = await openStudio(browser, { phone: true });
  await showStudio(s.page);
  await s.page.waitForTimeout(600);
  for (const pose of ['stand', 'type']) {
    await s.page.evaluate(p => VOStudio.setPose(p), pose);
    await s.page.waitForTimeout(400);
    const o = await s.page.evaluate(() => {
      const cv = document.querySelector('.st-stage-canvas'), c = cv.getBoundingClientRect(), S = VOStudio.state;
      const a = agents.find(x => x.id === 'alpha') || agents[0];
      // The stage's own render without the floor: what is left is the figure (+ desk) and its tag.
      const off = document.createElement('canvas');
      VOOffice.renderAgentPreview(off, a.getAppearance ? a.getAppearance() : a.appearance, { pose: S.pose, view: S.pose === 'stand' || S.pose === 'walk' ? 'stand' : 'desk',
        width: c.width, height: c.height, floor: false, nameTag: true, name: a.name, color: a.color });
      const d = off.getContext('2d').getImageData(0, 0, off.width, off.height).data, k = off.width / c.width;
      const controls = [...document.querySelectorAll('.st-tools .vo-btn, .st-facing .st-seg-btn, .st-play')].filter(b => b.offsetWidth);
      const under = controls.map(b => { const t = b.getBoundingClientRect(); let n = 0;
        for (let y = Math.max(0, Math.floor((t.top - c.top) * k)); y < Math.min(off.height, (t.bottom - c.top) * k); y++)
          for (let x = Math.max(0, Math.floor((t.left - c.left) * k)); x < Math.min(off.width, (t.right - c.left) * k); x++) if (d[(y * off.width + x) * 4 + 3] > 10) n++;
        return n ? (b.getAttribute('aria-label') || b.textContent.trim()) + ':' + n : ''; }).filter(Boolean);
      const inside = controls.every(b => { const t = b.getBoundingClientRect(); return t.top >= c.top - 1 && t.bottom <= c.bottom + 1; });
      return { n: controls.length, under, inside, scale: Number(document.querySelector('.st-stage').dataset.scale) };
    });
    check(o.n >= 9 && o.under.length === 0, `${pose}: no figure pixel under the ${o.n} stage controls`, JSON.stringify(o));
    check(o.inside, `${pose}: the controls stay on the stage`, JSON.stringify(o));
    if (pose === 'stand') check(o.scale >= 3, `stand: the figure keeps the full fit scale (${o.scale})`, JSON.stringify(o));
  }
  check(s.errors.length === 0, 'no page errors', s.errors.join(' | '));
  await s.context.close();
} finally {
  await browser.close();
}
const failed = results.filter(r => !r).length;
if (failed) { console.log(`${NAME}: ${failed} of ${results.length} checks FAILED`); process.exit(1); }
console.log(`${NAME}: all ${results.length} checks passed`);
