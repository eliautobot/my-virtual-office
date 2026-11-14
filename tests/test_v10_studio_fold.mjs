// v0.10 R-09: the Agent Studio's right pane says "more below" with a soft fade at the fold (as Settings, UI-13)
// while the list continues under the footer, and drops it at the end of the list (a mask: any theme's background).
import { launch, openStudio, showStudio } from './test_v10_studio_lib.mjs';

const NAME = 'test_v10_studio_fold';
const browser = await launch(NAME);
const results = [];
const check = (ok, label, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ': ' + detail}`); results.push(ok); };
const fold = () => { const side = document.querySelector('.studio-v10 .st-side'), p = side.querySelector('.st-panel');
  const m = getComputedStyle(p).maskImage || getComputedStyle(p).webkitMaskImage || 'none';
  return { more: side.classList.contains('vo-has-more'), fade: m !== 'none' && /transparent|rgba\(0, 0, 0, 0\)/.test(m) ? 1 : 0, over: p.scrollHeight - p.clientHeight, top: p.scrollTop }; };
try {
  const s = await openStudio(browser);
  await showStudio(s.page);
  await s.page.waitForTimeout(700);
  const a = await s.page.evaluate(fold);
  check(a.over > 8 && a.more && a.fade === 1, 'a list that runs past the fold shows the fade', JSON.stringify(a));
  await s.page.evaluate(() => { const p = document.querySelector('.studio-v10 .st-panel'); p.scrollTop = p.scrollHeight; });
  await s.page.waitForTimeout(400);
  const b = await s.page.evaluate(fold);
  check(!b.more && b.fade === 0, 'at the end of the list the fade goes', JSON.stringify(b));
  await s.page.evaluate(() => { const p = document.querySelector('.studio-v10 .st-panel'); p.scrollTop = 0; });
  await s.page.waitForTimeout(400);
  const c = await s.page.evaluate(fold);
  check(c.more && c.fade === 1, 'back at the top it shows again', JSON.stringify(c));
  check(s.errors.length === 0, 'no page errors', s.errors.join(' | '));
  await s.context.close();
} finally {
  await browser.close();
}
const failed = results.filter(r => !r).length;
if (failed) { console.log(`${NAME}: ${failed} of ${results.length} checks FAILED`); process.exit(1); }
console.log(`${NAME}: all ${results.length} checks passed`);
