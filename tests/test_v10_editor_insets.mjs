// v0.10 R-06 / R-07: while editing, the view insets keep the office and its resize handles clear of the
// map control column (desktop, right), the editing pill and the top edge (phones: the pill moves into the
// top bar). Insets are canvas px.
import { launch, openEditor, makeChecker } from './test_v10_editor_lib.mjs';

const NAME = 'test_v10_editor_insets';
const browser = await launch(NAME);
const c = makeChecker(NAME);
const geometry = () => {
  const R = el => { if (!el || el.hidden || !el.offsetWidth) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const cr = canvas.getBoundingClientRect(), a = _worldToCanvas(0, 0), b = _worldToCanvas(W, H);
  const toClient = (x, y, w, h) => { const p = _worldToCanvas(x, y), q = _worldToCanvas(x + w, y + h); return { l: cr.left + p.x, t: cr.top + p.y, r: cr.left + q.x, b: cr.top + q.y }; };
  const pill = document.getElementById('vo-office-save-status');
  const pr = R(pill), at = pr && document.elementFromPoint((pr.l + pr.r) / 2, (pr.t + pr.b) / 2);
  const gear = document.querySelector('.vo-topbar [data-vo-open-settings]'), gr = R(gear);
  const gat = gr && document.elementFromPoint((gr.l + gr.r) / 2, (gr.t + gr.b) / 2);
  return {
    canvas: { l: cr.left, t: cr.top, r: cr.right, b: cr.bottom }, insets: Object.assign({}, _viewInsets),
    office: { l: cr.left + a.x, t: cr.top + a.y, r: cr.left + b.x, b: cr.top + b.y },
    handles: _editResizeHandles.map(h => Object.assign({ edge: h.edge }, toClient(h.x, h.y, h.w, h.h))),
    buttons: _editButtons.filter(x => x.edge).map(x => Object.assign({ edge: x.edge }, toClient(x.x, x.y, x.w, x.h))),
    mapctl: R(document.querySelector('.vo-mapctl')), pill: pr, pillHit: !!at && pill.contains(at),
    gearHit: gr ? !!gat && gear.contains(gat) : null,
  };
};
const meets = (p, q) => p && q && p.l < q.r - 0.5 && p.r > q.l + 0.5 && p.t < q.b - 0.5 && p.b > q.t + 0.5;
try {
  {
    const e = await openEditor(browser, { width: 1600, height: 900 });
    await e.page.waitForTimeout(900);
    const g = await e.page.evaluate(geometry);
    c.ok(g.insets.right > 0 && g.mapctl && !meets(g.office, g.mapctl), 'desktop: the office keeps clear of the map controls', JSON.stringify({ office: g.office, mapctl: g.mapctl, insets: g.insets }));
    const right = g.handles.concat(g.buttons).filter(h => h.edge === 'right');
    c.ok(right.length >= 3 && right.every(h => h.r <= g.canvas.r && !meets(h, g.mapctl)), 'desktop: the right edge handle and its +/- are on the canvas, not under the map controls', JSON.stringify(right));
    c.ok(g.pill && g.office.t >= g.pill.b, 'desktop: the editing pill sits above the office, not on its top wall', JSON.stringify({ pill: g.pill, office: g.office }));
    const top = g.handles.concat(g.buttons).filter(h => h.edge === 'top');
    c.ok(top.length >= 3 && top.every(h => h.t >= g.canvas.t && !meets(h, g.pill)), 'desktop: the top handle and its +/- are clear', JSON.stringify(top));
    c.ok(e.errors.length === 0, 'desktop: no page errors', e.errors.join(' | '));
    await e.context.close();
  }
  for (const [width, height] of [[412, 915], [375, 667]]) {
    const e = await openEditor(browser, { width, height, mobile: true });
    await e.page.waitForTimeout(900);
    const g = await e.page.evaluate(geometry);
    const top = g.handles.concat(g.buttons).filter(h => h.edge === 'top');
    c.ok(top.length >= 3 && top.every(h => h.t >= g.canvas.t), `${width}: the top handle and its +/- are inside the canvas (not under the top bar)`, JSON.stringify({ canvas: g.canvas, top }));
    c.ok(g.pill && g.pill.b <= g.canvas.t && g.pillHit && g.gearHit !== false, `${width}: the editing pill sits in the top bar (not on the top wall), Settings stays tappable`, JSON.stringify({ pill: g.pill, canvas: g.canvas, hit: g.pillHit, gear: g.gearHit }));
    c.ok(g.insets.bottom > 0 && g.insets.bottom < g.canvas.b - g.canvas.t, `${width}: bottom inset is measured on the canvas`, JSON.stringify(g.insets));
    // An agent at work right under the top wall: its activity chip keeps off the top handle and its +/-.
    const chip = await e.page.evaluate(() => {
      const a = agents[0]; a.state = 'working'; a.activeToolCount = 1; a.task = 'Running tests';
      a.x = a.targetX = W / 2; a.y = a.targetY = 96; a.isSitting = false;
      _chromeRectsAt = 0; _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now()); _renderFrame(performance.now());
      const hs = _editResizeHandles.concat(_editButtons.filter(x => x.edge)).filter(h => h.edge === 'top').map(h => { const p = _worldToCanvas(h.x, h.y), q = _worldToCanvas(h.x + h.w, h.y + h.h); return { x: p.x, y: p.y, w: q.x - p.x, h: q.y - p.y }; });
      const r = a._chipRect; return { r, hs, hit: !!r && hs.some(h => r.x < h.x + h.w && r.x + r.w > h.x && r.y < h.y + h.h && r.y + r.h > h.y) };
    });
    c.ok(chip.r && chip.hs.length >= 3 && !chip.hit, `${width}: an activity chip keeps off the top handle`, JSON.stringify(chip));
    c.ok(e.errors.length === 0, `${width}: no page errors`, e.errors.join(' | '));
    await e.context.close();
  }
} finally {
  await browser.close();
}
c.done();
